// Contacts sidebar: the directory grouped by category, a local search over the
// loaded directory, the manual contact-sync job and the pending "new friends"
// requests. The Vue component received the account and a preloaded directory
// through props; here the directory lives in the threads slice, so the shell
// renders this component without props.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { wechatApi, WechatApiError } from '../api'
import { userFacingErrorMessage } from '../errors'
import { contactName } from '../format'
import { useT } from '../i18n/useT'
import type { Contact, ContactRequest, Operation } from '../types'
import {
  loadContactDirectory,
  refreshContactAuthoritative,
  selectBusinessUsernames,
  startChatWithContact,
  startChatWithId,
} from '../store/actions'
import { useStore } from '../store/hooks'
import { registerContactsPanelView } from '../store/viewRefs'
import Icon from './Icon'
import ThreadAvatar from './ThreadAvatar'
import '../styles/components/contacts.css'

const SYNC_POLL_INTERVAL = 1500
const SYNC_POLL_LIMIT = 80
const SYNC_STATUS_CLEAR_DELAY = 2500
// The pending "new friends" list is refreshed from the local profile while the
// panel is open, as the Vue component did.
const FRIEND_REQUEST_POLL_INTERVAL = 20_000

// The upstream contact database also holds group members, official accounts and
// WeCom entries; these categories are never shown as personal contacts.
const NON_PERSONAL_CATEGORIES = new Set(['system', 'business', 'openim', 'openimCustomerService', 'group'])

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5]

interface ContactGroup {
  key: string
  label: string
  items: Contact[]
}

interface DisplayRow {
  key: string
  contact?: Contact
  nested?: boolean
  group?: { key: string, label: string, count: number }
}

function isTerminalState(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

/**
 * Row name of a contact. WeCom customer-service (@openim) profiles are often
 * missing, with the nickname empty or replaced by the raw id; fall back to a
 * readable label instead of exposing a numeric id.
 */
function openimContactName(contact: Contact): string {
  const peer = contact.username || contact.id || ''
  if (!peer.endsWith('@openim'))
    return contactName(contact)
  const name = contact.remark?.trim()
    || contact.nickname?.trim()
    || contact.displayName?.trim()
    || ''
  if (!name || name === peer)
    return '企业微信客服'
  return name
}

/** Counts per displayed name: one WeCom app often has several seats sharing a
 *  nickname while being different accounts. */
function openimNameCountsFor(contacts: Contact[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const contact of contacts) {
    const name = openimContactName(contact)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

/** Same-nickname WeCom seats are told apart by the last four id digits. */
function contactDisplayName(contact: Contact, counts: Map<string, number>): string {
  const name = openimContactName(contact)
  const peer = contact.username || contact.id || ''
  if (peer.endsWith('@openim') && (counts.get(name) ?? 0) > 1) {
    const digits = peer.replace(/\D/g, '')
    if (digits.length >= 4)
      return `${name} ·${digits.slice(-4)}`
  }
  return name
}

/** Sort key matches the displayed name; Chinese names sort by pinyin. */
function byName(left: Contact, right: Contact): number {
  return openimContactName(left).localeCompare(openimContactName(right), 'zh-Hans-CN')
}

/** One row matches when any of its visible or searchable fields contains the
 *  keyword (case-insensitive). */
function contactMatches(
  contact: Contact,
  keyword: string,
  counts: Map<string, number>,
  knownNames: Map<string, string>,
): boolean {
  const peer = (contact.username || contact.id || '').trim()
  const fields = [
    contactDisplayName(contact, counts),
    knownNames.get(peer),
    contact.displayName,
    contact.nickname,
    contact.remark,
    contact.alias,
    contact.username,
    contact.id,
  ]
  return fields.some(field => (field ?? '').trim().toLowerCase().includes(keyword))
}

function requestName(item: ContactRequest): string {
  return item.displayName?.trim() || item.peerId || item.id
}

function formatRequestTime(value: number | null | undefined): string {
  if (!value)
    return '未知'
  const time = new Date(value * 1000)
  if (Number.isNaN(time.getTime()))
    return '未知'
  return time.toLocaleString('zh-CN', { hour12: false })
}

/** Why a request row cannot be accepted right now. */
function requestStatus(item: ContactRequest): string {
  if (item.actionable)
    return '申请可处理'
  if (item.isContact || item.state === 'contact')
    return '你们已经是好友了'
  if (item.state === 'request_sent')
    return '等待对方确认'
  return '申请已处理'
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

export default function ContactsPanel() {
  const t = useT()
  const directoryContacts = useStore(state => state.threads.directoryContacts)
  const directoryReady = useStore(state => state.threads.directoryReady)
  const contactNames = useStore(state => state.threads.contactNames)
  const businessUsernames = useStore(selectBusinessUsernames)
  const accountId = useStore(state => state.session.account?.id ?? '')
  const authenticated = useStore(state => state.session.account?.authenticated ?? false)

  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [directoryError, setDirectoryError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState('')
  const [syncFailed, setSyncFailed] = useState(false)
  const [friendRequests, setFriendRequests] = useState<ContactRequest[]>([])
  const [accepting, setAccepting] = useState<Record<string, boolean>>({})
  const [requestError, setRequestError] = useState('')
  const [detailRequest, setDetailRequest] = useState<ContactRequest | null>(null)
  // Contact folds open by default; the other categories start collapsed, as in
  // the Linux client.
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    personal: true,
    official: false,
    service: false,
    wecom: false,
    system: false,
  })

  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const friendRequestTimerRef = useRef<number | null>(null)
  const syncClearTimerRef = useRef<number | null>(null)
  const directoryTokenRef = useRef(0)
  const syncTokenRef = useRef(0)
  const loadingRef = useRef(true)
  const syncingRef = useRef(false)
  const syncStatusRef = useRef('')
  const acceptingRef = useRef<Record<string, boolean>>({})
  const accountIdRef = useRef(accountId)

  // Latest-value mirrors for callbacks that run after their render.
  accountIdRef.current = accountId

  function updateLoading(value: boolean): void {
    loadingRef.current = value
    setLoading(value)
  }

  function updateSyncing(value: boolean): void {
    syncingRef.current = value
    setSyncing(value)
  }

  function updateSyncStatus(value: string): void {
    syncStatusRef.current = value
    setSyncStatus(value)
  }

  function patchAccepting(id: string, value: boolean): void {
    const next = { ...acceptingRef.current, [id]: value }
    acceptingRef.current = next
    setAccepting(next)
  }

  /** Loads the shared directory; failures leave directoryReady false and the
   *  banner below reports them. */
  const loadDirectory = useCallback(async (force = false): Promise<void> => {
    const token = ++directoryTokenRef.current
    updateLoading(true)
    try {
      await loadContactDirectory(force)
    }
    catch (value) {
      if (token === directoryTokenRef.current)
        setDirectoryError(userFacingErrorMessage(value, '读取通讯录失败，请稍后重试。'))
    }
    finally {
      if (token === directoryTokenRef.current)
        updateLoading(false)
    }
  }, [])

  /** Reads incoming request conversations from the daemon's canonical rows.
   *  A hub without the route leaves the section empty. */
  const loadFriendRequests = useCallback(async (): Promise<void> => {
    const account = accountIdRef.current
    if (!account)
      return
    try {
      const page = await wechatApi.listContactRequests(account, { direction: 'incoming', limit: 50 })
      setFriendRequests(page.items ?? [])
      setRequestError('')
    }
    catch {
      setFriendRequests([])
    }
  }, [])

  useEffect(() => {
    // The view registry alias writes the same field the action layer reads.
    registerContactsPanelView({
      focusSearch: () => searchInputRef.current?.focus(),
    })
    return () => registerContactsPanelView(null)
  }, [])

  useEffect(() => {
    void loadDirectory()
    void loadFriendRequests()
    friendRequestTimerRef.current = window.setInterval(() => {
      void loadFriendRequests()
    }, FRIEND_REQUEST_POLL_INTERVAL)
    return () => {
      if (friendRequestTimerRef.current !== null) {
        window.clearInterval(friendRequestTimerRef.current)
        friendRequestTimerRef.current = null
      }
      if (syncClearTimerRef.current !== null) {
        window.clearTimeout(syncClearTimerRef.current)
        syncClearTimerRef.current = null
      }
      directoryTokenRef.current += 1
      syncTokenRef.current += 1
    }
  }, [loadDirectory, loadFriendRequests])

  // The directory action reports a failure only by leaving the flag unset, so
  // the banner follows the settled loading state instead of an exception.
  useEffect(() => {
    if (loading)
      return
    if (directoryReady) {
      setDirectoryError('')
      return
    }
    setDirectoryError(authenticated ? '读取通讯录失败，请稍后重试。' : '请先登录微信并完成同步。')
  }, [loading, directoryReady, authenticated])

  const normalizedQuery = query.trim()
  const openimNameCounts = useMemo(() => openimNameCountsFor(directoryContacts), [directoryContacts])

  /**
   * Personal contacts. Strict mode shows only rows the server confirmed via
   * localType; when the profile has no confirmed rows at all (the daemon's
   * ModContact projection did not write the official local_type bit) it falls
   * back to every personal row. Groups and official/WeCom/system accounts stay
   * excluded either way.
   */
  const personalContacts = useMemo(() => {
    const personal = directoryContacts.filter((contact) => {
      const category = contact.classification?.category ?? 'unknown'
      if (NON_PERSONAL_CATEGORIES.has(category))
        return false
      // Brand service accounts are classified by the directory; keep them out
      // of the personal group even when a cached row lost its category.
      if (contact.username && businessUsernames.has(contact.username))
        return false
      return !(contact.username ?? '').endsWith('@chatroom')
    })
    const confirmed = personal.filter(contact => contact.localType != null)
    return confirmed.length > 0 ? confirmed : personal
  }, [directoryContacts, businessUsernames])

  /**
   * Official accounts: gh_ rows; a subscription account is the default when the
   * business kind is missing.
   */
  const officialContacts = useMemo(() => directoryContacts.filter((contact) => {
    if ((contact.username ?? '').startsWith('gh_'))
      return (contact.classification?.businessKind ?? 'official_account') === 'official_account'
    return false
  }), [directoryContacts])

  /** Service accounts: gh_ rows without a business kind or marked as service,
   *  plus wxid customer-service accounts (Meituan and similar). */
  const serviceContacts = useMemo(() => directoryContacts.filter((contact) => {
    const classification = contact.classification
    if (classification?.category !== 'business')
      return false
    if ((contact.username ?? '').startsWith('gh_')) {
      return classification.businessKind == null
        || classification.businessKind === 'service_account'
    }
    return classification.businessKind === 'service_account'
  }), [directoryContacts])

  /**
   * WeCom contacts: only rows confirmed by the server-side contact sync.
   * @openim seats are usually one-way rows written by group or mini-program
   * traffic (no localType) and never added as friends, so an unconfirmed group
   * is hidden entirely.
   */
  const wecomContacts = useMemo(() => directoryContacts.filter(contact =>
    ['openim', 'openimCustomerService'].includes(contact.classification?.category ?? '')
    || (contact.username ?? '').endsWith('@openim'))
    .filter(contact => contact.localType != null), [directoryContacts])

  const systemContacts = useMemo(
    () => directoryContacts.filter(contact => contact.classification?.category === 'system'),
    [directoryContacts],
  )

  const contactGroups = useMemo<ContactGroup[]>(() => {
    const groups: ContactGroup[] = []
    const push = (key: string, label: string, items: Contact[]): void => {
      if (items.length > 0)
        groups.push({ key, label, items: [...items].sort(byName) })
    }
    push('personal', '联系人', personalContacts)
    push('official', '公众号', officialContacts)
    push('service', '服务号', serviceContacts)
    push('wecom', '企业微信联系人', wecomContacts)
    push('system', '系统账号', systemContacts)
    return groups
  }, [personalContacts, officialContacts, serviceContacts, wecomContacts, systemContacts])

  /** The directory is loaded in full, so search filters it locally instead of
   *  issuing one request per keystroke. */
  const searchResults = useMemo(() => {
    const keyword = normalizedQuery.toLowerCase()
    if (!keyword)
      return []
    return directoryContacts
      .filter(contact => contactMatches(contact, keyword, openimNameCounts, contactNames))
      .sort(byName)
  }, [directoryContacts, normalizedQuery, openimNameCounts, contactNames])

  function isGroupExpanded(key: string): boolean {
    return expandedGroups[key] ?? false
  }

  function toggleGroup(key: string): void {
    setExpandedGroups(previous => ({ ...previous, [key]: !(previous[key] ?? false) }))
  }

  const displayRows = useMemo<DisplayRow[]>(() => {
    if (normalizedQuery)
      return searchResults.map(contact => ({ key: contact.id, contact }))
    const rows: DisplayRow[] = []
    for (const group of contactGroups) {
      rows.push({ key: `group:${group.key}`, group: { key: group.key, label: group.label, count: group.items.length } })
      if (expandedGroups[group.key] ?? false) {
        for (const contact of group.items)
          rows.push({ key: contact.id, contact, nested: true })
      }
    }
    return rows
  }, [normalizedQuery, searchResults, contactGroups, expandedGroups])

  function openDetail(item: ContactRequest): void {
    setRequestError('')
    setDetailRequest(item)
  }

  function closeDetail(): void {
    setDetailRequest(null)
  }

  function acceptDisabled(item: ContactRequest): boolean {
    return acceptingRef.current[item.id] === true || !item.actionable
  }

  /** Accepts the inspected request version through the verified contact-request
   *  path, or deletes the local conversation when the owner ignores it. */
  async function actOnRequest(item: ContactRequest, action: 'accept' | 'delete'): Promise<void> {
    const account = accountIdRef.current
    if (!account || acceptingRef.current[item.id])
      return
    patchAccepting(item.id, true)
    setRequestError('')
    const failing = action === 'accept' ? '通过好友申请失败，请稍后重试。' : '删除申请记录失败，请稍后重试。'
    try {
      let operation = action === 'accept'
        ? await wechatApi.acceptContactRequest(account, item.id, item.version)
        : await wechatApi.deleteContactRequest(account, item.id, item.version)
      for (let attempt = 0; attempt < SYNC_POLL_LIMIT && !isTerminalState(operation.state); attempt++) {
        await sleep(SYNC_POLL_INTERVAL)
        operation = await wechatApi.getOperation(account, operation.id)
      }
      if (!isTerminalState(operation.state))
        throw new WechatApiError('操作耗时较长，请稍后重试。', 0)
      if (operation.state !== 'succeeded')
        throw new WechatApiError('操作未成功，请稍后重试。', 0)
      setDetailRequest(null)
      await Promise.all([loadDirectory(true), loadFriendRequests()])
    }
    catch (value) {
      setRequestError(userFacingErrorMessage(value, failing))
    }
    finally {
      patchAccepting(item.id, false)
    }
  }

  async function syncContacts(): Promise<void> {
    const account = accountIdRef.current
    if (!account || syncingRef.current || loadingRef.current)
      return
    const token = ++syncTokenRef.current
    updateSyncing(true)
    setSyncFailed(false)
    updateSyncStatus('正在同步通讯录…')
    try {
      let operation = await wechatApi.syncContacts(account)
      for (let attempt = 0; attempt < SYNC_POLL_LIMIT && !isTerminalState(operation.state); attempt++) {
        await sleep(SYNC_POLL_INTERVAL)
        if (token !== syncTokenRef.current)
          return
        operation = await wechatApi.getOperation(account, operation.id)
      }
      if (token !== syncTokenRef.current)
        return
      if (!isTerminalState(operation.state)) {
        setSyncFailed(true)
        updateSyncStatus('通讯录同步耗时较长，请稍后重新同步。')
        return
      }
      if (operation.state !== 'succeeded') {
        setSyncFailed(true)
        updateSyncStatus(describeOperationFailure(operation))
        return
      }
      await loadDirectory(true)
      void loadFriendRequests()
      updateSyncStatus('通讯录同步完成')
      syncClearTimerRef.current = window.setTimeout(() => {
        syncClearTimerRef.current = null
        if (syncStatusRef.current === '通讯录同步完成')
          updateSyncStatus('')
      }, SYNC_STATUS_CLEAR_DELAY)
    }
    catch (value) {
      if (token !== syncTokenRef.current)
        return
      setSyncFailed(true)
      updateSyncStatus(describeSyncError(value))
    }
    finally {
      if (token === syncTokenRef.current)
        updateSyncing(false)
    }
  }

  function handleQueryChange(event: ChangeEvent<HTMLInputElement>): void {
    setQuery(event.target.value)
  }

  function clearQuery(): void {
    setQuery('')
  }

  function startWithQuery(): void {
    const id = normalizedQuery
    if (id)
      startChatWithId(id)
  }

  /** Opens the conversation and, for direct friends, refreshes the
   *  authoritative profile so remarks reach the directory. */
  function startWithContact(contact: Contact): void {
    startChatWithContact(contact)
    const peer = (contact.username || contact.id).trim()
    if (peer && !peer.startsWith('gh_') && !peer.endsWith('@openim'))
      void refreshContactAuthoritative(peer)
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter')
      startWithQuery()
  }

  return (
    <aside className="contacts-panel">
      <header className="contacts-header">
        <div className="contacts-title-row">
          <div className="contacts-title">
            <h2>{t('通讯录')}</h2>
            <span className="contact-count">{personalContacts.length}</span>
          </div>
          <div className="header-actions">
            <button
              className="icon-button"
              type="button"
              title={t('同步通讯录')}
              disabled={syncing || loading}
              onClick={() => void syncContacts()}
            >
              <Icon name="refresh" size={16} className={syncing ? 'spin' : undefined} />
            </button>
          </div>
        </div>
      </header>

      <div className="search-wrap">
        <Icon name="search" size={15} className="search-icon" />
        <input
          ref={searchInputRef}
          value={query}
          type="text"
          placeholder={t('搜索联系人')}
          spellCheck={false}
          onChange={handleQueryChange}
          onKeyDown={handleSearchKeyDown}
        />
        {query
          ? (
            <button className="clear-button" type="button" title={t('清空搜索')} onClick={clearQuery}>
              <Icon name="close" size={12} />
            </button>
          )
          : null}
      </div>

      {syncStatus
        ? <div className={`contacts-status${syncFailed ? ' error' : ''}`}>{t(syncStatus)}</div>
        : null}
      {directoryError
        ? (
          <div className="contacts-status error">
            {t(directoryError)}
            <button type="button" onClick={() => void loadDirectory(true)}>{t('重试')}</button>
          </div>
        )
        : null}

      <div className="contacts-scroll scrollbar-thin">
        {friendRequests.length > 0 && (
          <section className="friend-requests">
            <h3 className="friend-requests-title">
              {t('新的朋友')}
              <span className="friend-requests-count">{friendRequests.length}</span>
            </h3>
            {requestError && <div className="contacts-status error">{t(requestError)}</div>}
            {friendRequests.map(item => (
              <div key={item.id} className="request-row">
                <button
                  type="button"
                  className="request-open"
                  title={t('查看申请详情')}
                  onClick={() => openDetail(item)}
                >
                  <ThreadAvatar
                    accountId={accountId}
                    name={requestName(item)}
                    username={item.peerId}
                    size={40}
                  />
                  <span className="request-main">
                    <span className="request-name">{requestName(item)}</span>
                    <span className="request-sub">{t(item.message || '请求添加你为朋友')}</span>
                  </span>
                </button>
                <span className="request-actions">
                  <button
                    type="button"
                    className="request-accept"
                    onClick={() => openDetail(item)}
                  >
                    {t(item.actionable ? '查看' : requestStatus(item))}
                  </button>
                </span>
              </div>
            ))}
          </section>
        )}

        {loading && directoryContacts.length === 0
          ? (
            <div className="contacts-skeletons">
              {SKELETON_ROWS.map(index => <span key={index} className="contact-skeleton" />)}
            </div>
          )
          : displayRows.length > 0
            ? displayRows.map((row) => {
              if (row.group) {
                const group = row.group
                return (
                  <button
                    key={row.key}
                    type="button"
                    className="group-header"
                    onClick={() => toggleGroup(group.key)}
                  >
                    <Icon
                      name="chevron-down"
                      size={14}
                      className={`group-chevron${isGroupExpanded(group.key) ? ' open' : ''}`}
                    />
                    <span className="group-label">{t(group.label)}</span>
                    <span className="group-count">{group.count}</span>
                  </button>
                )
              }

              const contact = row.contact
              if (!contact)
                return null
              return (
                <button
                  key={row.key}
                  type="button"
                  className={`contact-row${row.nested ? ' nested' : ''}`}
                  onClick={() => startWithContact(contact)}
                >
                  <ThreadAvatar
                    accountId={accountId}
                    name={contactDisplayName(contact, openimNameCounts)}
                    username={contact.username || contact.id}
                    size={40}
                  />
                  <span className="contact-main">
                    <span className="contact-name">{t(contactDisplayName(contact, openimNameCounts))}</span>
                    {contact.alias ? <span className="contact-sub">{contact.alias}</span> : null}
                  </span>
                  <span className="contact-action">{t('聊天')}</span>
                </button>
              )
            })
            : (
              <div className="contacts-empty">
                <span className="empty-icon"><Icon name="contacts" size={24} /></span>
                <p>{t(normalizedQuery ? '没有找到匹配的联系人' : '通讯录还没有联系人')}</p>
                <span>
                  {t(normalizedQuery
                    ? '按 Enter 或点击下方按钮，用该微信号开始聊天。'
                    : '同步通讯录后，就能在这里按昵称、备注或微信号查找联系人。')}
                </span>
                {!normalizedQuery && (
                  <button
                    type="button"
                    className="sync-button"
                    disabled={syncing}
                    onClick={() => void syncContacts()}
                  >
                    <Icon name="refresh" size={14} className={syncing ? 'spin' : undefined} />
                    {t(syncing ? '同步中' : '同步通讯录')}
                  </button>
                )}
              </div>
            )}
      </div>

      {normalizedQuery && (
        <footer className="contacts-footer">
          <button type="button" className="start-id-button" onClick={startWithQuery}>
            <Icon name="message" size={14} />
            {t('用「{query}」开始聊天', { query: normalizedQuery })}
          </button>
        </footer>
      )}

      {detailRequest && (
        <div
          className="request-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget)
              closeDetail()
          }}
        >
          <div className="request-detail" role="dialog" aria-modal="true">
            <button type="button" className="detail-close" title={t('关闭')} onClick={closeDetail}>
              <Icon name="close" size={14} />
            </button>
            <div className="detail-head">
              <ThreadAvatar
                accountId={accountId}
                name={requestName(detailRequest)}
                username={detailRequest.peerId}
                size={72}
              />
              <div className="detail-id">
                <span className="detail-name">{requestName(detailRequest)}</span>
                <span className="detail-source">{detailRequest.peerId}</span>
              </div>
            </div>
            <div className="detail-body">
              {detailRequest.message && (
                <div className="detail-greeting">
                  <span className="detail-label">{t('申请消息')}</span>
                  <p>{detailRequest.message}</p>
                </div>
              )}
              <div className="detail-meta">
                <span className="detail-label">{t('申请时间')}</span>
                <span>{t(formatRequestTime(detailRequest.updatedAt))}</span>
              </div>
              <div className={`detail-status ${detailRequest.actionable ? 'ready' : 'blocked'}`}>
                {t(requestStatus(detailRequest))}
              </div>
              {requestError && <div className="detail-status blocked">{t(requestError)}</div>}
            </div>
            <div className="detail-actions">
              <button
                type="button"
                className="detail-decline"
                disabled={accepting[detailRequest.id] === true}
                title={t('只删除本地申请记录，不会通知对方')}
                onClick={() => void actOnRequest(detailRequest, 'delete')}
              >
                {t(accepting[detailRequest.id] ? '处理中' : '删除')}
              </button>
              <button
                type="button"
                className="request-accept"
                disabled={acceptDisabled(detailRequest)}
                onClick={() => void actOnRequest(detailRequest, 'accept')}
              >
                {t(accepting[detailRequest.id] ? '处理中' : '同意')}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
