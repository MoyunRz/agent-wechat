// Contact detail card: remark editing, relationship privacy and removal for one
// saved friend. Saves are automatic (a short pause after typing, or blur) and
// every write carries the version from the last profile read, so two edits
// cannot silently overwrite each other. The card stays open after a removal and
// reports the result, matching the desktop client's flow.

import { useCallback, useEffect, useRef, useState } from 'react'
import { wechatApi, WechatApiError } from '../api'
import { userFacingErrorMessage } from '../errors'
import { contactName } from '../format'
import { useT } from '../i18n/useT'
import type { Contact, ContactPrivacySettings } from '../types'
import { useStore } from '../store/hooks'
import Icon from './Icon'
import LoadingDots from './LoadingDots'
import ThreadAvatar from './ThreadAvatar'
import '../styles/components/contact-detail.css'

type Props = {
  contactId: string
  onClose: () => void
  /** Called after a saved change lands so the directory can be refreshed. */
  onChanged: () => void
}

const REMARK_DEBOUNCE_MS = 800
const PRIVACY_DEBOUNCE_MS = 300
const OPERATION_POLL_MS = 1500
const OPERATION_POLL_LIMIT = 80
const PENDING_POLL_MS = 2000
const PENDING_POLL_LIMIT = 5
const REMARK_MAX_BYTES = 256

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function isTerminalState(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired'
}

function privacyHint(code: string): string {
  switch (code) {
    case 'contact_privacy_unresolved':
      return '请先刷新联系人资料，再设置关系隐私。'
    case 'ordinary_contact_required':
      return '该联系人暂不支持设置关系隐私。'
    case 'profile_identity_unavailable':
      return '本地资料不可用，请重新登录后再试。'
    case 'contact_flags_unresolved':
      return '暂时无法读取该联系人的关系设置。'
    default:
      return '暂时无法读取该联系人的关系设置。'
  }
}

function samePrivacy(left: ContactPrivacySettings | null | undefined, right: ContactPrivacySettings): boolean {
  return Boolean(left)
    && left!.chatsOnly === right.chatsOnly
    && left!.hideMyPosts === right.hideMyPosts
    && left!.hideTheirPosts === right.hideTheirPosts
}

export default function ContactDetailCard({ contactId, onClose, onChanged }: Props) {
  const t = useT()
  const accountId = useStore(state => state.session.account?.id ?? '')
  const ownUsername = useStore(state => state.session.account?.ownUsername ?? '')
  const isSelf = Boolean(ownUsername && contactId === ownUsername)

  const [profile, setProfile] = useState<Contact | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [remark, setRemark] = useState('')
  const [status, setStatus] = useState('')
  const [statusFailed, setStatusFailed] = useState(false)
  const [savingRemark, setSavingRemark] = useState(false)
  const [savingPrivacy, setSavingPrivacy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removed, setRemoved] = useState(false)

  const loadTokenRef = useRef(0)
  const remarkTimerRef = useRef<number | null>(null)
  const privacyTimerRef = useRef<number | null>(null)
  const pendingTimerRef = useRef<number | null>(null)
  const savingRef = useRef(false)
  const profileRef = useRef<Contact | null>(null)
  const remarkRef = useRef('')
  const savedRemarkRef = useRef<string | null>(null)

  profileRef.current = profile
  remarkRef.current = remark

  const clearTimers = useCallback((): void => {
    for (const timer of [remarkTimerRef.current, privacyTimerRef.current, pendingTimerRef.current]) {
      if (timer !== null)
        window.clearTimeout(timer)
    }
    remarkTimerRef.current = null
    privacyTimerRef.current = null
    pendingTimerRef.current = null
  }, [])

  const loadProfile = useCallback(async (): Promise<Contact | null> => {
    const account = accountId
    if (!account)
      return null
    const token = ++loadTokenRef.current
    setLoading(true)
    try {
      const next = await wechatApi.getContact(account, contactId)
      if (token !== loadTokenRef.current)
        return null
      setProfile(next)
      savedRemarkRef.current = next.remark ?? null
      setRemark(next.remark ?? '')
      setError('')
      return next
    }
    catch (value) {
      if (token !== loadTokenRef.current)
        return null
      setError(userFacingErrorMessage(value, '读取联系人资料失败，请稍后重试。'))
      return null
    }
    finally {
      if (token === loadTokenRef.current)
        setLoading(false)
    }
  }, [accountId, contactId])

  useEffect(() => {
    void loadProfile()
    return () => {
      loadTokenRef.current += 1
      clearTimers()
    }
  }, [loadProfile, clearTimers])

  /** Waits out the daemon's operation; a timeout is reported as uncertain. */
  async function waitForOperation(operationId: string): Promise<string> {
    let operation = await wechatApi.getOperation(accountId, operationId)
    for (let attempt = 0; attempt < OPERATION_POLL_LIMIT && !isTerminalState(operation.state); attempt++) {
      await sleep(OPERATION_POLL_MS)
      operation = await wechatApi.getOperation(accountId, operationId)
    }
    return operation.state
  }

  function reportSaving(message: string): void {
    setStatus(message)
    setStatusFailed(false)
  }

  function reportFailure(message: string): void {
    setStatus(message)
    setStatusFailed(true)
  }

  /** A pending privacy write clears itself after the next contact sync. */
  function watchPrivacyPending(): void {
    let attempts = 0
    const poll = async (): Promise<void> => {
      if (attempts++ >= PENDING_POLL_LIMIT)
        return
      pendingTimerRef.current = window.setTimeout(() => {
        pendingTimerRef.current = null
        void loadProfile().then((next) => {
          if (next?.privacyPending)
            void poll()
        })
      }, PENDING_POLL_MS)
    }
    void poll()
  }

  async function saveRemark(value: string, options: { force?: boolean } = {}): Promise<void> {
    const current = profileRef.current
    if (!accountId || !current || savingRef.current || removed)
      return
    const next = value.trim()
    if (!options.force && next === (savedRemarkRef.current ?? ''))
      return
    if (new TextEncoder().encode(next).length > REMARK_MAX_BYTES) {
      reportFailure('备注最多 256 字节，请缩短后重试。')
      return
    }
    if (!current.privacyVersion) {
      reportFailure(privacyHint(current.privacyUnavailable ?? ''))
      return
    }
    savingRef.current = true
    setSavingRemark(true)
    reportSaving('正在保存备注…')
    try {
      const operation = await wechatApi.updateContact(accountId, contactId, {
        remark: next || null,
        expectedVersion: current.privacyVersion,
      })
      const state = await waitForOperation(operation.id)
      if (state !== 'succeeded')
        throw new WechatApiError('操作未成功，请稍后重试。', 0)
      savedRemarkRef.current = next
      reportSaving('备注已保存')
      await loadProfile()
      onChanged()
    }
    catch (value) {
      const message = value instanceof WechatApiError && value.code === 'stale_contact_privacy'
        ? '联系人资料已更新，请确认新内容后重试。'
        : userFacingErrorMessage(value, '保存备注失败，请稍后重试。')
      reportFailure(message)
      await loadProfile()
    }
    finally {
      savingRef.current = false
      setSavingRemark(false)
    }
  }

  async function savePrivacy(next: ContactPrivacySettings): Promise<void> {
    const current = profileRef.current
    if (!accountId || !current || savingRef.current || removed)
      return
    if (samePrivacy(current.privacy, next))
      return
    if (!current.privacyVersion) {
      reportFailure(privacyHint(current.privacyUnavailable ?? ''))
      return
    }
    savingRef.current = true
    setSavingPrivacy(true)
    reportSaving('正在保存关系隐私…')
    try {
      // A rejected version means another device changed the relationship; one
      // fresh read and retry is enough to keep the user's choice.
      for (let attempt = 0; attempt < 2; attempt++) {
        const version = profileRef.current?.privacyVersion
        if (!version)
          throw new WechatApiError('contact_privacy_unresolved', 409)
        const operation = await wechatApi.updateContact(accountId, contactId, {
          privacy: next,
          expectedVersion: version,
        })
        const state = await waitForOperation(operation.id)
        if (state === 'succeeded') {
          reportSaving('关系隐私已保存，正在等待同步…')
          const refreshed = await loadProfile()
          onChanged()
          if (refreshed?.privacyPending)
            watchPrivacyPending()
          return
        }
        if (attempt === 0) {
          await loadProfile()
          continue
        }
        throw new WechatApiError('操作未成功，请稍后重试。', 0)
      }
    }
    catch (value) {
      const message = value instanceof WechatApiError && value.code === 'stale_contact_privacy'
        ? '联系人资料已更新，请确认新设置后重试。'
        : userFacingErrorMessage(value, '保存关系隐私失败，请稍后重试。')
      reportFailure(message)
      await loadProfile()
    }
    finally {
      savingRef.current = false
      setSavingPrivacy(false)
    }
  }

  function scheduleRemarkSave(): void {
    if (remarkTimerRef.current !== null)
      window.clearTimeout(remarkTimerRef.current)
    remarkTimerRef.current = window.setTimeout(() => {
      remarkTimerRef.current = null
      void saveRemark(remarkRef.current)
    }, REMARK_DEBOUNCE_MS)
  }

  function flushRemark(): void {
    if (remarkTimerRef.current === null)
      return
    window.clearTimeout(remarkTimerRef.current)
    remarkTimerRef.current = null
    void saveRemark(remarkRef.current)
  }

  function changeRemark(value: string): void {
    setRemark(value)
    scheduleRemarkSave()
  }

  function changePrivacy(patch: Partial<ContactPrivacySettings>): void {
    const current = profileRef.current?.privacy ?? { chatsOnly: false, hideMyPosts: false, hideTheirPosts: false }
    const next = { ...current, ...patch }
    setProfile(previous => previous ? { ...previous, privacy: next } : previous)
    if (privacyTimerRef.current !== null)
      window.clearTimeout(privacyTimerRef.current)
    privacyTimerRef.current = window.setTimeout(() => {
      privacyTimerRef.current = null
      void savePrivacy(next)
    }, PRIVACY_DEBOUNCE_MS)
  }

  async function removeContact(): Promise<void> {
    if (!accountId || savingRef.current || removed)
      return
    savingRef.current = true
    setConfirmRemove(false)
    reportSaving('正在删除联系人…')
    try {
      const operation = await wechatApi.removeContact(accountId, contactId)
      const state = await waitForOperation(operation.id)
      if (state !== 'succeeded')
        throw new WechatApiError('操作未成功，请稍后重试。', 0)
      setRemoved(true)
      reportSaving('已删除联系人。聊天记录会保留。')
      onChanged()
    }
    catch (value) {
      reportFailure(userFacingErrorMessage(value, '删除联系人失败，请稍后重试。'))
    }
    finally {
      savingRef.current = false
    }
  }

  const name = profile ? contactName(profile) : contactId
  const privacy = profile?.privacy ?? { chatsOnly: false, hideMyPosts: false, hideTheirPosts: false }
  const privacyEditable = Boolean(profile?.privacyVersion) && !profile?.privacyUnavailable && !removed
  const busy = savingRemark || savingPrivacy || removed
  const remarkChanged = remark.trim() !== (savedRemarkRef.current ?? '')

  return (
    <div
      className="request-overlay contact-card-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          flushRemark()
          onClose()
        }
      }}
    >
      <div className="request-detail contact-card" role="dialog" aria-modal="true" aria-label={t('联系人资料')}>
        <button
          type="button"
          className="detail-close"
          title={t('关闭')}
          onClick={() => {
            flushRemark()
            onClose()
          }}
        >
          <Icon name="close" size={14} />
        </button>

        <div className="detail-head contact-card-head">
          <ThreadAvatar accountId={accountId} name={name} username={profile?.username || contactId} size={64} />
          <div className="detail-id">
            <span className="detail-name">{name}</span>
            <span className="detail-source">{profile?.username || contactId}</span>
          </div>
        </div>

        {error && (
          <div className="contact-card-error">
            <Icon name="alert" size={13} />
            <span>{t(error)}</span>
            <button type="button" onClick={() => void loadProfile()}>{t('重试')}</button>
          </div>
        )}

        {isSelf && (
          <p className="contact-card-hint">{t('这是你自己的账号，不能在这里修改资料。')}</p>
        )}
        {!isSelf && profile && !profile.privacyVersion && !profile.privacyUnavailable && profile.localType == null && (
          <p className="contact-card-hint">{t('该联系人不是普通好友，或资料尚未同步，暂时不能修改备注和关系隐私。')}</p>
        )}

        {loading && !profile
          ? <div className="contact-card-loading"><LoadingDots />{t('正在读取联系人资料…')}</div>
          : profile
            ? (
              <>
                <div className="contact-card-rows">
                  <div className="detail-meta">
                    <span className="detail-label">{t('昵称')}</span>
                    <span>{profile.nickname || '—'}</span>
                  </div>
                  {profile.alias && (
                    <div className="detail-meta">
                      <span className="detail-label">{t('别名')}</span>
                      <span>{profile.alias}</span>
                    </div>
                  )}
                </div>

                <label className="contact-field">
                  <span className="detail-label">{t('备注')}</span>
                  <input
                    value={remark}
                    type="text"
                    maxLength={REMARK_MAX_BYTES}
                    placeholder={t('添加备注')}
                    disabled={busy || !profile.privacyVersion}
                    onChange={event => changeRemark(event.target.value)}
                    onBlur={flushRemark}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        flushRemark()
                      }
                    }}
                  />
                  <span className="contact-field-hint">
                    {profile.remarkPending
                      ? t('正在等待微信保存备注…')
                      : remarkChanged
                        ? t('停止输入后自动保存')
                        : t('备注只有你自己能看到')}
                  </span>
                </label>

                <fieldset className="contact-privacy" disabled={!privacyEditable || savingPrivacy}>
                  <legend className="detail-label">{t('关系隐私')}</legend>
                  {!privacyEditable && profile.privacyUnavailable && (
                    <p className="contact-privacy-hint">{t(privacyHint(profile.privacyUnavailable))}</p>
                  )}
                  <label className="contact-radio">
                    <input
                      type="radio"
                      name="contact-privacy-mode"
                      checked={!privacy.chatsOnly}
                      onChange={() => changePrivacy({ chatsOnly: false })}
                    />
                    <span>
                      <strong>{t('全部可见')}</strong>
                      <small>{t('可以聊天，也能看到彼此的朋友圈')}</small>
                    </span>
                  </label>
                  <label className="contact-radio">
                    <input
                      type="radio"
                      name="contact-privacy-mode"
                      checked={privacy.chatsOnly}
                      onChange={() => changePrivacy({ chatsOnly: true })}
                    />
                    <span>
                      <strong>{t('仅聊天')}</strong>
                      <small>{t('互相看不到朋友圈和微信运动')}</small>
                    </span>
                  </label>

                  {!privacy.chatsOnly && (
                    <div className="contact-switches">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={privacy.hideMyPosts}
                        className={`privacy-switch${privacy.hideMyPosts ? ' on' : ''}`}
                        onClick={() => changePrivacy({ hideMyPosts: !privacy.hideMyPosts })}
                      >
                        <span>{t('不让对方看我的朋友圈')}</span>
                        <i />
                      </button>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={privacy.hideTheirPosts}
                        className={`privacy-switch${privacy.hideTheirPosts ? ' on' : ''}`}
                        onClick={() => changePrivacy({ hideTheirPosts: !privacy.hideTheirPosts })}
                      >
                        <span>{t('不看对方的朋友圈')}</span>
                        <i />
                      </button>
                    </div>
                  )}
                  {profile.privacyPending && (
                    <p className="contact-privacy-hint">{t('正在等待已保存的隐私设置同步…')}</p>
                  )}
                </fieldset>

                {status && (
                  <div className={`contact-card-status${statusFailed ? ' error' : ''}`}>{t(status)}</div>
                )}

                {!isSelf && (
                  <div className="contact-danger">
                    {confirmRemove
                      ? (
                        <>
                          <p>{t('将此人从你的联系人中删除。聊天记录会保留。')}</p>
                          <div className="contact-danger-actions">
                            <button type="button" onClick={() => setConfirmRemove(false)}>{t('取消')}</button>
                            <button type="button" className="danger" onClick={() => void removeContact()}>
                              {t('删除联系人')}
                            </button>
                          </div>
                        </>
                      )
                      : (
                        <button
                          type="button"
                          className="contact-remove"
                          disabled={removed}
                          onClick={() => setConfirmRemove(true)}
                        >
                          <Icon name="trash" size={13} />
                          {t('删除联系人')}
                        </button>
                      )}
                  </div>
                )}
              </>
            )
            : null}
      </div>
    </div>
  )
}
