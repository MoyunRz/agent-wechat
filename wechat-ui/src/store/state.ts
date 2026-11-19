import type {
  AccountSummary,
  Contact,
  LocalMessage,
  LoginAttempt,
  MessageMediaMap,
  RailView,
  StagedAttachment,
  Thread,
  ThreadFilter,
  ThemeMode,
} from '../types'
import { createStore } from './create'

export interface IncomingToast {
  id: string
  threadId: string
  name: string
  preview: string
}

export interface SessionState {
  booting: boolean
  bootError: string
  account: AccountSummary | null
  /** WeChat nickname read from the signed-in profile; the alias is only a local slot name. */
  selfName: string
  loginAttempt: LoginAttempt | null
  /** Every account slot known to the daemon, used by the login screen. */
  accountSlots: AccountSummary[]
  loginBusy: boolean
  loginError: string
  qrFailed: boolean
  qrObjectUrl: string | null
  loggingOut: boolean
  offlineToggling: boolean
  accountActionError: string
  streamStatus: 'idle' | 'live' | 'reconnecting'
  manualRefreshing: boolean
  friendRequestCount: number
}

export interface ThreadsState {
  items: Thread[]
  loading: boolean
  error: string
  query: string
  filterMode: ThreadFilter
  activeThreadId: string | null
  detailsOpen: boolean
  /** Narrow (phone) layout: list and conversation panes are mutually exclusive. */
  isNarrow: boolean
  contactProfile: Contact | null
  contactProfileLoading: boolean
  contactProfileError: string
  directoryContacts: Contact[]
  contactNames: Map<string, string>
  friendNames: Set<string>
  directoryReady: boolean
  /** Timestamp of the last mark-all-read, used to suppress stale unread counts. */
  allReadAt: number
  readAt: Record<string, number>
  contactDialogOpen: boolean
}

export interface MessagesState {
  items: LocalMessage[]
  loading: boolean
  olderLoading: boolean
  cursor: string | null
  error: string
  mediaByMessage: MessageMediaMap
  unseenBelow: number
  highlightId: string | null
  searchOpen: boolean
  searchQuery: string
  searchResults: LocalMessage[]
  searching: boolean
  searchDone: boolean
  replyTo: LocalMessage | null
  draft: string
  attachments: StagedAttachment[]
  lightboxSrc: string | null
  groupMembersLoading: boolean
}

export interface UiState {
  themeId: string
  bubbleFontSize: number
  themeMode: ThemeMode
  bubbleInColor: string
  bubbleOutColor: string
  toastDurationMs: number
  toastEnabled: boolean
  railView: RailView
  toasts: IncomingToast[]
  /** Settings popover; kept in the store so a route can open it. */
  settingsOpen: boolean
}

export interface AppState {
  session: SessionState
  threads: ThreadsState
  messages: MessagesState
  ui: UiState
}

export const initialState: AppState = {
  session: {
    booting: true,
    bootError: '',
    account: null,
    selfName: '',
    loginAttempt: null,
    accountSlots: [],
    loginBusy: false,
    loginError: '',
    qrFailed: false,
    qrObjectUrl: null,
    loggingOut: false,
    offlineToggling: false,
    accountActionError: '',
    streamStatus: 'idle',
    manualRefreshing: false,
    friendRequestCount: 0,
  },
  threads: {
    items: [],
    loading: false,
    error: '',
    query: '',
    filterMode: 'all',
    activeThreadId: null,
    detailsOpen: false,
    isNarrow: false,
    contactProfile: null,
    contactProfileLoading: false,
    contactProfileError: '',
    directoryContacts: [],
    contactNames: new Map(),
    friendNames: new Set(),
    directoryReady: false,
    allReadAt: 0,
    readAt: {},
    contactDialogOpen: false,
  },
  messages: {
    items: [],
    loading: false,
    olderLoading: false,
    cursor: null,
    error: '',
    mediaByMessage: {},
    unseenBelow: 0,
    highlightId: null,
    searchOpen: false,
    searchQuery: '',
    searchResults: [],
    searching: false,
    searchDone: false,
    replyTo: null,
    draft: '',
    attachments: [],
    lightboxSrc: null,
    groupMembersLoading: false,
  },
  ui: {
    themeId: 'blue',
    bubbleFontSize: 13.5,
    themeMode: 'dark',
    bubbleInColor: '',
    bubbleOutColor: '',
    toastDurationMs: 4200,
    toastEnabled: true,
    railView: 'chats',
    toasts: [],
    settingsOpen: false,
  },
}

export const store = createStore<AppState>(initialState)

/** Patch one slice without touching the others. */
export function setSession(patch: Partial<SessionState> | ((state: SessionState) => Partial<SessionState>)): void {
  store.setState(state => ({ session: { ...state.session, ...(typeof patch === 'function' ? patch(state.session) : patch) } }))
}

export function setThreads(patch: Partial<ThreadsState> | ((state: ThreadsState) => Partial<ThreadsState>)): void {
  store.setState(state => ({ threads: { ...state.threads, ...(typeof patch === 'function' ? patch(state.threads) : patch) } }))
}

export function setMessages(patch: Partial<MessagesState> | ((state: MessagesState) => Partial<MessagesState>)): void {
  store.setState(state => ({ messages: { ...state.messages, ...(typeof patch === 'function' ? patch(state.messages) : patch) } }))
}

export function setUi(patch: Partial<UiState> | ((state: UiState) => Partial<UiState>)): void {
  store.setState(state => ({ ui: { ...state.ui, ...(typeof patch === 'function' ? patch(state.ui) : patch) } }))
}

export function getState(): AppState {
  return store.getState()
}
