import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wechatApi, WechatApiError } from '../../api'
import { compareMessages } from '../../format'
import { getLocale, setLocale, t } from '../../i18n'
import type {
  AccountSummary,
  Contact,
  GroupMember,
  LocalMessage,
  MediaAsset,
  Message,
  MentionOption,
  Thread,
} from '../../types'
import {
  GROUP_MEMBERS_CACHE_LIMIT,
  PERSISTED_MESSAGE_THREADS,
  THREAD_CACHE_LIMIT,
  flags,
  groupMembersCache,
  localMediaUrls,
  recentMessages,
  registerComposerHandle,
  registerMessageListHandle,
  registerThreadSearchInput,
  resetCaches,
  threadMessagesCache,
  timers,
} from '../caches'
import { getState, initialState, setMessages, setSession, setThreads, store } from '../state'
import {
  UI_CACHE_KEY,
  buildMentions,
  cacheThreadMessages,
  cancelReply,
  clearStagedAttachments,
  detectMediaKind,
  ensureCacheAccountMatch,
  ensureGroupMembers,
  fetchThreadMessages,
  handleMessageListBottom,
  jumpToLatestMessage,
  loadCachedSessionData,
  loadOlderMessages,
  localMediaType,
  mediaLimit,
  mergeServerMessages,
  persistSessionData,
  persistableMessages,
  refreshActiveMessages,
  removeAttachment,
  runThreadSearch,
  scheduleMessageRefresh,
  selectMentionLoading,
  selectMentionOptions,
  selectReplyToDisplay,
  setThreadSearchQuery,
  stageFiles,
  startReply,
  threadSearchSender,
  threadSearchSnippet,
  toggleThreadSearch,
} from './messages'
import { isMediaMessage, mediaErrorText, resolveMediaState, revokeUrl, setMessageMedia } from './media'

const DIRECTORY_CACHE_KEY = 'vane.wechat.directory-cache'
const READ_CURSOR_KEY = 'vane.wechat.read-cursor'

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
    readStateVersion: 'v1',
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

function localOutgoing(patch: Partial<LocalMessage> = {}): LocalMessage {
  return message({
    id: 'local-1',
    serverId: null,
    senderId: 'wxid_self',
    direction: 'outgoing',
    body: 'ping',
    version: 'local',
    local: true,
    pending: true,
    sendState: 'queued',
    ...patch,
  })
}

function groupThread(id = 'room@chatroom'): Thread {
  return thread({ id, peerId: id, kind: 'group', displayName: 'Group' })
}

function member(patch: Partial<GroupMember> = {}): GroupMember {
  return { id: 'wxid_m', username: 'wxid_m', displayName: 'Member', ...patch }
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
  flags.lastWarmTrigger = 0
  flags.cachedOwnUsername = ''
  flags.lastDirectoryLoad = 0
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolveFn) => { resolve = resolveFn })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index++)
    await Promise.resolve()
}

beforeEach(() => {
  window.localStorage.clear()
  resetStore()
  resetCaches()
  resetFlags()
  registerMessageListHandle(null)
  registerComposerHandle(null)
  registerThreadSearchInput(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetCaches()
  resetFlags()
  registerMessageListHandle(null)
  registerComposerHandle(null)
  registerThreadSearchInput(null)
  window.localStorage.clear()
})

describe('buildMentions', () => {
  const options: MentionOption[] = [
    { id: 'wxid_alice', label: 'Alice' },
    { id: 'wxid_bob', label: 'Bob' },
  ]

  it('returns undefined when the draft has no picker-inserted mention', () => {
    expect(buildMentions('', options)).toBeUndefined()
    expect(buildMentions('hello everyone', options)).toBeUndefined()
    // A plain "@name " typed by hand has no U+2005 terminator and is not a mention payload.
    expect(buildMentions('hello @Alice ', options)).toBeUndefined()
    expect(buildMentions('hello @Unknown\u2005', options)).toBeUndefined()
  })

  it('maps picker spans to user ids and UTF-16 offset positions', () => {
    const text = 'hi @Alice\u2005 and @Bob\u2005'
    expect(buildMentions(text, options)).toEqual({
      userIds: ['wxid_alice', 'wxid_bob'],
      positions: [
        { start: 3, end: 10, index: 0 },
        { start: 15, end: 20, index: 1 },
      ],
    })
    // The offsets address the original string, including the U+2005 terminator.
    const mentions = buildMentions(text, options)
    expect(text.slice(3, 10)).toBe('@Alice\u2005')
    expect(text.slice(15, 20)).toBe('@Bob\u2005')
    expect(mentions?.positions?.map(position => position.end - position.start)).toEqual([7, 5])
  })

  it('counts positions in UTF-16 code units for astral labels', () => {
    const astral: MentionOption[] = [{ id: 'wxid_emoji', label: '😀' }]
    const text = '@😀\u2005'
    const mentions = buildMentions(text, astral)
    expect(mentions).toEqual({
      userIds: ['wxid_emoji'],
      positions: [{ start: 0, end: 4, index: 0 }],
    })
    expect(text.slice(0, 4)).toBe(text)
  })

  it('reuses one user index for repeated mentions of the same member', () => {
    const text = '@Alice\u2005 ok @Alice\u2005'
    expect(buildMentions(text, options)).toEqual({
      userIds: ['wxid_alice'],
      positions: [
        { start: 0, end: 7, index: 0 },
        { start: 11, end: 18, index: 0 },
      ],
    })
  })

  it('switches the whole payload to @all when any span is @所有人', () => {
    const withAll: MentionOption[] = [{ id: 'notify@all', label: '所有人', all: true }, ...options]
    const text = '@所有人\u2005 please review @Bob\u2005'
    expect(buildMentions(text, withAll)).toEqual({
      all: true,
      positions: [
        { start: 0, end: 5, index: 0 },
        { start: 20, end: 25, index: 0 },
      ],
    })
  })

  it('ignores spans that do not match a known member', () => {
    const text = '@Ghost\u2005 and @Bob\u2005'
    expect(buildMentions(text, options)).toEqual({
      userIds: ['wxid_bob'],
      positions: [{ start: 12, end: 17, index: 0 }],
    })
  })
})

describe('detectMediaKind and mediaLimit', () => {
  function file(name: string, type = ''): File {
    return new File(['x'], name, { type })
  }

  it('classifies by MIME type and by extension', () => {
    expect(detectMediaKind(file('photo.PNG'))).toBe('image')
    expect(detectMediaKind(file('data.bin', 'image/webp'))).toBe('image')
    expect(detectMediaKind(file('clip.MOV'))).toBe('video')
    expect(detectMediaKind(file('clip', 'video/mp4'))).toBe('video')
    expect(detectMediaKind(file('voice.m4a'))).toBe('voice')
    expect(detectMediaKind(file('voice', 'audio/x-caf'))).toBe('voice')
    expect(detectMediaKind(file('notes.webm'))).toBe('voice')
    expect(detectMediaKind(file('archive.zip', 'application/zip'))).toBe('file')
    expect(detectMediaKind(file('noextension'))).toBe('file')
  })

  it('returns the reference upload ceilings', () => {
    expect(mediaLimit('image')).toBe(26_214_383)
    expect(mediaLimit('voice')).toBe(26_214_383)
    expect(mediaLimit('video')).toBe(536_870_912)
    expect(mediaLimit('file')).toBe(536_870_912)
  })

  it('maps outgoing attachment kinds to message types', () => {
    expect(localMediaType('image', 'a.png')).toEqual({ type: 3, body: t('[图片]') })
    expect(localMediaType('video', 'a.mp4')).toEqual({ type: 43, body: t('[视频]') })
    expect(localMediaType('voice', 'a.m4a')).toEqual({ type: 34, body: t('[语音]') })
    expect(localMediaType('file', 'report.pdf')).toEqual({ type: 49, appMessageType: 6, body: 'report.pdf' })
  })
})

describe('persistableMessages', () => {
  it('drops optimistic bubbles entirely', () => {
    const optimistic = localOutgoing({ id: 'local-1' })
    const server = message({ id: 'srv-1' })
    expect(persistableMessages([optimistic, server])).toHaveLength(1)
    expect(persistableMessages([optimistic, server])[0].id).toBe('srv-1')
  })

  it('strips transient send and media fields without mutating the input', () => {
    const item = message({
      id: 'srv-1',
      pending: true,
      sendState: 'queued',
      sendId: 'send-1',
      sendError: 'nope',
      localMedia: { kind: 'image', url: 'blob:preview', name: 'a.png', size: 1, contentType: 'image/png' },
    })
    const [persisted] = persistableMessages([item])
    expect(persisted).not.toHaveProperty('localMedia')
    expect(persisted).not.toHaveProperty('pending')
    expect(persisted).not.toHaveProperty('sendState')
    expect(persisted).not.toHaveProperty('sendId')
    expect(persisted).not.toHaveProperty('sendError')
    expect(JSON.stringify(persisted)).not.toContain('blob:')
    // The live message keeps its runtime fields.
    expect(item.sendState).toBe('queued')
    expect(item.localMedia?.url).toBe('blob:preview')
  })

  it('never persists blob URLs carried by local media bubbles', () => {
    const optimistic = localOutgoing({
      id: 'local-media-1',
      type: 3,
      body: t('[图片]'),
      localMedia: { kind: 'image', url: 'blob:abc', name: 'a.png', size: 1, contentType: 'image/png' },
    })
    expect(JSON.stringify(persistableMessages([optimistic]))).not.toContain('blob:')
  })
})

describe('thread search preview helpers', () => {
  it('previews message bodies, trimmed and capped at 120 characters', () => {
    expect(threadSearchSnippet(message({ body: '  hello  ' }))).toBe('hello')
    expect(threadSearchSnippet(message({ body: 'x'.repeat(200) }))).toHaveLength(120)
    expect(threadSearchSnippet(message({ body: null, type: 3 }))).toBe(t('[图片]'))
    expect(threadSearchSnippet(message({ body: '   ', type: 34 }))).toBe(t('[语音]'))
    expect(threadSearchSnippet(message({ body: null, type: 43 }))).toBe(t('[视频]'))
    expect(threadSearchSnippet(message({ body: null, type: 47 }))).toBe(t('[表情]'))
    expect(threadSearchSnippet(message({ body: null, type: 49 }))).toBe(t('[消息]'))
  })

  it('labels the sender of a search hit', () => {
    setThreads({
      items: [groupThread()],
      activeThreadId: 'room@chatroom',
    })
    const group = getState().threads.items[0]
    group.avatarMembers = [{ id: 'wxid_m', displayName: 'Member Name' }]

    expect(threadSearchSender(message({ direction: 'outgoing', senderId: 'wxid_self' }))).toBe(t('我'))
    expect(threadSearchSender(message({ direction: 'incoming', senderId: 'wxid_m' }))).toBe('Member Name')
    expect(threadSearchSender(message({ direction: 'incoming', senderId: 'wxid_unknown' }))).toBe('wxid_unknown')
    expect(threadSearchSender(message({ direction: 'incoming', senderId: null }))).toBe(t('对方'))
  })
})

describe('mention picker', () => {
  it('returns no options outside a group conversation', () => {
    setThreads({ items: [thread()], activeThreadId: 'thread-1' })
    expect(selectMentionOptions()).toEqual([])
  })

  it('starts with @所有人 and maps member labels with mention-name priority', () => {
    const group = groupThread()
    setThreads({ items: [group], activeThreadId: group.id })
    groupMembersCache.set(group.id, [
      member({ id: 'wxid_a', username: 'wxid_a', displayName: 'Alice', mentionName: null }),
      member({ id: 'wxid_b', username: 'wxid_b', displayName: 'Bob', mentionName: 'Bobby' }),
      member({ id: 'wxid_c', username: 'wxid_c', displayName: '  ', mentionName: '  ' }),
    ])
    expect(selectMentionOptions()).toEqual([
      { id: 'notify@all', label: t('所有人'), all: true },
      { id: 'wxid_a', label: 'Alice' },
      { id: 'wxid_b', label: 'Bobby' },
      { id: 'wxid_c', label: 'wxid_c' },
    ])
  })

  it('reports a pending member load only while nothing is cached', () => {
    const group = groupThread()
    setThreads({ items: [group], activeThreadId: group.id })
    setMessages({ groupMembersLoading: true })
    expect(selectMentionLoading()).toBe(true)

    groupMembersCache.set(group.id, [member()])
    expect(selectMentionLoading()).toBe(false)

    // Non-group conversations never show the mention spinner.
    setThreads({ items: [thread()], activeThreadId: 'thread-1' })
    expect(selectMentionLoading()).toBe(false)
  })

  it('loads group members with cursor paging and skips cached or non-group rows', async () => {
    const listSpy = vi.spyOn(wechatApi, 'listGroupMembers')
      .mockResolvedValueOnce({ items: [member({ id: 'wxid_a' })], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: [member({ id: 'wxid_b' })], nextCursor: null })
    setSession({ account: account() })

    await ensureGroupMembers('room@chatroom')
    expect(listSpy).toHaveBeenCalledTimes(2)
    expect(listSpy).toHaveBeenNthCalledWith(1, 'account-1', 'room@chatroom', 200, null)
    expect(listSpy).toHaveBeenNthCalledWith(2, 'account-1', 'room@chatroom', 200, 'page-2')
    expect(groupMembersCache.get('room@chatroom')?.map(item => item.id)).toEqual(['wxid_a', 'wxid_b'])
    expect(getState().messages.groupMembersLoading).toBe(false)

    // A cached conversation and a direct conversation make no request.
    await ensureGroupMembers('room@chatroom')
    await ensureGroupMembers('thread-1')
    expect(listSpy).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest member list beyond the cache limit', async () => {
    vi.spyOn(wechatApi, 'listGroupMembers').mockResolvedValue({ items: [member()], nextCursor: null })
    setSession({ account: account() })
    expect(GROUP_MEMBERS_CACHE_LIMIT).toBe(40)

    for (let index = 0; index < GROUP_MEMBERS_CACHE_LIMIT + 1; index++)
      await ensureGroupMembers('room-' + String(index) + '@chatroom')

    expect(groupMembersCache.size).toBe(GROUP_MEMBERS_CACHE_LIMIT)
    expect(groupMembersCache.has('room-0@chatroom')).toBe(false)
    expect(groupMembersCache.has('room-' + String(GROUP_MEMBERS_CACHE_LIMIT) + '@chatroom')).toBe(true)
  })
})

describe('mergeServerMessages', () => {
  beforeEach(() => {
    setThreads({ items: [thread()], activeThreadId: 'thread-1' })
  })

  it('replaces an optimistic echo with the authoritative server message', () => {
    const local = localOutgoing({ body: 'ping', createdAt: '2026-05-05T10:00:00.000Z' })
    const server = message({
      id: 'srv-echo',
      direction: 'outgoing',
      senderId: 'wxid_self',
      body: 'ping',
      createdAt: '2026-05-05T10:00:02.000Z',
    })
    setMessages({ items: [local] })
    mergeServerMessages([server])

    const items = getState().messages.items
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('srv-echo')
    // Server rows carry no optimistic flags at all.
    expect(items[0].local).toBeUndefined()
    expect(items[0].pending).toBeUndefined()
  })

  it('keeps optimistic bubbles that carry a send error', () => {
    const failed = localOutgoing({ body: 'ping', sendError: t('发送失败，请稍后重试。') })
    const server = message({
      id: 'srv-echo',
      direction: 'outgoing',
      senderId: 'wxid_self',
      body: 'ping',
      createdAt: '2026-05-05T10:00:02.000Z',
    })
    setMessages({ items: [failed] })
    mergeServerMessages([server])

    const items = getState().messages.items
    expect(items).toHaveLength(2)
    expect(items.some(item => item.local)).toBe(true)
    expect(items.some(item => item.id === 'srv-echo')).toBe(true)
  })

  it('updates an existing message by id and clears its local flags', () => {
    const existing = message({ id: 'srv-1', body: 'old body', pending: true })
    const updated = message({ id: 'srv-1', body: 'new body', createdAt: '2026-05-05T10:05:00.000Z' })
    setMessages({ items: [existing] })
    mergeServerMessages([updated])

    const items = getState().messages.items
    expect(items).toHaveLength(1)
    expect(items[0].body).toBe('new body')
    expect(items[0].local).toBe(false)
    expect(items[0].pending).toBe(false)
  })

  it('sorts the merged window by creation time and id', () => {
    const existing = message({ id: 'm-middle', createdAt: '2026-05-05T10:02:00.000Z' })
    const later = message({ id: 'm-later', createdAt: '2026-05-05T10:03:00.000Z' })
    const earlier = message({ id: 'm-earlier', createdAt: '2026-05-05T10:01:00.000Z' })
    setMessages({ items: [existing] })
    mergeServerMessages([later, earlier])

    expect(getState().messages.items.map(item => item.id)).toEqual(['m-earlier', 'm-middle', 'm-later'])
    expect(getState().messages.items.map(item => item.id)).toEqual(
      [...getState().messages.items].sort(compareMessages).map(item => item.id),
    )
  })

  it('suppresses the server echo of a local media bubble inside the three-minute window', () => {
    const localMedia = localOutgoing({
      id: 'local-media-1',
      type: 3,
      body: t('[图片]'),
      createdAt: '2026-05-05T10:00:00.000Z',
      localMedia: { kind: 'image', url: 'blob:x', name: 'a.png', size: 1, contentType: 'image/png' },
    })
    const echo = message({
      id: 'srv-image',
      type: 3,
      direction: 'outgoing',
      senderId: 'wxid_self',
      body: t('[图片]'),
      createdAt: '2026-05-05T10:00:30.000Z',
    })
    setMessages({ items: [localMedia] })
    mergeServerMessages([echo])

    expect(getState().messages.items.map(item => item.id)).toEqual(['local-media-1'])
  })

  it('merges an old media echo instead of keeping both bubbles', () => {
    const localMedia = localOutgoing({
      id: 'local-media-1',
      type: 3,
      body: t('[图片]'),
      createdAt: '2026-05-05T10:00:00.000Z',
      localMedia: { kind: 'image', url: 'blob:x', name: 'a.png', size: 1, contentType: 'image/png' },
    })
    const echo = message({
      id: 'srv-image',
      type: 3,
      direction: 'outgoing',
      senderId: 'wxid_self',
      body: t('[图片]'),
      createdAt: '2026-05-05T10:10:00.000Z',
    })
    setMessages({ items: [localMedia] })
    mergeServerMessages([echo])

    // The echo budget still retires the optimistic bubble, leaving the server row.
    expect(getState().messages.items.map(item => item.id)).toEqual(['srv-image'])
  })

  it('removes one optimistic bubble per echo when the same text was sent repeatedly', () => {
    const first = localOutgoing({ id: 'local-1', body: 'ping', createdAt: '2026-05-05T10:00:00.000Z' })
    const second = localOutgoing({ id: 'local-2', body: 'ping', createdAt: '2026-05-05T10:00:01.000Z' })
    const echo = message({
      id: 'srv-1',
      direction: 'outgoing',
      senderId: 'wxid_self',
      body: 'ping',
      createdAt: '2026-05-05T10:00:02.000Z',
    })
    setMessages({ items: [first, second] })
    mergeServerMessages([echo])
    expect(getState().messages.items.filter(item => item.local)).toHaveLength(1)
    expect(getState().messages.items.filter(item => item.id === 'srv-1')).toHaveLength(1)
  })

  it('never removes incoming messages that share the outgoing text', () => {
    const incoming = message({ id: 'incoming-1', direction: 'incoming', body: 'ping', createdAt: '2026-05-05T10:00:00.000Z' })
    const echo = message({
      id: 'srv-1',
      direction: 'outgoing',
      senderId: 'wxid_self',
      body: 'ping',
      createdAt: '2026-05-05T10:00:02.000Z',
    })
    setMessages({ items: [incoming] })
    mergeServerMessages([echo])
    expect(getState().messages.items.map(item => item.id)).toEqual(['incoming-1', 'srv-1'])
  })

  it('does not pair an echo from another day with an optimistic bubble', () => {
    const local = localOutgoing({ id: 'local-1', body: 'ping', createdAt: '2026-05-05T10:00:00.000Z' })
    const echo = message({
      id: 'srv-1',
      direction: 'outgoing',
      senderId: 'wxid_self',
      body: 'ping',
      createdAt: '2026-05-06T10:00:00.000Z',
    })
    setMessages({ items: [local] })
    mergeServerMessages([echo])
    expect(getState().messages.items.map(item => item.id)).toEqual(['local-1', 'srv-1'])
  })
})

describe('fetchThreadMessages', () => {
  beforeEach(() => {
    setSession({ account: account() })
    setThreads({ items: [thread()], activeThreadId: 'thread-1' })
  })

  it('resets the window with a sorted page and stores the cursor', async () => {
    const earlier = message({ id: 'm1', createdAt: '2026-05-05T10:00:00.000Z' })
    const later = message({ id: 'm2', createdAt: '2026-05-05T10:01:00.000Z' })
    const listSpy = vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [later, earlier], nextCursor: 'cursor-2' })

    await fetchThreadMessages('thread-1', 'reset')

    expect(listSpy).toHaveBeenCalledWith('account-1', 'thread-1', 20, undefined)
    const messages = getState().messages
    expect(messages.items.map(item => item.id)).toEqual(['m1', 'm2'])
    expect(messages.cursor).toBe('cursor-2')
    expect(messages.loading).toBe(false)
  })

  it('prepends an older page without duplicating known messages', async () => {
    const current = message({ id: 'm2', createdAt: '2026-05-05T10:01:00.000Z' })
    const older = message({ id: 'm1', createdAt: '2026-05-05T10:00:00.000Z' })
    setMessages({ items: [current], cursor: 'cursor-1' })
    const listSpy = vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [older, current], nextCursor: 'cursor-0' })

    await fetchThreadMessages('thread-1', 'older')

    expect(listSpy).toHaveBeenCalledWith('account-1', 'thread-1', 20, 'cursor-1')
    expect(getState().messages.items.map(item => item.id)).toEqual(['m1', 'm2'])
    expect(getState().messages.cursor).toBe('cursor-0')
    expect(getState().messages.olderLoading).toBe(false)
  })

  it('does not load an older page without a cursor', async () => {
    const listSpy = vi.spyOn(wechatApi, 'listMessages')
    await fetchThreadMessages('thread-1', 'older')
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('merges a refresh with echo de-duplication and keeps the cursor when rows exist', async () => {
    const local = localOutgoing({ id: 'local-1', body: 'ping', createdAt: '2026-05-05T10:00:00.000Z' })
    setMessages({ items: [local], cursor: 'keep-me' })
    vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({
      items: [message({ id: 'srv-1', direction: 'outgoing', senderId: 'wxid_self', body: 'ping', createdAt: '2026-05-05T10:00:01.000Z' })],
      nextCursor: 'ignored',
    })

    await fetchThreadMessages('thread-1', 'refresh')

    const messages = getState().messages
    expect(messages.items.map(item => item.id)).toEqual(['srv-1'])
    expect(messages.cursor).toBe('keep-me')
    expect(wechatApi.listMessages).toHaveBeenCalledWith('account-1', 'thread-1', 20, undefined)
  })

  it('drops a response that arrives after the conversation changed', async () => {
    const request = deferred<{ items: Message[], nextCursor: string | null }>()
    vi.spyOn(wechatApi, 'listMessages').mockReturnValue(request.promise)
    setMessages({ items: [], cursor: 'c0' })

    const pending = fetchThreadMessages('thread-1', 'reset')
    setThreads({ activeThreadId: 'thread-2' })
    request.resolve({ items: [message({ id: 'm1' })], nextCursor: 'c1' })
    await pending

    expect(getState().messages.items).toEqual([])
    expect(getState().messages.cursor).toBe('c0')
  })

  it('skips a second refresh while one is in flight', async () => {
    const request = deferred<{ items: Message[], nextCursor: string | null }>()
    const listSpy = vi.spyOn(wechatApi, 'listMessages').mockReturnValue(request.promise)

    const first = fetchThreadMessages('thread-1', 'refresh')
    const second = fetchThreadMessages('thread-1', 'refresh')
    request.resolve({ items: [], nextCursor: null })
    await Promise.all([first, second])

    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(flags.messageRefreshInFlight).toBeNull()
  })

  it('clears a draft conversation on 404 instead of surfacing an error', async () => {
    setThreads({ items: [thread({ id: 'draft-1', isDraft: true })], activeThreadId: 'draft-1' })
    setMessages({ items: [message()], cursor: 'c0' })
    vi.spyOn(wechatApi, 'listMessages').mockRejectedValue(new WechatApiError('missing', 404))

    await fetchThreadMessages('draft-1', 'reset')

    expect(getState().messages.items).toEqual([])
    expect(getState().messages.cursor).toBeNull()
    expect(getState().messages.error).toBe('')
  })

  it('surfaces a reset failure but keeps a refresh failure silent', async () => {
    vi.spyOn(wechatApi, 'listMessages').mockRejectedValue(new WechatApiError('missing', 404))

    await fetchThreadMessages('thread-1', 'reset')
    expect(getState().messages.error).toBe(t('没有找到对应的微信会话，请刷新后重试。'))

    setMessages({ error: '' })
    await fetchThreadMessages('thread-1', 'refresh')
    expect(getState().messages.error).toBe('')
  })
})

describe('thread message cache', () => {
  it('caches the live window per conversation and persists server rows only', () => {
    setSession({ account: account() })
    setMessages({ items: [message({ id: 'srv-1' }), localOutgoing({ id: 'local-1' })], cursor: 'c1' })
    cacheThreadMessages('thread-1')

    expect(threadMessagesCache.get('thread-1')?.items).toBe(getState().messages.items)
    expect(threadMessagesCache.get('thread-1')?.cursor).toBe('c1')
    expect(recentMessages.get('thread-1')?.items.map(item => item.id)).toEqual(['srv-1'])
    expect(recentMessages.get('thread-1')?.cursor).toBe('c1')
  })

  it('ignores an empty conversation id', () => {
    setSession({ account: account() })
    setMessages({ items: [message()] })
    cacheThreadMessages('')
    expect(threadMessagesCache.size).toBe(0)
  })

  it('evicts the least recently used memory window beyond 24 conversations', () => {
    setSession({ account: account() })
    expect(THREAD_CACHE_LIMIT).toBe(24)

    for (let index = 0; index < THREAD_CACHE_LIMIT; index++) {
      setMessages({ items: [], cursor: 'c' + String(index) })
      cacheThreadMessages('thread-' + String(index))
    }
    // Re-accessing thread-0 makes it the newest again.
    setMessages({ items: [], cursor: 'c0' })
    cacheThreadMessages('thread-0')
    setMessages({ items: [], cursor: 'c24' })
    cacheThreadMessages('thread-24')

    expect(threadMessagesCache.size).toBe(THREAD_CACHE_LIMIT)
    expect(threadMessagesCache.has('thread-0')).toBe(true)
    expect(threadMessagesCache.has('thread-1')).toBe(false)
    expect(threadMessagesCache.has('thread-24')).toBe(true)
  })

  it('keeps only the newest eight persisted windows', () => {
    setSession({ account: account() })
    expect(PERSISTED_MESSAGE_THREADS).toBe(8)

    for (let index = 0; index < 10; index++) {
      setMessages({ items: [message({ id: 'm' + String(index), threadId: 'thread-' + String(index) })], cursor: null })
      cacheThreadMessages('thread-' + String(index))
    }
    expect(recentMessages.size).toBe(PERSISTED_MESSAGE_THREADS)
    expect(recentMessages.has('thread-0')).toBe(false)
    expect(recentMessages.has('thread-1')).toBe(false)
    expect(recentMessages.has('thread-9')).toBe(true)
  })
})

describe('persistSessionData and loadCachedSessionData', () => {
  it('writes the reference snapshot shape under the UI cache key', () => {
    setSession({ account: account() })
    setThreads({ items: [thread({ id: 'a' }), thread({ id: 'b' })], contactNames: new Map([['peer-1', 'Peer Name']]), friendNames: new Set(['peer-1']) })
    setMessages({ items: [message({ id: 'srv-1' })], cursor: 'c1' })
    cacheThreadMessages('a')
    persistSessionData()

    const raw = window.localStorage.getItem(UI_CACHE_KEY)
    expect(raw).toBeTruthy()
    const snapshot = JSON.parse(raw as string) as Record<string, unknown>
    expect(Object.keys(snapshot).sort()).toEqual(['contacts', 'friends', 'ownUsername', 'recentMessages', 'savedAt', 'threads'])
    expect(typeof snapshot.savedAt).toBe('number')
    expect(snapshot.ownUsername).toBe('wxid_self')
    expect((snapshot.threads as Thread[]).map(item => item.id)).toEqual(['a', 'b'])
    expect(snapshot.contacts).toEqual({ 'peer-1': 'Peer Name' })
    expect(snapshot.friends).toEqual(['peer-1'])
    const recent = snapshot.recentMessages as Record<string, { items: LocalMessage[], cursor: string | null }>
    expect(Object.keys(recent)).toEqual(['a'])
    expect(recent.a.items.map(item => item.id)).toEqual(['srv-1'])
    expect(recent.a.cursor).toBe('c1')
  })

  it('caps the persisted list at 100 conversations and 2000 friends', () => {
    setSession({ account: account() })
    const threads = Array.from({ length: 101 }, (_, index) => thread({ id: 'thread-' + String(index) }))
    const friends = new Set(Array.from({ length: 2_001 }, (_, index) => 'friend-' + String(index)))
    setThreads({ items: threads, friendNames: friends })
    persistSessionData()

    const snapshot = JSON.parse(window.localStorage.getItem(UI_CACHE_KEY) as string) as {
      threads: Thread[]
      friends: string[]
    }
    expect(snapshot.threads).toHaveLength(100)
    expect(snapshot.friends).toHaveLength(2_000)
  })

  it('repaints cached threads with unread counts suppressed by the read cursor', () => {
    const oldMessage = { ...message(), id: 'preview-1', createdAt: '2026-05-05T10:00:00.000Z' }
    window.localStorage.setItem(UI_CACHE_KEY, JSON.stringify({
      ownUsername: 'wxid_self',
      threads: [
        thread({ id: 'old', unreadCount: 3, lastMessage: { id: 'preview-1', senderId: 'peer-1', senderName: null, direction: 'incoming', type: 1, text: 'hi', createdAt: oldMessage.createdAt } }),
        thread({ id: 'fresh', unreadCount: 2, lastMessage: { id: 'preview-2', senderId: 'peer-1', senderName: null, direction: 'incoming', type: 1, text: 'new', createdAt: new Date(Date.now() + 60_000).toISOString() } }),
      ],
      contacts: { 'peer-1': 'Peer Name' },
      friends: ['peer-1'],
      recentMessages: {
        a: { items: [message({ id: 'srv-1' })], cursor: 'c1' },
        empty: { items: [], cursor: null },
      },
    }))
    window.localStorage.setItem(READ_CURSOR_KEY, JSON.stringify({
      allReadAt: Date.parse('2026-05-06T00:00:00.000Z'),
      threadReadAt: {},
      ownUsername: 'wxid_self',
    }))
    window.localStorage.setItem(DIRECTORY_CACHE_KEY, JSON.stringify({
      ownUsername: 'wxid_self',
      contacts: [contact({ username: 'peer-1' })],
    }))

    loadCachedSessionData()

    const state = getState()
    expect(flags.cachedOwnUsername).toBe('wxid_self')
    expect(state.threads.items.map(item => item.id)).toEqual(['old', 'fresh'])
    expect(state.threads.items[0].unreadCount).toBe(0)
    expect(state.threads.items[1].unreadCount).toBe(2)
    expect(state.threads.contactNames.get('peer-1')).toBe('Peer Name')
    expect(state.threads.friendNames.has('peer-1')).toBe(true)
    expect(state.threads.directoryContacts).toHaveLength(1)
    expect(state.threads.directoryReady).toBe(true)
    expect(recentMessages.has('a')).toBe(true)
    expect(recentMessages.has('empty')).toBe(false)
  })

  it('does not repaint cached data over an already loaded session', () => {
    setThreads({ items: [thread({ id: 'live' })], activeThreadId: 'live' })
    window.localStorage.setItem(UI_CACHE_KEY, JSON.stringify({
      ownUsername: 'wxid_self',
      threads: [thread({ id: 'cached' })],
    }))
    loadCachedSessionData()
    expect(getState().threads.items.map(item => item.id)).toEqual(['live'])
  })

  it('ignores a directory snapshot written for another account', () => {
    window.localStorage.setItem(UI_CACHE_KEY, JSON.stringify({ ownUsername: 'wxid_self' }))
    window.localStorage.setItem(DIRECTORY_CACHE_KEY, JSON.stringify({
      ownUsername: 'wxid_other',
      contacts: [contact({ username: 'peer-1' })],
    }))
    loadCachedSessionData()
    expect(flags.cachedOwnUsername).toBe('wxid_self')
    expect(getState().threads.directoryContacts).toEqual([])
    expect(getState().threads.directoryReady).toBe(false)
  })

  it('ignores a corrupt cache and falls through', () => {
    window.localStorage.setItem(UI_CACHE_KEY, 'not-json')
    expect(() => loadCachedSessionData()).not.toThrow()
    expect(getState().threads.items).toEqual([])
  })
})

describe('ensureCacheAccountMatch', () => {
  it('clears another account state and removes every persisted key', () => {
    flags.cachedOwnUsername = 'wxid_old'
    setThreads({
      items: [thread()],
      contactNames: new Map([['peer-1', 'Name']]),
      friendNames: new Set(['peer-1']),
      directoryContacts: [contact()],
      allReadAt: 123,
    })
    window.localStorage.setItem(UI_CACHE_KEY, '{}')
    window.localStorage.setItem(DIRECTORY_CACHE_KEY, '{}')
    window.localStorage.setItem(READ_CURSOR_KEY, '{}')

    ensureCacheAccountMatch('wxid_new')

    expect(flags.cachedOwnUsername).toBe('wxid_new')
    const state = getState().threads
    expect(state.items).toEqual([])
    expect(state.contactNames.size).toBe(0)
    expect(state.friendNames.size).toBe(0)
    expect(state.directoryContacts).toEqual([])
    expect(state.allReadAt).toBe(0)
    expect(window.localStorage.getItem(UI_CACHE_KEY)).toBeNull()
    expect(window.localStorage.getItem(DIRECTORY_CACHE_KEY)).toBeNull()
    expect(window.localStorage.getItem(READ_CURSOR_KEY)).toBeNull()
  })

  it('keeps the caches when the account is unknown or unchanged', () => {
    flags.cachedOwnUsername = 'wxid_old'
    setThreads({ items: [thread()] })
    ensureCacheAccountMatch(undefined)
    ensureCacheAccountMatch('wxid_old')
    expect(getState().threads.items).toHaveLength(1)
    expect(flags.cachedOwnUsername).toBe('wxid_old')
  })
})

describe('media helpers', () => {
  const assets = (...states: MediaAsset['state'][]): MediaAsset[] =>
    states.map((state, index) => ({ id: 'asset-' + String(index), state }))

  it('classifies which messages need a media lookup', () => {
    expect(isMediaMessage(message({ type: 3 }))).toBe(true)
    expect(isMediaMessage(message({ type: 34 }))).toBe(true)
    expect(isMediaMessage(message({ type: 43 }))).toBe(true)
    expect(isMediaMessage(message({ type: 47 }))).toBe(true)
    expect(isMediaMessage(message({ type: 49, appMessageType: 6 }))).toBe(true)
    expect(isMediaMessage(message({ type: 49, appMessageType: 5 }))).toBe(false)
    expect(isMediaMessage(message({ type: 1 }))).toBe(false)
    expect(isMediaMessage(message({ type: 3, local: true }))).toBe(false)
    expect(isMediaMessage(message({ type: 3, localMedia: { kind: 'image', url: 'blob:x', name: 'a', size: 1, contentType: 'image/png' } }))).toBe(false)
  })

  it('collapses asset states with the reference priority', () => {
    expect(resolveMediaState([])).toBe('missing')
    expect(resolveMediaState(assets('missing' as MediaAsset['state']))).toBe('missing')
    expect(resolveMediaState(assets('expired'))).toBe('expired')
    expect(resolveMediaState(assets('unsupported', 'expired'))).toBe('expired')
    expect(resolveMediaState(assets('pending', 'expired'))).toBe('pending')
    expect(resolveMediaState(assets('available', 'pending'))).toBe('available')
  })

  it('normalizes lookup errors', () => {
    expect(mediaErrorText(null)).toBeNull()
    expect(mediaErrorText(undefined)).toBeNull()
    expect(mediaErrorText('media expired')).toBe('media expired')
    expect(mediaErrorText({ message: '  boom  ' })).toBe('  boom  ')
    expect(mediaErrorText({ message: '   ' })).toBe(t('媒体资源获取失败'))
    expect(mediaErrorText({ code: 'x' })).toBe(t('媒体资源获取失败'))
  })

  it('stores and merges per-message media state', () => {
    setMessageMedia({ messageId: 'm1', assets: [], state: 'missing' })
    setMessageMedia({ messageId: 'm2', assets: [], state: 'pending' })
    expect(Object.keys(getState().messages.mediaByMessage).sort()).toEqual(['m1', 'm2'])

    setMessageMedia({ messageId: 'm1', assets: [], state: 'available' })
    expect(getState().messages.mediaByMessage.m1.state).toBe('available')
    expect(getState().messages.mediaByMessage.m2.state).toBe('pending')
  })

  it('revokes object URLs and forgets them', () => {
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { revokeObjectURL })
    try {
      localMediaUrls.add('blob:x')
      revokeUrl('blob:x')
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:x')
      expect(localMediaUrls.has('blob:x')).toBe(false)

      revokeUrl(null)
      revokeUrl(undefined)
      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    }
    finally {
      Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })
})

describe('staged attachments', () => {
  let createObjectURL: ReturnType<typeof vi.fn>
  let revokeObjectURL: ReturnType<typeof vi.fn>

  beforeEach(() => {
    createObjectURL = vi.fn((file: File) => 'blob:' + file.name)
    revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
  })

  afterEach(() => {
    Reflect.deleteProperty(URL, 'createObjectURL')
    Reflect.deleteProperty(URL, 'revokeObjectURL')
  })

  function file(name: string, type: string, size: number): File {
    const created = new File(['x'], name, { type })
    Object.defineProperty(created, 'size', { value: size })
    return created
  }

  it('stages files up to their kind-specific ceiling', () => {
    setSession({ account: account() })
    stageFiles([
      file('photo.png', 'image/png', 1_000),
      file('clip.mp4', 'video/mp4', 500 * 1024 * 1024),
      file('doc.pdf', 'application/pdf', 512 * 1024 * 1024),
    ])

    const attachments = getState().messages.attachments
    expect(attachments.map(item => item.kind)).toEqual(['image', 'video', 'file'])
    expect(attachments.map(item => item.previewUrl)).toEqual(['blob:photo.png', 'blob:clip.mp4', 'blob:doc.pdf'])
    expect(localMediaUrls.size).toBe(3)
    expect(getState().session.accountActionError).toBe('')
  })

  it('rejects an oversized file with the reference banner text', () => {
    setSession({ account: account() })
    stageFiles([file('huge.png', 'image/png', 26_214_384)])

    expect(getState().messages.attachments).toEqual([])
    expect(getState().session.accountActionError).toBe('huge.png 超过 25 MB发送上限')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('does nothing without a signed-in account', () => {
    stageFiles([file('photo.png', 'image/png', 1_000)])
    expect(getState().messages.attachments).toEqual([])
  })

  it('revokes one preview on removal and all previews on clear', () => {
    setSession({ account: account() })
    stageFiles([file('a.png', 'image/png', 1), file('b.png', 'image/png', 1)])
    const [first, second] = getState().messages.attachments

    removeAttachment(first.id)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:a.png')
    expect(getState().messages.attachments.map(item => item.id)).toEqual([second.id])
    expect(localMediaUrls.has('blob:a.png')).toBe(false)

    clearStagedAttachments()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:b.png')
    expect(getState().messages.attachments).toEqual([])
    expect(localMediaUrls.size).toBe(0)
  })
})

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers()
  try {
    await run()
  }
  finally {
    vi.useRealTimers()
  }
}

describe('in-conversation search', () => {
  beforeEach(() => {
    setSession({ account: account() })
    setThreads({ items: [thread()], activeThreadId: 'thread-1' })
  })

  it('searches the loaded window first, case-insensitively and scoped to the conversation', async () => {
    const searchSpy = vi.spyOn(wechatApi, 'searchMessages').mockResolvedValue({ items: [], nextCursor: null })
    setMessages({
      searchQuery: 'HELLO',
      items: [
        message({ id: 'm1', threadId: 'thread-1', body: 'hello world', createdAt: '2026-05-05T10:00:00.000Z' }),
        message({ id: 'm2', threadId: 'thread-2', body: 'hello elsewhere', createdAt: '2026-05-05T10:01:00.000Z' }),
        message({ id: 'm3', threadId: 'thread-1', body: null, type: 3, createdAt: '2026-05-05T10:02:00.000Z' }),
      ],
    })

    await runThreadSearch()

    expect(searchSpy).toHaveBeenCalledWith('account-1', 'hello', 200, null)
    expect(getState().messages.searchResults.map(item => item.id)).toEqual(['m1'])
    expect(getState().messages.searching).toBe(false)
    expect(getState().messages.searchDone).toBe(true)
  })

  it('pages the daemon search and keeps only hits of the open conversation', async () => {
    const searchSpy = vi.spyOn(wechatApi, 'searchMessages')
      .mockResolvedValueOnce({
        items: [
          message({ id: 'other', threadId: 'thread-2', body: 'hello', createdAt: '2026-05-05T10:00:00.000Z' }),
          message({ id: 'hit-1', threadId: 'thread-1', body: 'hello there', createdAt: '2026-05-05T10:01:00.000Z' }),
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        items: [message({ id: 'hit-2', threadId: 'thread-1', body: 'HELLO', createdAt: '2026-05-05T10:02:00.000Z' })],
        nextCursor: null,
      })
    setMessages({ searchQuery: 'hello', items: [] })

    await runThreadSearch()

    expect(searchSpy).toHaveBeenCalledTimes(2)
    expect(searchSpy).toHaveBeenNthCalledWith(1, 'account-1', 'hello', 200, null)
    expect(searchSpy).toHaveBeenNthCalledWith(2, 'account-1', 'hello', 200, 'page-2')
    expect(getState().messages.searchResults.map(item => item.id)).toEqual(['hit-1', 'hit-2'])
    expect(getState().messages.searchDone).toBe(true)
  })

  it('stops at the 60-hit local ceiling without querying the daemon', async () => {
    const searchSpy = vi.spyOn(wechatApi, 'searchMessages')
    const items = Array.from({ length: 60 }, (_, index) => message({
      id: 'local-' + String(index),
      threadId: 'thread-1',
      body: 'hello',
      createdAt: new Date(Date.UTC(2026, 4, 5, 10, 0, index)).toISOString(),
    }))
    setMessages({ searchQuery: 'hello', items })

    await runThreadSearch()

    expect(searchSpy).not.toHaveBeenCalled()
    expect(getState().messages.searchResults).toHaveLength(60)
    expect(getState().messages.searching).toBe(false)
    // The capped local pass never reaches the daemon pass, so completion stays false.
    expect(getState().messages.searchDone).toBe(false)
  })

  it('clears stale results when the query or conversation is missing', async () => {
    const searchSpy = vi.spyOn(wechatApi, 'searchMessages')
    setMessages({ searchQuery: '   ', searchResults: [message()] })
    await runThreadSearch()
    expect(searchSpy).not.toHaveBeenCalled()
    expect(getState().messages.searchResults).toEqual([])
    expect(getState().messages.searching).toBe(false)

    setThreads({ activeThreadId: null })
    setMessages({ searchQuery: 'hello' })
    await runThreadSearch()
    expect(searchSpy).not.toHaveBeenCalled()
  })

  it('debounces the query watcher by 320 ms', async () => {
    const searchSpy = vi.spyOn(wechatApi, 'searchMessages').mockResolvedValue({ items: [], nextCursor: null })
    setMessages({ items: [] })

    await withFakeTimers(async () => {
      setThreadSearchQuery('hello')
      expect(getState().messages.searchQuery).toBe('hello')
      expect(timers.threadSearchDebounce).not.toBeNull()

      await vi.advanceTimersByTimeAsync(319)
      expect(searchSpy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await flushMicrotasks()
      expect(searchSpy).toHaveBeenCalledTimes(1)
    })
    expect(timers.threadSearchDebounce).toBeNull()
  })

  it('opens and closes the search panel', async () => {
    const focus = vi.fn()
    registerThreadSearchInput({ focus } as unknown as HTMLInputElement)

    await withFakeTimers(async () => {
      toggleThreadSearch()
      expect(getState().messages.searchOpen).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(focus).toHaveBeenCalledTimes(1)
    })

    setMessages({ searchQuery: 'hello', searchResults: [message()], highlightId: 'msg-1' })
    toggleThreadSearch()
    const messages = getState().messages
    expect(messages.searchOpen).toBe(false)
    expect(messages.searchQuery).toBe('')
    expect(messages.searchResults).toEqual([])
    expect(messages.highlightId).toBeNull()
  })
})

describe('reply quoting', () => {
  beforeEach(() => {
    setThreads({
      items: [thread({
        id: 'thread-1',
        peerId: 'peer-1',
        displayName: 'Thread Title',
        avatarMembers: [{ id: 'member-1', displayName: 'Member Name' }],
      })],
      activeThreadId: 'thread-1',
    })
  })

  it('returns null without a quoted message', () => {
    expect(selectReplyToDisplay()).toBeNull()
  })

  it('resolves the sender in the documented priority order', () => {
    setMessages({ replyTo: message({ id: 'r1', direction: 'incoming', senderId: 'peer-1', body: 'quoted' }) })
    expect(selectReplyToDisplay()).toEqual({ sender: 'Thread Title', preview: 'quoted' })

    setThreads({ contactNames: new Map([['peer-1', 'Remark Name']]) })
    expect(selectReplyToDisplay()).toEqual({ sender: 'Remark Name', preview: 'quoted' })

    setThreads({ contactNames: new Map() })
    setMessages({ replyTo: message({ id: 'r2', direction: 'incoming', senderId: 'member-1', body: 'quoted' }) })
    expect(selectReplyToDisplay()).toEqual({ sender: 'Member Name', preview: 'quoted' })

    setMessages({ replyTo: message({ id: 'r3', direction: 'incoming', senderId: 'wxid_raw', body: 'quoted' }) })
    expect(selectReplyToDisplay()).toEqual({ sender: 'wxid_raw', preview: 'quoted' })

    setMessages({ replyTo: message({ id: 'r4', direction: 'incoming', senderId: null, body: 'quoted' }) })
    expect(selectReplyToDisplay()).toEqual({ sender: t('对方'), preview: 'quoted' })

    setMessages({ replyTo: message({ id: 'r5', direction: 'outgoing', senderId: 'wxid_self', body: 'quoted' }) })
    expect(selectReplyToDisplay()).toEqual({ sender: t('我'), preview: 'quoted' })
  })

  it('falls back to a media label and caps the preview at 80 characters', () => {
    setMessages({ replyTo: message({ id: 'r1', body: null, type: 3, direction: 'incoming', senderId: 'peer-1' }) })
    expect(selectReplyToDisplay()?.preview).toBe(t('[图片]'))

    setMessages({ replyTo: message({ id: 'r2', body: 'y'.repeat(200), direction: 'incoming', senderId: 'peer-1' }) })
    expect(selectReplyToDisplay()?.preview).toHaveLength(80)
  })

  it('memoizes unchanged inputs and invalidates on message, names and locale changes', () => {
    setMessages({ replyTo: message({ id: 'r1', direction: 'incoming', senderId: 'peer-1', body: 'quoted' }) })
    const first = selectReplyToDisplay()
    expect(first).not.toBeNull()
    expect(selectReplyToDisplay()).toBe(first)

    setThreads({ contactNames: new Map([['peer-1', 'Renamed']]) })
    expect(selectReplyToDisplay()).not.toBe(first)

    setMessages({ replyTo: message({ id: 'r2', direction: 'incoming', senderId: 'peer-1', body: 'other' }) })
    const afterMessage = selectReplyToDisplay()
    const previousLocale = getLocale()
    try {
      setLocale(previousLocale === 'en' ? 'zh' : 'en')
      expect(selectReplyToDisplay()).not.toBe(afterMessage)
    }
    finally {
      setLocale(previousLocale)
    }
  })

  it('quotes only server-backed messages and focuses the composer', () => {
    const focus = vi.fn()
    registerComposerHandle({ focus })

    startReply(message({ id: 'local', serverId: null }))
    expect(getState().messages.replyTo).toBeNull()
    expect(focus).not.toHaveBeenCalled()

    const server = message({ id: 'srv', serverId: 'server-1' })
    startReply(server)
    expect(getState().messages.replyTo).toBe(server)
    expect(focus).toHaveBeenCalledTimes(1)

    cancelReply()
    expect(getState().messages.replyTo).toBeNull()
  })
})

describe('timeline actions', () => {
  beforeEach(() => {
    setSession({ account: account() })
    setThreads({ items: [thread()], activeThreadId: 'thread-1' })
  })

  it('guards the older page on conversation, cursor and loading state', async () => {
    const listSpy = vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })

    await loadOlderMessages()
    expect(listSpy).not.toHaveBeenCalled()

    setMessages({ cursor: 'c1' })
    await loadOlderMessages()
    expect(listSpy).toHaveBeenCalledWith('account-1', 'thread-1', 20, 'c1')

    listSpy.mockClear()
    setMessages({ cursor: 'c1', olderLoading: true })
    await loadOlderMessages()
    expect(listSpy).not.toHaveBeenCalled()

    setThreads({ activeThreadId: null })
    setMessages({ cursor: 'c1', olderLoading: false })
    await loadOlderMessages()
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('clears the new-message pill on scroll-to-bottom and on jump', () => {
    setMessages({ unseenBelow: 3 })
    handleMessageListBottom()
    expect(getState().messages.unseenBelow).toBe(0)

    const scrollToBottom = vi.fn()
    registerMessageListHandle({ scrollToBottom, scrollToMessage: vi.fn(), isAtBottom: () => false })
    setMessages({ unseenBelow: 2 })
    jumpToLatestMessage()
    expect(scrollToBottom).toHaveBeenCalledWith(true)
    expect(getState().messages.unseenBelow).toBe(0)
  })

  it('refreshes only while the target conversation stays open', async () => {
    const listSpy = vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })

    await withFakeTimers(async () => {
      scheduleMessageRefresh('thread-1')
      await vi.advanceTimersByTimeAsync(259)
      expect(listSpy).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await flushMicrotasks()
      expect(listSpy).toHaveBeenCalledTimes(1)

      scheduleMessageRefresh('thread-2')
      await vi.advanceTimersByTimeAsync(300)
      await flushMicrotasks()
      expect(listSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('refreshes the open conversation and the thread list together', async () => {
    const listMessages = vi.spyOn(wechatApi, 'listMessages').mockResolvedValue({ items: [], nextCursor: null })
    const listThreads = vi.spyOn(wechatApi, 'listThreads').mockResolvedValue({ items: [], nextCursor: null })

    await refreshActiveMessages()

    expect(listMessages).toHaveBeenCalledTimes(1)
    expect(listThreads).toHaveBeenCalledTimes(1)
    expect(getState().session.manualRefreshing).toBe(false)
  })

  it('does nothing without an open conversation', async () => {
    setThreads({ activeThreadId: null })
    const listMessages = vi.spyOn(wechatApi, 'listMessages')

    await refreshActiveMessages()

    expect(listMessages).not.toHaveBeenCalled()
    expect(getState().session.manualRefreshing).toBe(false)
  })
})

function contact(patch: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    username: 'peer-1',
    displayName: 'Peer Name',
    ...patch,
  }
}
