import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wechatApi, WechatApiError } from '../api'
import { sendFailureMessage } from '../errors'
import { t } from '../i18n'
import type { AccountSummary, LocalMessage, Thread, WechatEvent } from '../types'
import {
  TOAST_RECENT_WINDOW_MS,
  counters,
  flags,
  registerMessageListHandle,
  resetCaches,
  timers,
} from './caches'
import { getState, initialState, setMessages, setSession, setThreads, setUi, store } from './state'
import {
  handleStreamEvent,
  startEngine,
  startStream,
  stopStream,
  syncDocumentTitle,
} from './engine'

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

function message(patch: Partial<LocalMessage> = {}): LocalMessage {
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

function preview(createdAt: string, text = 'new message') {
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

function event(kind: string, data: Record<string, unknown> = {}, createdAt = new Date().toISOString(), cursor = 'cursor-1'): WechatEvent {
  return { cursor, kind, data, createdAt }
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
  flags.lastWarmTrigger = Date.now()
  flags.cachedOwnUsername = ''
  flags.lastDirectoryLoad = 0
  flags.autoLoginTriggered = false
  flags.streamAbort = null
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++)
    await Promise.resolve()
}

const originalMatchMedia = window.matchMedia

interface MatchMediaFixture {
  listeners: Array<(event: MediaQueryListEvent) => void>
  mediaQueryList: MediaQueryList
}

function stubMatchMedia(matches: boolean): MatchMediaFixture {
  const listeners: Array<(event: MediaQueryListEvent) => void> = []
  const mediaQueryList = {
    matches,
    media: '(max-width: 768px)',
    addEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change')
        listeners.push(listener)
    }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  } as unknown as MediaQueryList
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => mediaQueryList),
  })
  return { listeners, mediaQueryList }
}

function restoreMatchMedia(): void {
  if (originalMatchMedia) {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: originalMatchMedia })
    return
  }
  Reflect.deleteProperty(window, 'matchMedia')
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  resetStore()
  resetCaches()
  resetFlags()
  registerMessageListHandle(null)
  vi.spyOn(wechatApi, 'listThreads').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(wechatApi, 'markThreadRead').mockResolvedValue({})
  vi.spyOn(wechatApi, 'listContacts').mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(() => {
  vi.restoreAllMocks()
  resetCaches()
  resetFlags()
  registerMessageListHandle(null)
  restoreMatchMedia()
  window.localStorage.clear()
  vi.useRealTimers()
  document.title = ''
})

describe('syncDocumentTitle', () => {
  it('shows the login title while signed out', () => {
    setSession({ account: null })
    syncDocumentTitle()
    expect(document.title).toBe(t('微信登录'))

    setSession({ account: account({ authenticated: false }) })
    syncDocumentTitle()
    expect(document.title).toBe(t('微信登录'))
  })

  it('appends the open conversation to the WeChat nickname', () => {
    setSession({ account: account(), selfName: '' })
    setThreads({ items: [thread({ displayName: 'Peer One' })], activeThreadId: 'thread-1' })
    syncDocumentTitle()
    expect(document.title).toBe(t('微信') + ' · Peer One')

    setSession({ selfName: '小明' })
    syncDocumentTitle()
    expect(document.title).toBe('小明 · Peer One')

    setThreads({ activeThreadId: null })
    syncDocumentTitle()
    expect(document.title).toBe('小明')
  })
})

describe('handleStreamEvent: message events', () => {
  beforeEach(() => {
    setSession({ account: account(), selfName: 'self' })
  })

  it('counts a fresh committed message as unread on a background conversation', () => {
    const target = thread({ unreadCount: 1, lastMessage: preview(new Date().toISOString()) })
    const items = [target]
    setThreads({ items, activeThreadId: 'other-thread' })

    handleStreamEvent(event('message.committed', { threadId: 'thread-1' }))

    expect(target.unreadCount).toBe(2)
    // Subscribers are notified because the row was mutated in place.
    expect(getState().threads.items).not.toBe(items)
    expect(flags.lastCursor).toBe('cursor-1')
  })

  it('raises a toast card for a recent background message and auto-dismisses it', async () => {
    const target = thread({ unreadCount: 0, lastMessage: preview(new Date().toISOString(), 'ping') })
    // No open conversation: the background refresh must not auto-open a row.
    setThreads({ items: [target], activeThreadId: null })
    vi.spyOn(wechatApi, 'listThreads').mockResolvedValue({ items: [target], nextCursor: null })

    handleStreamEvent(event('message.committed', { threadId: 'thread-1' }))
    expect(getState().ui.toasts).toEqual([])

    await vi.advanceTimersByTimeAsync(500)
    const toasts = getState().ui.toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ threadId: 'thread-1', name: 'Peer One', preview: 'ping' })

    await vi.advanceTimersByTimeAsync(4_200)
    expect(getState().ui.toasts).toEqual([])
  })

  it('ignores message.updated for unread counting', async () => {
    const target = thread({ unreadCount: 0, lastMessage: preview(new Date().toISOString()) })
    setThreads({ items: [target], activeThreadId: 'other-thread' })

    handleStreamEvent(event('message.updated', { threadId: 'thread-1' }))
    await vi.advanceTimersByTimeAsync(600)

    expect(target.unreadCount).toBe(0)
    expect(getState().ui.toasts).toEqual([])
  })

  it('treats replayed history as stale and stays silent', async () => {
    const stale = new Date(Date.now() - 120_000).toISOString()
    const target = thread({ unreadCount: 0, lastMessage: preview(stale) })
    setThreads({ items: [target], activeThreadId: 'other-thread' })

    handleStreamEvent(event('message.committed', { threadId: 'thread-1' }, stale))
    await vi.advanceTimersByTimeAsync(600)

    expect(target.unreadCount).toBe(0)
    expect(getState().ui.toasts).toEqual([])
    // The reference freshness tolerance is one minute.
    expect(TOAST_RECENT_WINDOW_MS).toBe(10 * 60 * 1000)
  })

  it('ignores events for a conversation that is not in the list', () => {
    setThreads({ items: [], activeThreadId: null })
    expect(() => handleStreamEvent(event('message.committed', { threadId: 'unknown' }))).not.toThrow()
  })

  it('marks the open conversation read and shows the unseen pill', async () => {
    const open = thread({ unreadCount: 2, readStateVersion: 'v1', lastMessage: preview(new Date().toISOString()) })
    setThreads({ items: [open], activeThreadId: 'thread-1', detailsOpen: false })
    vi.spyOn(wechatApi, 'listThreads').mockResolvedValue({ items: [open], nextCursor: null })

    handleStreamEvent(event('message.committed', { threadId: 'thread-1' }))
    expect(getState().messages.unseenBelow).toBe(1)
    expect(open.unreadCount).toBe(0)

    // The debounced automatic read report fires once.
    await vi.advanceTimersByTimeAsync(400)
    expect(wechatApi.markThreadRead).toHaveBeenCalledTimes(1)
    expect(wechatApi.markThreadRead).toHaveBeenCalledWith('account-1', 'thread-1', 'v1')
  })

  it('does not show the unseen pill while the list is at the bottom', () => {
    setThreads({ items: [thread()], activeThreadId: 'thread-1' })
    registerMessageListHandle({
      scrollToBottom: vi.fn(),
      scrollToMessage: vi.fn(),
      isAtBottom: () => true,
    })

    handleStreamEvent(event('message.committed', { threadId: 'thread-1' }))
    expect(getState().messages.unseenBelow).toBe(0)
  })

  it('does not auto-report a read for message.updated', async () => {
    const open = thread({ unreadCount: 0, readStateVersion: 'v1' })
    setThreads({ items: [open], activeThreadId: 'thread-1' })

    handleStreamEvent(event('message.updated', { threadId: 'thread-1' }))
    await vi.advanceTimersByTimeAsync(500)

    expect(wechatApi.markThreadRead).not.toHaveBeenCalled()
  })
})

describe('handleStreamEvent: thread read-state', () => {
  it('clears the badge and drops that conversation toast', () => {
    const target = thread({ unreadCount: 4 })
    const items = [target]
    setThreads({ items, activeThreadId: null })
    setUi({
      toasts: [
        { id: 'toast-a', threadId: 'thread-1', name: 'A', preview: 'hi' },
        { id: 'toast-b', threadId: 'thread-2', name: 'B', preview: 'hi' },
      ],
    })

    handleStreamEvent(event('thread.read-state', { threadId: 'thread-1' }))

    expect(target.unreadCount).toBe(0)
    expect(getState().threads.items).not.toBe(items)
    expect(getState().ui.toasts.map(item => item.id)).toEqual(['toast-b'])
  })

  it('does not touch rows whose badge is already clear', () => {
    const target = thread({ unreadCount: 0 })
    const items = [target]
    setThreads({ items, activeThreadId: null })
    handleStreamEvent(event('thread.read-state', { threadId: 'thread-1' }))
    expect(getState().threads.items).toBe(items)
  })
})

describe('handleStreamEvent: list refresh events', () => {
  it('refreshes the conversation list after the debounce', async () => {
    setSession({ account: account() })
    handleStreamEvent(event('thread.updated'))
    await vi.advanceTimersByTimeAsync(349)
    expect(wechatApi.listThreads).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(wechatApi.listThreads).toHaveBeenCalledTimes(1)
  })

  it('refreshes the list for group and message events too', async () => {
    setSession({ account: account() })
    handleStreamEvent(event('group.updated'))
    await vi.advanceTimersByTimeAsync(350)
    await flush()
    expect(wechatApi.listThreads).toHaveBeenCalledTimes(1)
  })

  it('reloads the contact directory on contacts.updated', async () => {
    setSession({ account: account() })
    handleStreamEvent(event('contacts.updated'))
    await vi.advanceTimersByTimeAsync(350)
    await flush()
    expect(wechatApi.listContacts).toHaveBeenCalledTimes(1)
  })
})

describe('handleStreamEvent: send.updated', () => {
  function seedLocal(patch: Partial<LocalMessage> = {}): LocalMessage {
    const local = message({
      id: 'local-1',
      serverId: null,
      sendId: 'send-1',
      sendState: 'queued',
      local: true,
      pending: true,
      direction: 'outgoing',
      senderId: 'wxid_self',
      body: 'ping',
      ...patch,
    })
    setSession({ account: account() })
    setMessages({ items: [local] })
    setThreads({ items: [], activeThreadId: 'other-thread' })
    return local
  }

  it('accepts the send and clears the pending flag', () => {
    const local = seedLocal()
    const items = getState().messages.items

    handleStreamEvent(event('send.updated', { id: 'send-1', state: 'accepted' }))

    expect(local.sendState).toBe('accepted')
    expect(local.pending).toBe(false)
    expect(getState().messages.items).not.toBe(items)
  })

  it('maps a failed send to the human-readable error code', () => {
    const local = seedLocal()
    handleStreamEvent(event('send.updated', { id: 'send-1', state: 'failed', errorCode: 'auth_required' }))

    expect(local.sendState).toBe('failed')
    expect(local.pending).toBe(false)
    expect(local.sendError).toBe(sendFailureMessage('auth_required'))
  })

  it('flags an uncertain send as needing review', () => {
    const local = seedLocal()
    handleStreamEvent(event('send.updated', { id: 'send-1', state: 'needs_review' }))

    expect(local.sendState).toBe('needs_review')
    expect(local.pending).toBe(false)
    expect(local.sendError).toBe(t('发送结果待确认，请检查聊天记录'))
  })

  it('ignores unknown send ids, missing states and server rows', () => {
    const local = seedLocal()
    const items = getState().messages.items

    handleStreamEvent(event('send.updated', { id: 'send-unknown', state: 'accepted' }))
    handleStreamEvent(event('send.updated', { id: 'send-1' }))
    expect(getState().messages.items).toBe(items)
    expect(local.sendState).toBe('queued')

    const server = message({ id: 'srv-1', local: false, sendId: 'send-1' })
    setMessages({ items: [server] })
    handleStreamEvent(event('send.updated', { id: 'send-1', state: 'failed' }))
    expect(server.sendState).toBeUndefined()
  })

  it('refreshes the open conversation after an accepted send in it', async () => {
    const local = seedLocal({ threadId: 'thread-1' })
    setThreads({ items: [thread()], activeThreadId: 'thread-1' })

    handleStreamEvent(event('send.updated', { id: 'send-1', state: 'accepted' }))
    await vi.advanceTimersByTimeAsync(200)
    await flush()

    expect(local.pending).toBe(false)
    expect(wechatApi.listMessages).toHaveBeenCalled()
  })
})

describe('handleStreamEvent: account events', () => {
  beforeEach(() => {
    setSession({
      account: account(),
      selfName: 'self',
    })
  })

  it('polls the account once after a burst of account events', async () => {
    const next = account({ connection: 'connected' })
    const getAccount = vi.spyOn(wechatApi, 'getAccount').mockResolvedValue(next)

    handleStreamEvent(event('account.updated'))
    await vi.advanceTimersByTimeAsync(400)
    handleStreamEvent(event('login.updated'))
    await vi.advanceTimersByTimeAsync(799)
    expect(getAccount).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(getAccount).toHaveBeenCalledTimes(1)
    expect(getAccount).toHaveBeenCalledWith('account-1')
    expect(getState().session.account).toEqual(next)
  })

  it('surfaces an expired session from the account poll', async () => {
    vi.spyOn(wechatApi, 'getAccount').mockRejectedValue(new WechatApiError('expired', 401))

    handleStreamEvent(event('account.updated'))
    await vi.advanceTimersByTimeAsync(800)
    await flush()

    expect(getState().session.bootError).toBe(t('登录状态已失效，请重新登录微信。'))
  })
})

describe('handleStreamEvent: cursor tracking', () => {
  it('remembers the newest cursor and keeps the previous one for empty ids', () => {
    flags.lastCursor = 'old'
    handleStreamEvent(event('thread.updated', {}, new Date().toISOString(), 'new'))
    expect(flags.lastCursor).toBe('new')

    handleStreamEvent(event('thread.updated', {}, new Date().toISOString(), ''))
    expect(flags.lastCursor).toBe('new')
  })
})

describe('engine lifecycle', () => {
  async function bootEngine(options: { authenticated?: boolean } = {}): Promise<() => void> {
    stubMatchMedia(true)
    const slot = options.authenticated
      ? account({ savedLogin: true })
      : account({ authenticated: false, connection: 'disconnected' })
    vi.spyOn(wechatApi, 'listAccounts').mockResolvedValue([slot])
    // Do not start a QR login while the account is signed out.
    flags.autoLoginTriggered = true
    const dispose = startEngine()
    await flush()
    return dispose
  }

  it('boots, applies settings, detects the narrow layout and installs listeners', async () => {
    setUi({ themeId: 'green' })
    const fixture = stubMatchMedia(true)
    vi.spyOn(wechatApi, 'listAccounts').mockResolvedValue([account({ authenticated: false, connection: 'disconnected' })])
    flags.autoLoginTriggered = true

    const dispose = startEngine()
    await flush()

    expect(getState().session.booting).toBe(false)
    expect(getState().session.account?.id).toBe('account-1')
    expect(getState().threads.isNarrow).toBe(true)
    expect(document.title).toBe(t('微信登录'))
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#22c55e')
    expect(timers.account).not.toBeNull()
    expect(fixture.listeners).toHaveLength(1)

    setMessages({ lightboxSrc: 'blob:image' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(getState().messages.lightboxSrc).toBeNull()

    dispose()
    expect(flags.disposed).toBe(true)
    expect(timers.account).toBeNull()
    expect(getState().session.streamStatus).toBe('idle')

    // The keydown listener is gone after dispose.
    setMessages({ lightboxSrc: 'blob:image' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(getState().messages.lightboxSrc).toBe('blob:image')
  })

  it('mirrors the App.vue watchers for the title and the contact profile', async () => {
    const dispose = await bootEngine()

    vi.spyOn(wechatApi, 'getContact').mockResolvedValue({
      id: 'contact-1',
      username: 'peer-1',
      displayName: 'Loaded Profile',
    })
    setSession({ account: account(), selfName: 'Me' })
    setThreads({
      items: [thread({ peerId: 'peer-1', displayName: 'Peer One' })],
      activeThreadId: 'thread-1',
      detailsOpen: true,
    })
    await flush()

    expect(document.title).toBe('Me · Peer One')
    expect(wechatApi.getContact).toHaveBeenCalledWith('account-1', 'peer-1')
    expect(getState().threads.contactProfile?.displayName).toBe('Loaded Profile')

    setThreads({ detailsOpen: false })
    await flush()
    expect(getState().threads.contactProfile).toBeNull()

    // After dispose the watchers no longer react.
    dispose()
    setSession({ selfName: 'Renamed' })
    expect(document.title).toBe('Me · Peer One')
  })

  it('starts no stream while signed out and stops one on demand', async () => {
    setSession({ account: null })
    startStream()
    expect(getState().session.streamStatus).toBe('idle')
    expect(flags.streamActive).toBe(false)

    const token = counters.streamToken
    stopStream()
    expect(counters.streamToken).toBe(token + 1)
    expect(getState().session.streamStatus).toBe('idle')
  })
})
