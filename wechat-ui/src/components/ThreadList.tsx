// Conversation sidebar: search, filter tabs, the grouped conversation list and
// its loading/empty states. The Vue component received these through props and
// emitted changes; here the same values live in the threads slice, so the shell
// renders this component without props.

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatListTime, previewText, threadName, threadNoNotify } from '../format'
import { useT } from '../i18n/useT'
import {
  loadThreads,
  markAllThreadsRead,
  openNewChat,
  registerThreadListHandle,
  selectBusinessUsernames,
  selectThread,
  setFilterMode,
  setThreadQuery,
} from '../store/actions'
import { useStore } from '../store/hooks'
import { registerThreadListView } from '../store/viewRefs'
import type { Thread, ThreadFilter } from '../types'
import Icon from './Icon'
import LoadingDots from './LoadingDots'
import ThreadAvatar from './ThreadAvatar'
import '../styles/components/thread-list.css'

const FILTER_TABS: ReadonlyArray<{ mode: ThreadFilter, label: string }> = [
  { mode: 'all', label: '全部' },
  { mode: 'unread', label: '未读' },
  { mode: 'direct', label: '单聊' },
  { mode: 'groups', label: '群聊' },
  { mode: 'mini', label: '企业微信' },
  { mode: 'official', label: '服务通知' },
]

/** Collapsed aggregate categories: same buckets as the filter bar, matching
 *  the official client's aggregate entries. */
const COLLAPSED_CATEGORIES = {
  mini: { label: '企业微信', icon: 'mini' },
  official: { label: '服务通知', icon: 'service' },
} as const

type CollapsibleKey = keyof typeof COLLAPSED_CATEGORIES

interface CategoryGroup {
  key: CollapsibleKey
  label: string
  icon: string
  threads: Thread[]
  unread: number
  latest: Thread
}

interface DisplayItem {
  key: string
  thread?: Thread
  nested?: boolean
  group?: CategoryGroup
}

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5]

/**
 * Bucket a conversation by kind: groups / mini programs (OpenIM customer
 * service) / official accounts (gh_ and brand service accounts) / direct.
 */
function threadBucket(thread: Thread, businessUsernames: Set<string>): 'direct' | 'groups' | 'mini' | 'official' {
  if (thread.kind === 'group')
    return 'groups'
  const peer = (thread.peerId || thread.id).trim()
  if (peer.endsWith('@openim'))
    return 'mini'
  if (peer.startsWith('gh_'))
    return 'official'
  // Brand service notices (Meituan, Luckin, ...): wxid customer service
  // accounts marked business in the contact directory. They collapse into the
  // same aggregate entry as official accounts, like the official client.
  if (businessUsernames.has(peer))
    return 'official'
  return 'direct'
}

/** Newest conversation in a category, by last message time. */
function latestThread(threads: Thread[]): Thread {
  return threads.reduce((best, thread) => {
    const bestTime = Date.parse(best.lastMessage?.createdAt ?? '') || 0
    const time = Date.parse(thread.lastMessage?.createdAt ?? '') || 0
    return time > bestTime ? thread : best
  })
}

/** Category members sort by display name; the aggregate row keeps the newest
 *  conversation's position and preview. */
function memberKey(thread: Thread): string {
  return threadName(thread)
}

function byMemberName(left: Thread, right: Thread): number {
  return memberKey(left).localeCompare(memberKey(right), 'zh-Hans-CN')
}

export default function ThreadList() {
  const t = useT()
  const items = useStore(state => state.threads.items)
  const loading = useStore(state => state.threads.loading)
  const query = useStore(state => state.threads.query)
  const filterMode = useStore(state => state.threads.filterMode)
  const activeThreadId = useStore(state => state.threads.activeThreadId)
  const businessUsernames = useStore(selectBusinessUsernames)
  const accountId = useStore(state => state.session.account?.id ?? '')

  const searchInputRef = useRef<HTMLInputElement | null>(null)

  /** Manual expand state per category; the active conversation's category
   *  always stays open. */
  const [expandedCategories, setExpandedCategories] = useState<Record<CollapsibleKey, boolean>>({
    mini: false,
    official: false,
  })

  useEffect(() => {
    const view = {
      focusSearch: () => {
        searchInputRef.current?.focus()
      },
    }
    // Two registries exist: the view registry and the action handle that
    // focusThreadSearch reads. Expose the field to both.
    registerThreadListView(view)
    registerThreadListHandle(view)
    return () => {
      registerThreadListView(null)
      registerThreadListHandle(null)
    }
  }, [])

  const filtered = useMemo(() => {
    let list = items
    if (filterMode === 'unread')
      list = list.filter(thread => (thread.unreadCount ?? 0) > 0)
    else if (filterMode !== 'all')
      list = list.filter(thread => threadBucket(thread, businessUsernames) === filterMode)

    const keyword = query.trim().toLowerCase()
    if (!keyword)
      return list
    return list.filter((thread) => {
      const name = threadName(thread).toLowerCase()
      const preview = previewText(thread).toLowerCase()
      return name.includes(keyword) || preview.includes(keyword) || thread.id.toLowerCase().includes(keyword)
    })
  }, [items, filterMode, query, businessUsernames])

  /** Fold only for the all/unread views without a search term; search results
   *  stay flat so a match is never hidden inside an aggregate row. */
  const collapseEnabled = (filterMode === 'all' || filterMode === 'unread') && query.trim() === ''

  const activeBucket = useMemo<CollapsibleKey | null>(() => {
    const thread = items.find(item => item.id === activeThreadId)
    if (!thread)
      return null
    const bucket = threadBucket(thread, businessUsernames)
    return bucket === 'mini' || bucket === 'official' ? bucket : null
  }, [items, activeThreadId, businessUsernames])

  function categoryExpanded(key: CollapsibleKey): boolean {
    return expandedCategories[key] || activeBucket === key
  }

  function toggleCategory(key: CollapsibleKey): void {
    setExpandedCategories(previous => ({ ...previous, [key]: !(previous[key] || activeBucket === key) }))
  }

  /** Render order: plain conversations as-is; with folding enabled a
   *  category's members collapse into one aggregate row and, when expanded,
   *  appear indented below it. */
  const displayItems = useMemo<DisplayItem[]>(() => {
    if (!collapseEnabled)
      return filtered.map(thread => ({ key: thread.id, thread }))

    const groups = new Map<CollapsibleKey, Thread[]>()
    const result: DisplayItem[] = []
    for (const thread of filtered) {
      const bucket = threadBucket(thread, businessUsernames)
      if (bucket === 'mini' || bucket === 'official') {
        if (!groups.has(bucket)) {
          groups.set(bucket, [])
          // The aggregate row takes the newest conversation's sort position.
          result.push({ key: `cat:${bucket}` })
        }
        groups.get(bucket)!.push(thread)
      }
      else {
        result.push({ key: thread.id, thread })
      }
    }

    for (const [key, members] of groups) {
      const meta = COLLAPSED_CATEGORIES[key]
      const group: CategoryGroup = {
        key,
        label: meta.label,
        icon: meta.icon,
        threads: members,
        unread: members.reduce((sum, thread) => sum + (thread.unreadCount ?? 0), 0),
        latest: latestThread(members),
      }
      const entry = result.find(item => item.key === `cat:${key}`)
      if (entry)
        entry.group = group
      if (expandedCategories[key] || activeBucket === key) {
        const sorted = [...members].sort(byMemberName)
        sorted.forEach((thread, index) => {
          result.splice(result.indexOf(entry!) + 1 + index, 0, {
            key: `${key}:${thread.id}`,
            thread,
            nested: true,
          })
        })
      }
    }
    return result.filter(item => item.thread || item.group)
  }, [filtered, collapseEnabled, expandedCategories, activeBucket, businessUsernames])

  return (
    <aside className="thread-sidebar">
      <header className="sidebar-header">
        <div className="sidebar-title-row">
          <div className="sidebar-title">
            <h2>{t('聊天')}</h2>
            <span className="thread-count">{items.length}</span>
          </div>
          <div className="header-actions">
            <button
              className="icon-button"
              type="button"
              title={t('全部已读')}
              onClick={() => void markAllThreadsRead()}
            >
              <Icon name="checks" size={16} />
            </button>
            <button
              className="icon-button"
              type="button"
              title={t('新建聊天')}
              onClick={() => void openNewChat()}
            >
              <Icon name="plus" size={16} />
            </button>
            <button
              className="icon-button"
              type="button"
              title={t('刷新会话列表')}
              disabled={loading}
              onClick={() => void loadThreads()}
            >
              {loading ? <LoadingDots /> : <Icon name="refresh" size={16} />}
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
          placeholder={t('搜索聊天')}
          spellCheck={false}
          onChange={event => setThreadQuery(event.target.value)}
        />
        {query
          ? (
            <button
              className="clear-button"
              type="button"
              title={t('清除搜索')}
              onClick={() => setThreadQuery('')}
            >
              <Icon name="close" size={13} />
            </button>
          )
          : null}
      </div>

      <div className="filter-tabs">
        {FILTER_TABS.map(tab => (
          <button
            key={tab.mode}
            type="button"
            className={`filter-tab${filterMode === tab.mode ? ' active' : ''}`}
            onClick={() => setFilterMode(tab.mode)}
          >
            {t(tab.label)}
          </button>
        ))}
      </div>

      <div className="thread-scroll scrollbar-thin">
        {loading && items.length === 0
          ? (
            <div className="thread-skeletons">
              {SKELETON_ROWS.map(index => (
                <div key={index} className="thread-skeleton">
                  <span className="skeleton-avatar" />
                  <span className="skeleton-lines">
                    <span className="skeleton-line w-60" />
                    <span className="skeleton-line w-90" />
                  </span>
                </div>
              ))}
            </div>
          )
          : filtered.length > 0
            ? displayItems.map((item) => {
              if (item.group) {
                const group = item.group
                return (
                  <button
                    key={item.key}
                    type="button"
                    className="thread-item category-row"
                    onClick={() => toggleCategory(group.key)}
                  >
                    <span className={`category-avatar category-${group.icon}`}>
                      {/* WeCom: the same fallback glyph as the ThreadAvatar WeCom avatar, white mark on a blue gradient. */}
                      {group.icon === 'mini'
                        ? (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M4.1 6A2.15 2.15 0 0 1 6.25 3.85h7.9A2.15 2.15 0 0 1 16.3 6v5.4a2.15 2.15 0 0 1-2.15 2.15H9.6l-3.9 3.1v-3.1h.55A2.15 2.15 0 0 1 4.1 11.4Z"
                              fill="#fff"
                            />
                            <path
                              d="M14.9 10.3h3a2.15 2.15 0 0 1 2.15 2.15v3.2a2.15 2.15 0 0 1-2.15 2.15h-.35v2.3l-2.85-2.3h-2a2.15 2.15 0 0 1-2-1.4"
                              fill="none"
                              stroke="#fff"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                            />
                          </svg>
                        )
                        : (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M18.9 3.85a1.15 1.15 0 0 1 1.73 1v14.3a1.15 1.15 0 0 1-1.73 1L9.3 14.95H5.55A1.95 1.95 0 0 1 3.6 13v-2a1.95 1.95 0 0 1 1.95-1.95H9.3z"
                              fill="#fff"
                            />
                            <path d="M7.5 16.15h2.9v1.75a1.9 1.9 0 0 1-3.8 0v-1.75z" fill="#fff" />
                          </svg>
                        )}
                    </span>

                    <span className="thread-main">
                      <span className="thread-row">
                        <span className="thread-name">{t(group.label)}</span>
                        <span className="thread-time">{t(formatListTime(group.latest.lastMessage?.createdAt))}</span>
                      </span>
                      <span className="thread-row thread-preview-row">
                        <span className="thread-preview">
                          {t(threadName(group.latest))}
                          ：
                          {t(previewText(group.latest))}
                        </span>
                        <span className="thread-badges">
                          {group.unread > 0
                            ? (
                              <span className="unread-badge unread-muted">
                                {group.unread > 99 ? '99+' : group.unread}
                              </span>
                            )
                            : null}
                          <Icon
                            name="chevron-down"
                            size={14}
                            className={`category-chevron${categoryExpanded(group.key) ? ' open' : ''}`}
                          />
                        </span>
                      </span>
                    </span>
                  </button>
                )
              }

              const thread = item.thread!
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`thread-item${thread.id === activeThreadId ? ' active' : ''}${item.nested ? ' nested' : ''}`}
                  onClick={() => void selectThread(thread)}
                >
                  <ThreadAvatar
                    accountId={accountId}
                    name={threadName(thread)}
                    username={thread.peerId}
                    kind={thread.kind}
                    members={thread.avatarMembers}
                    size={46}
                  />

                  <span className="thread-main">
                    <span className="thread-row">
                      <span className="thread-name">{t(threadName(thread))}</span>
                      <span className="thread-time">{t(formatListTime(thread.lastMessage?.createdAt))}</span>
                    </span>
                    <span className="thread-row thread-preview-row">
                      <span className="thread-preview">{t(previewText(thread))}</span>
                      <span className="thread-badges">
                        {thread.pinned ? <Icon name="pin" size={13} className="muted-icon" /> : null}
                        {thread.muted ? <Icon name="mute" size={13} className="muted-icon" /> : null}
                        {(thread.unreadCount ?? 0) > 0
                          ? (
                            <span className={`unread-badge${threadNoNotify(thread) ? ' unread-muted' : ''}`}>
                              {(thread.unreadCount ?? 0) > 99 ? '99+' : thread.unreadCount}
                            </span>
                          )
                          : null}
                      </span>
                    </span>
                  </span>
                </button>
              )
            })
            : (
              <div className="thread-empty">
                <span className="empty-icon">
                  <Icon name={filterMode === 'groups' ? 'users' : 'message'} size={22} />
                </span>
                {query
                  ? <p>{t('没有匹配的聊天')}</p>
                  : filterMode === 'unread'
                    ? <p>{t('没有未读消息')}</p>
                    : filterMode === 'groups'
                      ? <p>{t('还没有群聊')}</p>
                      : filterMode === 'direct'
                        ? <p>{t('还没有单聊')}</p>
                        : filterMode === 'mini'
                          ? <p>{t('还没有企业微信会话')}</p>
                          : filterMode === 'official'
                            ? <p>{t('还没有服务号消息')}</p>
                            : (
                              <>
                                <p>{t('还没有聊天')}</p>
                                <span>{t('新账号不会同步手机历史，收到新消息后会出现在这里。')}</span>
                              </>
                            )}
              </div>
            )}
      </div>
    </aside>
  )
}
