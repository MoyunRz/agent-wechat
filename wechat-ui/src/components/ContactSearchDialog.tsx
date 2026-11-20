// Contact search dialog: debounced contact search plus a manual contact-sync
// job. The Vue component rendered through Teleport with a Transition; this port
// keeps the same portal target, DOM structure, classes and timing.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { wechatApi, WechatApiError } from '../api'
import { requestStatus } from '../contact-requests'
import { userFacingErrorMessage } from '../errors'
import { contactName } from '../format'
import { useT } from '../i18n/useT'
import { isTerminalOperation, operationOutcomeMessage } from '../operations'
import type { Contact, ContactDiscovery, ContactPrivacySettings, Operation } from '../types'
import Icon from './Icon'
import LoadingDots from './LoadingDots'
import ThreadAvatar from './ThreadAvatar'
import '../styles/components/contact-search.css'
import '../styles/components/contact-detail.css'

type ContactSearchDialogProps = {
  open: boolean
  accountId: string
  onClose: () => void
  onSelect: (contact: Contact) => void
  onStartId: (id: string) => void
  /** Jumps to the friend-request inbox for an incoming discovered request. */
  onOpenRequests?: () => void
}

type Phase = 'closed' | 'entering' | 'open' | 'leaving'

const SYNC_POLL_INTERVAL = 1500
const SYNC_POLL_LIMIT = 80
const SEARCH_DEBOUNCE_MS = 300
// Matches the 0.18s opacity transition declared in contact-search.css.
const TRANSITION_MS = 180

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function describeError(value: unknown): string {
  if (value instanceof WechatApiError) {
    if (value.status === 409)
      return '请先登录微信并完成同步，也可以直接输入微信号开始聊天。'
    return userFacingErrorMessage(value, '搜索联系人失败，请稍后重试。')
  }
  return userFacingErrorMessage(value, '搜索联系人失败，请稍后重试。')
}

function describeSyncError(value: unknown): string {
  if (value instanceof WechatApiError) {
    if (value.status === 401 || value.status === 403 || value.status === 409
      || value.code === 'auth_required' || value.code === 'profile_keys_missing')
      return '请先登录微信并完成同步。'
    return userFacingErrorMessage(value, '同步通讯录失败，请稍后重试。')
  }
  return userFacingErrorMessage(value, '同步通讯录失败，请稍后重试。')
}

function describeOperationFailure(operation: Operation): string {
  if (operation.state === 'cancelled')
    return '通讯录同步已取消，请重新点击同步。'
  const code = typeof operation.result?.code === 'string' ? operation.result.code : ''
  if (code === 'auth_required' || code === 'profile_keys_missing' || code === 'not_connected')
    return '请先登录微信并完成同步。'
  return '通讯录同步失败，请稍后重试。'
}

function describeDiscoveryError(value: unknown): string {
  if (value instanceof WechatApiError) {
    if (value.code === 'contact_discovery_rejected' || value.status === 400 || value.status === 404)
      return '没有找到这个微信号，请尝试输入准确的微信号。'
    if (value.status === 401 || value.status === 403 || value.status === 409)
      return '请先登录微信并完成同步。'
    return userFacingErrorMessage(value, '在微信中搜索失败，请稍后重试。')
  }
  return userFacingErrorMessage(value, '在微信中搜索失败，请稍后重试。')
}

export default function ContactSearchDialog({
  open,
  accountId,
  onClose,
  onSelect,
  onStartId,
  onOpenRequests,
}: ContactSearchDialogProps) {
  const t = useT()
  const [visible, setVisible] = useState(open)
  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed')
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState('')
  const [syncFailed, setSyncFailed] = useState(false)
  const [discovery, setDiscovery] = useState<ContactDiscovery | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryError, setDiscoveryError] = useState('')
  const [requestOpen, setRequestOpen] = useState(false)
  const [requestMessage, setRequestMessage] = useState('')
  const [chatsOnly, setChatsOnly] = useState(false)
  const [hideMyPosts, setHideMyPosts] = useState(false)
  const [hideTheirPosts, setHideTheirPosts] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [sendError, setSendError] = useState('')

  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchTimerRef = useRef<number | null>(null)
  const requestTokenRef = useRef(0)
  const syncTokenRef = useRef(0)
  const discoveryTokenRef = useRef(0)
  const discoveringRef = useRef(false)
  const syncingRef = useRef(false)
  const loadingRef = useRef(false)
  const queryRef = useRef('')
  const accountIdRef = useRef(accountId)
  const openRef = useRef(open)
  const visibleRef = useRef(visible)
  const previousOpenRef = useRef(open)

  // Latest-value mirrors for callbacks that run after their render.
  accountIdRef.current = accountId
  openRef.current = open
  visibleRef.current = visible

  /** Drops a previous server result and any draft send form. */
  function resetDiscovery(): void {
    discoveryTokenRef.current += 1
    discoveringRef.current = false
    setDiscovery(null)
    setDiscovering(false)
    setDiscoveryError('')
    setRequestOpen(false)
    setRequestMessage('')
    setChatsOnly(false)
    setHideMyPosts(false)
    setHideTheirPosts(false)
    setSending(false)
    setSent(false)
    setSendError('')
  }

  function updateQuery(value: string): void {
    if (value !== queryRef.current)
      resetDiscovery()
    queryRef.current = value
    setQuery(value)
  }

  function updateLoading(value: boolean): void {
    loadingRef.current = value
    setLoading(value)
  }

  function updateSyncing(value: boolean): void {
    syncingRef.current = value
    setSyncing(value)
  }

  function focusSearchInput(): void {
    searchInputRef.current?.focus({ preventScroll: true })
  }

  async function loadContacts(): Promise<void> {
    const token = ++requestTokenRef.current
    updateLoading(true)
    setError('')
    try {
      const response = await wechatApi.listContacts(accountIdRef.current, queryRef.current.trim(), 30)
      if (token !== requestTokenRef.current)
        return
      setContacts(response.items ?? [])
    }
    catch (value) {
      if (token !== requestTokenRef.current)
        return
      setContacts([])
      setError(describeError(value))
    }
    finally {
      if (token === requestTokenRef.current)
        updateLoading(false)
    }
  }

  async function syncContacts(): Promise<void> {
    if (syncingRef.current || loadingRef.current)
      return
    const token = ++syncTokenRef.current
    updateSyncing(true)
    setSyncFailed(false)
    setSyncStatus('正在同步通讯录…')
    try {
      let operation = await wechatApi.syncContacts(accountIdRef.current)
      for (let attempt = 0; attempt < SYNC_POLL_LIMIT && !isTerminalOperation(operation.state); attempt++) {
        await sleep(SYNC_POLL_INTERVAL)
        if (token !== syncTokenRef.current)
          return
        operation = await wechatApi.getOperation(accountIdRef.current, operation.id)
      }
      if (token !== syncTokenRef.current)
        return
      if (!isTerminalOperation(operation.state)) {
        setSyncFailed(true)
        setSyncStatus('通讯录同步超时，请稍后重试。')
        return
      }
      if (operation.state === 'succeeded') {
        setSyncStatus('通讯录已同步')
        await loadContacts()
        return
      }
      setSyncFailed(true)
      setSyncStatus(describeOperationFailure(operation))
    }
    catch (value) {
      if (token !== syncTokenRef.current)
        return
      setSyncFailed(true)
      setSyncStatus(describeSyncError(value))
    }
    finally {
      if (token === syncTokenRef.current)
        updateSyncing(false)
    }
  }

  /** Asks WeChat to resolve the typed ID before a friend request is sent. */
  async function discover(): Promise<void> {
    const keyword = queryRef.current.trim()
    const account = accountIdRef.current
    if (!keyword || !account || discoveringRef.current)
      return
    const token = ++discoveryTokenRef.current
    discoveringRef.current = true
    setDiscovering(true)
    setDiscoveryError('')
    try {
      const result = await wechatApi.discoverContact(account, keyword)
      if (token !== discoveryTokenRef.current)
        return
      setDiscovery(result)
    }
    catch (value) {
      if (token !== discoveryTokenRef.current)
        return
      setDiscovery(null)
      setDiscoveryError(describeDiscoveryError(value))
    }
    finally {
      if (token === discoveryTokenRef.current) {
        discoveringRef.current = false
        setDiscovering(false)
      }
    }
  }

  async function sendRequest(): Promise<void> {
    const current = discovery
    const account = accountIdRef.current
    const message = requestMessage.trim()
    if (!account || !current || !message || sending)
      return
    const recipientRef = current.recipientRef
    if (!recipientRef) {
      setSendError('该结果没有好友申请凭证，请重新搜索。')
      return
    }
    setSending(true)
    setSendError('')
    const privacy: ContactPrivacySettings = chatsOnly
      ? { chatsOnly: true, hideMyPosts: false, hideTheirPosts: false }
      : { chatsOnly: false, hideMyPosts, hideTheirPosts }
    try {
      let operation = await wechatApi.sendContactRequest(account, {
        recipientRef,
        message,
        privacy,
      })
      for (let attempt = 0; attempt < SYNC_POLL_LIMIT && !isTerminalOperation(operation.state); attempt++) {
        await sleep(SYNC_POLL_INTERVAL)
        operation = await wechatApi.getOperation(account, operation.id)
      }
      if (!isTerminalOperation(operation.state))
        throw new WechatApiError('操作耗时较长，请稍后重试。', 0)
      if (operation.state !== 'succeeded')
        throw new WechatApiError(operationOutcomeMessage(operation.state), 0)
      setSent(true)
      setRequestOpen(false)
      await loadContacts()
    }
    catch (value) {
      setSendError(userFacingErrorMessage(value, '发送好友申请失败，请稍后重试。'))
    }
    finally {
      setSending(false)
    }
  }

  function scheduleSearch(delay = SEARCH_DEBOUNCE_MS): void {
    if (searchTimerRef.current !== null)
      window.clearTimeout(searchTimerRef.current)
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null
      void loadContacts()
    }, delay)
  }

  function handleSearchInput(event: ChangeEvent<HTMLInputElement>): void {
    updateQuery(event.target.value)
    scheduleSearch()
  }

  function choose(contact: Contact): void {
    onSelect(contact)
  }

  function startWithTypedId(): void {
    const normalized = query.trim()
    if (normalized)
      onStartId(normalized)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      // The greeting textarea keeps Enter for new lines.
      if ((event.target as HTMLElement).tagName === 'TEXTAREA')
        return
      event.preventDefault()
      if (contacts.length > 0)
        choose(contacts[0])
      else
        startWithTypedId()
    }
  }

  useLayoutEffect(() => {
    const previous = previousOpenRef.current
    previousOpenRef.current = open
    // Mirrors the Vue watcher, which did nothing on the initial render.
    if (previous === open)
      return

    const cleanups: Array<() => void> = []
    const nextFrame = (callback: () => void): void => {
      const id = window.requestAnimationFrame(callback)
      cleanups.push(() => window.cancelAnimationFrame(id))
    }
    const later = (ms: number, callback: () => void): void => {
      const id = window.setTimeout(callback, ms)
      cleanups.push(() => window.clearTimeout(id))
    }

    if (open) {
      setVisible(true)
      setPhase('entering')
      // Vue's <Transition> inserted the dialog with the entering classes and
      // dropped them one frame later; paint twice before fading in.
      nextFrame(() => nextFrame(() => setPhase('open')))
      // Vue focused the field again from the transition's after-enter hook.
      later(TRANSITION_MS, () => {
        if (openRef.current)
          focusSearchInput()
      })
    }
    else if (visibleRef.current) {
      setPhase('leaving')
      later(TRANSITION_MS, () => {
        setVisible(false)
        setPhase('closed')
      })
    }

    syncTokenRef.current += 1
    updateSyncing(false)
    if (!open) {
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
      requestTokenRef.current += 1
      syncTokenRef.current += 1
      discoveryTokenRef.current += 1
      return () => {
        for (const cleanup of cleanups)
          cleanup()
      }
    }

    updateQuery('')
    setContacts([])
    setError('')
    setSyncStatus('')
    setSyncFailed(false)
    resetDiscovery()
    // The field mounts after this effect; focus again on the next frame so the
    // click that opened the dialog cannot keep its own focus target.
    nextFrame(() => {
      if (openRef.current)
        focusSearchInput()
    })
    void loadContacts()

    return () => {
      for (const cleanup of cleanups)
        cleanup()
    }
  }, [open])

  useLayoutEffect(() => {
    if (visible && open)
      focusSearchInput()
  }, [visible, open])

  useEffect(() => {
    return () => {
      if (searchTimerRef.current !== null)
        window.clearTimeout(searchTimerRef.current)
      requestTokenRef.current += 1
      syncTokenRef.current += 1
      discoveryTokenRef.current += 1
    }
  }, [])

  const normalizedQuery = query.trim()

  if (!visible)
    return null

  const backdropClass = phase === 'entering'
    ? 'contact-backdrop contact-enter-from contact-enter-active'
    : phase === 'leaving'
      ? 'contact-backdrop contact-leave-active contact-leave-to'
      : 'contact-backdrop'

  const syncStatusClass = [
    'contact-sync-state',
    syncFailed ? 'is-error' : '',
    !syncFailed && !syncing ? 'is-success' : '',
  ].filter(Boolean).join(' ')

  return createPortal(
    <div className={backdropClass} onClick={onClose}>
      <section
        className="contact-dialog"
        onClick={(event) => { event.stopPropagation() }}
        onKeyDown={handleKeyDown}
      >
        <header className="contact-head">
          <div>
            <strong>{t('新建聊天')}</strong>
            <span>{t('搜索通讯录，或输入微信号直接开始')}</span>
          </div>
          <button type="button" className="contact-close" title={t('关闭')} onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>

        <div className="contact-search">
          <Icon name="search" size={15} className="contact-search-icon" />
          <input
            ref={searchInputRef}
            value={query}
            type="text"
            placeholder={t('搜索联系人或输入微信号')}
            spellCheck="false"
            autoFocus
            onChange={handleSearchInput}
            onKeyDown={handleKeyDown}
          />
          {loading && (
            <span className="contact-spinner">
              <LoadingDots />
            </span>
          )}
        </div>

        {error && <p className="contact-error">{t(error)}</p>}

        <p className="contact-source-note">{t('搜索结果来自已同步的通讯录，覆盖微信号、昵称、备注和备注名。')}</p>

        {normalizedQuery && (
          <section className="discovery">
            {!discovery && !discovering && !discoveryError && (
              <button type="button" className="discovery-trigger" onClick={() => void discover()}>
                <Icon name="search" size={13} />
                {t('在微信中搜索“{query}”', { query: normalizedQuery })}
              </button>
            )}
            {discovering && (
              <div className="discovery-status">
                <LoadingDots />
                {t('正在微信中搜索…')}
              </div>
            )}
            {discoveryError && <div className="contact-error">{t(discoveryError)}</div>}

            {discovery && (
              <>
                <div className="discovery-card">
                  <ThreadAvatar
                    accountId={accountId}
                    name={discovery.displayName}
                    username={discovery.recipientRef ?? discovery.contactId ?? discovery.displayName}
                    size={38}
                  />
                  <span className="contact-meta">
                    <span className="contact-name">{discovery.displayName}</span>
                    <span className="contact-sub">{t('微信搜索结果')}</span>
                  </span>
                  {discovery.contactId
                    ? (
                        <button type="button" className="contact-action" onClick={() => onStartId(discovery.contactId!)}>
                          {t('聊天')}
                        </button>
                      )
                    : discovery.request
                      ? (
                          discovery.request.direction === 'incoming' && onOpenRequests
                            ? (
                                <button type="button" className="contact-action" onClick={onOpenRequests}>
                                  {t('去处理')}
                                </button>
                              )
                            : <span className="discovery-chip">{t(requestStatus(discovery.request))}</span>
                        )
                      : sent
                        ? <span className="discovery-chip">{t('已发送申请')}</span>
                        : discovery.recipientRef
                          ? (
                              <button
                                type="button"
                                className="contact-action"
                                onClick={() => setRequestOpen(open => !open)}
                              >
                                {t('添加好友')}
                              </button>
                            )
                          : null}
                </div>

                {discovery.request?.direction === 'incoming' && (
                  <p className="discovery-note">{t('对方已经申请添加你，在“好友申请”里通过即可。')}</p>
                )}
                {discovery.request?.direction === 'outgoing' && (
                  <p className="discovery-note">{t('申请已发送，等待对方确认。')}</p>
                )}
                {sent && <p className="discovery-note">{t('好友申请已发送，等待对方确认。')}</p>}
                {!discovery.contactId && !discovery.request && !sent && !discovery.recipientRef && (
                  <p className="discovery-note">{t('该结果没有好友申请凭证，请重新搜索。')}</p>
                )}

                {requestOpen && discovery.recipientRef && !discovery.contactId && !discovery.request && (
                  <form
                    className="discovery-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void sendRequest()
                    }}
                  >
                    <textarea
                      value={requestMessage}
                      placeholder={t('填写验证申请，对方会看到这段话')}
                      maxLength={4096}
                      rows={3}
                      disabled={sending}
                      onChange={event => setRequestMessage(event.target.value)}
                    />
                    <div className="discovery-privacy">
                      <label className="contact-radio">
                        <input
                          type="radio"
                          name="discovery-privacy"
                          checked={!chatsOnly}
                          onChange={() => setChatsOnly(false)}
                        />
                        <span><strong>{t('全部可见')}</strong></span>
                      </label>
                      <label className="contact-radio">
                        <input
                          type="radio"
                          name="discovery-privacy"
                          checked={chatsOnly}
                          onChange={() => setChatsOnly(true)}
                        />
                        <span><strong>{t('仅聊天')}</strong></span>
                      </label>
                      {!chatsOnly && (
                        <div className="contact-switches">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={hideMyPosts}
                            className={`privacy-switch${hideMyPosts ? ' on' : ''}`}
                            onClick={() => setHideMyPosts(value => !value)}
                          >
                            <span>{t('不让对方看我的朋友圈')}</span>
                            <i />
                          </button>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={hideTheirPosts}
                            className={`privacy-switch${hideTheirPosts ? ' on' : ''}`}
                            onClick={() => setHideTheirPosts(value => !value)}
                          >
                            <span>{t('不看对方的朋友圈')}</span>
                            <i />
                          </button>
                        </div>
                      )}
                    </div>
                    {sendError && <div className="contact-error">{t(sendError)}</div>}
                    <div className="discovery-form-actions">
                      <button type="button" onClick={() => setRequestOpen(false)}>{t('取消')}</button>
                      <button type="submit" disabled={sending || !requestMessage.trim()}>
                        {t(sending ? '发送中…' : '发送申请')}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </section>
        )}

        <div className="contact-results scrollbar-thin">
          {contacts.map(contact => (
            <button
              key={contact.id}
              type="button"
              className="contact-item"
              onClick={() => { choose(contact) }}
            >
              <ThreadAvatar
                accountId={accountId}
                name={contactName(contact)}
                username={contact.username || contact.id}
                size={38}
              />
              <span className="contact-meta">
                <span className="contact-name">{contactName(contact)}</span>
                <span className="contact-sub">
                  {contact.username || contact.id}
                  {contact.alias && contact.alias !== contact.username ? ` · ${contact.alias}` : null}
                </span>
              </span>
              <span className="contact-action">{t('聊天')}</span>
            </button>
          ))}

          {!loading && contacts.length === 0 && (
            <div className="contact-empty">
              <span className="contact-empty-icon"><Icon name="users" size={22} /></span>
              <p>{normalizedQuery ? t('没有找到匹配的联系人') : t('通讯录还没有可搜索的联系人')}</p>
              <span>
                {normalizedQuery
                  ? t('可以直接用“{query}”作为微信号开始聊天。', { query: normalizedQuery })
                  : t('输入微信号或联系人 ID 也可以开始聊天。')}
              </span>
            </div>
          )}
        </div>

        <footer className="contact-foot">
          <div className="contact-foot-sync">
            <button
              type="button"
              className="contact-sync"
              disabled={syncing || loading}
              onClick={() => { void syncContacts() }}
            >
              {syncing ? <LoadingDots /> : <Icon name="refresh" size={13} />}
              <span>{t('同步通讯录')}</span>
            </button>
            {syncStatus && <span className={syncStatusClass}>{t(syncStatus)}</span>}
          </div>
          {normalizedQuery
            ? (
                <button
                  type="button"
                  className="contact-start-id"
                  onClick={startWithTypedId}
                >
                  {t('使用“{query}”开始聊天', { query: normalizedQuery })}
                </button>
              )
            : <span className="contact-hint">{t('Enter 选择第一个结果 · Esc 关闭')}</span>}
        </footer>
      </section>
    </div>,
    document.body,
  )
}
