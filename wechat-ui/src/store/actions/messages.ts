// The message timeline: loading, merging, in-conversation search, replies,
// attachments and sending.

import { wechatApi, WechatApiError } from '../../api'
import { sendFailureMessage } from '../../errors'
import { compareMessages, dayKey, threadName } from '../../format'
import { getLocale, t } from '../../i18n'
import type {
  Contact,
  GroupMember,
  LocalMedia,
  LocalMessage,
  MediaKind,
  MentionOption,
  Message,
  StagedAttachment,
  Thread,
} from '../../types'
import {
  GROUP_MEMBERS_CACHE_LIMIT,
  MAX_IMAGE_VOICE_BYTES,
  MAX_VIDEO_FILE_BYTES,
  MESSAGE_PAGE_SIZE,
  PERSISTED_MESSAGE_THREADS,
  THREAD_CACHE_LIMIT,
  clearTimer,
  counters,
  flags,
  groupMembersCache,
  handles,
  localMediaUrls,
  recentMessages,
  threadMessagesCache,
  timers,
} from '../caches'
import { getState, setMessages, setSession, setThreads } from '../state'
import { loadMediaForMessages, revokeUrl } from './media'
import { errorText, sleep } from './session'
import {
  applyContactNames,
  loadReadCursor,
  loadThreads,
  markThreadRead,
  scheduleThreadRefresh,
  selectActiveThread,
  selectActiveThreadIsGroup,
  suppressReadCursor,
} from './threads'

export const UI_CACHE_KEY = 'vane.wechat.ui-cache'
const DIRECTORY_CACHE_KEY = 'vane.wechat.directory-cache'
const READ_CURSOR_KEY = 'vane.wechat.read-cursor'
const THREAD_SEARCH_RESULT_LIMIT = 60
const THREAD_SEARCH_MAX_PAGES = 8
const THREAD_SEARCH_DEBOUNCE_MS = 320
const EMPTY_MEMBERS: GroupMember[] = []
const EMPTY_MENTION_OPTIONS: MentionOption[] = []

/** Server messages only: optimistic bubbles and blob URLs never hit storage. */
export function persistableMessages(items: LocalMessage[]): Message[] {
  return items
    .filter(item => !item.local)
    .map((item) => {
      const { localMedia: _media, local: _local, pending: _pending, sendState: _state, sendId: _id, sendError: _error, ...rest } = item
      return rest
    })
}

/** Remembers the current message window for a conversation (memory and disk). */
export function cacheThreadMessages(threadId: string): void {
  if (!threadId)
    return
  const state = getState()
  threadMessagesCache.delete(threadId)
  threadMessagesCache.set(threadId, { items: state.messages.items, cursor: state.messages.cursor })
  while (threadMessagesCache.size > THREAD_CACHE_LIMIT) {
    const oldest = threadMessagesCache.keys().next().value
    if (oldest === undefined)
      break
    threadMessagesCache.delete(oldest)
  }
  recentMessages.delete(threadId)
  recentMessages.set(threadId, { items: persistableMessages(state.messages.items), cursor: state.messages.cursor })
  while (recentMessages.size > PERSISTED_MESSAGE_THREADS) {
    const oldest = recentMessages.keys().next().value
    if (oldest === undefined)
      break
    recentMessages.delete(oldest)
  }
  persistSessionData()
}

/** Persists the conversation list, contact names and message windows. */
export function persistSessionData(): void {
  try {
    const state = getState()
    const recent: Record<string, { items: Message[], cursor: string | null }> = {}
    for (const [threadId, entry] of recentMessages)
      recent[threadId] = entry
    window.localStorage.setItem(UI_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      ownUsername: state.session.account?.ownUsername ?? flags.cachedOwnUsername,
      threads: state.threads.items.slice(0, 100),
      contacts: Object.fromEntries(state.threads.contactNames),
      friends: [...state.threads.friendNames].slice(0, 2000),
      recentMessages: recent,
    }))
  }
  catch {
    // A full quota or a private-mode browser must not break the interface.
  }
}

/** Paints the last saved session so the first screen is not empty. */
export function loadCachedSessionData(): void {
  try {
    const raw = window.localStorage.getItem(UI_CACHE_KEY)
    if (!raw)
      return
    const parsed = JSON.parse(raw) as {
      threads?: unknown
      contacts?: unknown
      friends?: unknown
      recentMessages?: unknown
      ownUsername?: unknown
    }
    flags.cachedOwnUsername = typeof parsed.ownUsername === 'string' ? parsed.ownUsername : ''
    loadReadCursor()
    if (Array.isArray(parsed.threads) && getState().threads.items.length === 0) {
      const cachedThreads = parsed.threads as Thread[]
      // Cached unread counts may predate a successful read; replay the cursor
      // so a refresh does not resurrect cleared badges.
      cachedThreads.forEach((thread) => { thread.unreadCount = suppressReadCursor(thread.unreadCount ?? 0, thread) })
      setThreads({ items: cachedThreads })
    }
    if (parsed.contacts && typeof parsed.contacts === 'object' && getState().threads.contactNames.size === 0) {
      setThreads({ contactNames: new Map(Object.entries(parsed.contacts as Record<string, string>)) })
      applyContactNames()
    }
    if (Array.isArray(parsed.friends) && getState().threads.friendNames.size === 0)
      setThreads({ friendNames: new Set(parsed.friends as string[]) })
    // Full directory snapshot: the contacts panel opens instantly after reload.
    try {
      const rawDir = window.localStorage.getItem(DIRECTORY_CACHE_KEY)
      if (rawDir) {
        const dir = JSON.parse(rawDir) as { contacts?: unknown, ownUsername?: unknown }
        const sameAccount = !dir.ownUsername
          || !flags.cachedOwnUsername
          || dir.ownUsername === flags.cachedOwnUsername
        if (sameAccount && Array.isArray(dir.contacts) && dir.contacts.length > 0 && getState().threads.directoryContacts.length === 0) {
          setThreads({ directoryContacts: dir.contacts as Contact[], directoryReady: true })
        }
      }
    }
    catch {
      // A corrupt snapshot is ignored; the background load fills it in.
    }
    if (parsed.recentMessages && typeof parsed.recentMessages === 'object' && recentMessages.size === 0) {
      for (const [threadId, entry] of Object.entries(parsed.recentMessages as Record<string, { items?: unknown, cursor?: unknown }>)) {
        const items = Array.isArray(entry?.items) ? (entry.items as Message[]) : null
        if (!items || items.length === 0)
          continue
        recentMessages.set(threadId, { items, cursor: typeof entry.cursor === 'string' ? entry.cursor : null })
      }
      while (recentMessages.size > PERSISTED_MESSAGE_THREADS) {
        const oldest = recentMessages.keys().next().value
        if (oldest === undefined)
          break
        recentMessages.delete(oldest)
      }
    }
  }
  catch {
    // A corrupt cache falls through to the normal load path.
  }
}

/** Drops the persisted caches when a different WeChat account signs in. */
export function ensureCacheAccountMatch(ownUsername: string | null | undefined): void {
  if (!flags.cachedOwnUsername || !ownUsername || flags.cachedOwnUsername === ownUsername)
    return
  flags.cachedOwnUsername = ownUsername
  recentMessages.clear()
  threadMessagesCache.clear()
  flags.lastDirectoryLoad = 0
  setThreads({
    items: [],
    contactNames: new Map(),
    friendNames: new Set(),
    directoryContacts: [],
    allReadAt: 0,
  })
  applyContactNames()
  try {
    window.localStorage.removeItem(UI_CACHE_KEY)
    window.localStorage.removeItem(DIRECTORY_CACHE_KEY)
    window.localStorage.removeItem(READ_CURSOR_KEY)
  }
  catch {
    // Cleanup failures do not block the sign-in.
  }
}

/** Loads one page of a conversation: reset, refresh or older. */
export async function fetchThreadMessages(threadId: string, mode: 'reset' | 'refresh' | 'older'): Promise<void> {
  const current = getState().session.account
  if (!current)
    return
  if (mode === 'older' && !getState().messages.cursor)
    return
  // The daemon message endpoint can take ten seconds when busy: skip a second
  // refresh while one is in flight instead of stacking requests.
  if (mode === 'refresh') {
    if (flags.messageRefreshInFlight === threadId)
      return
    flags.messageRefreshInFlight = threadId
  }

  const requestId = ++counters.activeMessageRequest
  if (mode === 'reset')
    setMessages({ loading: true, error: '' })
  if (mode === 'older')
    setMessages({ olderLoading: true })

  try {
    const cursor = mode === 'older' ? getState().messages.cursor : undefined
    const response = await wechatApi.listMessages(current.id, threadId, MESSAGE_PAGE_SIZE, cursor)
    if (requestId !== counters.activeMessageRequest || getState().threads.activeThreadId !== threadId)
      return

    const items = (response.items ?? []).slice().sort(compareMessages)
    if (mode === 'older') {
      const known = new Set(getState().messages.items.map(item => item.id))
      setMessages(state => ({
        items: [...items.filter(item => !known.has(item.id)), ...state.items],
        cursor: response.nextCursor ?? null,
      }))
    }
    else if (mode === 'reset') {
      setMessages({ items, cursor: response.nextCursor ?? null })
    }
    else {
      mergeServerMessages(items)
      if (getState().messages.items.length === 0)
        setMessages({ cursor: response.nextCursor ?? null })
    }

    cacheThreadMessages(threadId)
    void loadMediaForMessages(getState().messages.items)
  }
  catch (error) {
    const draft = getState().threads.items.find(thread => thread.id === threadId)?.isDraft
    if (draft && error instanceof WechatApiError && error.status === 404) {
      // A new conversation has no local message store before its first message.
      if (requestId === counters.activeMessageRequest)
        setMessages({ items: [], cursor: null })
    }
    else if (requestId === counters.activeMessageRequest && mode !== 'refresh') {
      setMessages({ error: errorText(error) })
    }
  }
  finally {
    if (mode === 'refresh' && flags.messageRefreshInFlight === threadId)
      flags.messageRefreshInFlight = null
    if (requestId === counters.activeMessageRequest)
      setMessages({ loading: false, olderLoading: false })
  }
}

/** Merges server messages into the open window without duplicating echoes. */
export function mergeServerMessages(items: Message[]): void {
  const existingItems = getState().messages.items
  // A local media bubble already shows a preview; the server echo of the same
  // message must not be displayed twice.
  const localMediaOutgoing = existingItems.filter(item => item.local && item.localMedia && item.direction === 'outgoing')
  const itemsForMerge = items.filter((item) => {
    if (item.direction !== 'outgoing' || !item.body)
      return true
    const itemTime = item.createdAt ? new Date(item.createdAt).getTime() : 0
    return !localMediaOutgoing.some((local) => {
      const localTime = local.createdAt ? new Date(local.createdAt).getTime() : 0
      return local.type === item.type && Math.abs(itemTime - localTime) < 3 * 60 * 1000
    })
  })

  const serverById = new Map(itemsForMerge.map(item => [item.id, item]))
  const merged: LocalMessage[] = []
  const seen = new Set<string>()

  for (const existing of existingItems) {
    const server = serverById.get(existing.id)
    if (server) {
      merged.push({ ...existing, ...server, local: false, pending: false })
      seen.add(existing.id)
      continue
    }
    merged.push(existing)
  }

  for (const item of itemsForMerge) {
    if (seen.has(item.id))
      continue
    merged.push(item)
  }

  merged.sort(compareMessages)

  // A server echo is authoritative: remove the matching optimistic bubble
  // (including one still marked as sending) so the pair never shows twice.
  // Failed or unconfirmed bubbles carry error feedback and are kept; repeated
  // sends of the same text are matched by count.
  const echoBudget = new Map<string, number>()
  for (const item of itemsForMerge) {
    if (item.direction === 'outgoing' && item.body) {
      const key = `${item.body}|${dayKey(item.createdAt)}`
      echoBudget.set(key, (echoBudget.get(key) ?? 0) + 1)
    }
  }
  setMessages({
    items: merged.filter((item) => {
      if (!item.local || item.direction !== 'outgoing' || !item.body || item.sendError)
        return true
      const key = `${item.body}|${dayKey(item.createdAt)}`
      const budget = echoBudget.get(key) ?? 0
      if (budget <= 0)
        return true
      echoBudget.set(key, budget - 1)
      return false
    }),
  })
}

/** Schedules one refresh of the open conversation. */
export function scheduleMessageRefresh(threadId: string, delay = 260): void {
  timers.message = clearTimer(timers.message)
  timers.message = window.setTimeout(() => {
    if (getState().threads.activeThreadId === threadId)
      void fetchThreadMessages(threadId, 'refresh')
  }, delay)
}

/** Manual refresh of the open conversation and the thread list. */
export async function refreshActiveMessages(): Promise<void> {
  const activeThreadId = getState().threads.activeThreadId
  if (!activeThreadId)
    return
  setSession({ manualRefreshing: true })
  try {
    await Promise.all([
      fetchThreadMessages(activeThreadId, 'refresh'),
      loadThreads(),
    ])
  }
  finally {
    setSession({ manualRefreshing: false })
  }
}

/** Loads the previous page of the open conversation. */
export async function loadOlderMessages(): Promise<void> {
  const state = getState()
  if (!state.threads.activeThreadId || state.messages.olderLoading || !state.messages.cursor)
    return
  await fetchThreadMessages(state.threads.activeThreadId, 'older')
}

/** The list scrolled back to the bottom: the "new messages" pill disappears. */
export function handleMessageListBottom(): void {
  setMessages({ unseenBelow: 0 })
}

/** Scrolls the list to the newest message and clears the pill. */
export function jumpToLatestMessage(): void {
  handles.messageList?.scrollToBottom(true)
  setMessages({ unseenBelow: 0 })
}

function threadSearchMatches(item: LocalMessage, keyword: string): boolean {
  const text = item.body?.toLowerCase() ?? ''
  return text.includes(keyword)
}

/** Display name of a search hit's sender. */
export function threadSearchSender(item: LocalMessage): string {
  if (item.direction === 'outgoing')
    return t('我')
  const thread = selectActiveThread()
  const member = thread?.avatarMembers?.find(candidate => candidate.id === item.senderId)
  return member?.displayName || item.senderId || t('对方')
}

/** One-line preview of a search hit. */
export function threadSearchSnippet(item: LocalMessage): string {
  const text = item.body?.trim() ?? ''
  if (text)
    return text.slice(0, 120)
  switch (item.type) {
    case 3: return t('[图片]')
    case 34: return t('[语音]')
    case 43: return t('[视频]')
    case 47: return t('[表情]')
    default: return t('[消息]')
  }
}

/** Searches the open conversation locally first, then across the daemon. */
export async function runThreadSearch(): Promise<void> {
  const state = getState()
  const current = state.session.account
  const threadId = state.threads.activeThreadId
  const keyword = state.messages.searchQuery.trim().toLowerCase()
  setMessages({ searchResults: [] })
  if (!current || !threadId || !keyword) {
    setMessages({ searching: false })
    return
  }
  const seq = ++counters.threadSearch
  setMessages({ searching: true, searchDone: false })
  try {
    const results = new Map<string, LocalMessage>()
    const collect = (items: LocalMessage[]): void => {
      for (const item of items) {
        if (item.threadId === threadId && threadSearchMatches(item, keyword))
          results.set(item.id, item)
      }
      setMessages({ searchResults: [...results.values()].sort(compareMessages) })
    }
    // 1) Search the loaded window first so results appear immediately.
    collect(getState().messages.items)
    if (results.size >= THREAD_SEARCH_RESULT_LIMIT)
      return
    // 2) Full daemon search (no per-conversation filter upstream), paging.
    let cursor: string | null = null
    for (let page = 0; page < THREAD_SEARCH_MAX_PAGES; page++) {
      if (seq !== counters.threadSearch || flags.disposed)
        return
      const response = await wechatApi.searchMessages(current.id, keyword, 200, cursor)
      collect(response.items ?? [])
      if (results.size >= THREAD_SEARCH_RESULT_LIMIT)
        return
      cursor = response.nextCursor ?? null
      if (!cursor) {
        setMessages({ searchDone: true })
        return
      }
    }
    setMessages({ searchDone: true })
  }
  catch {
    // A failed search keeps the current results; typing again retries.
  }
  finally {
    if (seq === counters.threadSearch)
      setMessages({ searching: false })
  }
}

/** Debounces a search run after the query changed. */
export function scheduleThreadSearch(): void {
  timers.threadSearchDebounce = clearTimer(timers.threadSearchDebounce)
  timers.threadSearchDebounce = window.setTimeout(() => {
    timers.threadSearchDebounce = null
    void runThreadSearch()
  }, THREAD_SEARCH_DEBOUNCE_MS)
}

/** Sets the in-conversation search query and schedules the search. */
export function setThreadSearchQuery(query: string): void {
  setMessages({ searchQuery: query })
  scheduleThreadSearch()
}

/** Opens or closes the in-conversation search panel. */
export function toggleThreadSearch(): void {
  const open = !getState().messages.searchOpen
  if (open) {
    setMessages({ searchOpen: true })
    window.setTimeout(() => handles.threadSearchInput?.focus(), 0)
  }
  else {
    // Bump the sequence so a search that is still paging stops storing results,
    // and drop the busy flag the closed panel would otherwise keep.
    counters.threadSearch += 1
    timers.threadSearchDebounce = clearTimer(timers.threadSearchDebounce)
    setMessages({ searchOpen: false, searchQuery: '', searchResults: [], searching: false, searchDone: false, highlightId: null })
  }
}

/** Scrolls to a search hit, loading older pages until it is in the window. */
export async function jumpToSearchResult(item: LocalMessage): Promise<void> {
  setMessages({ searchOpen: false })
  if (getState().threads.activeThreadId !== item.threadId)
    return
  let hops = 0
  while (!getState().messages.items.some(candidate => candidate.id === item.id) && getState().messages.cursor && hops < 20) {
    await loadOlderMessages()
    hops += 1
  }
  if (!getState().messages.items.some(candidate => candidate.id === item.id))
    return
  await new Promise<void>(resolve => window.setTimeout(resolve, 0))
  handles.messageList?.scrollToMessage(item.id)
  setMessages({ highlightId: item.id })
  window.setTimeout(() => {
    if (getState().messages.highlightId === item.id)
      setMessages({ highlightId: null })
  }, 2400)
}

/** Quotes a message in the composer; only server-backed messages can be quoted. */
export function startReply(message: LocalMessage): void {
  if (!message.serverId?.trim())
    return
  setMessages({ replyTo: message })
  handles.composer?.focus()
}

/** Drops the quoted message. */
export function cancelReply(): void {
  setMessages({ replyTo: null })
}

export interface ReplyToDisplay {
  sender: string
  preview: string
}

let replyToCache: {
  message: LocalMessage
  names: Map<string, string>
  thread: Thread | null
  // applyContactNames rewrites displayName in place, so identity alone is not
  // enough: keep the title the label was built from.
  title: string
  // The sender label and preview are translated, so a language switch must
  // invalidate the memo instead of reusing the previous locale's strings.
  locale: string
  value: ReplyToDisplay
} | null = null

/** Sender name and content preview of the quoted message. */
export function selectReplyToDisplay(state = getState()): ReplyToDisplay | null {
  const message = state.messages.replyTo
  if (!message)
    return null
  const thread = selectActiveThread(state)
  const names = state.threads.contactNames
  const locale = getLocale()
  const title = thread?.displayName ?? ''
  if (replyToCache && replyToCache.message === message && replyToCache.names === names && replyToCache.thread === thread && replyToCache.title === title && replyToCache.locale === locale)
    return replyToCache.value

  const text = message.body?.trim() ?? ''
  const preview = text || (message.type === 3
    ? t('[图片]')
    : message.type === 34
      ? t('[语音]')
      : message.type === 43
        ? t('[视频]')
        : message.type === 47
          ? t('[表情]')
          : t('[消息]'))
  // Sender name priority: remark/nickname from the directory, then the group
  // member display name, then the conversation title, then the raw id.
  const senderId = message.senderId ?? ''
  const sender = message.direction === 'outgoing'
    ? t('我')
    : (names.get(senderId)
      || (senderId && senderId === thread?.peerId ? threadName(thread) : '')
      || thread?.avatarMembers?.find(entry => entry.id === senderId)?.displayName
      || senderId
      || t('对方'))
  const value: ReplyToDisplay = { sender, preview: preview.slice(0, 80) }
  replyToCache = { message, names, thread, title, locale, value }
  return value
}

/** Updates the composer draft. */
export function setDraft(draft: string): void {
  setMessages({ draft })
}

/** Classifies a picked file by MIME type and extension. */
export function detectMediaKind(file: File): MediaKind {
  const type = file.type.toLowerCase()
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
  const videoTypes = ['video/quicktime', 'video/mp4', 'video/3gpp', 'video/3gpp2', 'video/mj2']
  const voiceTypes = [
    'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
    'audio/flac', 'audio/ogg', 'audio/opus', 'audio/webm', 'audio/x-caf', 'audio/amr',
  ]
  if (imageTypes.includes(type) || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext))
    return 'image'
  if (videoTypes.includes(type) || ['mp4', 'mov', '3gp', '3g2', 'mj2'].includes(ext))
    return 'video'
  if (voiceTypes.includes(type) || ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm', 'caf', 'amr'].includes(ext))
    return 'voice'
  return 'file'
}

/** Upload ceiling for one attachment kind. */
export function mediaLimit(kind: MediaKind): number {
  return kind === 'image' || kind === 'voice' ? MAX_IMAGE_VOICE_BYTES : MAX_VIDEO_FILE_BYTES
}

/** Stages picked files for the next send. */
export function stageFiles(files: File[]): void {
  if (!getState().session.account)
    return
  for (const file of files) {
    const kind = detectMediaKind(file)
    if (file.size > mediaLimit(kind)) {
      const limit = kind === 'image' || kind === 'voice' ? ' 25 MB' : ' 512 MB'
      setSession({ accountActionError: t('{name} 超过{limit}发送上限', { name: file.name, limit }) })
      continue
    }
    const previewUrl = URL.createObjectURL(file)
    localMediaUrls.add(previewUrl)
    setMessages(state => ({
      attachments: [...state.attachments, {
        id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        name: file.name,
        size: file.size,
        kind,
        previewUrl,
      }],
    }))
  }
}

/** Removes one staged attachment and revokes its preview URL. */
export function removeAttachment(id: string): void {
  const item = getState().messages.attachments.find(attachment => attachment.id === id)
  if (item)
    revokeUrl(item.previewUrl)
  setMessages(state => ({ attachments: state.attachments.filter(attachment => attachment.id !== id) }))
}

/** Revokes every staged attachment preview. */
export function clearStagedAttachments(): void {
  for (const item of getState().messages.attachments)
    revokeUrl(item.previewUrl)
  setMessages({ attachments: [] })
}

/** Revokes every object URL created for local media bubbles. */
export function revokeAllLocalMedia(): void {
  for (const url of localMediaUrls)
    URL.revokeObjectURL(url)
  localMediaUrls.clear()
}

/**
 * Scans the draft for mentions inserted by the picker (`@name\u{2005}`) and
 * builds the daemon mention payload. Mixing @all switches the payload to all.
 */
export function buildMentions(text: string, options: MentionOption[]): { userIds?: string[], all?: boolean, positions?: Array<{ start: number, end: number, index: number }> } | undefined {
  const spans: Array<{ start: number, end: number, option: MentionOption }> = []
  for (const match of text.matchAll(/@([^\u2005]+)\u2005/gu)) {
    const option = options.find(candidate => candidate.label === match[1])
    if (option)
      spans.push({ start: match.index, end: match.index + match[0].length, option })
  }
  if (spans.length === 0)
    return undefined
  if (spans.some(span => span.option.all)) {
    return {
      all: true,
      positions: spans.map(span => ({ start: span.start, end: span.end, index: 0 })),
    }
  }
  const userIds: string[] = []
  const indexByUser = new Map<string, number>()
  const positions = spans.map((span) => {
    let index = indexByUser.get(span.option.id)
    if (index === undefined) {
      index = userIds.length
      indexByUser.set(span.option.id, index)
      userIds.push(span.option.id)
    }
    return { start: span.start, end: span.end, index }
  })
  return { userIds, positions }
}

let mentionOptionsCache: { key: string, members: GroupMember[], locale: string, value: MentionOption[] } | null = null

/** Mention picker entries for the open group conversation. */
export function selectMentionOptions(state = getState()): MentionOption[] {
  const threadId = state.threads.activeThreadId
  if (!selectActiveThreadIsGroup(state) || !threadId)
    return EMPTY_MENTION_OPTIONS
  const members = groupMembersCache.get(threadId) ?? EMPTY_MEMBERS
  const locale = getLocale()
  if (mentionOptionsCache && mentionOptionsCache.key === threadId && mentionOptionsCache.members === members && mentionOptionsCache.locale === locale)
    return mentionOptionsCache.value
  const options = members.map((member) => {
    const label = member.mentionName?.trim() || member.displayName?.trim() || member.username
    return { id: member.id, label }
  })
  const value: MentionOption[] = [{ id: 'notify@all', label: t('所有人'), all: true }, ...options]
  mentionOptionsCache = { key: threadId, members, locale, value }
  return value
}

/** True while the member list of the open group is still loading. */
export function selectMentionLoading(state = getState()): boolean {
  const threadId = state.threads.activeThreadId
  return selectActiveThreadIsGroup(state)
    && state.messages.groupMembersLoading
    && Boolean(threadId) && !groupMembersCache.has(threadId ?? '')
}

/** Loads and caches the member list of a group conversation. */
export async function ensureGroupMembers(threadId: string): Promise<void> {
  const current = getState().session.account
  if (!current || !threadId.endsWith('@chatroom'))
    return
  if (groupMembersCache.has(threadId) || getState().messages.groupMembersLoading)
    return
  setMessages({ groupMembersLoading: true })
  const requestId = ++counters.groupMembersRequest
  try {
    const members: GroupMember[] = []
    let cursor: string | null = null
    for (let page = 0; page < 3; page++) {
      const response = await wechatApi.listGroupMembers(current.id, threadId, 200, cursor)
      members.push(...(response.items ?? []))
      cursor = response.nextCursor ?? null
      if (!cursor)
        break
    }
    if (requestId === counters.groupMembersRequest) {
      if (groupMembersCache.size >= GROUP_MEMBERS_CACHE_LIMIT) {
        const oldest = groupMembersCache.keys().next().value
        if (oldest !== undefined)
          groupMembersCache.delete(oldest)
      }
      groupMembersCache.set(threadId, members)
    }
  }
  catch {
    // A failed member load leaves the picker empty without blocking anything.
  }
  finally {
    if (requestId === counters.groupMembersRequest)
      setMessages({ groupMembersLoading: false })
  }
}

/** Notifies subscribers after a message object was mutated in place. */
export function touchMessages(): void {
  setMessages(state => ({ items: [...state.items] }))
}

async function sendTextMessage(current: { id: string, ownUsername: string | null }, thread: Thread, text: string): Promise<void> {
  const local: LocalMessage = {
    id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    accountId: current.id,
    threadId: thread.id,
    serverId: null,
    senderId: current.ownUsername ?? null,
    type: 1,
    direction: 'outgoing',
    body: text,
    createdAt: new Date().toISOString(),
    version: 'local',
    local: true,
    pending: true,
    sendState: 'queued',
  }

  setMessages(state => ({ items: [...state.items, local] }))
  // Sending marks the conversation read, matching the official client.
  thread.unreadCount = 0
  markThreadRead(thread)
  const pendingMessage = local
  // Quoting needs the platform server id of the referenced message.
  const replyTo = getState().messages.replyTo
  const quoted = replyTo?.serverId?.trim()
    ? { messageId: replyTo.id, serverId: replyTo.serverId.trim() }
    : undefined
  setMessages({ replyTo: null })
  // Mentions only apply to group conversations and picker-inserted spans.
  const mentions = buildMentions(text, selectMentionOptions())
  try {
    const intent = await wechatApi.sendText(current.id, thread.id, text, { quote: quoted, mentions })
    pendingMessage.sendId = intent.id
    pendingMessage.sendState = intent.state
    if (intent.state === 'accepted') {
      pendingMessage.pending = false
      scheduleThreadRefresh(300)
      void fetchThreadMessages(thread.id, 'refresh')
    }
    else if (intent.state === 'failed' || intent.state === 'needs_review' || intent.state === 'cancelled') {
      pendingMessage.pending = false
      pendingMessage.sendError = intent.state === 'failed'
        ? sendFailureMessage(intent.errorCode)
        : (intent.state === 'needs_review' ? t('发送结果待确认，请检查聊天记录') : t('发送已取消'))
    }
    else {
      void pollSend(pendingMessage, intent.id)
    }
    touchMessages()
  }
  catch (error) {
    pendingMessage.pending = false
    pendingMessage.sendState = 'failed'
    pendingMessage.sendError = errorText(error)
    touchMessages()
  }
}

/** Message type, app type and fallback body of an outgoing attachment. */
export function localMediaType(kind: MediaKind, name: string): { type: number, appMessageType?: number, body: string } {
  switch (kind) {
    case 'image':
      return { type: 3, body: t('[图片]') }
    case 'video':
      return { type: 43, body: t('[视频]') }
    case 'voice':
      return { type: 34, body: t('[语音]') }
    default:
      return { type: 49, appMessageType: 6, body: name }
  }
}

async function sendAttachment(thread: Thread, attachment: StagedAttachment): Promise<void> {
  const current = getState().session.account
  if (!current)
    return
  const mediaInfo = localMediaType(attachment.kind, attachment.name)
  const media: LocalMedia = {
    kind: attachment.kind,
    url: attachment.previewUrl,
    name: attachment.name,
    size: attachment.size,
    contentType: attachment.file.type,
  }
  const local: LocalMessage = {
    id: `local-media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    accountId: current.id,
    threadId: thread.id,
    serverId: null,
    senderId: current.ownUsername ?? null,
    type: mediaInfo.type,
    appMessageType: mediaInfo.appMessageType,
    direction: 'outgoing',
    body: mediaInfo.body,
    createdAt: new Date().toISOString(),
    version: 'local',
    local: true,
    pending: true,
    sendState: 'uploading',
    localMedia: media,
  }

  setMessages(state => ({ items: [...state.items, local] }))
  // Sending marks the conversation read, matching the official client.
  thread.unreadCount = 0
  markThreadRead(thread)
  const pendingMessage = local
  handles.messageList?.scrollToBottom(true)

  try {
    const source = await wechatApi.uploadFile(current.id, attachment.file)
    pendingMessage.sendState = 'queued'
    const job = await wechatApi.sendMedia(current.id, thread.id, attachment.kind, source.id)
    pendingMessage.sendId = job.id
    pendingMessage.sendState = job.state
    touchMessages()
    void pollMediaJob(pendingMessage, job.id)
  }
  catch (error) {
    pendingMessage.pending = false
    pendingMessage.sendState = 'failed'
    pendingMessage.sendError = errorText(error)
    touchMessages()
  }
}

async function pollMediaJob(local: LocalMessage, jobId: string): Promise<void> {
  const current = getState().session.account
  if (!current)
    return
  for (let attempt = 0; attempt < 240; attempt++) {
    if (flags.disposed || local.sendError)
      return
    await sleep(1500)
    try {
      const job = await wechatApi.getJob(current.id, jobId)
      local.sendState = job.state
      if (job.serverMessageId)
        local.serverId = job.serverMessageId
      if (job.state === 'accepted') {
        local.pending = false
        touchMessages()
        scheduleThreadRefresh(300)
        if (getState().threads.activeThreadId === local.threadId)
          await fetchThreadMessages(local.threadId, 'refresh')
        return
      }
      if (job.state === 'failed' || job.state === 'needs_review' || job.state === 'cancelled'
        || job.state === 'expired' || job.state === 'unsupported') {
        local.pending = false
        const fallback = job.state === 'failed'
          ? t('发送失败，请稍后重试。')
          : job.state === 'needs_review'
            ? t('发送结果待确认，请检查聊天记录')
            : job.state === 'expired'
              ? t('发送已超时，请重新发送。')
              : job.state === 'unsupported'
                ? t('当前消息类型暂不支持发送。')
                : t('发送已取消')
        local.sendError = sendFailureMessage(job.reason, fallback)
        touchMessages()
        return
      }
      touchMessages()
    }
    catch (error) {
      // A clear authentication or not-found error ends polling; a network blip
      // keeps retrying.
      if (error instanceof WechatApiError
        && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409)) {
        local.pending = false
        local.sendState = 'failed'
        local.sendError = errorText(error)
        touchMessages()
        return
      }
    }
  }
  local.pending = false
  local.sendState = 'needs_review'
  local.sendError = t('发送结果待确认，请检查聊天记录')
  touchMessages()
}

/** Sends the draft text and every staged attachment. */
export async function sendMessage(): Promise<void> {
  const state = getState()
  const current = state.session.account
  const thread = selectActiveThread(state)
  if (!current || !thread)
    return
  const text = state.messages.draft.trim()
  const attachments = state.messages.attachments
  if (!text && attachments.length === 0)
    return

  setMessages({ draft: '', attachments: [] })
  handles.messageList?.scrollToBottom(true)

  if (text)
    void sendTextMessage(current, thread, text)
  for (const attachment of attachments)
    void sendAttachment(thread, attachment)
  handles.composer?.focus()
}

async function pollSend(local: LocalMessage, sendId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (flags.disposed || local.sendError)
      return
    if (local.sendState === 'accepted' || local.sendState === 'failed' || local.sendState === 'needs_review' || local.sendState === 'cancelled')
      break

    // The daemon returns as soon as the send is queued: poll tightly at first
    // and then back off, balancing state freshness against query cost.
    await sleep(attempt < 5 ? 150 : 700)
    try {
      const intent = await wechatApi.getSend(sendId)
      local.sendState = intent.state
      local.serverId = intent.serverId
      touchMessages()
      if (intent.state === 'accepted') {
        local.pending = false
        touchMessages()
        if (getState().threads.activeThreadId === local.threadId)
          await fetchThreadMessages(local.threadId, 'refresh')
        break
      }
      if (intent.state === 'failed') {
        local.pending = false
        local.sendError = sendFailureMessage(intent.errorCode)
        touchMessages()
        break
      }
      if (intent.state === 'needs_review') {
        local.pending = false
        local.sendError = t('发送结果待确认，请检查聊天记录')
        touchMessages()
        break
      }
      if (intent.state === 'cancelled') {
        local.pending = false
        local.sendError = t('发送已取消')
        touchMessages()
        break
      }
    }
    catch {
      // A single failed query keeps retrying; the send still has to be
      // reconciled by its task id.
    }
  }

  if (local.sendState === 'queued' || local.sendState === 'submitting') {
    local.pending = false
    local.sendState = 'accepted'
    touchMessages()
    if (getState().threads.activeThreadId === local.threadId)
      await fetchThreadMessages(local.threadId, 'refresh')
  }
}

