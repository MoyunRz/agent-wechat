// Message timeline of the open conversation. It takes no props: the message
// window, the open conversation and the account all come from the store, and
// scrolling calls the store actions. The imperative handle the actions use for
// auto-scroll, jump-to-message and the new-message pill is registered in both
// registries (viewRefs and the action handle).

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import brandLogoUrl from '../assets/agent-wechat-logo.svg'
import { dayKey, dayLabel } from '../format'
import { useT } from '../i18n/useT'
import {
  handleMessageListBottom,
  loadOlderMessages,
  registerMessageListHandle,
  selectActiveThread,
  setLightboxSrc,
  startReply,
} from '../store/actions'
import { useStore } from '../store/hooks'
import { registerMessageListView } from '../store/viewRefs'
import type { LocalMessage } from '../types'
import Icon from './Icon'
import MessageBubble from './MessageBubble'
import '../styles/components/messages.css'

const GROUP_WINDOW_MS = 5 * 60 * 1000
/** Distance from the bottom that still counts as "at the bottom". */
const BOTTOM_THRESHOLD = 90
/** Distance from the top that triggers the older-page load. */
const LOAD_OLDER_THRESHOLD = 70

function sameGroup(previous: LocalMessage | undefined, current: LocalMessage | undefined): boolean {
  if (!previous || !current)
    return false
  if (previous.type === 10000 || current.type === 10000)
    return false
  if (previous.direction === null || current.direction === null)
    return false
  if (previous.direction !== current.direction)
    return false
  if ((previous.senderId ?? '') !== (current.senderId ?? ''))
    return false
  if (dayKey(previous.createdAt) !== dayKey(current.createdAt))
    return false
  const previousTime = previous.createdAt ? new Date(previous.createdAt).getTime() : Number.NaN
  const currentTime = current.createdAt ? new Date(current.createdAt).getTime() : Number.NaN
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime))
    return false
  const gap = currentTime - previousTime
  return gap >= 0 && gap <= GROUP_WINDOW_MS
}

export default function MessageList() {
  const t = useT()
  const items = useStore(state => state.messages.items)
  const loading = useStore(state => state.messages.loading)
  const olderLoading = useStore(state => state.messages.olderLoading)
  const cursor = useStore(state => state.messages.cursor)
  const mediaByMessage = useStore(state => state.messages.mediaByMessage)
  const highlightId = useStore(state => state.messages.highlightId)
  const thread = useStore(selectActiveThread)
  const account = useStore(state => state.session.account)

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  /** Items of the previous commit, used to detect a prepended older page. */
  const previousItems = useRef<LocalMessage[]>(items)

  const hasMore = Boolean(cursor)
  /** Official accounts (gh_) render a single-column card feed without avatars. */
  const cardLayout = (thread?.peerId ?? '').trim().startsWith('gh_')

  const scrollToBottom = useCallback((force = false): void => {
    const el = scrollerRef.current
    if (!el)
      return
    if (!force && !stickToBottom.current)
      return
    el.scrollTop = el.scrollHeight
  }, [])

  /**
   * Centers the target message; nothing happens when it is not rendered.
   *
   * The list follows the newest message while `stickToBottom` is set, so this
   * clears it first: otherwise the next commit (a media lookup, a decoded
   * image, a re-render) scrolls the user away from the message they jumped to.
   */
  const scrollToMessage = useCallback((id: string): void => {
    const el = scrollerRef.current
    if (!el)
      return
    stickToBottom.current = false
    const selector = '[data-mid="' + CSS.escape(id) + '"]'
    const target = el.querySelector<HTMLElement>(selector)
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // Media can decode after the first scroll and shift the layout; center the
    // message once more when that happens.
    const settle = window.setTimeout(() => {
      el.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: 'center' })
    }, 400)
    window.setTimeout(() => window.clearTimeout(settle), 2000)
  }, [])

  const isAtBottom = useCallback((): boolean => stickToBottom.current, [])

  useEffect(() => {
    const handle = { scrollToBottom, scrollToMessage, isAtBottom }
    // Two registries exist: the view registry and the handle the store actions
    // read for auto-scroll, jump-to-message and the new-message pill.
    registerMessageListView(handle)
    registerMessageListHandle(handle)
    return () => {
      registerMessageListHandle(null)
      registerMessageListView(null)
    }
  }, [scrollToBottom, scrollToMessage, isAtBottom])

  const onScroll = useCallback((): void => {
    const el = scrollerRef.current
    if (!el)
      return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD
    stickToBottom.current = atBottom
    if (atBottom)
      handleMessageListBottom()
    if (el.scrollTop < LOAD_OLDER_THRESHOLD && hasMore && !olderLoading && !loading)
      void loadOlderMessages()
  }, [hasMore, loading, olderLoading])

  // A conversation switch always lands at the newest message.
  useLayoutEffect(() => {
    stickToBottom.current = true
    const el = scrollerRef.current
    if (el)
      el.scrollTop = el.scrollHeight
  }, [thread?.id])

  // The Vue component's watcher ran before the DOM was patched, so the scroll
  // metrics are read during render (before the commit) and applied afterwards.
  const metrics = previousItems.current !== items && scrollerRef.current
    ? { height: scrollerRef.current.scrollHeight, top: scrollerRef.current.scrollTop }
    : null

  useLayoutEffect(() => {
    const previousList = previousItems.current
    previousItems.current = items
    const el = scrollerRef.current
    if (!el)
      return

    const previousHeight = metrics ? metrics.height : el.scrollHeight
    const previousTop = metrics ? metrics.top : el.scrollTop
    const prepended = previousList.length > 0
      && items.length > previousList.length
      && items[0]?.id !== previousList[0]?.id
      && items[items.length - 1]?.id === previousList[previousList.length - 1]?.id

    if (prepended && !stickToBottom.current) {
      el.scrollTop = previousTop + (el.scrollHeight - previousHeight)
      return
    }

    if (stickToBottom.current || previousList.length === 0)
      el.scrollTop = el.scrollHeight
    // The metrics belong to this commit's render; listing them as a dependency
    // would re-run the adjustment with a stale measurement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  function maybeShowDay(index: number): boolean {
    const message = items[index]
    if (!message)
      return false
    if (index === 0)
      return true
    const previous = items[index - 1]
    return dayKey(previous?.createdAt) !== dayKey(message.createdAt)
  }

  function groupPosition(index: number): 'single' | 'first' | 'middle' | 'last' {
    const current = items[index]
    const joinedPrevious = sameGroup(items[index - 1], current)
    const joinedNext = sameGroup(current, items[index + 1])
    if (!joinedPrevious && !joinedNext)
      return 'single'
    if (!joinedPrevious)
      return 'first'
    if (!joinedNext)
      return 'last'
    return 'middle'
  }

  return (
    <div ref={scrollerRef} className="message-scroll scrollbar-thin" onScroll={onScroll}>
      {!thread
        ? (
          <div className="welcome-screen">
            <span className="welcome-logo"><img src={brandLogoUrl} alt="" width={82} height={82} /></span>
            <h2>Agent WeChat</h2>
            <p className="welcome-slogan">{t('面向人与 AI 智能体的开源微信客户端')}</p>
            <span className="welcome-hint">{t('从左侧会话列表选择一个聊天开始')}</span>
          </div>
        )
        : (
          <div className={cardLayout ? 'message-inner official-feed' : 'message-inner'}>
            {hasMore
              ? (
                <button
                  className="load-older"
                  type="button"
                  disabled={olderLoading}
                  onClick={() => void loadOlderMessages()}
                >
                  <Icon name="refresh" size={13} className={olderLoading ? 'spin' : undefined} />
                  {olderLoading ? t('加载中') : t('加载更早消息')}
                </button>
              )
              : null}

            {loading && items.length === 0
              ? (
                <div className="message-skeletons">
                  {[1, 2, 3, 4, 5].map(index => (
                    <span
                      key={index}
                      className={index % 2 === 0 ? 'message-skeleton own' : 'message-skeleton'}
                    />
                  ))}
                </div>
              )
              : items.length === 0
                ? (
                  <div className="message-empty">
                    <span className="empty-icon"><Icon name="message" size={26} /></span>
                    <p>{t('还没有消息')}</p>
                    <span>{t('发送一条消息开始聊天')}</span>
                  </div>
                )
                : null}

            {thread && account
              ? items.map((message, index) => (
                <Fragment key={message.id}>
                  {maybeShowDay(index)
                    ? (
                      <div className="day-divider">
                        <span>{t(dayLabel(message.createdAt))}</span>
                      </div>
                    )
                    : null}
                  <MessageBubble
                    message={message}
                    thread={thread}
                    account={account}
                    media={mediaByMessage[message.id]}
                    groupPosition={groupPosition(index)}
                    dataMid={message.id}
                    className={highlightId === message.id ? 'message-flash' : undefined}
                    onReply={() => startReply(message)}
                    onPreview={src => setLightboxSrc(src)}
                  />
                </Fragment>
              ))
              : null}
          </div>
        )}
    </div>
  )
}
