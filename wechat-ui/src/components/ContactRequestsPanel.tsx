// Friend-request inbox: received and sent request conversations, with server
// search, paging, history and the verified accept/delete actions. The contacts
// sidebar keeps its short "new friends" section; this view is the full inbox.

import { useCallback, useEffect, useRef, useState } from 'react'
import { wechatApi, WechatApiError } from '../api'
import {
  formatRequestTime,
  requestDirectionLabel,
  requestMessageSide,
  requestName,
  requestStatus,
} from '../contact-requests'
import { userFacingErrorMessage } from '../errors'
import { useT } from '../i18n/useT'
import type { ContactPrivacySettings, ContactRequest } from '../types'
import {
  loadContactDirectory,
  refreshFriendRequestCount,
} from '../store/actions'
import { useStore } from '../store/hooks'
import ContactPrivacyFields, { defaultContactPrivacy } from './ContactPrivacyFields'
import Icon from './Icon'
import ThreadAvatar from './ThreadAvatar'
import '../styles/components/contact-requests.css'

type Filter = 'all' | 'incoming' | 'outgoing'

const PAGE_LIMIT = 100
const SEARCH_DEBOUNCE_MS = 300
const REFRESH_INTERVAL = 20_000
const OPERATION_POLL_MS = 1500
const OPERATION_POLL_LIMIT = 80
const FILTERS: Filter[] = ['all', 'incoming', 'outgoing']
const FILTER_LABELS: Record<Filter, string> = {
  all: '全部',
  incoming: '收到的',
  outgoing: '已发送',
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function isTerminalState(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired'
}

/** Keeps the newest copy of each conversation when a page is appended. */
function mergeItems(previous: ContactRequest[], next: ContactRequest[]): ContactRequest[] {
  const merged = new Map(previous.map(item => [item.id, item]))
  for (const item of next)
    merged.set(item.id, item)
  return [...merged.values()]
}

export default function ContactRequestsPanel() {
  const t = useT()
  const accountId = useStore(state => state.session.account?.id ?? '')
  const active = useStore(state => state.ui.railView === 'requests')

  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<ContactRequest[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [moreLoading, setMoreLoading] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<ContactRequest | null>(null)
  const [busyId, setBusyId] = useState('')
  const [actionError, setActionError] = useState('')
  const [privacy, setPrivacy] = useState<ContactPrivacySettings>(defaultContactPrivacy)

  const loadTokenRef = useRef(0)
  const accountIdRef = useRef(accountId)

  accountIdRef.current = accountId

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const fetchPage = useCallback(async (from: string | null, append: boolean): Promise<void> => {
    const account = accountIdRef.current
    if (!account)
      return
    const token = ++loadTokenRef.current
    if (append)
      setMoreLoading(true)
    else
      setLoading(true)
    try {
      const page = await wechatApi.listContactRequests(account, {
        direction: filter === 'all' ? undefined : filter,
        search: search || undefined,
        limit: PAGE_LIMIT,
        cursor: from ?? undefined,
      })
      if (token !== loadTokenRef.current)
        return
      const next = page.items ?? []
      setItems(previous => (append ? mergeItems(previous, next) : next))
      setPendingCount(page.pendingIncomingCount ?? 0)
      setCursor(page.nextCursor ?? null)
      setError('')
    }
    catch (value) {
      if (token !== loadTokenRef.current)
        return
      if (!append)
        setItems([])
      setError(userFacingErrorMessage(value, '读取好友申请失败，请稍后重试。'))
    }
    finally {
      if (token === loadTokenRef.current) {
        setLoading(false)
        setMoreLoading(false)
      }
    }
  }, [filter, search])

  useEffect(() => {
    if (!active)
      return
    void fetchPage(null, false)
  }, [active, fetchPage])

  useEffect(() => {
    if (!active)
      return undefined
    const timer = window.setInterval(() => { void fetchPage(null, false) }, REFRESH_INTERVAL)
    return () => window.clearInterval(timer)
  }, [active, fetchPage])

  useEffect(() => () => {
    loadTokenRef.current += 1
  }, [])

  async function openDetail(item: ContactRequest): Promise<void> {
    setDetail(item)
    setActionError('')
    setPrivacy(defaultContactPrivacy())
    const account = accountIdRef.current
    if (!account)
      return
    try {
      const fresh = await wechatApi.getContactRequest(account, item.id)
      setDetail(current => (current?.id === item.id ? fresh : current))
    }
    catch {
      // The list copy is still enough to inspect; a failed read keeps it.
    }
  }

  async function actOnRequest(item: ContactRequest, action: 'accept' | 'delete'): Promise<void> {
    const account = accountIdRef.current
    if (!account || busyId)
      return
    setBusyId(item.id)
    setActionError('')
    const failing = action === 'accept' ? '通过好友申请失败，请稍后重试。' : '删除申请记录失败，请稍后重试。'
    try {
      let operation = action === 'accept'
        ? await wechatApi.acceptContactRequest(account, item.id, item.version, privacy)
        : await wechatApi.deleteContactRequest(account, item.id, item.version)
      for (let attempt = 0; attempt < OPERATION_POLL_LIMIT && !isTerminalState(operation.state); attempt++) {
        await sleep(OPERATION_POLL_MS)
        operation = await wechatApi.getOperation(account, operation.id)
      }
      if (!isTerminalState(operation.state))
        throw new WechatApiError('操作耗时较长，请稍后重试。', 0)
      if (operation.state !== 'succeeded')
        throw new WechatApiError('操作未成功，请稍后重试。', 0)
      setDetail(null)
      await fetchPage(null, false)
      void loadContactDirectory(true)
      void refreshFriendRequestCount()
    }
    catch (value) {
      setActionError(userFacingErrorMessage(value, failing))
    }
    finally {
      setBusyId('')
    }
  }

  return (
    <aside className="contacts-panel requests-panel">
      <header className="contacts-header">
        <div className="contacts-title-row">
          <div className="contacts-title">
            <h2>{t('好友申请')}</h2>
            {pendingCount > 0 && <span className="contact-count">{pendingCount}</span>}
          </div>
          <div className="header-actions">
            <button
              className="icon-button"
              type="button"
              title={t('刷新')}
              disabled={loading}
              onClick={() => { void fetchPage(null, false) }}
            >
              <Icon name="refresh" size={16} className={loading ? 'spin' : undefined} />
            </button>
          </div>
        </div>
        <div className="request-tabs">
          {FILTERS.map(item => (
            <button
              key={item}
              type="button"
              className={`request-tab${filter === item ? ' active' : ''}`}
              onClick={() => setFilter(item)}
            >
              {t(FILTER_LABELS[item])}
            </button>
          ))}
        </div>
      </header>

      <div className="search-wrap">
        <Icon name="search" size={15} className="search-icon" />
        <input
          value={query}
          type="text"
          placeholder={t('搜索好友申请')}
          spellCheck={false}
          onChange={event => setQuery(event.target.value)}
        />
        {query && (
          <button className="clear-button" type="button" title={t('清空搜索')} onClick={() => setQuery('')}>
            <Icon name="close" size={12} />
          </button>
        )}
      </div>

      {error && (
        <div className="contacts-status error">
          {t(error)}
          <button type="button" onClick={() => void fetchPage(null, false)}>{t('重试')}</button>
        </div>
      )}

      <div className="contacts-scroll scrollbar-thin">
        {loading && items.length === 0
          ? <div className="contacts-skeletons">{[0, 1, 2, 3].map(index => <span key={index} className="contact-skeleton" />)}</div>
          : items.length === 0
            ? (
              <div className="contacts-empty">
                <span className="empty-icon"><Icon name="users" size={24} /></span>
                <p>{t(search ? '没有找到匹配的好友申请' : '还没有好友申请')}</p>
                <span>{t(search ? '换个关键词，或切换到其他分类。' : '收到或发出的好友申请会显示在这里。')}</span>
              </div>
            )
            : items.map(item => (
              <button
                key={item.id}
                type="button"
                className="request-row requests-row"
                onClick={() => void openDetail(item)}
              >
                <ThreadAvatar
                  accountId={accountId}
                  name={requestName(item)}
                  username={item.peerId}
                  size={40}
                />
                <span className="request-main">
                  <span className="request-name">{requestName(item)}</span>
                  <span className="request-sub">
                    {item.message || t('请求添加你为朋友')}
                    {' · '}
                    {t(requestDirectionLabel(item))}
                  </span>
                </span>
                <span className="requests-side">
                  <span className={`requests-chip${item.actionable ? ' ready' : ''}`}>{t(requestStatus(item))}</span>
                  <time>{formatRequestTime(item.updatedAt)}</time>
                </span>
              </button>
            ))}

        {cursor && (
          <button
            type="button"
            className="requests-more"
            disabled={moreLoading}
            onClick={() => { void fetchPage(cursor, true) }}
          >
            {moreLoading && <Icon name="refresh" size={13} className="spin" />}
            {t(moreLoading ? '加载中…' : '加载更多')}
          </button>
        )}
      </div>

      {detail && (
        <div
          className="request-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget)
              setDetail(null)
          }}
        >
          <div className="request-detail requests-detail" role="dialog" aria-modal="true">
            <button type="button" className="detail-close" title={t('关闭')} onClick={() => setDetail(null)}>
              <Icon name="close" size={14} />
            </button>
            <div className="detail-head">
              <ThreadAvatar
                accountId={accountId}
                name={requestName(detail)}
                username={detail.peerId}
                size={72}
              />
              <div className="detail-id">
                <span className="detail-name">{requestName(detail)}</span>
                <span className="detail-source">{detail.peerId}</span>
              </div>
            </div>
            <div className="detail-body">
              <div className="detail-meta">
                <span className="detail-label">{t('申请方向')}</span>
                <span>{t(requestDirectionLabel(detail))}</span>
              </div>
              {detail.message && (
                <div className="detail-greeting">
                  <span className="detail-label">{t('申请消息')}</span>
                  <p>{detail.message}</p>
                </div>
              )}
              <div className="detail-meta">
                <span className="detail-label">{t('申请时间')}</span>
                <span>{t(formatRequestTime(detail.updatedAt))}</span>
              </div>
              <div className={`detail-status ${detail.actionable ? 'ready' : 'blocked'}`}>
                {t(requestStatus(detail))}
              </div>

              <ContactPrivacyFields
                value={privacy}
                onChange={setPrivacy}
                disabled={busyId === detail.id || !detail.actionable}
                hint="通过前选择你愿意共享的内容。"
              />

              {detail.history.length > 0 && (
                <details className="requests-history">
                  <summary>{t('申请记录')} · {detail.history.length}</summary>
                  <ol>
                    {detail.history.map(entry => (
                      <li key={`${entry.serverId}:${entry.createdAt}`}>
                        <span className="requests-history-side">
                          {t(requestMessageSide(entry.direction))} · {formatRequestTime(entry.createdAt)}
                        </span>
                        <p>{entry.message}</p>
                      </li>
                    ))}
                  </ol>
                </details>
              )}

              {actionError && <div className="detail-status blocked">{t(actionError)}</div>}
            </div>
            <div className="detail-actions">
              <button
                type="button"
                className="detail-decline"
                disabled={busyId === detail.id}
                title={t('只删除本地申请记录，不会通知对方')}
                onClick={() => void actOnRequest(detail, 'delete')}
              >
                {t(busyId === detail.id ? '处理中' : '删除')}
              </button>
              <button
                type="button"
                className="request-accept"
                disabled={busyId === detail.id || !detail.actionable}
                onClick={() => void actOnRequest(detail, 'accept')}
              >
                {t(busyId === detail.id ? '处理中' : '同意')}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
