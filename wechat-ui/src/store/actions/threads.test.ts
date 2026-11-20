import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wechatApi, WechatApiError } from '../../api'
import { t } from '../../i18n'
import type { AccountSummary, Contact, Message, Thread } from '../../types'
import {
  DIRECTORY_REFRESH_INTERVAL,
  PAGE_SIZE,
  THREAD_READ_CURSOR_LIMIT,
  flags,
  recentMessages,
  registerComposerHandle,
  resetCaches,
  threadMessagesCache,
} from '../caches'
import { getState, initialState, setMessages, setSession, setThreads, setUi, store } from '../state'
import {
  DIRECTORY_CACHE_KEY,
  READ_CURSOR_KEY,
  applyContactNames,
  goBackToList,
  loadContactDirectory,
  loadContactProfile,
  loadReadCursor,
  loadThreads,
  markActiveThreadRead,
  markAllThreadsRead,
  markThreadRead,
  openNewChat,
  persistReadCursor,
  reconcileActiveThread,
  refreshContactAuthoritative,
  resetContactProfile,
  scheduleAutoRead,
  scheduleThreadRefresh,
  selectActiveThreadIsGroup,
  selectActiveThreadReceivesOnly,
  selectBusinessUsernames,
  selectContactProfileName,
  selectDetailsPeerId,
  selectMobileChatOpen,
  selectPeerIsStranger,
  selectThread,
  selectUnreadTotal,
  setDetailsOpen,
  setFilterMode,
  setNarrow,
  setThreadQuery,
  startChatWithContact,
  startChatWithId,
  startDraftChat,
  stampThreadRead,
  suppressReadCursor,
  syncAllThreadsReadToDaemon,
  toggleDetails,
  warmRecentThreads,
} from './threads'

function account(patch: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: 'account-1',
    alias: null,
    authenticated: true,
    connection: 'connected',
    ownUsername: 'wxid_self',
    ...patch,
  }
}

function thread(patch: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    accountId: 'account-1',
    peerId: 'peer-1',
    kind: 'direct',
    displayName: 'Peer One',
    unreadCount: 0,
    readStateVersion: '',
    lastMessage: null,
    avatarMembers: [],
    ...patch,
  }
}

function preview(createdAt: string, text = 'hi') {
  return {
    id: 'preview-1',
    senderId: 'peer-1',
    senderName: null,
    direction: 'incoming',
    type: 1,
    text,
    createdAt,
  }
}

function contact(patch: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    username: 'peer-1',
    displayName: 'Peer Name',
    ...patch,
  }
}

function message(patch: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    accountId: 'account-1',
    threadId: 'thread-1',
    serverId: 'server-1',
    senderId: 'peer-1',
    type: 1,
    direction: 'incoming',
    body: 'hello',
    createdAt: '2026-05-05T10:00:00.000Z',
    version: 'v1',
    ...patch,
  }
}

function resetStore(): void {
  store.setState(() => ({
    session: { ...initialState.session },
    threads: { ...initialState.threads, contactNames: new Map(), friendNames: new Set(), readAt: {} },
    messages: { ...initialState.messages, mediaByMessage: {}, attachments: [], searchResults: [] },
    ui: { ...initialState.ui, toasts: [] },
  }))
}

function resetFlags(): void {
  flags.disposed = false
  flags.bootedAt = Date.now()
  flags.streamActive = false
  flags.threadsInFlight = false
  flags.readSyncRunning = false
  flags.lastCursor = null
  flags.messageRefreshInFlight = null
  flags.autoReadThread = null
  // Suppress the background warm-up unless a test drives it explicitly.
  flags.lastWarmTrigger = Date.now()
  flags.cachedOwnUsername = ''
  flags.lastDirectoryLoad = 0
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++)
    await Promise.resolve()
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolveFn) => { resolve = resolveFn })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  resetStore()
  resetCaches()
  resetFlags()
  registerComposerHandle(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetCaches()
  resetFlags()
  registerComposerHandle(null)
  window.localStorage.clear()
  vi.useRealTimers()
})

describe('thread selectors', () => {
  it('sums unread counts but ignores muted and official rows', () => {
    setThreads({
      items: [
        thread({ id: 'a', unreadCount: 2 }),
        thread({ id: 'b', unreadCount: 5, muted: true }),
        thread({ id: 'c', unreadCount: 7, peerId: 'gh_official' }),
        thread({ id: 'd', unreadCount: 3, peerId: 'peer-d' }),
        thread({ id: 'e', unreadCount: null }),
      ],
    })
    expect(selectUnreadTotal()).toBe(5)
  })

  it('detects group conversations by kind and @chatroom peer id', () => {
    setThreads({ items: [thread({ kind: 'group', peerId: 'room@chatroom' })], activeThreadId: 'thread-1' })
    expect(selectActiveThreadIsGroup()).toBe(true)

    setThreads({ items: [thread({ kind: 'group', peerId: 'group-peer' })] })
    expect(selectActiveThreadIsGroup()).toBe(false)

    setThreads({ items: [thread()] })
    expect(selectActiveThreadIsGroup()).toBe(false)
  })

  it('hides the composer for receive-only conversations', () => {
    setThreads({ items: [thread({ peerId: ' gh_abc ' })], activeThreadId: 'thread-1' })
    expect(selectActiveThreadReceivesOnly()).toBe(true)
    setThreads({ items: [thread({ peerId: 'fmessage' })] })
    expect(selectActiveThreadReceivesOnly()).toBe(true)
    setThreads({ items: [thread({ peerId: 'peer-1' })] })
    expect(selectActiveThreadReceivesOnly()).toBe(false)
  })

  it('shows a peer id in the details panel only for direct conversations', () => {
    setThreads({ items: [thread({ peerId: 'peer-1' })], activeThreadId: 'thread-1' })
    expect(selectDetailsPeerId()).toBe('peer-1')

    setThreads({ items: [thread({ peerId: '  ' })] })
    expect(selectDetailsPeerId()).toBe('')

    setThreads({ items: [thread({ kind: 'group', peerId: 'room@chatroom' })] })
    expect(selectDetailsPeerId()).toBe('')
    setThreads({ items: [thread({ kind: 'system', peerId: 'sys' })] })
    expect(selectDetailsPeerId()).toBe('')
  })

  it('prefers the loaded contact profile for the details name', () => {
    setThreads({ items: [thread({ displayName: 'Thread Name' })], activeThreadId: 'thread-1' })
    expect(selectContactProfileName()).toBe('Thread Name')

    setThreads({ contactProfile: contact({ displayName: '  ', remark: 'Remark', nickname: 'Nick', username: 'peer-1' }) })
    expect(selectContactProfileName()).toBe('Remark')

    setThreads({ contactProfile: contact({ displayName: null, remark: null, nickname: 'Nick' }) })
    expect(selectContactProfileName()).toBe('Nick')

    setThreads({ contactProfile: contact({ displayName: null, remark: null, nickname: null, username: 'wxid_only' }) })
    expect(selectContactProfileName()).toBe('wxid_only')

    setThreads({ contactProfile: null, activeThreadId: null })
    expect(selectContactProfileName()).toBe('')
  })

  it('collects brand service usernames from the directory classification', () => {
    setThreads({
      directoryContacts: [
        contact({ id: 'c1', username: 'wxid_shop', classification: { category: 'business' } }),
        contact({ id: 'c2', username: 'wxid_friend', classification: { category: 'friend' } }),
        contact({ id: 'c3', username: '', classification: { category: 'business' } }),
      ],
    })
    expect([...selectBusinessUsernames()]).toEqual(['wxid_shop'])
  })

  it('opens the conversation pane only on narrow layouts with an active row', () => {
    setThreads({ isNarrow: true, activeThreadId: 'thread-1' })
    expect(selectMobileChatOpen()).toBe(true)
    setThreads({ isNarrow: true, activeThreadId: null })
    expect(selectMobileChatOpen()).toBe(false)
    setThreads({ isNarrow: false, activeThreadId: 'thread-1' })
    expect(selectMobileChatOpen()).toBe(false)
  })
})

describe('selectPeerIsStranger', () => {
  beforeEach(() => {
    setSession({ account: account() })
  })

  it('stays quiet until the directory is ready', () => {
    setThreads({ items: [thread()], activeThreadId: 'thread-1', directoryReady: false })
    expect(selectPeerIsStranger()).toBe(false)
    setThreads({ directoryReady: true })
    expect(selectPeerIsStranger()).toBe(true)
  })

  it('stays quiet while the contact sync is incomplete', () => {
    setSession({ account: account({ contactSyncReady: false }) })
    setThreads({ items: [thread()], activeThreadId: 'thread-1', directoryReady: true })
    expect(selectPeerIsStranger()).toBe(false)
  })

  it('never flags non-direct conversations or service accounts', () => {
    setThreads({ items: [thread({ kind: 'group', peerId: 'room@chatroom' })], activeThreadId: 'thread-1', directoryReady: true })
    expect(selectPeerIsStranger()).toBe(false)

    setThreads({ items: [thread({ peerId: 'gh_official' })], activeThreadId: 'thread-1' })
    expect(selectPeerIsStranger()).toBe(false)

    setThreads({ items: [thread({ peerId: 'wxid_kefu@openim' })], activeThreadId: 'thread-1' })
    expect(selectPeerIsStranger()).toBe(false)

    setThreads({ items: [thread({ peerId: 'filehelper', displayName: 'File Transfer' })], activeThreadId: 'thread-1' })
    expect(selectPeerIsStranger()).toBe(false)

    setThreads({
      items: [thread({ peerId: 'wxid_shop' })],
      activeThreadId: 'thread-1',
      directoryContacts: [contact({ id: 'shop', username: 'wxid_shop', classification: { category: 'business' } })],
    })
    expect(selectPeerIsStranger()).toBe(false)
  })

  it('flags a direct peer that is not a confirmed friend', () => {
    setThreads({ items: [thread({ peerId: 'wxid_stranger' })], activeThreadId: 'thread-1', directoryReady: true })
    expect(selectPeerIsStranger()).toBe(true)

    setThreads({ friendNames: new Set(['wxid_stranger']) })
    expect(selectPeerIsStranger()).toBe(false)
  })
})

describe('suppressReadCursor', () => {
  const lastMessageAt = '2026-05-05T10:00:00.000Z'

  it('leaves zero and unparsable unread counts alone', () => {
    setThreads({ allReadAt: Date.now(), readAt: {} })
    expect(suppressReadCursor(0, thread())).toBe(0)
    expect(suppressReadCursor(4, thread({ lastMessage: null }))).toBe(4)
    expect(suppressReadCursor(4, thread({ lastMessage: preview('not-a-date') }))).toBe(4)
  })

  it('drops a count whose newest message predates the global all-read cursor', () => {
    const cursor = Date.parse('2026-05-06T00:00:00.000Z')
    setThreads({ allReadAt: cursor, readAt: {} })
    expect(suppressReadCursor(5, thread({ lastMessage: preview(lastMessageAt) }))).toBe(0)

    setThreads({ allReadAt: Date.parse('2026-05-04T00:00:00.000Z') })
    expect(suppressReadCursor(5, thread({ lastMessage: preview(lastMessageAt) }))).toBe(5)
  })

  it('drops a count older than the per-conversation read cursor', () => {
    setThreads({ allReadAt: 0, readAt: { 'thread-1': Date.parse('2026-05-06T00:00:00.000Z') } })
    expect(suppressReadCursor(3, thread({ id: 'thread-1', lastMessage: preview(lastMessageAt) }))).toBe(0)
    // Other conversations are unaffected by this cursor.
    expect(suppressReadCursor(3, thread({ id: 'thread-2', lastMessage: preview(lastMessageAt) }))).toBe(3)

    setThreads({ readAt: { 'thread-1': Date.parse('2026-05-04T00:00:00.000Z') } })
    expect(suppressReadCursor(3, thread({ id: 'thread-1', lastMessage: preview(lastMessageAt) }))).toBe(3)
  })
})

describe('read cursors', () => {
  it('stamps one conversation and persists the reference key', () => {
    setSession({ account: account() })
    stampThreadRead('thread-1')

    const readAt = getState().threads.readAt
    expect(Object.keys(readAt)).toEqual(['thread-1'])
    expect(readAt['thread-1']).toBeGreaterThan(0)

    const raw = window.localStorage.getItem(READ_CURSOR_KEY)
    expect(READ_CURSOR_KEY).toBe('vane.wechat.read-cursor')
    expect(JSON.parse(raw as string)).toEqual({
      allReadAt: 0,
      threadReadAt: { 'thread-1': readAt['thread-1'] },
      ownUsername: 'wxid_self',
    })
  })

  it('skips an empty conversation id', () => {
    stampThreadRead('')
    expect(getState().threads.readAt).toEqual({})
    expect(window.localStorage.getItem(READ_CURSOR_KEY)).toBeNull()
  })

  it('trims the cursor map to the newest 300 conversations', () => {
    expect(THREAD_READ_CURSOR_LIMIT).toBe(300)
    const seeded: Record<string, number> = {}
    for (let index = 1; index <= THREAD_READ_CURSOR_LIMIT; index++)
      seeded['old-' + String(index)] = index
    setThreads({ readAt: seeded })

    stampThreadRead('brand-new')

    const readAt = getState().threads.readAt
    expect(Object.keys(readAt)).toHaveLength(THREAD_READ_CURSOR_LIMIT)
    expect(readAt['brand-new']).toBeGreaterThan(0)
    expect(readAt['old-1']).toBeUndefined()
    expect(readAt['old-2']).toBe(2)
    const persisted = JSON.parse(window.localStorage.getItem(READ_CURSOR_KEY) as string) as { threadReadAt: Record<string, number> }
    expect(persisted.threadReadAt['brand-new']).toBe(readAt['brand-new'])
    expect(Object.keys(persisted.threadReadAt)).toHaveLength(THREAD_READ_CURSOR_LIMIT)
  })

  it('does not write an empty cursor file', () => {
    persistReadCursor()
    expect(window.localStorage.getItem(READ_CURSOR_KEY)).toBeNull()

    setThreads({ allReadAt: 42 })
    persistReadCursor()
    expect(window.localStorage.getItem(READ_CURSOR_KEY)).toContain('42')
  })

  it('restores valid cursors and ignores invalid entries', () => {
    window.localStorage.setItem(READ_CURSOR_KEY, JSON.stringify({
      allReadAt: 1_000,
      threadReadAt: { good: 2_000, zero: 0, negative: -1, text: 'x' },
    }))
    loadReadCursor()
    expect(getState().threads.allReadAt).toBe(1_000)
    expect(getState().threads.readAt).toEqual({ good: 2_000 })
  })

  it('does not restore cursors written for another account', () => {
    flags.cachedOwnUsername = 'wxid_self'
    window.localStorage.setItem(READ_CURSOR_KEY, JSON.stringify({
      allReadAt: 1_000,
      threadReadAt: { a: 2_000 },
      ownUsername: 'wxid_other',
    }))
    loadReadCursor()
    expect(getState().threads.allReadAt).toBe(0)
    expect(getState().threads.readAt).toEqual({})
  })

  it('ignores a corrupt cursor file', () => {
    window.localStorage.setItem(READ_CURSOR_KEY, '{bad json')
    expect(() => loadReadCursor()).not.toThrow()
    expect(getState().threads.allReadAt).toBe(0)
  })
})

describe('loadThreads', () => {
  beforeEach(() => {
    setSession({ account: account() })
  })

  it('does nothing without an account slot', async () => {
    setSession({ account: null })
    const listSpy = vi.spyOn(wechatApi, 'listThreads')
    await loadThreads()
    expect(listSpy).not.toHaveBeenCalled()
    expect(getState().threads.loading).toBe(false)
  })

  it('refreshes offline slots that still have saved login material', async () => {
    setSession({ account: account({ authenticated: false, savedLogin: true, connection: 'disconnected' }) })
    const listSpy = vi.spyOn(wechatApi, 'listThreads').mockResolvedValue({ items: [thread()], nextCursor: null })
    await loadThreads()
    expect(listSpy).toHaveBeenCalledWith('account-1', PAGE_SIZE)
    expect(getState().threads.items.map(item => item.id)).toEqual(['thread-1'])
  })

  it('suppresses backfilled unread, forces the open row read and applies names', async () => {
    const cursor = Date.parse('2026-05-06T00:00:00.000Z')
    setThreads({
      allReadAt: cursor,
      readAt: {},
      activeThreadId: 'active',
      contactNames: new Map([['peer-old', 'Renamed Peer']]),
    })
    vi.spyOn(wechatApi, 'listThreads').mockResolvedValue({
      items: [
        thread({ id: 'old', peerId: 'peer-old', displayName: 'peer-old', unreadCount: 4, lastMessage: preview('2026-05-05T10:00:00.000Z') }),
        thread({ id: 'active', peerId: 'peer-active', unreadCount: 9, lastMessage: preview('2026-05-07T10:00:00.000Z') }),
        thread({ id: 'fresh', peerId: 'peer-fresh', unreadCount: 2, lastMessage: preview('2026-05-07T10:00:00.000Z') }),
      ],
      nextCursor: null,
    })

    await loadThreads()

    const items = getState().threads.items
    expect(items.map(item => item.id)).toEqual(['old', 'active', 'fresh'])
    expect(items[0].unreadCount).toBe(0)
    expect(items[0].displayName).toBe('Renamed Peer')
    expect(items[1].unreadCount).toBe(0)
    expect(items[2].unreadCount).toBe(2)
    expect(getState().threads.loading).toBe(false)
    expect(getState().threads.error).toBe('')
    expect(window.localStorage.getItem('vane.wechat.ui-cache')).toBeTruthy()
  })

  it('keeps a local draft conversation the server list does not know yet', async () => {
    const draft = thread({ id: 'draft-1', peerId: 'draft-1', displayName: 'New Chat', readStateVersion: '', isDraft: true })
    setThreads({ items: [draft], activeThreadId: 'draft-1' })
    vi.spyOn(wechatApi, 'listThreads').mockResolvedValue({ items: [thread({ id: 'other' })], nextCursor: null })

    await loadThreads()
    expect(getState().threads.items.map(item => item.id)).toEqual(['draft-1', 'other'])
  })

  it('collapses concurrent refreshes into one request', async () => {
    const request = deferred<{ items: Thread[], nextCursor: string | null }>()
    const listSpy = vi.spyOn(wechatApi, 'listThreads').mockReturnValue(request.promise)

    const first = loadThreads()
    const second = loadThreads()
    await flush()
    request.resolve({ items: [thread()], nextCursor: null })
    await Promise.all([first, second])

    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(flags.threadsInFlight).toBe(false)
    expect(getState().threads.items.map(item => item.id)).toEqual(['thread-1'])
  })

  it('surfaces a list failure and stops the spinner', async () => {
    vi.spyOn(wechatApi, 'listThreads').mockRejectedValue(new WechatApiError('列表读取失败', 500))
    await loadThreads()
    expect(getState().threads.error).toBe('列表读取失败')
    expect(getState().threads.loading).toBe(false)
  })
})

describe('warmRecentThreads', () => {
  it('prefetches uncached conversations and honours the trigger throttle', async () => {
    setSession({ account: account() })
    const active = thread({ id: 'active' })
    const cached = thread({ id: 'cached' })
    const target = thread({ id: 'target' })
    setThreads({ items: [active, cached, target], activeThreadId: 'active' })
    threadMessagesCache.set('cached', { items: [], cursor: null })
    recentMessages.set('cached', { items: [], cursor: null })

    const listSpy = vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({
      items: [message({ id: 'm2', createdAt: '2026-05-05T10:01:00.000Z' }), message({ id: 'm1', createdAt: '2026-05-05T10:00:00.000Z' })],
      nextCursor: 'cursor-1',
    })

    flags.lastWarmTrigger = 0
    warmRecentThreads()
    await vi.advanceTimersByTimeAsync(500)

    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(listSpy).toHaveBeenCalledWith('account-1', 'target', 20, undefined)
    expect(threadMessagesCache.get('target')?.items.map(item => item.id)).toEqual(['m1', 'm2'])
    expect(threadMessagesCache.get('target')?.cursor).toBe('cursor-1')
    expect(recentMessages.get('target')?.items.map(item => item.id)).toEqual(['m1', 'm2'])

    // A second call inside the throttle window does nothing.
    listSpy.mockClear()
    warmRecentThreads()
    await vi.advanceTimersByTimeAsync(500)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('stays idle when signed out or disposed', async () => {
    const listSpy = vi.spyOn(wechatApi, 'listMessages')
    setSession({ account: account({ authenticated: false }) })
    flags.lastWarmTrigger = 0
    warmRecentThreads()
    expect(listSpy).not.toHaveBeenCalled()

    setSession({ account: account() })
    flags.disposed = true
    flags.lastWarmTrigger = 0
    warmRecentThreads()
    expect(listSpy).not.toHaveBeenCalled()
  })
})

describe('reconcileActiveThread', () => {
  it('never opens a conversation on its own during staged loading', () => {
    setThreads({ items: [thread()], activeThreadId: null })
    reconcileActiveThread()
    expect(getState().threads.activeThreadId).toBeNull()
  })

  it('falls back to the first row when the open conversation disappeared', async () => {
    setSession({ account: account() })
    vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })
    setThreads({ items: [thread({ id: 'first', kind: 'system', peerId: 'sys' })], activeThreadId: 'gone' })

    reconcileActiveThread()
    await flush()

    expect(getState().threads.activeThreadId).toBe('first')
  })

  it('clears the selection when the list is empty', () => {
    setThreads({ items: [], activeThreadId: 'gone' })
    setMessages({ items: [message()], cursor: 'c1' })
    reconcileActiveThread()
    expect(getState().threads.activeThreadId).toBeNull()
    expect(getState().messages.items).toEqual([])
    expect(getState().messages.cursor).toBeNull()
  })
})

describe('selectThread', () => {
  beforeEach(() => {
    setSession({ account: account() })
  })

  it('retries the read report when the same conversation is still unread', async () => {
    const open = thread({ id: 'thread-1', unreadCount: 3, readStateVersion: 'v1' })
    setThreads({ items: [open], activeThreadId: 'thread-1' })
    const listSpy = vi.spyOn(wechatApi, 'listMessages')
    const readSpy = vi.spyOn(wechatApi, 'markThreadRead').mockResolvedValue({ version: 'v2' })

    await selectThread(open)
    await flush()

    expect(listSpy).not.toHaveBeenCalled()
    expect(readSpy).toHaveBeenCalledWith('account-1', 'thread-1', 'v1')
  })

  it('paints the cached window, touches the LRU order and refreshes in the background', async () => {
    const cachedMessage = message({ id: 'cached-1' })
    setThreads({ items: [thread()], activeThreadId: null })
    threadMessagesCache.set('thread-1', { items: [cachedMessage], cursor: 'cached-cursor' })
    threadMessagesCache.set('thread-2', { items: [], cursor: null })
    const listSpy = vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })

    await selectThread(getState().threads.items[0])
    await flush()

    expect(getState().threads.activeThreadId).toBe('thread-1')
    expect(getState().messages.items.map(item => item.id)).toEqual(['cached-1'])
    expect(getState().messages.cursor).toBe('cached-cursor')
    expect([...threadMessagesCache.keys()]).toEqual(['thread-2', 'thread-1'])
    expect(listSpy).toHaveBeenCalledWith('account-1', 'thread-1', 20, undefined)
  })

  it('repaints a persisted window as a copy before merging the refresh', async () => {
    setThreads({ items: [thread()], activeThreadId: null })
    const persistedMessage = message({ id: 'persisted-1' })
    recentMessages.set('thread-1', { items: [persistedMessage], cursor: 'persisted-cursor' })
    vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })

    await selectThread(getState().threads.items[0])

    const items = getState().messages.items
    expect(items.map(item => item.id)).toEqual(['persisted-1'])
    expect(items[0]).not.toBe(persistedMessage)
    expect(getState().messages.cursor).toBe('persisted-cursor')
    expect(threadMessagesCache.has('thread-1')).toBe(true)
  })

  it('loads a fresh window and resets per-conversation interface state', async () => {
    setThreads({ items: [thread()], activeThreadId: null })
    setMessages({
      unseenBelow: 4,
      replyTo: message(),
      searchOpen: true,
      searchQuery: 'q',
      searchResults: [message()],
      highlightId: 'm1',
      error: 'old error',
    })
    const focus = vi.fn()
    registerComposerHandle({ focus })
    vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [message({ id: 'fresh-1' })], nextCursor: 'next' })

    await selectThread(getState().threads.items[0])

    const messages = getState().messages
    expect(messages.items.map(item => item.id)).toEqual(['fresh-1'])
    expect(messages.cursor).toBe('next')
    expect(messages.unseenBelow).toBe(0)
    expect(messages.replyTo).toBeNull()
    expect(messages.searchOpen).toBe(false)
    expect(messages.searchQuery).toBe('')
    expect(messages.searchResults).toEqual([])
    expect(messages.highlightId).toBeNull()
    expect(messages.error).toBe('')
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('refetches the authoritative profile of a direct peer once per session', async () => {
    const refreshSpy = vi.spyOn(wechatApi, 'refreshContactProfile').mockResolvedValue({ id: 'op', kind: 'contact', state: 'failed' })
    setThreads({ items: [thread({ peerId: 'wxid_friend' })], activeThreadId: null })
    vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })

    await selectThread(getState().threads.items[0])
    await selectThread(getState().threads.items[0])
    await flush()

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(refreshSpy).toHaveBeenCalledWith('account-1', 'wxid_friend')
  })
})

describe('markThreadRead', () => {
  beforeEach(() => {
    setSession({ account: account() })
  })

  it('stamps the cursor without a server report when the version is unknown', () => {
    const target = thread({ id: 'thread-1', readStateVersion: '' })
    setThreads({ items: [target], activeThreadId: 'thread-1' })
    const readSpy = vi.spyOn(wechatApi, 'markThreadRead')

    markThreadRead(target)

    expect(readSpy).not.toHaveBeenCalled()
    expect(getState().threads.readAt['thread-1']).toBeGreaterThan(0)
  })

  it('reports with the row version and adopts the advanced version', async () => {
    const target = thread({ id: 'thread-1', readStateVersion: 'v1' })
    setThreads({ items: [target], activeThreadId: 'thread-1' })
    const readSpy = vi.spyOn(wechatApi, 'markThreadRead').mockResolvedValue({ version: 'v2' })

    markThreadRead(target)
    await flush()

    expect(readSpy).toHaveBeenCalledWith('account-1', 'thread-1', 'v1')
    expect(target.readStateVersion).toBe('v2')
  })

  it('retries once with the refreshed version after a conflict', async () => {
    const target = thread({ id: 'thread-1', readStateVersion: 'v1' })
    setThreads({ items: [target], activeThreadId: 'thread-1' })
    const readSpy = vi.spyOn(wechatApi, 'markThreadRead')
      .mockRejectedValueOnce(new Error('409 conflict'))
      .mockResolvedValue({ version: 'v3' })

    markThreadRead(target)
    await flush()
    expect(readSpy).toHaveBeenCalledTimes(1)

    target.readStateVersion = 'v2'
    await vi.advanceTimersByTimeAsync(1_200)
    await flush()

    expect(readSpy).toHaveBeenCalledTimes(2)
    expect(readSpy).toHaveBeenLastCalledWith('account-1', 'thread-1', 'v2')
    // The retry is best effort: it does not adopt the new version (reference behaviour).
    expect(target.readStateVersion).toBe('v2')
  })
})

describe('scheduleAutoRead', () => {
  it('debounces repeated new-message reports into one', async () => {
    setSession({ account: account() })
    const first = thread({ id: 'first', readStateVersion: 'v1' })
    const second = thread({ id: 'second', readStateVersion: 'v2' })
    setThreads({ items: [first, second], activeThreadId: 'first' })
    const readSpy = vi.spyOn(wechatApi, 'markThreadRead').mockResolvedValue({})

    scheduleAutoRead(first)
    scheduleAutoRead(second)
    await vi.advanceTimersByTimeAsync(400)
    await flush()

    expect(readSpy).toHaveBeenCalledTimes(1)
    expect(readSpy).toHaveBeenCalledWith('account-1', 'second', 'v2')
  })
})

describe('markAllThreadsRead', () => {
  it('clears every badge, dismisses toasts, stamps the cursor and syncs the daemon', async () => {
    setSession({ account: account() })
    setThreads({ items: [thread({ id: 'a', unreadCount: 3 }), thread({ id: 'b', unreadCount: 0 })], activeThreadId: 'a' })
    setMessages({ unseenBelow: 5 })
    setUi({ toasts: [{ id: 'toast-1', threadId: 'a', name: 'A', preview: 'hi' }] })
    const listSpy = vi.spyOn(wechatApi, 'listThreads').mockResolvedValue({ items: [], nextCursor: null })

    markAllThreadsRead()
    await flush()

    const state = getState()
    expect(state.threads.items.every(item => (item.unreadCount ?? 0) === 0)).toBe(true)
    expect(state.threads.allReadAt).toBeGreaterThan(0)
    expect(state.messages.unseenBelow).toBe(0)
    expect(state.ui.toasts).toEqual([])
    expect(window.localStorage.getItem(READ_CURSOR_KEY)).toBeTruthy()
    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(flags.readSyncRunning).toBe(false)
  })

  it('does not start a second daemon sync while one is running', async () => {
    setSession({ account: account() })
    setThreads({ items: [thread()] })
    flags.readSyncRunning = true
    const listSpy = vi.spyOn(wechatApi, 'listThreads')

    markAllThreadsRead()
    await flush()

    expect(listSpy).not.toHaveBeenCalled()
    expect(flags.readSyncRunning).toBe(true)
  })
})

describe('syncAllThreadsReadToDaemon', () => {
  it('stops after a round with nothing left unread', async () => {
    setSession({ account: account() })
    const listSpy = vi.spyOn(wechatApi, 'listThreads').mockResolvedValue({ items: [thread({ unreadCount: 0 })], nextCursor: null })
    const readSpy = vi.spyOn(wechatApi, 'markThreadRead')

    await syncAllThreadsReadToDaemon()

    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(readSpy).not.toHaveBeenCalled()
  })
})

describe('loadContactDirectory', () => {
  beforeEach(() => {
    setSession({ account: account() })
  })

  it('requires an authenticated account', async () => {
    setSession({ account: account({ authenticated: false }) })
    const listSpy = vi.spyOn(wechatApi, 'listContacts')
    await loadContactDirectory(true)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('throttles reloads unless forced', async () => {
    expect(DIRECTORY_REFRESH_INTERVAL).toBe(60_000)
    const listSpy = vi.spyOn(wechatApi, 'listContacts').mockResolvedValue({ items: [], nextCursor: null })
    flags.lastDirectoryLoad = Date.now() - 1_000

    await loadContactDirectory()
    expect(listSpy).not.toHaveBeenCalled()

    await loadContactDirectory(true)
    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(flags.lastDirectoryLoad).toBeGreaterThan(0)
  })

  it('pages the directory and derives friends, names and the slim snapshot', async () => {
    const listSpy = vi.spyOn(wechatApi, 'listContacts')
      .mockResolvedValueOnce({
        items: [
          contact({ id: 'c1', username: 'wxid_friend', displayName: ' Friend Name ', localType: 1, relation: 'friend', contactFlag: 1 }),
          contact({ id: 'c2', username: 'wxid_group', displayName: 'Group', localType: 2, classification: { category: 'group' } }),
          contact({ id: 'c3', username: 'wxid_shop', displayName: 'Shop', localType: 1, classification: { category: 'business' } }),
          contact({ id: 'c4', username: 'wxid_nick', displayName: null, nickname: ' Nick ', localType: 1 }),
          contact({ id: 'c5', username: 'wxid_unconfirmed', displayName: 'Unconfirmed' }),
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null })

    await loadContactDirectory(true)

    expect(listSpy).toHaveBeenCalledTimes(2)
    expect(listSpy).toHaveBeenNthCalledWith(1, 'account-1', '', 200, null)
    expect(listSpy).toHaveBeenNthCalledWith(2, 'account-1', '', 200, 'page-2')

    const state = getState().threads
    expect(state.directoryContacts).toHaveLength(5)
    expect([...state.friendNames].sort()).toEqual(['wxid_friend', 'wxid_nick'])
    expect(state.contactNames.get('wxid_friend')).toBe('Friend Name')
    expect(state.contactNames.get('wxid_nick')).toBe('Nick')
    expect(state.contactNames.has('wxid_group')).toBe(false)
    expect(state.directoryReady).toBe(true)

    const directory = JSON.parse(window.localStorage.getItem(DIRECTORY_CACHE_KEY) as string) as {
      savedAt: number
      ownUsername: string
      contacts: Array<Record<string, unknown>>
    }
    expect(typeof directory.savedAt).toBe('number')
    expect(directory.ownUsername).toBe('wxid_self')
    expect(directory.contacts).toHaveLength(5)
    expect(Object.keys(directory.contacts[0]).sort()).toEqual(['displayName', 'id', 'localType', 'username'])
    expect(directory.contacts[0]).not.toHaveProperty('relation')
    expect(directory.contacts[0]).not.toHaveProperty('contactFlag')

    const snapshot = JSON.parse(window.localStorage.getItem('vane.wechat.ui-cache') as string) as {
      contacts: Record<string, string>
      friends: string[]
    }
    expect(snapshot.contacts.wxid_friend).toBe('Friend Name')
    expect(snapshot.friends).toContain('wxid_friend')
  })

  it('falls back to every personal contact when no confirmed localType exists', async () => {
    vi.spyOn(wechatApi, 'listContacts').mockResolvedValue({
      items: [
        contact({ id: 'a', username: 'wxid_person', displayName: 'Person' }),
        contact({ id: 'b', username: 'room@chatroom', displayName: 'Room', classification: { category: 'group' } }),
        contact({ id: 'c', username: 'wxid_bare', displayName: 'Bare' }),
        contact({ id: 'd', username: 'gh_official', displayName: 'Official', classification: { category: 'system' } }),
      ],
      nextCursor: null,
    })

    await loadContactDirectory(true)

    expect([...getState().threads.friendNames].sort()).toEqual(['wxid_bare', 'wxid_person'])
  })

  it('stays not ready when the directory request fails', async () => {
    vi.spyOn(wechatApi, 'listContacts').mockRejectedValue(new Error('network down'))
    await loadContactDirectory(true)
    expect(getState().threads.directoryReady).toBe(false)
    expect(getState().threads.directoryContacts).toEqual([])
    expect(flags.lastDirectoryLoad).toBe(0)
  })
})

describe('applyContactNames', () => {
  it('overrides raw conversation titles from the directory but never drafts', () => {
    setThreads({
      items: [
        thread({ id: 't1', peerId: 'peer-1', displayName: 'peer-1' }),
        thread({ id: 't2', peerId: '', displayName: 't2' }),
        thread({ id: 'draft', peerId: 'peer-3', displayName: 'peer-3', isDraft: true }),
      ],
      contactNames: new Map([['peer-1', 'Pretty One'], ['t2', 'Pretty Two'], ['peer-3', 'Pretty Three']]),
    })
    applyContactNames()
    const items = getState().threads.items
    expect(items[0].displayName).toBe('Pretty One')
    expect(items[1].displayName).toBe('Pretty Two')
    expect(items[2].displayName).toBe('peer-3')
  })

  it('does nothing without names or conversations', () => {
    setThreads({ items: [thread({ displayName: 'raw', peerId: 'peer-1' })], contactNames: new Map() })
    applyContactNames()
    expect(getState().threads.items[0].displayName).toBe('raw')
  })
})

describe('loadContactProfile', () => {
  beforeEach(() => {
    setSession({ account: account() })
    setThreads({ items: [thread({ peerId: 'peer-1' })], activeThreadId: 'thread-1' })
  })

  it('loads the peer profile', async () => {
    const getSpy = vi.spyOn(wechatApi, 'getContact').mockResolvedValue(contact({ displayName: 'Loaded' }))
    await loadContactProfile()
    expect(getSpy).toHaveBeenCalledWith('account-1', 'peer-1')
    expect(getState().threads.contactProfile?.displayName).toBe('Loaded')
    expect(getState().threads.contactProfileLoading).toBe(false)
  })

  it('maps a 404 to the documented empty-profile message', async () => {
    vi.spyOn(wechatApi, 'getContact').mockRejectedValue(new WechatApiError('missing', 404))
    await loadContactProfile()
    expect(getState().threads.contactProfileError).toBe(t('通讯录中还没有这位联系人的资料。'))
  })

  it('ignores a response that arrives after the profile was reset', async () => {
    const request = deferred<Contact>()
    vi.spyOn(wechatApi, 'getContact').mockReturnValue(request.promise)

    const pending = loadContactProfile()
    resetContactProfile()
    request.resolve(contact({ displayName: 'Stale' }))
    await pending

    expect(getState().threads.contactProfile).toBeNull()
    expect(getState().threads.contactProfileLoading).toBe(false)
  })

  it('clears the panel state when there is no peer', async () => {
    setThreads({ items: [thread({ kind: 'group', peerId: 'room@chatroom' })], activeThreadId: 'thread-1' })
    const getSpy = vi.spyOn(wechatApi, 'getContact')
    await loadContactProfile()
    expect(getSpy).not.toHaveBeenCalled()
    expect(getState().threads.contactProfileLoading).toBe(false)
  })
})

describe('refreshContactAuthoritative', () => {
  it('reloads the directory after a successful profile refresh and runs once per peer', async () => {
    setSession({ account: account() })
    const refreshSpy = vi.spyOn(wechatApi, 'refreshContactProfile').mockResolvedValue({ id: 'op-1', kind: 'profile', state: 'succeeded' })
    const listSpy = vi.spyOn(wechatApi, 'listContacts').mockResolvedValue({ items: [], nextCursor: null })

    await refreshContactAuthoritative('wxid_peer')
    await flush()
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(listSpy).toHaveBeenCalledTimes(1)

    await refreshContactAuthoritative('wxid_peer')
    await flush()
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })
})

describe('new conversations', () => {
  beforeEach(() => {
    setSession({ account: account() })
  })

  it('opens and closes the contact dialog', () => {
    openNewChat()
    expect(getState().threads.contactDialogOpen).toBe(true)
  })

  it('creates a local draft conversation and selects it', async () => {
    vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(wechatApi, 'refreshContactProfile').mockResolvedValue({ id: 'op', kind: 'profile', state: 'failed' })
    setThreads({ query: 'old', filterMode: 'unread' })
    setUi({ railView: 'contacts' })

    startDraftChat('wxid_new', 'New Person')
    await flush()

    const items = getState().threads.items
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      id: 'wxid_new',
      accountId: 'account-1',
      peerId: 'wxid_new',
      kind: 'direct',
      displayName: 'New Person',
      unreadCount: 0,
      muted: false,
      pinned: false,
      readStateVersion: '',
      lastMessage: null,
      avatarMembers: [],
      isDraft: true,
    })
    expect(getState().threads.activeThreadId).toBe('wxid_new')
    expect(getState().threads.contactDialogOpen).toBe(false)
    expect(getState().threads.query).toBe('')
    expect(getState().threads.filterMode).toBe('all')
    expect(getState().ui.railView).toBe('chats')
  })

  it('reuses an existing conversation instead of duplicating it', async () => {
    const existing = thread({ id: 'wxid_known', peerId: 'wxid_known', displayName: 'Known' })
    setThreads({ items: [existing], activeThreadId: null })
    vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(wechatApi, 'refreshContactProfile').mockResolvedValue({ id: 'op', kind: 'profile', state: 'failed' })

    startChatWithContact(contact({ id: 'wxid_known', username: 'wxid_known' }))
    await flush()

    expect(getState().threads.items).toHaveLength(1)
    expect(getState().threads.activeThreadId).toBe('wxid_known')
  })

  it('derives the display name from displayName, remark, nickname and id', async () => {
    vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(wechatApi, 'refreshContactProfile').mockResolvedValue({ id: 'op', kind: 'profile', state: 'failed' })

    startChatWithContact(contact({ id: 'c1', username: 'wxid_a', displayName: '  ', remark: ' Remark ', nickname: 'Nick' }))
    await flush()
    expect(getState().threads.items[0].displayName).toBe('Remark')

    startChatWithContact(contact({ id: 'wxid_b', username: 'wxid_b', displayName: null, remark: null, nickname: 'Nick' }))
    await flush()
    expect(getState().threads.items.find(item => item.id === 'wxid_b')?.displayName).toBe('Nick')

    startChatWithId('  wxid_c  ')
    await flush()
    expect(getState().threads.items.find(item => item.id === 'wxid_c')?.displayName).toBe('wxid_c')
  })

  it('ignores blank ids and missing accounts', async () => {
    startChatWithId('   ')
    expect(getState().threads.items).toEqual([])

    setSession({ account: null })
    startDraftChat('wxid_x', 'X')
    expect(getState().threads.items).toEqual([])
  })
})

describe('read actions and list navigation', () => {
  it('marks the open conversation read and closes the details panel', () => {
    setSession({ account: account() })
    const target = thread({ id: 'thread-1', unreadCount: 2, readStateVersion: 'v1' })
    setThreads({ items: [target], activeThreadId: 'thread-1', detailsOpen: true })
    vi.spyOn(wechatApi, 'markThreadRead').mockResolvedValue({ version: 'v2' })

    markActiveThreadRead()

    expect(target.unreadCount).toBe(0)
    expect(getState().threads.detailsOpen).toBe(false)
    expect(getState().threads.readAt['thread-1']).toBeGreaterThan(0)
  })

  it('clears the selection when returning to the list', () => {
    setThreads({ activeThreadId: 'thread-1', detailsOpen: true })
    setMessages({ searchOpen: true })
    goBackToList()
    expect(getState().threads.activeThreadId).toBeNull()
    expect(getState().threads.detailsOpen).toBe(false)
    expect(getState().messages.searchOpen).toBe(false)
  })

  it('drives the layout and filter flags', () => {
    setNarrow(true)
    expect(getState().threads.isNarrow).toBe(true)
    setThreadQuery('bob')
    expect(getState().threads.query).toBe('bob')
    setFilterMode('groups')
    expect(getState().threads.filterMode).toBe('groups')
    toggleDetails()
    expect(getState().threads.detailsOpen).toBe(true)
    toggleDetails()
    expect(getState().threads.detailsOpen).toBe(false)
    setDetailsOpen(true)
    expect(getState().threads.detailsOpen).toBe(true)
  })

  it('schedules one list refresh after the reference delay', async () => {
    setSession({ account: account() })
    vi.spyOn(wechatApi, 'listThreads').mockResolvedValue({ items: [], nextCursor: null })
    scheduleThreadRefresh()
    scheduleThreadRefresh()
    await vi.advanceTimersByTimeAsync(349)
    expect(wechatApi.listThreads).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(wechatApi.listThreads).toHaveBeenCalledTimes(1)
  })
})
