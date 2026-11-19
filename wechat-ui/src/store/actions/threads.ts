// The conversation list, the open conversation, read state and the contact
// directory that feeds names and the stranger banner.

import { wechatApi, WechatApiError } from '../../api'
import { compareMessages, threadName, threadNoNotify } from '../../format'
import { t } from '../../i18n'
import { specialAvatarFor } from '../../special-avatars'
import type { Contact, Thread, ThreadFilter } from '../../types'
import {
  DIRECTORY_REFRESH_INTERVAL,
  MESSAGE_PAGE_SIZE,
  PAGE_SIZE,
  THREAD_READ_CURSOR_LIMIT,
  WARM_FETCH_INTERVAL,
  WARM_THREAD_LIMIT,
  WARM_TRIGGER_INTERVAL,
  clearTimer,
  counters,
  flags,
  handles,
  recentMessages,
  refreshedProfiles,
  threadMessagesCache,
  timers,
} from '../caches'
import { getState, setMessages, setThreads, type AppState } from '../state'
import { loadMediaForMessages } from './media'
import {
  cacheThreadMessages,
  ensureGroupMembers,
  fetchThreadMessages,
  persistSessionData,
  revokeAllLocalMedia,
} from './messages'
import { errorText, isSignedIn, sleep } from './session'
import { dismissToast, setRailView } from './ui'

export const READ_CURSOR_KEY = 'vane.wechat.read-cursor'
export const DIRECTORY_CACHE_KEY = 'vane.wechat.directory-cache'

const NON_PERSONAL_CATEGORIES = new Set(['system', 'business', 'openim', 'openimCustomerService', 'group'])

/** The conversation that is currently open. */
export function selectActiveThread(state: AppState = getState()): Thread | null {
  const id = state.threads.activeThreadId
  if (!id)
    return null
  return state.threads.items.find(thread => thread.id === id) ?? null
}

/** Narrow layouts show either the list or the conversation, never both. */
export function selectMobileChatOpen(state: AppState = getState()): boolean {
  return state.threads.isNarrow && state.threads.activeThreadId !== null
}

/** Unread badge of the rail. Muted and official conversations are excluded. */
export function selectUnreadTotal(state: AppState = getState()): number {
  return state.threads.items.reduce(
    (sum, thread) => sum + (threadNoNotify(thread) ? 0 : (thread.unreadCount ?? 0)),
    0,
  )
}

/** True when the open conversation is a WeChat group. */
export function selectActiveThreadIsGroup(state: AppState = getState()): boolean {
  const thread = selectActiveThread(state)
  return Boolean(thread && thread.kind === 'group' && thread.peerId.endsWith('@chatroom'))
}

/** Official accounts (gh_) only receive: the composer is hidden. */
export function selectActiveThreadIsOfficial(state: AppState = getState()): boolean {
  return (selectActiveThread(state)?.peerId ?? '').trim().startsWith('gh_')
}

/** Peer username shown in the conversation details, when there is one. */
export function selectDetailsPeerId(state: AppState = getState()): string {
  const thread = selectActiveThread(state)
  if (!thread || thread.kind === 'group' || thread.kind === 'system')
    return ''
  return (thread.peerId || thread.id).trim()
}

/** Name of the peer in the details panel: contact profile first, then thread. */
export function selectContactProfileName(state: AppState = getState()): string {
  const contact = state.threads.contactProfile
  if (contact) {
    return contact.displayName?.trim()
      || contact.remark?.trim()
      || contact.nickname?.trim()
      || contact.username
      || contact.id
  }
  const thread = selectActiveThread(state)
  return thread ? threadName(thread) : ''
}

let businessUsernamesCache: { source: Contact[], value: Set<string> } | null = null

/**
 * Brand service accounts (Meituan, Luckin and other wxid customer-service
 * accounts). They are not gh_ prefixed, so the directory classification is the
 * only signal that folds them into the service entry.
 */
export function selectBusinessUsernames(state: AppState = getState()): Set<string> {
  const contacts = state.threads.directoryContacts
  if (businessUsernamesCache && businessUsernamesCache.source === contacts)
    return businessUsernamesCache.value
  const set = new Set<string>()
  for (const contact of contacts) {
    if (contact.classification?.category === 'business' && contact.username)
      set.add(contact.username)
  }
  businessUsernamesCache = { source: contacts, value: set }
  return set
}

/** True when the direct-message peer is not a confirmed friend yet. */
export function selectPeerIsStranger(state: AppState = getState()): boolean {
  if (!state.threads.directoryReady)
    return false
  // While the contact sync is still incomplete the profile holds partial rows
  // and the banner would fire for everyone.
  if (state.session.account?.contactSyncReady === false)
    return false
  const thread = selectActiveThread(state)
  if (!thread || thread.kind !== 'direct')
    return false
  const peer = (thread.peerId || thread.id).trim()
  if (!peer)
    return false
  // Official accounts and WeCom service conversations do not need friendship.
  if (peer.startsWith('gh_') || peer.endsWith('@openim'))
    return false
  // Built-in system accounts (file transfer, WeChat Team, voice notes) and
  // brand service accounts have no friendship either.
  if (specialAvatarFor(peer, thread.displayName) || selectBusinessUsernames(state).has(peer))
    return false
  return !state.threads.friendNames.has(peer)
}

/** Notifies subscribers after a thread object was mutated in place. */
export function touchThreads(): void {
  setThreads(state => ({ items: [...state.items] }))
}

/** Reloads the conversation list; concurrent calls are collapsed. */
export async function loadThreads(): Promise<void> {
  const current = getState().session.account
  // Offline slots still refresh: only the daemon holds the authoritative unread
  // counts and read-state versions, so skipping would keep stale badges and make
  // every read report conflict.
  if (!current || !isSignedIn(current) || flags.threadsInFlight)
    return
  flags.threadsInFlight = true
  setThreads({ loading: true, error: '' })
  try {
    const response = await wechatApi.listThreads(current.id, PAGE_SIZE)
    const items = response.items ?? []
    const state = getState()
    // The mark-all-read cursor suppresses backfilled history unread counts.
    if (state.threads.allReadAt)
      items.forEach((thread) => { thread.unreadCount = suppressReadCursor(thread.unreadCount ?? 0, thread) })
    // The open conversation always renders as read: an automatic read report may
    // still be retrying, and a lagging count must not reappear.
    if (state.threads.activeThreadId)
      items.forEach((thread) => { if (thread.id === state.threads.activeThreadId) thread.unreadCount = 0 })
    const active = selectActiveThread(state)
    const draft = active?.isDraft ? active : null
    // Keep a local draft conversation that the upstream list does not know yet,
    // so the list does not jump away after the first message.
    setThreads({ items: draft && !items.some(thread => thread.id === draft.id) ? [draft, ...items] : items })
    applyContactNames()
    persistSessionData()
    reconcileActiveThread()
    // Once the list is ready, warm the recent conversation windows.
    warmRecentThreads()
  }
  catch (error) {
    setThreads({ error: errorText(error) })
  }
  finally {
    flags.threadsInFlight = false
    setThreads({ loading: false })
  }
}

/**
 * Warms the message windows of the most recent conversations in the
 * background. The daemon takes seconds to decode a conversation the first
 * time, so warming makes the first click instant. Only caches are written.
 */
export function warmRecentThreads(): void {
  const current = getState().session.account
  if (!current?.authenticated || flags.disposed)
    return
  if (Date.now() - flags.lastWarmTrigger < WARM_TRIGGER_INTERVAL)
    return
  flags.lastWarmTrigger = Date.now()
  const generation = ++counters.warmGeneration
  void (async () => {
    const state = getState()
    for (const thread of state.threads.items.slice(0, WARM_THREAD_LIMIT)) {
      if (generation !== counters.warmGeneration || flags.disposed)
        return
      if (thread.id === getState().threads.activeThreadId)
        continue
      if (threadMessagesCache.has(thread.id) || recentMessages.has(thread.id))
        continue
      try {
        const response = await wechatApi.listMessages(current.id, thread.id, MESSAGE_PAGE_SIZE, undefined)
        if (generation !== counters.warmGeneration || flags.disposed)
          return
        const items = (response.items ?? []).slice().sort(compareMessages)
        const cursor = response.nextCursor ?? null
        threadMessagesCache.delete(thread.id)
        threadMessagesCache.set(thread.id, { items, cursor })
        recentMessages.set(thread.id, { items, cursor })
      }
      catch {
        // Warming is silent; a click falls back to the normal load path.
      }
      await sleep(WARM_FETCH_INTERVAL)
    }
  })()
}

/** Falls back to the first conversation when the open one disappeared. */
export function reconcileActiveThread(): void {
  const state = getState()
  const activeThreadId = state.threads.activeThreadId
  const existing = activeThreadId
    ? state.threads.items.find(thread => thread.id === activeThreadId)
    : null
  if (existing)
    return
  // Staged loading: entering the app never opens a conversation automatically;
  // only an open conversation removed upstream falls back to the first row.
  if (!activeThreadId)
    return
  const first = state.threads.items[0]
  if (first) {
    void selectThread(first)
    return
  }
  setThreads({ activeThreadId: null })
  setMessages({ items: [], cursor: null })
}

/** Schedules one conversation list refresh (events arrive in bursts). */
export function scheduleThreadRefresh(delay = 350): void {
  timers.threads = clearTimer(timers.threads)
  timers.threads = window.setTimeout(() => {
    void loadThreads()
  }, delay)
}

/** Opens a conversation, painting cached messages before refreshing. */
export async function selectThread(thread: Thread): Promise<void> {
  const state = getState()
  if (state.threads.activeThreadId === thread.id) {
    // The open conversation still shows unread: the last read report failed
    // (version conflict), so a second click retries instead of doing nothing.
    if ((thread.unreadCount ?? 0) > 0)
      markThreadRead(thread)
    return
  }
  thread.unreadCount = 0
  setThreads({ activeThreadId: thread.id, detailsOpen: false })
  setMessages({
    unseenBelow: 0,
    replyTo: null,
    searchOpen: false,
    searchQuery: '',
    searchResults: [],
    highlightId: null,
    error: '',
  })
  revokeAllLocalMedia()
  // Pre-fetch the member list of a group so the mention picker is instant.
  void ensureGroupMembers(thread.id)
  // Direct conversations fetch the authoritative profile: remarks only land in
  // the local directory through GetContact.
  const peer = (thread.peerId || thread.id).trim()
  if (thread.kind === 'direct' && !peer.startsWith('gh_') && !peer.endsWith('@openim'))
    void refreshContactAuthoritative(peer)
  // Cache hit: show the cached window instantly and refresh in the background.
  const cached = threadMessagesCache.get(thread.id)
  if (cached) {
    threadMessagesCache.delete(thread.id)
    threadMessagesCache.set(thread.id, cached)
    setMessages({ items: cached.items, cursor: cached.cursor })
    // Cached messages were never looked up for media: load progressively.
    void loadMediaForMessages(cached.items)
    void fetchThreadMessages(thread.id, 'refresh')
  }
  else if (recentMessages.has(thread.id)) {
    // After a reload the memory cache is empty: paint the persisted window and
    // merge the refresh in the background.
    const persisted = recentMessages.get(thread.id)!
    const items = persisted.items.map(item => ({ ...item }))
    setMessages({ items, cursor: persisted.cursor })
    cacheThreadMessages(thread.id)
    void loadMediaForMessages(items)
    void fetchThreadMessages(thread.id, 'refresh')
  }
  else {
    setMessages({ items: [], cursor: null })
    await fetchThreadMessages(thread.id, 'reset')
  }
  markThreadRead(thread)
  handles.composer?.focus()
}

/** Loads the contact profile of the peer shown in the details panel. */
export async function loadContactProfile(): Promise<void> {
  const state = getState()
  const current = state.session.account
  const username = selectDetailsPeerId(state)
  const token = ++counters.contactProfileRequest
  setThreads({ contactProfile: null, contactProfileError: '' })
  if (!current || !username) {
    setThreads({ contactProfileLoading: false })
    return
  }
  setThreads({ contactProfileLoading: true })
  try {
    const contact = await wechatApi.getContact(current.id, username)
    if (token !== counters.contactProfileRequest)
      return
    setThreads({ contactProfile: contact })
  }
  catch (error) {
    if (token !== counters.contactProfileRequest)
      return
    setThreads({
      contactProfileError: error instanceof WechatApiError && error.status === 404
        ? t('通讯录中还没有这位联系人的资料。')
        : errorText(error),
    })
  }
  finally {
    if (token === counters.contactProfileRequest)
      setThreads({ contactProfileLoading: false })
  }
}

/** Drops the loaded contact profile (details panel closed or peer changed). */
export function resetContactProfile(): void {
  counters.contactProfileRequest += 1
  setThreads({ contactProfile: null, contactProfileError: '', contactProfileLoading: false })
}

/** Focuses the search field of the visible side panel. */
export function focusThreadSearch(): void {
  if (getState().ui.railView === 'contacts')
    handles.contactsPanel?.focusSearch()
  else
    handles.threadList?.focusSearch()
}

/** Marks the open conversation read from the details panel. */
export function markActiveThreadRead(): void {
  const thread = selectActiveThread()
  if (!thread)
    return
  thread.unreadCount = 0
  touchThreads()
  markThreadRead(thread)
  setThreads({ detailsOpen: false })
}

/** Opens the contact search dialog for a new conversation. */
export function openNewChat(): void {
  setThreads({ contactDialogOpen: true })
}

/** Starts (or opens) a conversation with a directory contact. */
export function startChatWithContact(contact: Contact): void {
  const id = (contact.username || contact.id).trim()
  if (!id)
    return
  startDraftChat(
    id,
    contact.displayName?.trim()
      || contact.remark?.trim()
      || contact.nickname?.trim()
      || id,
  )
}

/** Starts (or opens) a conversation by raw username or id. */
export function startChatWithId(rawId: string): void {
  const id = rawId.trim()
  if (!id)
    return
  startDraftChat(id, id)
}

/** Opens an existing conversation or creates a local draft conversation. */
export function startDraftChat(id: string, displayName: string): void {
  const state = getState()
  const current = state.session.account
  if (!current)
    return
  setThreads({ contactDialogOpen: false })
  setRailView('chats')
  setThreads({ filterMode: 'all', query: '' })

  const existing = state.threads.items.find(thread => thread.id === id)
  if (existing) {
    void selectThread(existing)
    return
  }

  const draftThread: Thread = {
    id,
    accountId: current.id,
    peerId: id,
    kind: 'direct',
    displayName,
    unreadCount: 0,
    muted: false,
    pinned: false,
    readStateVersion: '',
    lastMessage: null,
    avatarMembers: [],
    isDraft: true,
  }
  setThreads(state => ({ items: [draftThread, ...state.items] }))
  void selectThread(draftThread)
}

/** Reports the conversation as read and stamps the local read cursor. */
export function markThreadRead(thread: Thread): void {
  const current = getState().session.account
  if (!current)
    return
  // The user has seen the messages here: stamp the cursor regardless of whether
  // the daemon report succeeds, so a reload cannot resurrect stale unread.
  stampThreadRead(thread.id)
  // The unread count lives on the thread object and is cleared in place, so the
  // list has to be notified explicitly.
  touchThreads()
  if (!thread.readStateVersion)
    return
  void wechatApi.markThreadRead(current.id, thread.id, thread.readStateVersion)
    .then((result) => {
      // A successful read advances the daemon read-state version; keep it in
      // sync so later reports do not conflict and other rows do not lag.
      if (result?.version)
        thread.readStateVersion = result.version
    })
    .catch(() => {
      // Read reporting is best effort. On a version conflict fetch the current
      // version once and report again, otherwise the background sync keeps the
      // unread count on the daemon side.
      window.setTimeout(() => {
        if (flags.disposed)
          return
        const fresh = getState().threads.items.find(item => item.id === thread.id)
        if (fresh?.readStateVersion)
          void wechatApi.markThreadRead(current.id, fresh.id, fresh.readStateVersion).catch(() => {})
      }, 1_200)
    })
}

/** Debounces the automatic read report for the open conversation. */
export function scheduleAutoRead(thread: Thread): void {
  flags.autoReadThread = thread
  if (timers.autoRead !== null)
    return
  timers.autoRead = window.setTimeout(() => {
    timers.autoRead = null
    const target = flags.autoReadThread
    flags.autoReadThread = null
    // Report with the newest object from the list: its version may have moved.
    const fresh = target ? getState().threads.items.find(item => item.id === target.id) : undefined
    if (fresh)
      markThreadRead(fresh)
  }, 400)
}

/** Records the per-conversation read cursor, trimmed to the newest entries. */
export function stampThreadRead(threadId: string): void {
  if (!threadId)
    return
  const next: Record<string, number> = { ...getState().threads.readAt, [threadId]: Date.now() }
  const entries = Object.entries(next)
  const trimmed = entries.length > THREAD_READ_CURSOR_LIMIT
    ? Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, THREAD_READ_CURSOR_LIMIT))
    : next
  setThreads({ readAt: trimmed })
  persistReadCursor()
}

/** Persists the read cursors for the current account. */
export function persistReadCursor(): void {
  try {
    const state = getState()
    if (!state.threads.allReadAt && Object.keys(state.threads.readAt).length === 0)
      return
    window.localStorage.setItem(READ_CURSOR_KEY, JSON.stringify({
      allReadAt: state.threads.allReadAt,
      threadReadAt: state.threads.readAt,
      ownUsername: state.session.account?.ownUsername ?? flags.cachedOwnUsername,
    }))
  }
  catch {
    // A failed write only affects read badges after the next reload.
  }
}

/** Restores the read cursors written by an earlier page load. */
export function loadReadCursor(): void {
  try {
    const raw = window.localStorage.getItem(READ_CURSOR_KEY)
    if (!raw)
      return
    const parsed = JSON.parse(raw) as {
      allReadAt?: unknown
      threadReadAt?: unknown
      ownUsername?: unknown
    }
    if (parsed.ownUsername && flags.cachedOwnUsername && parsed.ownUsername !== flags.cachedOwnUsername)
      return
    const patch: { allReadAt?: number, readAt?: Record<string, number> } = {}
    if (typeof parsed.allReadAt === 'number' && parsed.allReadAt > 0)
      patch.allReadAt = parsed.allReadAt
    if (parsed.threadReadAt && typeof parsed.threadReadAt === 'object') {
      const restored: Record<string, number> = {}
      for (const [id, at] of Object.entries(parsed.threadReadAt as Record<string, unknown>)) {
        if (typeof at === 'number' && at > 0)
          restored[id] = at
      }
      patch.readAt = restored
    }
    setThreads(patch)
  }
  catch {
    // A corrupt cursor falls back to the daemon counts.
  }
}

/** Suppresses a backfilled unread count that predates a read cursor. */
export function suppressReadCursor(unreadCount: number, thread: Thread): number {
  if (!unreadCount)
    return unreadCount
  const latestAt = Date.parse(thread.lastMessage?.createdAt ?? '')
  if (!Number.isFinite(latestAt))
    return unreadCount
  const state = getState().threads
  if (state.allReadAt && latestAt < state.allReadAt)
    return 0
  const readAt = state.readAt[thread.id]
  if (readAt && latestAt < readAt)
    return 0
  return unreadCount
}

/**
 * Clears the unread state of every conversation on the daemon, one
 * conversation per round: readStateVersion is a global cursor, so any read
 * invalidates the versions of the other rows.
 */
export async function syncAllThreadsReadToDaemon(): Promise<void> {
  const current = getState().session.account
  if (!current)
    return
  for (let round = 0; round < 40 && !flags.disposed; round++) {
    try {
      const response = await wechatApi.listThreads(current.id, PAGE_SIZE)
      if (flags.disposed)
        return
      const target = (response.items ?? []).find(thread =>
        (thread.unreadCount ?? 0) > 0 && thread.readStateVersion)
      if (!target)
        return
      await wechatApi.markThreadRead(current.id, target.id, target.readStateVersion)
    }
    catch {
      // A 409 or a network blip: the next round reloads the version.
    }
    await sleep(1_500)
  }
}

/** Marks every conversation read locally and syncs the daemon in background. */
export function markAllThreadsRead(): void {
  const state = getState()
  for (const thread of state.threads.items)
    thread.unreadCount = 0
  setMessages({ unseenBelow: 0 })
  for (const toast of [...state.ui.toasts])
    dismissToast(toast.id)
  setThreads({ items: [...state.threads.items], allReadAt: Date.now() })
  persistReadCursor()
  // Sync the daemon even when the cursor already cleared the interface: the
  // unread state may only exist there or on another device.
  if (flags.readSyncRunning)
    return
  flags.readSyncRunning = true
  void syncAllThreadsReadToDaemon().finally(() => {
    flags.readSyncRunning = false
  })
}

/** Returns to the conversation list (narrow layouts). */
export function goBackToList(): void {
  setThreads({ detailsOpen: false, activeThreadId: null })
  setMessages({ searchOpen: false })
}

/** Applies the narrow (phone) layout flag from the media query. */
export function setNarrow(isNarrow: boolean): void {
  setThreads({ isNarrow })
}

/** Sets the conversation list filter query. */
export function setThreadQuery(query: string): void {
  setThreads({ query })
}

/** Sets the conversation list filter tab. */
export function setFilterMode(filterMode: ThreadFilter): void {
  setThreads({ filterMode })
}

/** Opens or closes the conversation details panel. */
export function setDetailsOpen(open: boolean): void {
  setThreads({ detailsOpen: open })
}

/** Toggles the conversation details panel. */
export function toggleDetails(): void {
  setThreads(state => ({ detailsOpen: !state.detailsOpen }))
}

/** Personal contacts only: official, business, system and group rows excluded. */
function isPersonalCategory(contact: Contact): boolean {
  const category = contact.classification?.category ?? 'unknown'
  return !NON_PERSONAL_CATEGORIES.has(category)
}

/** Keeps only the fields the interface and the classification need. */
function slimContact(contact: Contact): Contact {
  return {
    id: contact.id,
    username: contact.username,
    displayName: contact.displayName,
    nickname: contact.nickname,
    remark: contact.remark,
    alias: contact.alias,
    localType: contact.localType,
    classification: contact.classification
      ? {
          category: contact.classification.category,
          businessKind: contact.classification.businessKind,
        }
      : undefined,
  }
}

/** Persists the full directory snapshot under its own storage key. */
export function persistDirectoryCache(): void {
  try {
    const state = getState()
    window.localStorage.setItem(DIRECTORY_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      ownUsername: state.session.account?.ownUsername ?? flags.cachedOwnUsername,
      contacts: state.threads.directoryContacts.map(slimContact),
    }))
  }
  catch {
    // Over quota or private mode: the in-memory directory still works.
  }
}

/**
 * Loads the full contact directory. Without `force` the reload is throttled:
 * contacts.updated fires repeatedly during a profile sync.
 */
export async function loadContactDirectory(force = false): Promise<void> {
  const current = getState().session.account
  if (!current?.authenticated)
    return
  if (!force && Date.now() - flags.lastDirectoryLoad < DIRECTORY_REFRESH_INTERVAL)
    return
  try {
    const items: Contact[] = []
    let cursor: string | null = null
    // No ten-page cap: with more than 2000 contacts the remainder would look
    // like strangers. Forty pages is only a guard against a looping cursor.
    for (let page = 0; page < 40; page++) {
      const response = await wechatApi.listContacts(current.id, '', 200, cursor)
      items.push(...(response.items ?? []))
      cursor = response.nextCursor ?? null
      if (!cursor)
        break
    }
    const confirmedFriends = items.filter(item => item.localType != null && isPersonalCategory(item))
    const known = confirmedFriends.length > 0
      ? confirmedFriends
      : items.filter(item => isPersonalCategory(item) && !(item.username ?? '').endsWith('@chatroom'))
    const friends = new Set<string>()
    const names = new Map<string, string>()
    for (const contact of known) {
      const key = contact.username || contact.id
      if (!key)
        continue
      friends.add(key)
      const display = contact.displayName?.trim() || contact.nickname?.trim() || ''
      if (display && display !== key)
        names.set(key, display)
    }
    setThreads({ friendNames: friends, contactNames: names, directoryContacts: items })
    applyContactNames()
    flags.lastDirectoryLoad = Date.now()
    persistDirectoryCache()
    persistSessionData()
    setThreads({ directoryReady: true })
  }
  catch {
    // A failed load stays "not ready": better no banner than a false one.
  }
}

/**
 * Fetches the authoritative profile of one contact when a direct conversation
 * opens. Remark-like fields only arrive through GetContact; the directory and
 * the list names update once it succeeds.
 */
export async function refreshContactAuthoritative(username: string): Promise<void> {
  const current = getState().session.account
  if (!current?.authenticated || refreshedProfiles.has(username))
    return
  refreshedProfiles.add(username)
  try {
    let operation = await wechatApi.refreshContactProfile(current.id, username)
    for (let attempt = 0; attempt < 20 && !isTerminalOperation(operation.state); attempt++) {
      await sleep(600)
      operation = await wechatApi.getOperation(current.id, operation.id)
    }
    if (operation.state === 'succeeded')
      void loadContactDirectory(true)
  }
  catch {
    // Offline or the endpoint is not ready: contacts.updated still refreshes.
  }
}

function isTerminalOperation(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired'
}

/** Overrides raw conversation titles with names from the local directory. */
export function applyContactNames(): void {
  const state = getState()
  if (state.threads.contactNames.size === 0 || state.threads.items.length === 0)
    return
  for (const thread of state.threads.items) {
    if (thread.isDraft)
      continue
    const current = thread.displayName?.trim() ?? ''
    const resolved = state.threads.contactNames.get(thread.peerId || thread.id)
    if (resolved && current !== resolved)
      thread.displayName = resolved
  }
}
