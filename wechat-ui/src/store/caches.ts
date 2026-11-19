// Module-level mutable state that the interface never renders directly:
// conversation caches, in-flight guards, request sequence counters, timer
// handles and small per-page facts. Keeping this out of the store means
// writing it never re-renders anything.

import type { Contact, GroupMember, LocalMessage, Message, Thread } from '../types'

/** Conversation page size used by the thread list endpoint. */
export const PAGE_SIZE = 50
/** Messages rendered when a conversation opens; older pages load lazily. */
export const MESSAGE_PAGE_SIZE = 20
/** Conversation message windows kept in memory (least recently used evicted). */
export const THREAD_CACHE_LIMIT = 24
/** Conversation message windows kept in localStorage across reloads. */
export const PERSISTED_MESSAGE_THREADS = 8
/** Group member lists kept for the mention picker. */
export const GROUP_MEMBERS_CACHE_LIMIT = 40
/** Conversations pre-fetched in the background after the list loads. */
export const WARM_THREAD_LIMIT = 12
/** Delay between two background pre-fetch requests. */
export const WARM_FETCH_INTERVAL = 200
/** Minimum delay between two background pre-fetch rounds. */
export const WARM_TRIGGER_INTERVAL = 5_000
/** Only the newest message inside this window raises a notification card. */
export const TOAST_RECENT_WINDOW_MS = 10 * 60 * 1000
/** Minimum interval between two full contact directory reloads. */
export const DIRECTORY_REFRESH_INTERVAL = 60_000
/** Per-conversation read cursors kept in localStorage. */
export const THREAD_READ_CURSOR_LIMIT = 300
/** Upload ceiling for images and voice clips (25 MiB). */
export const MAX_IMAGE_VOICE_BYTES = 26_214_383
/** Upload ceiling for video and file attachments (512 MiB). */
export const MAX_VIDEO_FILE_BYTES = 536_870_912
/** Number of media lookups issued per batch. */
export const MEDIA_BATCH_SIZE = 4
/** Pause between two media lookup batches. */
export const MEDIA_BATCH_DELAY = 120
/** Delay before retrying media that is still pending. */
export const MEDIA_RETRY_DELAY = 1_500
/** Maximum automatic retries for one pending media message. */
export const MEDIA_MAX_RETRIES = 3

export interface ThreadMessageCacheEntry {
  items: LocalMessage[]
  cursor: string | null
}

export interface PersistedMessageEntry {
  items: Message[]
  cursor: string | null
}

/** In-memory message windows per conversation, least recently used first. */
export const threadMessagesCache = new Map<string, ThreadMessageCacheEntry>()
/** Persisted message windows per conversation, oldest first. */
export const recentMessages = new Map<string, PersistedMessageEntry>()
/** Group member lists per conversation id. */
export const groupMembersCache = new Map<string, GroupMember[]>()
/** Message ids with a media lookup in flight. */
export const mediaInFlight = new Set<string>()
/** Media transfers already requested, keyed by message id and quality. */
export const mediaTransferRequested = new Set<string>()
/** Automatic retry counter per message id. */
export const mediaRetryCounts = new Map<string, number>()
/** Object URLs created for staged attachments and local media bubbles. */
export const localMediaUrls = new Set<string>()
/** Contacts whose authoritative profile was already refreshed this session. */
export const refreshedProfiles = new Set<string>()
/** Auto-dismiss timer per incoming toast id. */
export const toastTimers = new Map<string, number>()
/** Pending delayed toast per conversation id. */
export const toastDelayTimers = new Map<string, number>()

/** Request sequence counters; a stale response is dropped when its counter moved. */
export const counters = {
  qrLoad: 0,
  qrNonce: 0,
  threadSearch: 0,
  groupMembersRequest: 0,
  contactProfileRequest: 0,
  activeMessageRequest: 0,
  streamToken: 0,
  warmGeneration: 0,
}

/** Small mutable facts shared by the action modules. */
export const flags = {
  /** Set once the engine is torn down; async loops check it before continuing. */
  disposed: false,
  /** The login QR code is generated automatically at most once per page load. */
  autoLoginTriggered: false,
  /** Page load time; events older than this are replays and never count as new. */
  bootedAt: Date.now(),
  streamActive: false,
  /** Thread list request in flight; high-frequency events must not pile up. */
  threadsInFlight: false,
  /** Mark-all-read daemon sync in flight. */
  readSyncRunning: false,
  /** WeChat username the persisted caches belong to. */
  cachedOwnUsername: '',
  lastDirectoryLoad: 0,
  lastWarmTrigger: 0,
  lastCursor: null as string | null,
  messageRefreshInFlight: null as string | null,
  autoReadThread: null as Thread | null,
  /** Temporary slot created by the unbound scan login, released once it settles. */
  pendingLoginAccountId: '',
  loginAttemptKey: '',
  loginConflictRetries: 0,
  streamAbort: null as AbortController | null,
  narrowQuery: null as MediaQueryList | null,
}

/** Pending timeout handles. */
export const timers = {
  account: null as number | null,
  login: null as number | null,
  loginRetry: null as number | null,
  threads: null as number | null,
  message: null as number | null,
  accountRefresh: null as number | null,
  friendRequest: null as number | null,
  mediaRetry: null as number | null,
  autoRead: null as number | null,
  threadSearchDebounce: null as number | null,
}

/** Imperative handles registered by the components that own the behaviour. */
export interface MessageListHandle {
  scrollToBottom: (force?: boolean) => void
  scrollToMessage: (id: string) => void
  isAtBottom: () => boolean
}

export interface ComposerHandle {
  focus: () => void
}

export interface SearchFocusHandle {
  focusSearch: () => void
}

export const handles = {
  messageList: null as MessageListHandle | null,
  composer: null as ComposerHandle | null,
  threadList: null as SearchFocusHandle | null,
  contactsPanel: null as SearchFocusHandle | null,
  threadSearchInput: null as HTMLInputElement | null,
}

export function registerMessageListHandle(handle: MessageListHandle | null): void {
  handles.messageList = handle
}

export function registerComposerHandle(handle: ComposerHandle | null): void {
  handles.composer = handle
}

export function registerThreadListHandle(handle: SearchFocusHandle | null): void {
  handles.threadList = handle
}

export function registerContactsPanelHandle(handle: SearchFocusHandle | null): void {
  handles.contactsPanel = handle
}

export function registerThreadSearchInput(element: HTMLInputElement | null): void {
  handles.threadSearchInput = element
}

/** Clears a timeout handle and returns null so callers can reassign it. */
export function clearTimer(handle: number | null): null {
  if (handle !== null)
    window.clearTimeout(handle)
  return null
}

/** Clears every pending timeout tracked by the action modules. */
export function clearAllTimers(): void {
  for (const key of Object.keys(timers) as Array<keyof typeof timers>)
    timers[key] = clearTimer(timers[key])
  for (const timer of toastTimers.values())
    window.clearTimeout(timer)
  toastTimers.clear()
  for (const timer of toastDelayTimers.values())
    window.clearTimeout(timer)
  toastDelayTimers.clear()
}

/** Restores the runtime flags for a fresh engine start. */
export function resetRuntimeState(): void {
  flags.disposed = false
  flags.bootedAt = Date.now()
  flags.streamActive = false
  flags.threadsInFlight = false
  flags.readSyncRunning = false
  flags.lastCursor = null
  flags.messageRefreshInFlight = null
  flags.autoReadThread = null
  flags.lastWarmTrigger = 0
}

/** Drops every cached conversation window, media guard and pending timer. */
export function resetCaches(): void {
  threadMessagesCache.clear()
  recentMessages.clear()
  groupMembersCache.clear()
  mediaInFlight.clear()
  mediaTransferRequested.clear()
  mediaRetryCounts.clear()
  localMediaUrls.clear()
  refreshedProfiles.clear()
  clearAllTimers()
  counters.qrLoad = 0
  counters.qrNonce = 0
  counters.threadSearch = 0
  counters.groupMembersRequest = 0
  counters.contactProfileRequest = 0
  counters.activeMessageRequest = 0
  counters.streamToken = 0
  counters.warmGeneration = 0
}

/** Directory cache snapshot shape stored under the directory cache key. */
export interface DirectoryCacheSnapshot {
  savedAt?: number
  ownUsername?: string
  contacts?: Contact[]
}
