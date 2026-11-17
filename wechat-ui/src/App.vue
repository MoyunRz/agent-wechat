<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { hasHubAuth, invalidateAvatarCache, newIdempotencyKey, wechatApi, WechatApiError } from './api'
import { sendFailureMessage, userFacingErrorMessage } from './errors'
import { consumeEventStream } from './events'
import {
  compareMessages,
  connectionTone,
  dayKey,
  formatListTime,
  previewText,
  threadKindLabel,
  threadName,
} from './format'
import type {
  AccountSummary,
  Contact,
  GroupMember,
  LocalMedia,
  LocalMessage,
  LoginAttempt,
  MediaAsset,
  MediaKind,
  MentionOption,
  Message,
  MessageMedia,
  MessageMediaMap,
  RailView,
  StagedAttachment,
  TextMentions,
  Thread,
  ThreadFilter,
  ThemeMode,
  UiTheme,
  WechatEvent,
} from './types'
import AppRail from './components/AppRail.vue'
import Composer from './components/Composer.vue'
import ContactsPanel from './components/ContactsPanel.vue'
import ContactSearchDialog from './components/ContactSearchDialog.vue'
import Icon from './components/Icon.vue'
import LoginPanel from './components/LoginPanel.vue'
import MessageList from './components/MessageList.vue'
import ThreadAvatar from './components/ThreadAvatar.vue'
import ThreadList from './components/ThreadList.vue'

const PAGE_SIZE = 50
/** 打开会话时先渲染的最近消息条数；更早的消息滚动到顶部时按游标懒加载。 */
const MESSAGE_PAGE_SIZE = 20
/** 消息提示卡片只覆盖最近窗口内的消息；更早的历史回灌一律静默。 */
const TOAST_RECENT_WINDOW_MS = 10 * 60 * 1000
const UI_SETTINGS_KEY = 'vane.wechat.ui-settings'
const DEFAULT_BUBBLE_FONT_SIZE = 13.5
// 新消息卡片默认停留时长（毫秒），可在「界面设置」中调整。
const DEFAULT_TOAST_DURATION = 4200

const UI_THEMES: UiTheme[] = [
  {
    id: 'blue',
    label: '默认蓝',
    accent: '#2f7cf6',
    accentStrong: '#1f6feb',
    accentSoft: 'rgba(47, 124, 246, 0.16)',
    accentFaint: 'rgba(47, 124, 246, 0.06)',
    bubble: 'linear-gradient(135deg, #2f7cf6, #245fdc)',
  },
  {
    id: 'green',
    label: '微信绿',
    accent: '#22c55e',
    accentStrong: '#0e9f6e',
    accentSoft: 'rgba(34, 197, 94, 0.16)',
    accentFaint: 'rgba(34, 197, 94, 0.06)',
    bubble: 'linear-gradient(135deg, #22c55e, #0e9f6e)',
  },
  {
    id: 'purple',
    label: '紫罗兰',
    accent: '#8b5cf6',
    accentStrong: '#6d28d9',
    accentSoft: 'rgba(139, 92, 246, 0.16)',
    accentFaint: 'rgba(139, 92, 246, 0.06)',
    bubble: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
  },
  {
    id: 'orange',
    label: '暖橙',
    accent: '#f97316',
    accentStrong: '#ea580c',
    accentSoft: 'rgba(249, 115, 22, 0.16)',
    accentFaint: 'rgba(249, 115, 22, 0.06)',
    bubble: 'linear-gradient(135deg, #f97316, #ea580c)',
  },
  {
    id: 'rose',
    label: '玫红',
    accent: '#f43f5e',
    accentStrong: '#e11d48',
    accentSoft: 'rgba(244, 63, 94, 0.16)',
    accentFaint: 'rgba(244, 63, 94, 0.06)',
    bubble: 'linear-gradient(135deg, #f43f5e, #e11d48)',
  },
]

function normalizeHexColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : ''
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function mixHex(base: string, target: string, ratio: number): string {
  const from = hexToRgb(base)
  const to = hexToRgb(target)
  const channel = (index: number) => Math.round(from[index] + (to[index] - from[index]) * ratio)
  return `#${channel(0).toString(16).padStart(2, '0')}${channel(1).toString(16).padStart(2, '0')}${channel(2).toString(16).padStart(2, '0')}`
}

function rgbaColor(hex: string, alpha: number): string {
  const [red, green, blue] = hexToRgb(hex)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function relativeLuminance(hex: string): number {
  const channel = (value: number) => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }
  const [red, green, blue] = hexToRgb(hex)
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

function readableTextColor(hex: string): string {
  return relativeLuminance(hex) > 0.5 ? '#0f172a' : '#ffffff'
}

function loadUiSettings(): {
  themeId: string
  bubbleFontSize: number
  themeMode: ThemeMode
  bubbleInColor: string
  bubbleOutColor: string
  toastDurationMs: number
  toastEnabled: boolean
} {
  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_KEY)
    if (!raw) {
      return {
        themeId: 'blue',
        bubbleFontSize: DEFAULT_BUBBLE_FONT_SIZE,
        themeMode: 'dark',
        bubbleInColor: '',
        bubbleOutColor: '',
        toastDurationMs: DEFAULT_TOAST_DURATION,
        toastEnabled: true,
      }
    }
    const parsed = JSON.parse(raw) as {
      themeId?: unknown
      bubbleFontSize?: unknown
      themeMode?: unknown
      bubbleInColor?: unknown
      bubbleOutColor?: unknown
      toastDurationMs?: unknown
      toastEnabled?: unknown
    }
    const themeId = typeof parsed.themeId === 'string' && UI_THEMES.some(theme => theme.id === parsed.themeId)
      ? parsed.themeId
      : 'blue'
    const size = typeof parsed.bubbleFontSize === 'number' && Number.isFinite(parsed.bubbleFontSize)
      ? Math.min(18, Math.max(12, parsed.bubbleFontSize))
      : DEFAULT_BUBBLE_FONT_SIZE
    const themeMode = parsed.themeMode === 'light' ? 'light' : 'dark'
    const toastDuration = typeof parsed.toastDurationMs === 'number' && Number.isFinite(parsed.toastDurationMs)
      ? Math.min(30_000, Math.max(2_000, parsed.toastDurationMs))
      : DEFAULT_TOAST_DURATION
    return {
      themeId,
      bubbleFontSize: size,
      themeMode,
      bubbleInColor: normalizeHexColor(parsed.bubbleInColor),
      bubbleOutColor: normalizeHexColor(parsed.bubbleOutColor),
      toastDurationMs: toastDuration,
      toastEnabled: parsed.toastEnabled !== false,
    }
  }
  catch {
    return {
      themeId: 'blue',
      bubbleFontSize: DEFAULT_BUBBLE_FONT_SIZE,
      themeMode: 'dark',
      bubbleInColor: '',
      bubbleOutColor: '',
      toastDurationMs: DEFAULT_TOAST_DURATION,
      toastEnabled: true,
    }
  }
}

const initialUiSettings = loadUiSettings()
const themeId = ref(initialUiSettings.themeId)
const bubbleFontSize = ref(initialUiSettings.bubbleFontSize)
const themeMode = ref<ThemeMode>(initialUiSettings.themeMode)
const bubbleInColor = ref(initialUiSettings.bubbleInColor)
const bubbleOutColor = ref(initialUiSettings.bubbleOutColor)
const toastDurationMs = ref(initialUiSettings.toastDurationMs)
const toastEnabled = ref(initialUiSettings.toastEnabled)

function applyUiSettings(): void {
  const theme = UI_THEMES.find(item => item.id === themeId.value) ?? UI_THEMES[0]
  const root = document.documentElement
  root.style.setProperty('--accent', theme.accent)
  root.style.setProperty('--accent-strong', theme.accentStrong)
  root.style.setProperty('--accent-soft', theme.accentSoft)
  root.style.setProperty('--accent-faint', theme.accentFaint)
  root.style.setProperty('--bubble-font-size', `${bubbleFontSize.value}px`)
  root.classList.toggle('theme-light', themeMode.value === 'light')

  const incoming = normalizeHexColor(bubbleInColor.value)
    || (themeMode.value === 'light' ? '#ffffff' : '#1a212c')
  const outgoing = normalizeHexColor(bubbleOutColor.value) || theme.accent
  const incomingText = readableTextColor(incoming)
  const outgoingText = readableTextColor(outgoing)

  root.style.setProperty('--bubble-in', incoming)
  root.style.setProperty('--bubble-in-bg', `linear-gradient(180deg, ${mixHex(incoming, '#ffffff', 0.05)}, ${incoming})`)
  root.style.setProperty('--bubble-in-text', incomingText)
  root.style.setProperty('--bubble-in-meta', rgbaColor(incomingText, 0.58))
  root.style.setProperty('--bubble-in-surface', rgbaColor(incomingText, 0.08))
  root.style.setProperty('--bubble-in-surface-strong', rgbaColor(incomingText, 0.14))
  root.style.setProperty('--bubble-in-danger', incomingText === '#ffffff' ? '#fecaca' : '#b91c1c')

  root.style.setProperty('--bubble-out', `linear-gradient(135deg, ${outgoing}, ${mixHex(outgoing, '#000000', 0.12)})`)
  root.style.setProperty('--bubble-out-text', outgoingText)
  root.style.setProperty('--bubble-out-meta', rgbaColor(outgoingText, 0.74))
  root.style.setProperty('--bubble-out-surface', rgbaColor(outgoingText, 0.12))
  root.style.setProperty('--bubble-out-surface-strong', rgbaColor(outgoingText, 0.18))
  root.style.setProperty('--bubble-out-danger', outgoingText === '#ffffff' ? '#fecaca' : '#b91c1c')
  root.style.setProperty('--bubble-out-shadow', `0 3px 12px ${rgbaColor(outgoing, 0.24)}, inset 0 1px 0 ${rgbaColor(outgoingText, 0.14)}`)
}

function persistUiSettings(): void {
  try {
    window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({
      themeId: themeId.value,
      bubbleFontSize: bubbleFontSize.value,
      themeMode: themeMode.value,
      bubbleInColor: bubbleInColor.value,
      bubbleOutColor: bubbleOutColor.value,
      toastDurationMs: toastDurationMs.value,
      toastEnabled: toastEnabled.value,
    }))
  }
  catch {
    // 隐私模式等场景下写入失败不影响当前设置。
  }
}

applyUiSettings()

watch([themeId, bubbleFontSize, themeMode, bubbleInColor, bubbleOutColor, toastDurationMs, toastEnabled], () => {
  applyUiSettings()
  persistUiSettings()
})

const booting = ref(true)
const bootError = ref('')
const account = ref<AccountSummary | null>(null)
// 登录后从个人资料读取真实微信昵称（如 rxz），账号别名只作为本地槽位标识。
const selfName = ref('')

const loginAttempt = ref<LoginAttempt | null>(null)
/** 每次页面加载只自动生成一次登录二维码；失败后走手动按钮。 */
let autoLoginTriggered = false
/** 缓存所属的微信账号身份；换号登录时不沿用旧缓存，防止串号展示。 */
let cachedOwnUsername = ''
const loginBusy = ref(false)
const loginError = ref('')
const qrFailed = ref(false)
const qrObjectUrl = ref<string | null>(null)
const qrNonce = ref(0)
const loggingOut = ref(false)
const accountActionError = ref('')

const threads = ref<Thread[]>([])
const threadsLoading = ref(false)
const threadsError = ref('')
const threadQuery = ref('')
const filterMode = ref<ThreadFilter>('all')
const railView = ref<RailView>('chats')
const activeThreadId = ref<string | null>(null)
const threadDetailsOpen = ref(false)

const contactProfile = ref<Contact | null>(null)
const contactProfileLoading = ref(false)
const contactProfileError = ref('')
let contactProfileRequest = 0

const messages = ref<LocalMessage[]>([])
const messagesLoading = ref(false)
const olderLoading = ref(false)
const messagesCursor = ref<string | null>(null)
const messageError = ref('')

// 会话消息内存缓存：切换会话回来先展示缓存（秒开、无骨架屏），再后台静默刷新。
// 缓存保存的是 messages 数组的活引用，刷新/合并后自动保持最新；LRU 上限 24 个会话。
const THREAD_CACHE_LIMIT = 24
const threadMessagesCache = new Map<string, { items: LocalMessage[], cursor: string | null }>()

// 消息窗口持久化：页面刷新后内存缓存清空，最近 8 个会话的消息先从 localStorage
// 铺底（秒显、无骨架屏），再后台静默合并。只存服务端权威消息，本地乐观气泡
// 与 blob 媒体 URL 刷新后失效，一律不落盘。登出时随 UI_CACHE_KEY 一起清除。
const PERSISTED_MESSAGE_THREADS = 8
const recentMessages = new Map<string, { items: Message[], cursor: string | null }>()

function persistableMessages(items: LocalMessage[]): Message[] {
  return items
    .filter(item => !item.local)
    .map((item) => {
      const { localMedia: _media, local: _local, pending: _pending, sendState: _state, sendId: _id, sendError: _error, ...rest } = item
      return rest
    })
}

function cacheThreadMessages(threadId: string): void {
  if (!threadId)
    return
  threadMessagesCache.delete(threadId)
  threadMessagesCache.set(threadId, { items: messages.value, cursor: messagesCursor.value })
  while (threadMessagesCache.size > THREAD_CACHE_LIMIT) {
    const oldest = threadMessagesCache.keys().next().value
    if (oldest === undefined)
      break
    threadMessagesCache.delete(oldest)
  }
  recentMessages.delete(threadId)
  recentMessages.set(threadId, { items: persistableMessages(messages.value), cursor: messagesCursor.value })
  while (recentMessages.size > PERSISTED_MESSAGE_THREADS) {
    const oldest = recentMessages.keys().next().value
    if (oldest === undefined)
      break
    recentMessages.delete(oldest)
  }
  persistSessionData()
}

// 页面刷新后的启动缓存：先把上次保存的会话列表/联系人目录画出来，再后台刷新替换。
const UI_CACHE_KEY = 'vane.wechat.ui-cache'

function loadCachedSessionData(): void {
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
    cachedOwnUsername = typeof parsed.ownUsername === 'string' ? parsed.ownUsername : ''
    loadReadCursor()
    if (Array.isArray(parsed.threads) && threads.value.length === 0) {
      const cachedThreads = parsed.threads as Thread[]
      if (allReadAt.value)
        cachedThreads.forEach((thread) => { thread.unreadCount = suppressReadCursor(thread.unreadCount ?? 0, thread) })
      threads.value = cachedThreads
    }
    if (parsed.contacts && typeof parsed.contacts === 'object' && contactNames.value.size === 0) {
      contactNames.value = new Map(Object.entries(parsed.contacts as Record<string, string>))
      applyContactNames()
    }
    if (Array.isArray(parsed.friends) && friendNames.value.size === 0)
      friendNames.value = new Set(parsed.friends as string[])
    // 全量目录快照：刷新后通讯录直接秒开上次的分组数据，后台再静默刷新替换。
    try {
      const rawDir = window.localStorage.getItem(DIRECTORY_CACHE_KEY)
      if (rawDir) {
        const dir = JSON.parse(rawDir) as { contacts?: unknown, ownUsername?: unknown }
        const sameAccount = !dir.ownUsername
          || !cachedOwnUsername
          || dir.ownUsername === cachedOwnUsername
        if (sameAccount && Array.isArray(dir.contacts) && dir.contacts.length > 0 && directoryContacts.value.length === 0) {
          directoryContacts.value = dir.contacts as Contact[]
          // 快照已是完整目录：陌生人横幅在后台重载完成前也不误报。
          contactDirectoryReady.value = true
        }
      }
    }
    catch {
      // 目录快照损坏时忽略，走正常后台加载。
    }
    // 最近会话的消息窗口：刷新后打开会话先铺底秒显，后台刷新再合并。
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
    // 缓存损坏时忽略，走正常加载。
  }
}

/** 换号登录时不沿用上一个账号的持久化缓存，防止串号展示。 */
function ensureCacheAccountMatch(ownUsername: string | null | undefined): void {
  if (!cachedOwnUsername || !ownUsername || cachedOwnUsername === ownUsername)
    return
  cachedOwnUsername = ownUsername
  threads.value = []
  recentMessages.clear()
  threadMessagesCache.clear()
  contactNames.value = new Map()
  friendNames.value = new Set()
  directoryContacts.value = []
  lastDirectoryLoad = 0
  allReadAt.value = 0
  applyContactNames()
  try {
    window.localStorage.removeItem(UI_CACHE_KEY)
    window.localStorage.removeItem(DIRECTORY_CACHE_KEY)
    window.localStorage.removeItem(READ_CURSOR_KEY)
  }
  catch {
    // 清理失败不影响主流程。
  }
}

function persistSessionData(): void {
  try {
    const recent: Record<string, { items: Message[], cursor: string | null }> = {}
    for (const [threadId, entry] of recentMessages)
      recent[threadId] = entry
    window.localStorage.setItem(UI_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      ownUsername: account.value?.ownUsername ?? cachedOwnUsername,
      threads: threads.value.slice(0, 100),
      contacts: Object.fromEntries(contactNames.value),
      friends: [...friendNames.value].slice(0, 2000),
      recentMessages: recent,
    }))
  }
  catch {
    // 隐私模式等场景下写入失败不影响当前使用。
  }
}

const draft = ref('')
// 图片放大预览遮罩：点图片打开，点遮罩/Esc 关闭；表情包（type 47）不触发。
const lightboxSrc = ref<string | null>(null)

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && lightboxSrc.value)
    lightboxSrc.value = null
}
// 当前引用回复的消息：hover 气泡上的引用按钮设置；发送或切换会话后清空。
const replyTo = ref<LocalMessage | null>(null)

// 会话内历史搜索：头部 🔍 展开，daemon 全量检索后按当前会话过滤，点击结果定位并高亮。
const THREAD_SEARCH_RESULT_LIMIT = 60
const THREAD_SEARCH_MAX_PAGES = 8
const threadSearchOpen = ref(false)
const threadSearchQuery = ref('')
const threadSearchResults = ref<LocalMessage[]>([])
const threadSearching = ref(false)
const threadSearchDone = ref(false)
const threadSearchInput = ref<HTMLInputElement | null>(null)
const messageHighlightId = ref<string | null>(null)
let threadSearchToken = 0
let threadSearchDebounce: number | null = null

function threadSearchMatches(item: LocalMessage, keyword: string): boolean {
  const text = item.body?.toLowerCase() ?? ''
  return text.includes(keyword)
}

function threadSearchSender(item: LocalMessage): string {
  if (item.direction === 'outgoing')
    return '我'
  const thread = activeThread.value
  const member = thread?.avatarMembers?.find(candidate => candidate.id === item.senderId)
  return member?.displayName || item.senderId || '对方'
}

function threadSearchSnippet(item: LocalMessage): string {
  const text = item.body?.trim() ?? ''
  if (text)
    return text.slice(0, 120)
  switch (item.type) {
    case 3: return '[图片]'
    case 34: return '[语音]'
    case 43: return '[视频]'
    case 47: return '[表情]'
    default: return '[消息]'
  }
}

async function runThreadSearch(): Promise<void> {
  const current = account.value
  const threadId = activeThreadId.value
  const keyword = threadSearchQuery.value.trim().toLowerCase()
  threadSearchResults.value = []
  if (!current || !threadId || !keyword) {
    threadSearching.value = false
    return
  }
  const seq = ++threadSearchToken
  threadSearching.value = true
  threadSearchDone.value = false
  try {
    const results = new Map<string, LocalMessage>()
    const collect = (items: LocalMessage[]): void => {
      for (const item of items) {
        if (item.threadId === threadId && threadSearchMatches(item, keyword))
          results.set(item.id, item)
      }
      threadSearchResults.value = [...results.values()].sort(compareMessages)
    }
    // 1) 先搜当前已加载的消息，立刻出结果。
    collect(messages.value)
    if (results.size >= THREAD_SEARCH_RESULT_LIMIT)
      return
    // 2) 服务端全量检索（daemon 不支持按会话过滤，客户端过滤当前会话），自动翻页。
    let cursor: string | null = null
    for (let page = 0; page < THREAD_SEARCH_MAX_PAGES; page++) {
      if (seq !== threadSearchToken || disposed)
        return
      const response = await wechatApi.searchMessages(current.id, keyword, 200, cursor)
      collect(response.items ?? [])
      if (results.size >= THREAD_SEARCH_RESULT_LIMIT)
        return
      cursor = response.nextCursor ?? null
      if (!cursor) {
        threadSearchDone.value = true
        return
      }
    }
    threadSearchDone.value = true
  }
  catch {
    // 搜索失败保持当前结果；输入变化时会重新触发。
  }
  finally {
    if (seq === threadSearchToken)
      threadSearching.value = false
  }
}

function toggleThreadSearch(): void {
  threadSearchOpen.value = !threadSearchOpen.value
  if (threadSearchOpen.value) {
    void nextTick(() => threadSearchInput.value?.focus())
  }
  else {
    threadSearchQuery.value = ''
    threadSearchResults.value = []
    messageHighlightId.value = null
  }
}

async function jumpToSearchResult(item: LocalMessage): Promise<void> {
  threadSearchOpen.value = false
  if (activeThreadId.value !== item.threadId)
    return
  // 目标消息不在已加载区间时，自动向上翻历史加载（上限 20 页）。
  let hops = 0
  while (!messages.value.some(candidate => candidate.id === item.id) && messagesCursor.value && hops < 20) {
    await loadOlderMessages()
    hops += 1
  }
  if (!messages.value.some(candidate => candidate.id === item.id))
    return
  await nextTick()
  messageList.value?.scrollToMessage(item.id)
  messageHighlightId.value = item.id
  window.setTimeout(() => {
    messageHighlightId.value = null
  }, 2400)
}

watch(threadSearchQuery, () => {
  if (threadSearchDebounce !== null)
    window.clearTimeout(threadSearchDebounce)
  threadSearchDebounce = window.setTimeout(() => {
    threadSearchDebounce = null
    void runThreadSearch()
  }, 320)
})

// ---- @ 提及（群聊）-----------------------------------------------------

const GROUP_MEMBERS_CACHE_LIMIT = 40
const groupMembersCache = new Map<string, GroupMember[]>()
const groupMembersLoading = ref(false)
let groupMembersRequestId = 0

const activeThreadIsGroup = computed(() => {
  const thread = activeThread.value
  return Boolean(thread && thread.kind === 'group' && thread.peerId.endsWith('@chatroom'))
})

/** 服务号/公众号（gh_）只收不发：隐藏输入框，消息流改为卡片布局。 */
const activeThreadIsOfficial = computed(() =>
  (activeThread.value?.peerId ?? '').trim().startsWith('gh_'))

const mentionOptions = computed<MentionOption[]>(() => {
  if (!activeThreadIsGroup.value || !activeThreadId.value)
    return []
  const members = groupMembersCache.get(activeThreadId.value) ?? []
  const options = members.map((member) => {
    const label = member.mentionName?.trim() || member.displayName?.trim() || member.username
    return { id: member.id, label }
  })
  return [{ id: 'notify@all', label: '所有人', all: true }, ...options]
})

const mentionLoading = computed(() => {
  return activeThreadIsGroup.value
    && groupMembersLoading.value
    && Boolean(activeThreadId.value) && !groupMembersCache.has(activeThreadId.value ?? '')
})

/** 拉取当前群的成员列表（本地 catalog 读，带游标翻页），结果按会话缓存。 */
async function ensureGroupMembers(threadId: string): Promise<void> {
  const current = account.value
  if (!current || !threadId.endsWith('@chatroom'))
    return
  if (groupMembersCache.has(threadId) || groupMembersLoading.value)
    return
  groupMembersLoading.value = true
  const requestId = ++groupMembersRequestId
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
    if (requestId === groupMembersRequestId) {
      if (groupMembersCache.size >= GROUP_MEMBERS_CACHE_LIMIT) {
        const oldest = groupMembersCache.keys().next().value
        if (oldest !== undefined)
          groupMembersCache.delete(oldest)
      }
      groupMembersCache.set(threadId, members)
    }
  }
  catch {
    // 群成员加载失败时 @ 选择器显示为空列表，不影响其他功能。
  }
  finally {
    if (requestId === groupMembersRequestId)
      groupMembersLoading.value = false
  }
}

/**
 * 从草稿文本扫描提及片段（`@名字\u{2005}`，仅选择器插入的文本带 U+2005 结尾），
 * 与成员表匹配后生成服务端契约的 mentions。混用 @所有人 时按 all 发送。
 */
function buildMentions(text: string, options: MentionOption[]): TextMentions | undefined {
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

/** 引用条展示：发送者显示名 + 内容预览。 */
const replyToDisplay = computed(() => {
  const message = replyTo.value
  if (!message)
    return null
  const text = message.body?.trim() ?? ''
  const preview = text || (message.type === 3
    ? '[图片]'
    : message.type === 34
      ? '[语音]'
      : message.type === 43
        ? '[视频]'
        : message.type === 47
          ? '[表情]'
          : '[消息]')
  // 发送者显示名按 备注>昵称>username>id 优先级解析：优先联系人目录名，
  // 其次群成员展示名，会话对象回退到会话标题，最后才暴露原始 ID。
  const senderId = message.senderId ?? ''
  const sender = message.direction === 'outgoing'
    ? '我'
    : (contactNames.value.get(senderId)
      || (senderId && senderId === activeThread.value?.peerId ? threadName(activeThread.value) : '')
      || activeThread.value?.avatarMembers?.find(item => item.id === senderId)?.displayName
      || senderId
      || '对方')
  return { sender, preview: preview.slice(0, 80) }
})

function startReply(message: LocalMessage): void {
  if (!message.serverId?.trim())
    return
  replyTo.value = message
  composer.value?.focus()
}

const stagedAttachments = ref<StagedAttachment[]>([])
const localMediaUrls = new Set<string>()
const contactDialogOpen = ref(false)
const streamStatus = ref<'idle' | 'live' | 'reconnecting'>('idle')
const manualRefreshing = ref(false)

type IncomingToast = {
  id: string
  threadId: string
  name: string
  preview: string
}

const TOAST_LIMIT = 3
const incomingToasts = ref<IncomingToast[]>([])
const unseenBelow = ref(0)
const toastTimers = new Map<string, number>()
const toastDelayTimers = new Map<string, number>()

const MAX_IMAGE_VOICE_BYTES = 26_214_383
const MAX_VIDEO_FILE_BYTES = 536_870_912

/** 每批查找/触发下载的媒体数量：小批量渐进加载，占位图标先渲染，媒体逐个到位。 */
const MEDIA_BATCH_SIZE = 4
const MEDIA_BATCH_DELAY = 120
const MEDIA_RETRY_DELAY = 1_500
const MEDIA_MAX_RETRIES = 3

const mediaByMessage = ref<MessageMediaMap>({})
const mediaInFlight = new Set<string>()
const mediaTransferRequested = new Set<string>()
const mediaRetryCounts = new Map<string, number>()
let mediaRetryTimer: number | null = null

const messageList = ref<{
  scrollToBottom: (force?: boolean) => void
  scrollToMessage: (id: string) => void
  isAtBottom: () => boolean
} | null>(null)
const composer = ref<{ focus: () => void } | null>(null)
const threadList = ref<{ focusSearch: () => void } | null>(null)
const contactsPanel = ref<{ focusSearch: () => void } | null>(null)

const activeThread = computed(() => {
  if (!activeThreadId.value)
    return null
  return threads.value.find(thread => thread.id === activeThreadId.value) ?? null
})

/** 已确认好友的用户名集合（localType 非空 = 微信服务器通讯录同步确认）。 */
const friendNames = ref<Set<string>>(new Set())

/** 全部会话未读总数：左侧导航聊天图标的计数标记。免打扰会话（灰色徽标）不计入。 */
const unreadTotal = computed(() =>
  threads.value.reduce(
    (sum, thread) => sum + (thread.muted === true ? 0 : (thread.unreadCount ?? 0)),
    0,
  ))

/**
 * 待处理好友申请数：左侧导航通讯录图标的计数标记。
 * 与通讯录面板的申请列表各自独立轮询（轻量读接口）；失败保持现值不清零，
 * 避免旧版 hub 无接口时闪红。
 */
const FRIEND_REQUEST_POLL_INTERVAL = 20_000
const friendRequestCount = ref(0)
let friendRequestCountTimer: number | null = null

async function refreshFriendRequestCount(): Promise<void> {
  const current = account.value
  if (!current?.authenticated)
    return
  try {
    const response = await wechatApi.listFriendRequests(current.id)
    friendRequestCount.value = (response.items ?? []).length
  }
  catch {
    // 拉取失败保持现值；旧版 hub 无该接口时始终为 0。
  }
}

function startFriendRequestPoll(): void {
  if (friendRequestCountTimer !== null)
    return
  void refreshFriendRequestCount()
  friendRequestCountTimer = window.setInterval(() => {
    void refreshFriendRequestCount()
  }, FRIEND_REQUEST_POLL_INTERVAL)
}

function stopFriendRequestPoll(): void {
  friendRequestCountTimer = clearTimer(friendRequestCountTimer)
  friendRequestCount.value = 0
}

/**
 * 「全部已读」游标：点击扫把时记录的时间戳，刷新后据此压制 daemon 回填的
 * 历史未读数（早于游标的最后一条消息不再算未读）。游标随账号校验落盘；
 * daemon 侧逐会话已读成功后未读天然为 0，游标只是 UI 兜底。
 */
const READ_CURSOR_KEY = 'vane.wechat.read-cursor'
const allReadAt = ref(0)
/** 会话级已读游标：threadId → 已读时刻。打开会话即记录，刷新后据此压制
 * daemon 回流的陈旧未读（官方客户端仍在运行时会把它的未读计数写回 session.db）。 */
const THREAD_READ_CURSOR_LIMIT = 300
const threadReadAt = ref<Record<string, number>>({})

function persistReadCursor(): void {
  try {
    if (!allReadAt.value && Object.keys(threadReadAt.value).length === 0)
      return
    window.localStorage.setItem(READ_CURSOR_KEY, JSON.stringify({
      allReadAt: allReadAt.value,
      threadReadAt: threadReadAt.value,
      ownUsername: account.value?.ownUsername ?? cachedOwnUsername,
    }))
  }
  catch {
    // 写入失败不影响当前会话内的已读展示。
  }
}

function loadReadCursor(): void {
  try {
    const raw = window.localStorage.getItem(READ_CURSOR_KEY)
    if (!raw)
      return
    const parsed = JSON.parse(raw) as {
      allReadAt?: unknown
      threadReadAt?: unknown
      ownUsername?: unknown
    }
    if (parsed.ownUsername && cachedOwnUsername && parsed.ownUsername !== cachedOwnUsername)
      return
    if (typeof parsed.allReadAt === 'number' && parsed.allReadAt > 0)
      allReadAt.value = parsed.allReadAt
    if (parsed.threadReadAt && typeof parsed.threadReadAt === 'object') {
      const restored: Record<string, number> = {}
      for (const [id, at] of Object.entries(parsed.threadReadAt as Record<string, unknown>)) {
        if (typeof at === 'number' && at > 0)
          restored[id] = at
      }
      threadReadAt.value = restored
    }
  }
  catch {
    // 游标损坏时忽略：未读数按 daemon 数据展示。
  }
}

/** 记录会话已读游标并裁剪到上限（保留最近的记录）。 */
function stampThreadRead(threadId: string): void {
  if (!threadId)
    return
  threadReadAt.value = { ...threadReadAt.value, [threadId]: Date.now() }
  const entries = Object.entries(threadReadAt.value)
  if (entries.length > THREAD_READ_CURSOR_LIMIT) {
    const keep = entries
      .sort((a, b) => b[1] - a[1])
      .slice(0, THREAD_READ_CURSOR_LIMIT)
    threadReadAt.value = Object.fromEntries(keep)
  }
  persistReadCursor()
}

/** 回填未读数时按已读游标压制历史未读；晚于游标的新消息不受影响。 */
function suppressReadCursor(unreadCount: number, thread: Thread): number {
  if (!unreadCount)
    return unreadCount
  const latestAt = Date.parse(thread.lastMessage?.createdAt ?? '')
  if (!Number.isFinite(latestAt))
    return unreadCount
  if (allReadAt.value && latestAt < allReadAt.value)
    return 0
  const readAt = threadReadAt.value[thread.id]
  if (readAt && latestAt < readAt)
    return 0
  return unreadCount
}

/**
 * 后台把 daemon 侧的会话未读逐个清掉（同步到手机等其他设备）。
 * readStateVersion 是全局游标：任何一次已读都会让列表里其他会话的版本失效，
 * 所以只能每轮重拉列表、清一个最旧的未读会话，直到清完或达轮次上限。
 * 每轮都是一次重的全列表请求：低频限速，避免把 daemon 打垮拖慢前台。
 */
async function syncAllThreadsReadToDaemon(): Promise<void> {
  const current = account.value
  if (!current)
    return
  for (let round = 0; round < 40 && !disposed; round++) {
    try {
      const response = await wechatApi.listThreads(current.id, PAGE_SIZE)
      if (disposed)
        return
      const target = (response.items ?? []).find(thread =>
        (thread.unreadCount ?? 0) > 0 && thread.readStateVersion)
      if (!target)
        return
      await wechatApi.markThreadRead(current.id, target.id, target.readStateVersion)
    }
    catch {
      // 409 冲突或网络抖动：下一轮重拉版本继续。
    }
    await sleep(1_500)
  }
}

/** 一键全部已读：立即清 UI + 记游标，daemon 侧后台慢慢同步（单飞防重入）。 */
let readSyncRunning = false

function markAllThreadsRead(): void {
  for (const thread of threads.value)
    thread.unreadCount = 0
  unseenBelow.value = 0
  for (const toast of [...incomingToasts.value])
    dismissToast(toast.id)
  allReadAt.value = Date.now()
  persistReadCursor()
  // UI 已经被游标清零时也要同步 daemon（未读只存在于 daemon/其他设备侧）。
  if (readSyncRunning)
    return
  readSyncRunning = true
  void syncAllThreadsReadToDaemon().finally(() => {
    readSyncRunning = false
  })
}

/** 通讯录目录：username → 展示名，用于在服务端资料同步完成前快速显示名字。 */
const contactNames = ref<Map<string, string>>(new Map())

/** 全量通讯录预载：登录后后台拉取，通讯录面板打开时直接秒开。 */
const directoryContacts = ref<Contact[]>([])

/** 目录快照独立缓存：全量目录体积大，避免挤爆主缓存 key 的 localStorage 配额。 */
const DIRECTORY_CACHE_KEY = 'vane.wechat.directory-cache'
/** 目录全量重拉的最小间隔：SSE 事件风暴或频繁切页时不再反复跑 40 页同步。 */
const DIRECTORY_REFRESH_INTERVAL = 60_000
let lastDirectoryLoad = 0

/** 目录快照瘦身：只保留 UI 展示与分类所需字段，version 等大字段不落盘。 */
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

function persistDirectoryCache(): void {
  try {
    window.localStorage.setItem(DIRECTORY_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      ownUsername: account.value?.ownUsername ?? cachedOwnUsername,
      contacts: directoryContacts.value.map(slimContact),
    }))
  }
  catch {
    // 快照超配额或隐私模式下写入失败：内存缓存仍然有效，不影响当前使用。
  }
}

/**
 * 品牌服务通知用户名集合（美团/瑞幸等 wxid 企业客服）。
 * 这些会话 peerId 不是 gh_ 前缀，靠联系人目录的 business 分类识别，
 * 会话列表把它们与服务号一起折叠进「服务通知」聚合入口。
 */
const businessUsernames = computed(() => {
  const set = new Set<string>()
  for (const contact of directoryContacts.value) {
    if (contact.classification?.category === 'business' && contact.username)
      set.add(contact.username)
  }
  return set
})

/** 好友目录是否已成功加载；完成前不显示陌生人横幅，避免同步未完成时全列表误报。 */
const contactDirectoryReady = ref(false)

/** 单聊对方还不是好友时显示顶部提醒；公众号/小程序类会话无需好友关系，不提醒。 */
const peerIsStranger = computed(() => {
  if (!contactDirectoryReady.value)
    return false
  // 联系人同步尚未就绪时 profile 里只有不完整的联系人行，横幅必然误报。
  if (account.value?.contactSyncReady === false)
    return false
  const thread = activeThread.value
  if (!thread || thread.kind !== 'direct')
    return false
  const peer = (thread.peerId || thread.id).trim()
  if (!peer)
    return false
  // 公众号（gh_）与小程序/OpenIM 客服会话不依赖好友关系，保持界面安静。
  if (peer.startsWith('gh_') || peer.endsWith('@openim'))
    return false
  return !friendNames.value.has(peer)
})

/** 个人类联系人的共同判据：排除公众号/企业微信/系统/群分类。 */
function isPersonalCategory(contact: Contact): boolean {
  const category = contact.classification?.category ?? 'unknown'
  return !NON_PERSONAL_CATEGORIES.has(category)
}

const NON_PERSONAL_CATEGORIES = new Set(['system', 'business', 'openim', 'openimCustomerService', 'group'])

/**
 * 好友名字典（用于会话名覆盖与陌生人横幅判断）。
 * daemon 单页上限 200，这里游标翻页拉全量。
 * 降级：当前 profile 里所有联系人的 localType 都为空（daemon ModContact 投影
 * 尚未写官方 local_type 位）时，把个人类联系人都视为已知联系人，避免
 * 通讯录与陌生人横幅完全失效；一旦出现确认条目则严格只认确认数据。
 */
async function loadContactDirectory(force = false): Promise<void> {
  const current = account.value
  if (!current?.authenticated)
    return
  // 节流：SSE 的 contacts.updated 会随资料同步反复触发；60s 内已拉过全量就跳过，
  // 手动权威刷新（force）不受限。快照铺底后界面有数据，短暂延迟不造成空屏。
  if (!force && Date.now() - lastDirectoryLoad < DIRECTORY_REFRESH_INTERVAL)
    return
  try {
    const items: Contact[] = []
    let cursor: string | null = null
    // 目录加载不设 10 页小上限：联系人超过 2000 时，多出的好友会被误判为陌生人。
    // 每页在 daemon 目录缓存下 ~25ms，安全上限 40 页（8000 条）防异常游标循环。
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
    friendNames.value = friends
    contactNames.value = names
    directoryContacts.value = items
    applyContactNames()
    lastDirectoryLoad = Date.now()
    persistDirectoryCache()
    persistSessionData()
    contactDirectoryReady.value = true
  }
  catch {
    // 目录加载失败保持未就绪：横幅宁可暂时不显示，也不要在数据不完整时全列表误报。
  }
}

/** 本会话周期内已按需刷新过权威资料的联系人，避免重复 RPC。 */
const refreshedProfiles = new Set<string>()

/**
 * 打开单聊时按需拉取权威资料（对齐官方客户端「打开会话即取资料」的行为）：
 * 备注（remark）这类受控字段不会随批量同步落到本地 contact 表，
 * GetContact 读取才是权威来源；成功后目录与列表名自动更新。
 */
async function refreshContactAuthoritative(username: string): Promise<void> {
  const current = account.value
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
    // 离线或资料端点未就绪时静默；contacts.updated 事件流也会驱动目录刷新。
  }
}

function isTerminalOperation(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'expired'
}

/** 服务端会话摘要的 displayName 在资料同步完成前可能是原始 ID；用本地通讯录目录先行覆盖。 */
function applyContactNames(): void {
  if (contactNames.value.size === 0 || threads.value.length === 0)
    return
  for (const thread of threads.value) {
    if (thread.isDraft)
      continue
    const current = thread.displayName?.trim() ?? ''
    const resolved = contactNames.value.get(thread.peerId || thread.id)
    if (resolved && current !== resolved)
      thread.displayName = resolved
  }
}

/** 会话详情里展示的对方微信号；群聊和系统会话没有单一对方。 */
const detailsPeerId = computed(() => {
  const thread = activeThread.value
  if (!thread || thread.kind === 'group' || thread.kind === 'system')
    return ''
  return (thread.peerId || thread.id).trim()
})

const contactProfileName = computed(() => {
  const contact = contactProfile.value
  if (contact) {
    return contact.displayName?.trim()
      || contact.remark?.trim()
      || contact.nickname?.trim()
      || contact.username
      || contact.id
  }
  return activeThread.value ? threadName(activeThread.value) : ''
})

const connectionState = computed(() => {
  const current = account.value
  if (!current)
    return 'offline'
  return connectionTone(current.connection, current.authenticated)
})

let qrLoadSeq = 0

function setQrObjectUrl(url: string | null): void {
  if (qrObjectUrl.value && qrObjectUrl.value !== url)
    URL.revokeObjectURL(qrObjectUrl.value)
  qrObjectUrl.value = url
}

async function loadQrImage(): Promise<void> {
  const current = account.value
  const attempt = loginAttempt.value
  if (!current || !attempt) {
    setQrObjectUrl(null)
    return
  }
  // 与旧 qrUrl 判定一致：仅当二维码就绪时取图。
  if (!attempt.result?.qrAvailable && attempt.state !== 'awaiting_scan') {
    setQrObjectUrl(null)
    return
  }
  const generation = attempt.result?.qrGeneration ?? 0
  const seq = ++qrLoadSeq
  try {
    const url = await wechatApi.loadLoginQr(current.id, attempt.id, generation)
    if (seq !== qrLoadSeq) {
      URL.revokeObjectURL(url)
      return
    }
    setQrObjectUrl(url)
    qrFailed.value = false
  }
  catch {
    if (seq === qrLoadSeq) {
      setQrObjectUrl(null)
      qrFailed.value = true
    }
  }
}

const streamLabel = computed(() => {
  if (streamStatus.value === 'live')
    return '实时同步中'
  if (streamStatus.value === 'reconnecting')
    return '正在重连'
  return '未连接'
})

let accountTimer: number | null = null
let loginTimer: number | null = null
let loginAttemptKey = ''
let threadsTimer: number | null = null
let messageTimer: number | null = null
let accountRefreshTimer: number | null = null
let streamAbort: AbortController | null = null
let streamToken = 0
let streamActive = false
let activeMessageRequest = 0
let lastCursor: string | null = null
let disposed = false
// 页面加载时间；晚于它的事件才可能是新消息（容忍 1 分钟时钟偏差）。
const bootedAt = Date.now()

/**
 * 判断事件是否足够新鲜：流重连或页面刷新时，旧事件可能被重新下发，
 * 其 createdAt 早于页面加载时间，不应触发未读与通知。
 */
function isFreshEvent(createdAt: string): boolean {
  const time = Date.parse(createdAt)
  if (!Number.isFinite(time))
    return true
  return time >= bootedAt - 60_000
}

function clearTimer(timer: number | null): null {
  if (timer !== null)
    window.clearTimeout(timer)
  return null
}

function errorText(error: unknown): string {
  if (error instanceof WechatApiError) {
    switch (error.status) {
      case 401:
        return '登录状态已失效，请重新登录微信。'
      case 404:
        return '没有找到对应的微信会话，请刷新后重试。'
      case 409:
        return error.code === 'operation_in_progress'
          ? '登录正在进行中，请稍后重试。'
          : '微信尚未连接，请稍后重试。'
      case 503:
        return '微信服务暂时不可用，请稍后重试。'
      default:
        break
    }
    return userFacingErrorMessage(error, '微信操作失败，请稍后重试。')
  }
  return userFacingErrorMessage(error, '微信操作失败，请稍后重试。')
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => window.setTimeout(resolve, ms))
}

async function ensureAccount(): Promise<AccountSummary> {
  let items = await wechatApi.listAccounts()
  if (items.length > 0)
    return items[0]

  try {
    return await wechatApi.createAccount()
  }
  catch (error) {
    // 上游创建账号可能已落盘但 operation 返回失败，重读一次再决定。
    items = await wechatApi.listAccounts()
    if (items.length > 0)
      return items[0]
    throw error
  }
}

async function loadSelfProfile(): Promise<void> {
  const current = account.value
  const username = current?.ownUsername?.trim()
  if (!current || !current.authenticated || !username)
    return
  try {
    // 自己不在自己的通讯录里，本地记录常是空壳；优先向服务器定向查询昵称。
    let name = ''
    try {
      const lookup = await wechatApi.lookupContacts(current.id, [username])
      const item = lookup.items?.find(candidate => candidate.id === username)
      const display = item?.displayName?.trim() ?? ''
      if (display && display !== username)
        name = display
    }
    catch {
      // 查询失败时退回本地联系人记录。
    }
    if (!name) {
      const contact = await wechatApi.getContact(current.id, username)
      const display = contact.displayName?.trim() || ''
      const nickname = contact.nickname?.trim() || ''
      name = [display, nickname].find(value => value && value !== username) || ''
    }
    selfName.value = name
  }
  catch {
    // 个人资料读取失败时退回通用名称，不影响聊天主流程。
  }
}

async function bootstrap(): Promise<void> {
  booting.value = true
  bootError.value = ''
  try {
    // 先用上次保存的列表/目录瞬时铺底，网络刷新后自动替换。
    loadCachedSessionData()
    account.value = await ensureAccount()
    ensureCacheAccountMatch(account.value.ownUsername)
    if (account.value.authenticated) {
      await loadSelfProfile()
      await loadThreads()
      void loadContactDirectory()
      void startCatalogSync()
      startStream()
      startFriendRequestPoll()
    }
    else if (!autoLoginTriggered && hasHubAuth()) {
      // 未登录时自动生成登录二维码，省去手动点击；失败后保留手动按钮兜底。
      autoLoginTriggered = true
      void startLogin()
    }
    scheduleAccountPoll()
  }
  catch (error) {
    bootError.value = errorText(error)
  }
  finally {
    booting.value = false
  }
}

function scheduleAccountPoll(delay = 12_000): void {
  accountTimer = clearTimer(accountTimer)
  if (disposed)
    return
  accountTimer = window.setTimeout(() => {
    void pollAccount()
  }, delay)
}

async function pollAccount(): Promise<void> {
  const current = account.value
  if (!current || disposed) {
    scheduleAccountPoll()
    return
  }

  try {
    const next = await wechatApi.getAccount(current.id)
    const wasAuthenticated = current.authenticated
    const wasConnected = current.connection
    account.value = next

    if (!wasAuthenticated && next.authenticated)
      await afterAuthenticated()
    else if (wasAuthenticated && !next.authenticated)
      handleSignedOut()
    else if (next.authenticated && next.connection === 'connected' && wasConnected !== 'connected')
      await loadThreads()
    if (next.authenticated && !selfName.value)
      await loadSelfProfile()
  }
  catch (error) {
    if (error instanceof WechatApiError && error.status === 401)
      bootError.value = errorText(error)
  }

  scheduleAccountPoll()
}

function handleSignedOut(explicit = false): void {
  stopStream()
  stopFriendRequestPoll()
  loginAttempt.value = null
  selfName.value = ''
  threads.value = []
  revokeAllLocalMedia()
  clearMessageMedia()
  threadMessagesCache.clear()
  replyTo.value = null
  // 仅用户主动退出才清空持久化缓存；会话被踢/掉线时保留，重新登录同账号
  // 即可继续秒开（换号由 ensureCacheAccountMatch 按 wxid 校验防串号）。
  if (explicit) {
    recentMessages.clear()
    allReadAt.value = 0
    try {
      window.localStorage.removeItem(UI_CACHE_KEY)
      window.localStorage.removeItem(DIRECTORY_CACHE_KEY)
      window.localStorage.removeItem(READ_CURSOR_KEY)
    }
    catch {
      // 清理失败不影响登出流程。
    }
  }
  messages.value = []
  activeThreadId.value = null
  messagesCursor.value = null
  threadsError.value = ''
  messageError.value = ''
  threadDetailsOpen.value = false
  contactDialogOpen.value = false
  loginAttemptKey = ''
  unseenBelow.value = 0
  incomingToasts.value = []
  friendNames.value = new Set()
  contactNames.value = new Map()
  directoryContacts.value = []
  contactDirectoryReady.value = false
  for (const timer of toastTimers.values())
    window.clearTimeout(timer)
  toastTimers.clear()
  for (const timer of toastDelayTimers.values())
    window.clearTimeout(timer)
  toastDelayTimers.clear()
  clearStagedAttachments()
}

async function afterAuthenticated(): Promise<void> {
  loginAttempt.value = null
  loginError.value = ''
  qrFailed.value = false
  ensureCacheAccountMatch(account.value?.ownUsername)
  await loadSelfProfile()
  // 分阶段加载：先出会话列表，再补联系人资料（名字/头像），最后由用户打开会话时拉取历史消息。
  await loadThreads()
  void loadContactDirectory()
  void startCatalogSync()
  startStream()
  startFriendRequestPoll()
}

/** 让服务器开始同步联系人目录与群资料；完成后经 SSE contacts.updated/group.updated 事件驱动界面刷新。 */
async function startCatalogSync(): Promise<void> {
  const current = account.value
  if (!current?.authenticated)
    return
  try {
    await wechatApi.syncContacts(current.id)
  }
  catch {
    // 目录同步失败不阻塞界面；后续 contacts.updated 事件或手动刷新仍会补齐。
  }
  try {
    await wechatApi.syncGroups(current.id)
  }
  catch {
    // 群资料同步同理。
  }
}

async function refreshAccount(): Promise<void> {
  const current = account.value
  if (!current)
    return
  manualRefreshing.value = true
  try {
    const next = await wechatApi.getAccount(current.id)
    const wasAuthenticated = current.authenticated
    account.value = next
    if (!wasAuthenticated && next.authenticated)
      await afterAuthenticated()
    else if (wasAuthenticated && !next.authenticated)
      handleSignedOut()
    else if (next.authenticated && threads.value.length === 0)
      await loadThreads()
    if (next.authenticated)
      await loadSelfProfile()
  }
  catch (error) {
    loginError.value = errorText(error)
  }
  finally {
    manualRefreshing.value = false
  }
}

async function logoutAccount(): Promise<void> {
  const current = account.value
  if (!current || loggingOut.value)
    return
  loggingOut.value = true
  accountActionError.value = ''
  try {
    await wechatApi.logout(current.id)
    account.value = {
      ...current,
      authenticated: false,
      connection: 'disconnected',
      ownUsername: null,
    }
    handleSignedOut(true)
    loginAttempt.value = null
    loginError.value = ''
    qrFailed.value = false
  }
  catch (error) {
    accountActionError.value = errorText(error)
  }
  finally {
    loggingOut.value = false
  }
}

async function startLogin(): Promise<void> {
  const current = account.value
  if (!current || loginBusy.value)
    return
  loginBusy.value = true
  loginError.value = ''
  accountActionError.value = ''
  qrFailed.value = false
  loginAttempt.value = null
  try {
    if (!loginAttemptKey)
      loginAttemptKey = newIdempotencyKey('login')
    loginAttempt.value = await wechatApi.createLoginAttempt(current.id, loginAttemptKey)
    scheduleLoginPoll()
  }
  catch (error) {
    loginError.value = errorText(error)
  }
  finally {
    loginBusy.value = false
  }
}

function scheduleLoginPoll(delay = 900): void {
  loginTimer = clearTimer(loginTimer)
  if (disposed)
    return
  loginTimer = window.setTimeout(() => {
    void pollLogin()
  }, delay)
}

async function pollLogin(): Promise<void> {
  const current = account.value
  const attempt = loginAttempt.value
  if (!current || !attempt || disposed)
    return

  try {
    const next = await wechatApi.getLoginAttempt(current.id, attempt.id)
    loginAttempt.value = next

    if (next.state === 'succeeded') {
      const latest = await wechatApi.getAccount(current.id)
      account.value = latest
      if (latest.authenticated) {
        loginAttemptKey = ''
        await afterAuthenticated()
        return
      }
      scheduleLoginPoll(700)
      return
    }

    if (next.state === 'failed' || next.state === 'cancelled' || next.state === 'expired' || next.state === 'rejected') {
      loginAttemptKey = ''
      return
    }

    scheduleLoginPoll(next.state === 'awaiting_approval' ? 1500 : 900)
  }
  catch (error) {
    loginError.value = errorText(error)
    scheduleLoginPoll(1800)
  }
}

async function cancelLogin(): Promise<void> {
  const current = account.value
  const attempt = loginAttempt.value
  if (!current || !attempt)
    return
  loginTimer = clearTimer(loginTimer)
  loginBusy.value = true
  try {
    loginAttempt.value = await wechatApi.cancelLoginAttempt(current.id, attempt.id)
    loginAttemptKey = ''
  }
  catch (error) {
    loginError.value = errorText(error)
  }
  finally {
    loginBusy.value = false
  }
}

function retryQr(): void {
  qrFailed.value = false
  qrNonce.value += 1
}

watch(
  () => [account.value?.id, loginAttempt.value?.id, loginAttempt.value?.result?.qrGeneration, qrNonce.value],
  () => {
    qrFailed.value = false
    void loadQrImage()
  },
)

watch(
  () => [account.value?.ownUsername, account.value?.authenticated, selfName.value, activeThread.value?.displayName],
  () => {
    // 展示微信昵称（如 rxz）；账号槽位别名（Vane-n-test）不进入界面标题。
    const accountLabel = account.value?.authenticated ? (selfName.value || '微信') : '微信登录'
    const threadLabel = activeThread.value ? ` · ${threadName(activeThread.value)}` : ''
    document.title = `${accountLabel}${threadLabel}`
  },
  { immediate: true },
)

/** 会话列表在途守卫：SSE 高频事件下避免同接口请求堆积把 daemon 打垮。 */
let threadsInFlight = false

async function loadThreads(): Promise<void> {
  const current = account.value
  if (!current || !current.authenticated || threadsInFlight)
    return
  threadsInFlight = true
  threadsLoading.value = true
  threadsError.value = ''
  try {
    const response = await wechatApi.listThreads(current.id, PAGE_SIZE)
    const items = response.items ?? []
    // 「全部已读」游标兜底：压制 daemon 回填的历史未读，晚于游标的新消息不受影响。
    if (allReadAt.value)
      items.forEach((thread) => { thread.unreadCount = suppressReadCursor(thread.unreadCount ?? 0, thread) })
    // 当前打开的会话永远显示已读：自动已读上报可能因版本冲突暂时失败，
    // 不能让 daemon 的滞后未读数回填到正开着的会话上。
    if (activeThreadId.value)
      items.forEach((thread) => { if (thread.id === activeThreadId.value) thread.unreadCount = 0 })
    const draft = activeThread.value?.isDraft ? activeThread.value : null
    // 新聊天尚未出现在上游列表时保留本地草稿，避免首条消息发出后列表跳回其它会话。
    if (draft && !items.some(thread => thread.id === draft.id))
      threads.value = [draft, ...items]
    else
      threads.value = items
    applyContactNames()
    persistSessionData()
    reconcileActiveThread()
    // 会话列表就绪后后台预热最近会话的消息窗口。
    warmRecentThreads()
  }
  catch (error) {
    threadsError.value = errorText(error)
  }
  finally {
    threadsInFlight = false
    threadsLoading.value = false
  }
}

/** 后台预热的会话数与批间让出间隔：串行低频拉取，避免与前台请求抢 daemon。 */
const WARM_THREAD_LIMIT = 12
const WARM_FETCH_INTERVAL = 200
const WARM_TRIGGER_INTERVAL = 5_000
let warmGeneration = 0
let lastWarmTrigger = 0

/**
 * 后台预热最近会话的消息窗口。daemon 首次解码一个会话的消息要数秒，
 * 预热后点击会话直接命中缓存秒显，最新数据由 selectThread 的后台刷新合并。
 * 只写缓存不触碰 messages.value 等 UI 状态；列表高频刷新时靠双节流防抖。
 */
function warmRecentThreads(): void {
  const current = account.value
  if (!current?.authenticated || disposed)
    return
  if (Date.now() - lastWarmTrigger < WARM_TRIGGER_INTERVAL)
    return
  lastWarmTrigger = Date.now()
  const generation = ++warmGeneration
  void (async () => {
    for (const thread of threads.value.slice(0, WARM_THREAD_LIMIT)) {
      if (generation !== warmGeneration || disposed)
        return
      if (thread.id === activeThreadId.value)
        continue
      if (threadMessagesCache.has(thread.id) || recentMessages.has(thread.id))
        continue
      try {
        const response = await wechatApi.listMessages(current.id, thread.id, MESSAGE_PAGE_SIZE, undefined)
        if (generation !== warmGeneration || disposed)
          return
        const items = (response.items ?? []).slice().sort(compareMessages)
        const cursor = response.nextCursor ?? null
        threadMessagesCache.delete(thread.id)
        threadMessagesCache.set(thread.id, { items: items as LocalMessage[], cursor })
        recentMessages.set(thread.id, { items, cursor })
      }
      catch {
        // 预热失败静默：点击时走正常加载流程。
      }
      await sleep(WARM_FETCH_INTERVAL)
    }
  })()
}

function reconcileActiveThread(): void {
  const existing = activeThreadId.value
    ? threads.value.find(thread => thread.id === activeThreadId.value)
    : null
  if (existing)
    return
  // 分阶段加载：进入应用时不自动打开会话、不拉取历史消息；
  // 只有已打开的会话被上游移除时，才回退选中列表第一条。
  if (!activeThreadId.value)
    return
  const first = threads.value[0]
  if (first) {
    void selectThread(first)
    return
  }
  activeThreadId.value = null
  messages.value = []
  messagesCursor.value = null
}

function scheduleThreadRefresh(delay = 350): void {
  threadsTimer = clearTimer(threadsTimer)
  threadsTimer = window.setTimeout(() => {
    void loadThreads()
  }, delay)
}

async function selectThread(thread: Thread): Promise<void> {
  if (activeThreadId.value === thread.id)
    return
  activeThreadId.value = thread.id
  threadDetailsOpen.value = false
  thread.unreadCount = 0
  unseenBelow.value = 0
  revokeAllLocalMedia()
  replyTo.value = null
  threadSearchOpen.value = false
  threadSearchQuery.value = ''
  threadSearchResults.value = []
  messageHighlightId.value = null
  messageError.value = ''
  // 群聊会话后台预取成员列表，@ 选择器即开即用。
  void ensureGroupMembers(thread.id)
  // 单聊按需拉取权威资料：备注等受控字段只有 GetContact 才会落到本地目录。
  const peer = (thread.peerId || thread.id).trim()
  if (thread.kind === 'direct' && !peer.startsWith('gh_') && !peer.endsWith('@openim'))
    void refreshContactAuthoritative(peer)
  // 缓存命中：先展示缓存内容（秒开），再后台静默刷新；未命中才走加载流程。
  const cached = threadMessagesCache.get(thread.id)
  if (cached) {
    threadMessagesCache.delete(thread.id)
    threadMessagesCache.set(thread.id, cached)
    messages.value = cached.items
    messagesCursor.value = cached.cursor
    // 缓存数据尚未做过媒体查找：立即按最新优先渐进加载，图片占位不再干等网络刷新。
    void loadMediaForMessages(messages.value)
    void fetchThreadMessages(thread.id, 'refresh')
  }
  else if (recentMessages.has(thread.id)) {
    // 刷新页面后内存缓存已空：用持久化的消息窗口铺底秒显，后台刷新合并。
    const persisted = recentMessages.get(thread.id)!
    messages.value = persisted.items.map(item => ({ ...item }))
    messagesCursor.value = persisted.cursor
    cacheThreadMessages(thread.id)
    void loadMediaForMessages(messages.value)
    void fetchThreadMessages(thread.id, 'refresh')
  }
  else {
    messages.value = []
    messagesCursor.value = null
    await fetchThreadMessages(thread.id, 'reset')
  }
  markThreadRead(thread)
  composer.value?.focus()
}

async function loadContactProfile(): Promise<void> {
  const current = account.value
  const username = detailsPeerId.value
  const token = ++contactProfileRequest
  contactProfile.value = null
  contactProfileError.value = ''
  if (!current || !username) {
    contactProfileLoading.value = false
    return
  }
  contactProfileLoading.value = true
  try {
    const contact = await wechatApi.getContact(current.id, username)
    if (token !== contactProfileRequest)
      return
    contactProfile.value = contact
  }
  catch (error) {
    if (token !== contactProfileRequest)
      return
    contactProfileError.value = error instanceof WechatApiError && error.status === 404
      ? '通讯录中还没有这位联系人的资料。'
      : errorText(error)
  }
  finally {
    if (token === contactProfileRequest)
      contactProfileLoading.value = false
  }
}

watch(
  () => [threadDetailsOpen.value, detailsPeerId.value, account.value?.id],
  () => {
    if (threadDetailsOpen.value && detailsPeerId.value) {
      void loadContactProfile()
      return
    }
    contactProfileRequest += 1
    contactProfile.value = null
    contactProfileError.value = ''
    contactProfileLoading.value = false
  },
)

function focusThreadSearch(): void {
  if (railView.value === 'contacts')
    contactsPanel.value?.focusSearch()
  else
    threadList.value?.focusSearch()
}

function markActiveThreadRead(): void {
  const thread = activeThread.value
  if (!thread)
    return
  thread.unreadCount = 0
  markThreadRead(thread)
  threadDetailsOpen.value = false
}

function openNewChat(): void {
  contactDialogOpen.value = true
}

function startChatWithContact(contact: Contact): void {
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

function startChatWithId(rawId: string): void {
  const id = rawId.trim()
  if (!id)
    return
  startDraftChat(id, id)
}

function startDraftChat(id: string, displayName: string): void {
  const current = account.value
  if (!current)
    return
  contactDialogOpen.value = false
  railView.value = 'chats'
  filterMode.value = 'all'
  threadQuery.value = ''

  const existing = threads.value.find(thread => thread.id === id)
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
  threads.value = [draftThread, ...threads.value]
  void selectThread(draftThread)
}

function markThreadRead(thread: Thread): void {
  const current = account.value
  if (!current)
    return
  // 用户已在此会话里看过消息：无论 daemon 上报是否成功，都记会话游标，
  // 刷新后据此压制官方客户端写回的陈旧未读。
  stampThreadRead(thread.id)
  if (!thread.readStateVersion)
    return
  void wechatApi.markThreadRead(current.id, thread.id, thread.readStateVersion)
    .catch(() => {
      // 已读是 best-effort。版本冲突（409）时重拉一次最新版本补报，
      // 否则自动已读会被后台同步循环的版本 bump 顶掉，未读挂在 daemon 侧。
      window.setTimeout(() => {
        if (disposed)
          return
        const fresh = threads.value.find(item => item.id === thread.id)
        if (fresh?.readStateVersion)
          void wechatApi.markThreadRead(current.id, fresh.id, fresh.readStateVersion).catch(() => {})
      }, 1_200)
    })
}

/** 打开会话期间的新消息自动已读上报：连发多条时防抖合并成一次调用。 */
let autoReadTimer: number | null = null
let autoReadThread: Thread | null = null

function scheduleAutoRead(thread: Thread): void {
  autoReadThread = thread
  if (autoReadTimer !== null)
    return
  autoReadTimer = window.setTimeout(() => {
    autoReadTimer = null
    const target = autoReadThread
    autoReadThread = null
    // 用列表里的最新对象上报（readStateVersion 可能已被刷新更新）。
    const fresh = target ? threads.value.find(item => item.id === target.id) : undefined
    if (fresh)
      markThreadRead(fresh)
  }, 400)
}

/** 会话消息 refresh 在途守卫：SSE 连发事件时同会话 refresh 不叠加请求。 */
let messageRefreshInFlight: string | null = null

async function fetchThreadMessages(threadId: string, mode: 'reset' | 'refresh' | 'older'): Promise<void> {
  const current = account.value
  if (!current)
    return
  if (mode === 'older' && !messagesCursor.value)
    return
  // daemon 的消息接口在忙时可能到 10s：在途期间跳过重复刷新，
  // 在途结束后由后续事件再次调度，不丢新消息。
  if (mode === 'refresh') {
    if (messageRefreshInFlight === threadId)
      return
    messageRefreshInFlight = threadId
  }

  const requestId = ++activeMessageRequest
  if (mode === 'reset') {
    messagesLoading.value = true
    messageError.value = ''
  }
  if (mode === 'older')
    olderLoading.value = true

  try {
    const cursor = mode === 'older' ? messagesCursor.value : undefined
    const response = await wechatApi.listMessages(current.id, threadId, MESSAGE_PAGE_SIZE, cursor)
    if (requestId !== activeMessageRequest || activeThreadId.value !== threadId)
      return

    const items = (response.items ?? []).slice().sort(compareMessages)
    if (mode === 'older') {
      const known = new Set(messages.value.map(item => item.id))
      messages.value = [...items.filter(item => !known.has(item.id)), ...messages.value]
      messagesCursor.value = response.nextCursor ?? null
    }
    else if (mode === 'reset') {
      messages.value = items
      messagesCursor.value = response.nextCursor ?? null
    }
    else {
      mergeServerMessages(items)
      if (messages.value.length === 0)
        messagesCursor.value = response.nextCursor ?? null
    }

    cacheThreadMessages(threadId)
    void loadMediaForMessages(messages.value)
  }
  catch (error) {
    const draft = threads.value.find(thread => thread.id === threadId)?.isDraft
    if (draft && error instanceof WechatApiError && error.status === 404) {
      // 新建聊天在发出第一条消息前可能还没有本地消息库。
      if (requestId === activeMessageRequest) {
        messages.value = []
        messagesCursor.value = null
      }
    }
    else if (requestId === activeMessageRequest && mode !== 'refresh') {
      messageError.value = errorText(error)
    }
  }
  finally {
    if (mode === 'refresh' && messageRefreshInFlight === threadId)
      messageRefreshInFlight = null
    if (requestId === activeMessageRequest) {
      messagesLoading.value = false
      olderLoading.value = false
    }
  }
}

function mergeServerMessages(items: Message[]): void {
  // 本地媒体气泡已经带预览；同一条消息的服务端回显不再重复展示。
  const localMediaOutgoing = messages.value.filter(item => item.local && item.localMedia && item.direction === 'outgoing')
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

  for (const existing of messages.value) {
    const server = serverById.get(existing.id)
    if (server) {
      merged.push({ ...existing, ...server, local: false, pending: false })
      seen.add(existing.id)
      continue
    }
    if (existing.local) {
      merged.push(existing)
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

  // 服务端回显是已持久化的权威数据：按「同文本+同日」配额移除本地乐观气泡
  // （含「发送中」），避免回显先于发送状态翻转到时成对出现。失败/待确认的
  // 本地气泡带错误反馈，不参与移除；同文本多次发送按回显条数配额，不会误删。
  const echoBudget = new Map<string, number>()
  for (const item of itemsForMerge) {
    if (item.direction === 'outgoing' && item.body) {
      const key = `${item.body}|${dayKey(item.createdAt)}`
      echoBudget.set(key, (echoBudget.get(key) ?? 0) + 1)
    }
  }
  messages.value = merged.filter((item) => {
    if (!item.local || item.direction !== 'outgoing' || !item.body || item.sendError)
      return true
    const key = `${item.body}|${dayKey(item.createdAt)}`
    const budget = echoBudget.get(key) ?? 0
    if (budget <= 0)
      return true
    echoBudget.set(key, budget - 1)
    return false
  })
}

function scheduleMessageRefresh(threadId: string, delay = 260): void {
  messageTimer = clearTimer(messageTimer)
  messageTimer = window.setTimeout(() => {
    if (activeThreadId.value === threadId)
      void fetchThreadMessages(threadId, 'refresh')
  }, delay)
}

function isMediaMessage(message: LocalMessage): boolean {
  if (message.local || message.localMedia)
    return false
  if (message.type === 3 || message.type === 34 || message.type === 43 || message.type === 47)
    return true
  return message.type === 49 && message.appMessageType === 6
}

function resolveMediaState(assets: MediaAsset[]): MessageMedia['state'] {
  if (assets.some(asset => asset.state === 'available'))
    return 'available'
  if (assets.some(asset => asset.state === 'pending'))
    return 'pending'
  if (assets.some(asset => asset.state === 'expired'))
    return 'expired'
  if (assets.some(asset => asset.state === 'unsupported'))
    return 'unsupported'
  return 'missing'
}

function mediaErrorText(error: unknown): string | null {
  if (!error)
    return null
  if (typeof error === 'string')
    return error
  if (typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim())
      return message
  }
  return '媒体资源获取失败'
}

function setMessageMedia(entry: MessageMedia): void {
  mediaByMessage.value = {
    ...mediaByMessage.value,
    [entry.messageId]: entry,
  }
}

async function requestTransferOnce(
  accountId: string,
  messageId: string,
  quality: 'best' | 'thumbnail' | 'normal' = 'best',
): Promise<void> {
  const requestKey = `${messageId}:${quality}`
  if (mediaTransferRequested.has(requestKey))
    return
  mediaTransferRequested.add(requestKey)
  try {
    await wechatApi.requestMediaTransfer(accountId, messageId, quality)
  }
  catch {
    // 下载授权失败时保留占位，后续查询到 pending 仍可再次尝试。
    mediaTransferRequested.delete(requestKey)
  }
}

function scheduleMediaRetry(): void {
  if (mediaRetryTimer !== null || disposed)
    return
  mediaRetryTimer = window.setTimeout(() => {
    mediaRetryTimer = null
    void retryPendingMedia()
  }, MEDIA_RETRY_DELAY)
}

async function retryPendingMedia(): Promise<void> {
  const current = account.value
  if (!current || disposed)
    return
  const ids: string[] = []
  for (const entry of Object.values(mediaByMessage.value)) {
    if (entry.state !== 'pending')
      continue
    const attempts = mediaRetryCounts.get(entry.messageId) ?? 0
    if (attempts >= MEDIA_MAX_RETRIES)
      continue
    mediaRetryCounts.set(entry.messageId, attempts + 1)
    ids.push(entry.messageId)
  }
  if (ids.length === 0)
    return

  for (let index = 0; index < ids.length; index += MEDIA_BATCH_SIZE) {
    await lookupMediaBatch(current.id, ids.slice(index, index + MEDIA_BATCH_SIZE))
    if (index + MEDIA_BATCH_SIZE < ids.length)
      await sleep(MEDIA_BATCH_DELAY)
  }

  const hasPending = Object.values(mediaByMessage.value).some(
    entry => entry.state === 'pending'
      && (mediaRetryCounts.get(entry.messageId) ?? 0) < MEDIA_MAX_RETRIES,
  )
  if (hasPending)
    scheduleMediaRetry()
}

async function lookupMediaBatch(accountId: string, messageIds: string[]): Promise<void> {
  const ids = messageIds.filter(id => !mediaInFlight.has(id))
  if (ids.length === 0)
    return
  for (const id of ids)
    mediaInFlight.add(id)

  try {
    const items = await wechatApi.lookupMedia(accountId, ids)
    if (disposed || account.value?.id !== accountId)
      return

    const byId = new Map(items.map(item => [item.messageId, item]))
    let pendingFound = false
    for (const id of ids) {
      const item = byId.get(id)
      const assets = item?.assets ?? []
      const state = resolveMediaState(assets)
      setMessageMedia({
        messageId: id,
        assets,
        state,
        error: mediaErrorText(item?.error),
      })
      if (state === 'pending') {
        pendingFound = true
        // 视频只自动下载缩略图（首帧海报）；完整视频等用户点击播放时再取。
        const hasVideo = assets.some(asset => (asset.kind ?? '').toLowerCase().includes('video'))
        void requestTransferOnce(accountId, id, hasVideo ? 'thumbnail' : 'best')
      }
      else {
        mediaRetryCounts.delete(id)
      }
    }
    if (pendingFound)
      scheduleMediaRetry()
  }
  catch {
    // 媒体查询失败不阻塞消息展示；下次消息刷新时会重新尝试。
  }
  finally {
    for (const id of ids)
      mediaInFlight.delete(id)
  }
}

async function loadMediaForMessages(items: LocalMessage[]): Promise<void> {
  const current = account.value
  if (!current || disposed || !current.authenticated)
    return

  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!isMediaMessage(item) || seen.has(item.id))
      continue
    if (mediaByMessage.value[item.id] || mediaInFlight.has(item.id))
      continue
    seen.add(item.id)
    ids.push(item.id)
  }

  // 打开会话时视口停在底部：最新消息的媒体最先进入视口，倒序渐进加载。
  // 批间让出主线程，保证列表与占位图标始终可交互，媒体慢慢补齐。
  const ordered = [...ids].reverse()
  for (let index = 0; index < ordered.length; index += MEDIA_BATCH_SIZE) {
    await lookupMediaBatch(current.id, ordered.slice(index, index + MEDIA_BATCH_SIZE))
    if (index + MEDIA_BATCH_SIZE < ordered.length)
      await sleep(MEDIA_BATCH_DELAY)
  }
}

function clearMessageMedia(): void {
  mediaRetryTimer = clearTimer(mediaRetryTimer)
  mediaByMessage.value = {}
  mediaInFlight.clear()
  mediaTransferRequested.clear()
  mediaRetryCounts.clear()
}

async function refreshActiveMessages(): Promise<void> {
  if (!activeThreadId.value)
    return
  manualRefreshing.value = true
  try {
    await Promise.all([
      fetchThreadMessages(activeThreadId.value, 'refresh'),
      loadThreads(),
    ])
  }
  finally {
    manualRefreshing.value = false
  }
}

async function loadOlderMessages(): Promise<void> {
  if (!activeThreadId.value || olderLoading.value || !messagesCursor.value)
    return
  await fetchThreadMessages(activeThreadId.value, 'older')
}

function handleMessageListBottom(): void {
  unseenBelow.value = 0
}

function jumpToLatestMessage(): void {
  messageList.value?.scrollToBottom(true)
  unseenBelow.value = 0
}

function detectMediaKind(file: File): MediaKind {
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

function mediaLimit(kind: MediaKind): number {
  return kind === 'image' || kind === 'voice' ? MAX_IMAGE_VOICE_BYTES : MAX_VIDEO_FILE_BYTES
}

function revokeUrl(url: string | null | undefined): void {
  if (!url)
    return
  URL.revokeObjectURL(url)
  localMediaUrls.delete(url)
}

function stageFiles(files: File[]): void {
  const current = account.value
  if (!current)
    return
  for (const file of files) {
    const kind = detectMediaKind(file)
    if (file.size > mediaLimit(kind)) {
      accountActionError.value = `${file.name} 超过${kind === 'image' || kind === 'voice' ? ' 25 MB' : ' 512 MB'}发送上限`
      continue
    }
    const previewUrl = URL.createObjectURL(file)
    localMediaUrls.add(previewUrl)
    stagedAttachments.value = [...stagedAttachments.value, {
      id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      name: file.name,
      size: file.size,
      kind,
      previewUrl,
    }]
  }
}

function removeAttachment(id: string): void {
  const item = stagedAttachments.value.find(attachment => attachment.id === id)
  if (item)
    revokeUrl(item.previewUrl)
  stagedAttachments.value = stagedAttachments.value.filter(attachment => attachment.id !== id)
}

function clearStagedAttachments(): void {
  for (const item of stagedAttachments.value)
    revokeUrl(item.previewUrl)
  stagedAttachments.value = []
}

function revokeAllLocalMedia(): void {
  for (const url of localMediaUrls)
    URL.revokeObjectURL(url)
  localMediaUrls.clear()
}

async function sendTextMessage(current: AccountSummary, thread: Thread, text: string): Promise<void> {
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

  messages.value = [...messages.value, local]
  // 发送即视为已读（官方客户端语义）：清掉列表未读并同步 daemon。
  thread.unreadCount = 0
  markThreadRead(thread)
  // 数组读取返回的是响应式代理；后续必须改这个代理，直接改 local 原生对象不会触发视图。
  const pendingMessage = messages.value[messages.value.length - 1]
  // 引用回复：被引用消息必须有平台权威 serverId 才能发送引用。
  const quoted = replyTo.value?.serverId?.trim()
    ? { messageId: replyTo.value.id, serverId: replyTo.value.serverId.trim() }
    : undefined
  replyTo.value = null
  // @ 提及：仅群聊且草稿里含选择器插入的提及片段时携带。
  const mentions = buildMentions(text, mentionOptions.value)
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
        : (intent.state === 'needs_review' ? '发送结果待确认，请检查聊天记录' : '发送已取消')
    }
    else {
      void pollSend(pendingMessage, intent.id)
    }
  }
  catch (error) {
    pendingMessage.pending = false
    pendingMessage.sendState = 'failed'
    pendingMessage.sendError = errorText(error)
  }
}

function localMediaType(kind: MediaKind, name: string): { type: number, appMessageType?: number, body: string } {
  switch (kind) {
    case 'image':
      return { type: 3, body: '[图片]' }
    case 'video':
      return { type: 43, body: '[视频]' }
    case 'voice':
      return { type: 34, body: '[语音]' }
    default:
      return { type: 49, appMessageType: 6, body: name }
  }
}

async function sendAttachment(thread: Thread, attachment: StagedAttachment): Promise<void> {
  const current = account.value
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

  messages.value = [...messages.value, local]
  // 发送即视为已读（官方客户端语义）：清掉列表未读并同步 daemon。
  thread.unreadCount = 0
  markThreadRead(thread)
  const pendingMessage = messages.value[messages.value.length - 1]
  messageList.value?.scrollToBottom(true)

  try {
    const source = await wechatApi.uploadFile(current.id, attachment.file)
    pendingMessage.sendState = 'queued'
    const job = await wechatApi.sendMedia(current.id, thread.id, attachment.kind, source.id)
    pendingMessage.sendId = job.id
    pendingMessage.sendState = job.state
    void pollMediaJob(pendingMessage, job.id)
  }
  catch (error) {
    pendingMessage.pending = false
    pendingMessage.sendState = 'failed'
    pendingMessage.sendError = errorText(error)
  }
}

async function pollMediaJob(local: LocalMessage, jobId: string): Promise<void> {
  const current = account.value
  if (!current)
    return
  for (let attempt = 0; attempt < 240; attempt++) {
    if (disposed || local.sendError)
      return
    await sleep(1500)
    try {
      const job = await wechatApi.getJob(current.id, jobId)
      local.sendState = job.state
      if (job.serverMessageId)
        local.serverId = job.serverMessageId
      if (job.state === 'accepted') {
        local.pending = false
        scheduleThreadRefresh(300)
        if (activeThreadId.value === local.threadId)
          await fetchThreadMessages(local.threadId, 'refresh')
        return
      }
      if (job.state === 'failed' || job.state === 'needs_review' || job.state === 'cancelled'
        || job.state === 'expired' || job.state === 'unsupported') {
        local.pending = false
        const fallback = job.state === 'failed'
          ? '发送失败，请稍后重试。'
          : job.state === 'needs_review'
            ? '发送结果待确认，请检查聊天记录'
            : job.state === 'expired'
              ? '发送已超时，请重新发送。'
              : job.state === 'unsupported'
                ? '当前消息类型暂不支持发送。'
                : '发送已取消'
        local.sendError = sendFailureMessage(job.reason, fallback)
        return
      }
    }
    catch (error) {
      // 明确的鉴权/不存在错误直接终止轮询；网络抖动才继续重试。
      if (error instanceof WechatApiError
        && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409)) {
        local.pending = false
        local.sendState = 'failed'
        local.sendError = errorText(error)
        return
      }
    }
  }
  local.pending = false
  local.sendState = 'needs_review'
  local.sendError = '发送结果待确认，请检查聊天记录'
}

async function sendMessage(): Promise<void> {
  const current = account.value
  const thread = activeThread.value
  if (!current || !thread)
    return
  const text = draft.value.trim()
  const attachments = stagedAttachments.value
  if (!text && attachments.length === 0)
    return

  draft.value = ''
  stagedAttachments.value = []
  messageList.value?.scrollToBottom(true)

  if (text)
    void sendTextMessage(current, thread, text)
  for (const attachment of attachments)
    void sendAttachment(thread, attachment)
  composer.value?.focus()
}

async function pollSend(local: LocalMessage, sendId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (disposed || local.sendError)
      return
    if (local.sendState === 'accepted' || local.sendState === 'failed' || local.sendState === 'needs_review' || local.sendState === 'cancelled')
      break

    // daemon 入队即返回，多数发送在前几百毫秒内完成：首拍密、后续放缓，
    // 兼顾状态翻转的即时性与查询开销。
    await sleep(attempt < 5 ? 150 : 700)
    try {
      const intent = await wechatApi.getSend(sendId)
      local.sendState = intent.state
      local.serverId = intent.serverId
      if (intent.state === 'accepted') {
        local.pending = false
        if (activeThreadId.value === local.threadId)
          await fetchThreadMessages(local.threadId, 'refresh')
        break
      }
      if (intent.state === 'failed') {
        local.pending = false
        local.sendError = sendFailureMessage(intent.errorCode)
        break
      }
      if (intent.state === 'needs_review') {
        local.pending = false
        local.sendError = '发送结果待确认，请检查聊天记录'
        break
      }
      if (intent.state === 'cancelled') {
        local.pending = false
        local.sendError = '发送已取消'
        break
      }
    }
    catch {
      // 单次查询失败继续重试；发送本身仍需按原任务 ID 核对。
    }
  }

  if (local.sendState === 'queued' || local.sendState === 'submitting') {
    local.pending = false
    local.sendState = 'accepted'
    if (activeThreadId.value === local.threadId)
      await fetchThreadMessages(local.threadId, 'refresh')
  }
}

function startStream(): void {
  if (streamActive || !account.value?.authenticated)
    return
  stopStream()
  streamActive = true
  lastCursor = null
  const token = ++streamToken
  const currentAccountId = account.value.id
  // daemon 重启（SSE 断开重连）后重新校验全部头像：重启瞬间快照可能把别的
  // 联系人的头像字节短暂错配给某个 username，旧字节已被 UI 缓存，必须整批重取。
  let streamOpenedOnce = false

  void (async () => {
    while (!disposed && token === streamToken && account.value?.authenticated) {
      const controller = new AbortController()
      streamAbort = controller
      try {
        streamStatus.value = 'reconnecting'
        await consumeEventStream({
          accountId: currentAccountId,
          after: lastCursor,
          signal: controller.signal,
          onOpen: () => {
            if (token !== streamToken)
              return
            streamStatus.value = 'live'
            if (streamOpenedOnce) {
              invalidateAvatarCache()
              window.dispatchEvent(new Event('wx-avatars-invalidated'))
            }
            streamOpenedOnce = true
          },
          onEvent: event => handleStreamEvent(event),
        })
      }
      catch (error) {
        // Cursor 过期（410，事件已超出保留窗）时丢弃旧游标，下次连接从
        // daemon 当前事件头开始；其余网络中断保留 cursor，退避重连。
        if (error instanceof Error && error.message.includes('410'))
          lastCursor = null
      }
      if (token !== streamToken || disposed)
        return
      streamStatus.value = 'reconnecting'
      await sleep(1_600)
    }
  })()
}

function stopStream(): void {
  streamToken += 1
  streamActive = false
  streamStatus.value = 'idle'
  streamAbort?.abort()
  streamAbort = null
}

function dismissToast(id: string): void {
  const timer = toastTimers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    toastTimers.delete(id)
  }
  incomingToasts.value = incomingToasts.value.filter(item => item.id !== id)
}

function pushIncomingToast(threadId: string): void {
  if (!toastEnabled.value)
    return
  const thread = threads.value.find(item => item.id === threadId)
  if (!thread)
    return
  // 其他设备设置的「消息免打扰」：不弹提示卡片，未读徽标保留（与官方客户端一致）。
  if (thread.muted === true)
    return
  if ((thread.lastMessage?.direction ?? '') === 'outgoing')
    return
  // 没读过才提示；当前打开的会话已标记已读，不会到这里。
  if ((thread.unreadCount ?? 0) <= 0)
    return
  // 只提示最新消息：会话最新一条消息必须足够新。登录时的历史回灌
  // （哪怕事件是刚落库的）只要最新消息超出窗口就不弹，避免整屏历史轰炸。
  const latestAt = Date.parse(thread.lastMessage?.createdAt ?? '')
  if (!Number.isFinite(latestAt) || Date.now() - latestAt > TOAST_RECENT_WINDOW_MS)
    return
  const preview = previewText(thread).trim()
  if (!preview)
    return

  for (const item of incomingToasts.value) {
    if (item.threadId === threadId)
      dismissToast(item.id)
  }

  const toast: IncomingToast = {
    id: `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    name: threadName(thread),
    preview,
  }
  incomingToasts.value = [toast, ...incomingToasts.value].slice(0, TOAST_LIMIT)
  toastTimers.set(toast.id, window.setTimeout(() => dismissToast(toast.id), toastDurationMs.value))
}

/** 静默等会话列表刷新拿到新预览，再弹 Toast，避免展示旧消息。 */
function scheduleIncomingToast(threadId: string): void {
  const existing = toastDelayTimers.get(threadId)
  if (existing !== undefined)
    window.clearTimeout(existing)
  toastDelayTimers.set(threadId, window.setTimeout(() => {
    toastDelayTimers.delete(threadId)
    pushIncomingToast(threadId)
  }, 500))
}

function openToast(toast: IncomingToast): void {
  dismissToast(toast.id)
  const thread = threads.value.find(item => item.id === toast.threadId)
  if (thread)
    void selectThread(thread)
  else
    void loadThreads()
}

function threadForToast(threadId: string): Thread | undefined {
  return threads.value.find(item => item.id === threadId)
}

function handleStreamEvent(event: WechatEvent): void {
  if (event.cursor)
    lastCursor = event.cursor

  const kind = event.kind
  if (kind === 'message.committed' || kind === 'message.updated') {
    const threadId = String(event.data.threadId ?? '')
    // 只有真正新落库（committed）且时间新鲜的消息才算未读并弹通知。
    // message.updated（媒体补全、消息编辑、已读回执）针对的常常是历史消息，
    // 刷新页面或切换会话时会被重新触发，不能当作新消息。
    const isNewMessage = kind === 'message.committed' && isFreshEvent(event.createdAt)
    if (threadId && threadId !== activeThreadId.value) {
      const thread = threads.value.find(item => item.id === threadId)
      if (thread && isNewMessage) {
        thread.unreadCount = (thread.unreadCount ?? 0) + 1
        scheduleIncomingToast(threadId)
      }
    }
    if (threadId && threadId === activeThreadId.value) {
      if (!messageList.value?.isAtBottom())
        unseenBelow.value += 1
      scheduleMessageRefresh(threadId)
      // 打开着的会话收到新消息即自动上报已读（对齐官方客户端）：
      // 否则 daemon 会把会话打开期间进来的消息计成未读并回填到列表。
      if (isNewMessage) {
        const thread = threads.value.find(item => item.id === threadId)
        if (thread) {
          thread.unreadCount = 0
          scheduleAutoRead(thread)
        }
      }
    }
    scheduleThreadRefresh()
    return
  }

  if (kind === 'thread.read-state') {
    // 其他设备已读：daemon 已清本地会话未读，UI 立即同步徽标并撤下提示卡片，
    // 再刷新列表以对齐部分已读等场景的权威未读数。
    const threadId = String(event.data.threadId ?? '')
    if (threadId) {
      const thread = threads.value.find(item => item.id === threadId)
      if (thread && (thread.unreadCount ?? 0) > 0)
        thread.unreadCount = 0
      for (const toast of [...incomingToasts.value]) {
        if (toast.threadId === threadId)
          dismissToast(toast.id)
      }
    }
    scheduleThreadRefresh()
    return
  }

  if (kind === 'thread.updated' || kind === 'contacts.updated' || kind === 'group.updated') {
    scheduleThreadRefresh()
    if (kind === 'contacts.updated')
      void loadContactDirectory()
    return
  }

  if (kind === 'send.updated') {
    const sendId = String(event.data.id ?? '')
    const state = String(event.data.state ?? '')
    if (sendId) {
      const local = messages.value.find(item => item.local && item.sendId === sendId)
      if (local && state) {
        local.sendState = state
        if (state === 'accepted') {
          local.pending = false
          if (activeThreadId.value === local.threadId)
            scheduleMessageRefresh(local.threadId, 200)
        }
        else if (state === 'failed' || state === 'needs_review') {
          local.pending = false
          local.sendError = state === 'failed'
            ? sendFailureMessage(event.data.errorCode)
            : '发送结果待确认，请检查聊天记录'
        }
      }
    }
    return
  }

  if (kind === 'account.updated' || kind === 'login.updated') {
    accountRefreshTimer = clearTimer(accountRefreshTimer)
    accountRefreshTimer = window.setTimeout(() => {
      void pollAccount()
    }, 800)
  }
}

onMounted(() => {
  void bootstrap()
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('keydown', onGlobalKeydown)
  setQrObjectUrl(null)
  clearTimer(accountTimer)
  clearTimer(loginTimer)
  clearTimer(threadsTimer)
  clearTimer(messageTimer)
  clearTimer(accountRefreshTimer)
  for (const timer of toastTimers.values())
    window.clearTimeout(timer)
  toastTimers.clear()
  for (const timer of toastDelayTimers.values())
    window.clearTimeout(timer)
  toastDelayTimers.clear()
  clearMessageMedia()
  clearStagedAttachments()
  revokeAllLocalMedia()
  stopStream()
})
</script>

<template>
  <div class="app-shell">
    <div v-if="booting" class="boot-screen">
      <span class="boot-logo"><Icon name="message" :size="26" /></span>
      <span class="boot-spinner"><Icon name="refresh" :size="16" class="spin" /></span>
      <p>正在加载微信会话</p>
    </div>

    <div v-else-if="bootError && !account" class="boot-screen">
      <span class="boot-logo error"><Icon name="alert" :size="26" /></span>
      <p>{{ bootError }}</p>
      <button class="boot-retry" type="button" @click="bootstrap">重试</button>
    </div>

    <div v-else-if="!hasHubAuth()" class="boot-screen">
      <span class="boot-logo error"><Icon name="alert" :size="26" /></span>
      <p>缺少访问凭据：请使用 Hub 启动日志里的一键链接打开本页面。</p>
    </div>

    <LoginPanel
      v-else-if="account && !account.authenticated"
      :account="account"
      :attempt="loginAttempt"
      :qr-url="qrObjectUrl"
      :qr-failed="qrFailed"
      :busy="loginBusy"
      :error="loginError"
      @start="startLogin"
      @cancel="cancelLogin"
      @refresh="refreshAccount"
      @retry-qr="retryQr"
      @qr-error="qrFailed = true"
    />

    <template v-else-if="account">
      <AppRail
        v-model:view="railView"
        v-model:theme-mode="themeMode"
        v-model:theme-id="themeId"
        v-model:bubble-font-size="bubbleFontSize"
        v-model:bubble-in-color="bubbleInColor"
        v-model:bubble-out-color="bubbleOutColor"
        v-model:toast-duration-ms="toastDurationMs"
        v-model:toast-enabled="toastEnabled"
        :unread-total="unreadTotal"
        :friend-request-count="friendRequestCount"
        :account="account"
        :account-name="selfName || '微信'"
        :account-refreshing="manualRefreshing"
        :logging-out="loggingOut"
        :themes="UI_THEMES"
        @refresh-account="refreshAccount"
        @logout="logoutAccount"
      />

      <!-- KeepAlive 保活：聊天列表/通讯录切换不再销毁重建，头像与滚动位置得以保留。 -->
      <KeepAlive>
        <ThreadList
          v-if="railView === 'chats'"
          ref="threadList"
          v-model:filter-mode="filterMode"
          :account="account"
          :threads="threads"
          :active-id="activeThreadId"
          :query="threadQuery"
          :loading="threadsLoading"
          :business-usernames="businessUsernames"
          @select="selectThread"
          @update:query="threadQuery = $event"
          @refresh="loadThreads"
          @new-chat="openNewChat"
          @read-all="markAllThreadsRead"
        />

        <ContactsPanel
          v-else
          ref="contactsPanel"
          :account="account"
          :preloaded-contacts="directoryContacts"
          @select="startChatWithContact"
          @start-id="startChatWithId"
        />
      </KeepAlive>

      <main class="chat-pane">
        <header class="chat-header">
          <template v-if="activeThread">
            <button
              type="button"
              class="chat-avatar-button"
              title="查看个人信息"
              @click="threadDetailsOpen = true"
            >
              <ThreadAvatar
                :account-id="account.id"
                :name="threadName(activeThread)"
                :username="activeThread.peerId"
                :kind="activeThread.kind"
                :members="activeThread.avatarMembers"
                :size="36"
              />
              <span
                class="chat-avatar-stream"
                :data-live="streamStatus === 'live'"
                :title="streamLabel"
                :aria-label="streamLabel"
              />
            </button>
            <div class="chat-title">
              <h2>{{ threadName(activeThread) }}</h2>
              <p>
                {{ threadKindLabel(activeThread.kind, activeThread.peerId) }}
                <span v-if="(activeThread.unreadCount ?? 0) > 0"> · {{ activeThread.unreadCount }} 条未读</span>
              </p>
            </div>
            <div class="chat-actions">
              <button
                class="icon-button"
                type="button"
                title="查找聊天记录"
                :class="{ active: threadSearchOpen }"
                @click="toggleThreadSearch"
              >
                <Icon name="search" :size="16" />
              </button>
              <button
                class="icon-button"
                type="button"
                title="会话详情"
                :class="{ active: threadDetailsOpen }"
                @click="threadDetailsOpen = !threadDetailsOpen"
              >
                <Icon name="panel" :size="16" />
              </button>
              <button
                class="icon-button"
                type="button"
                title="刷新聊天"
                :disabled="manualRefreshing"
                @click="refreshActiveMessages"
              >
                <Icon name="refresh" :size="16" :class="{ spin: manualRefreshing }" />
              </button>
            </div>
          </template>

          <template v-else>
            <span class="brand-logo"><Icon name="message" :size="18" /></span>
            <div class="chat-title">
              <h2>Agent WeChat</h2>
              <p>面向人与 AI 智能体的开源微信客户端</p>
            </div>
            <div class="chat-actions">
              <button class="icon-button" type="button" title="搜索聊天" @click="focusThreadSearch">
                <Icon name="search" :size="16" />
              </button>
            </div>
          </template>
        </header>

        <section v-if="threadSearchOpen && activeThread" class="thread-search-panel">
          <div class="thread-search-input">
            <Icon name="search" :size="14" />
            <input
              ref="threadSearchInput"
              v-model="threadSearchQuery"
              type="text"
              placeholder="查找当前会话的历史消息"
              @keydown.esc.prevent="toggleThreadSearch"
            >
            <button
              v-if="threadSearchQuery"
              type="button"
              class="thread-search-clear"
              title="清空"
              @click="threadSearchQuery = ''"
            >
              <Icon name="close" :size="12" />
            </button>
          </div>
          <div v-if="threadSearching" class="thread-search-status">
            <Icon name="refresh" :size="12" class="spin" />
            搜索中…
          </div>
          <div
            v-else-if="threadSearchResults.length === 0 && threadSearchQuery.trim()"
            class="thread-search-status"
          >
            没有找到相关聊天记录
          </div>
          <div v-else-if="threadSearchResults.length > 0" class="thread-search-results scrollbar-thin">
            <button
              v-for="item in threadSearchResults"
              :key="item.id"
              type="button"
              class="thread-search-item"
              @click="jumpToSearchResult(item)"
            >
              <strong>{{ threadSearchSender(item) }}</strong>
              <span class="thread-search-snippet">{{ threadSearchSnippet(item) }}</span>
              <time>{{ formatListTime(item.createdAt) }}</time>
            </button>
          </div>
        </section>

        <TransitionGroup name="incoming-toast" tag="div" class="incoming-toasts">
          <div
            v-for="toast in incomingToasts"
            :key="toast.id"
            class="incoming-toast"
            role="button"
            tabindex="0"
            @click="openToast(toast)"
            @keydown.enter.prevent="openToast(toast)"
          >
            <ThreadAvatar
              :account-id="account.id"
              :name="toast.name"
              :username="threadForToast(toast.threadId)?.peerId"
              :kind="threadForToast(toast.threadId)?.kind"
              :members="threadForToast(toast.threadId)?.avatarMembers"
              :size="32"
            />
            <div class="incoming-toast-body">
              <strong>{{ toast.name }}</strong>
              <span>{{ toast.preview }}</span>
            </div>
            <button
              type="button"
              class="incoming-toast-close"
              title="关闭"
              @click.stop="dismissToast(toast.id)"
            >
              <Icon name="close" :size="12" />
            </button>
          </div>
        </TransitionGroup>

        <Transition name="popover">
          <div v-if="threadDetailsOpen" class="chat-details-backdrop" @click="threadDetailsOpen = false" />
        </Transition>

        <Transition name="popover">
          <section v-if="threadDetailsOpen && activeThread" class="chat-details">
            <header class="details-head">
              <div>
                <strong>会话详情</strong>
                <span>{{ threadName(activeThread) }}</span>
              </div>
              <button type="button" class="details-close" title="关闭" @click="threadDetailsOpen = false">
                <Icon name="close" :size="14" />
              </button>
            </header>

            <div class="details-body">
              <div class="details-profile">
                <ThreadAvatar
                  :account-id="account.id"
                  :name="activeThread.kind === 'group' ? threadName(activeThread) : contactProfileName"
                  :username="activeThread.peerId"
                  :kind="activeThread.kind"
                  :members="activeThread.avatarMembers"
                  :size="42"
                />
                <div class="profile-main">
                  <strong>{{ activeThread.kind === 'group' ? threadName(activeThread) : contactProfileName }}</strong>
                  <span v-if="activeThread.kind === 'group'" class="profile-subtitle">
                    {{ threadKindLabel(activeThread.kind) }} · {{ activeThread.avatarMembers?.length ?? 0 }} 位缓存成员
                  </span>
                  <span v-else class="profile-subtitle">{{ contactProfile?.username || detailsPeerId }}</span>
                </div>
              </div>

              <template v-if="activeThread.kind !== 'group' && activeThread.kind !== 'system'">
                <div v-if="contactProfileLoading" class="details-hint">
                  <Icon name="refresh" :size="12" class="spin" />
                  正在读取联系人资料…
                </div>
                <div v-else-if="contactProfileError" class="details-hint error">
                  <Icon name="alert" :size="12" />
                  {{ contactProfileError }}
                </div>
                <template v-else-if="contactProfile">
                  <div class="details-row">
                    <span class="details-label">备注</span>
                    <span>{{ contactProfile.remark || '—' }}</span>
                  </div>
                  <div class="details-row">
                    <span class="details-label">昵称</span>
                    <span>{{ contactProfile.nickname || '—' }}</span>
                  </div>
                  <div class="details-row">
                    <span class="details-label">微信号</span>
                    <span>{{ contactProfile.username || detailsPeerId }}</span>
                  </div>
                  <div v-if="contactProfile.alias" class="details-row">
                    <span class="details-label">别名</span>
                    <span>{{ contactProfile.alias }}</span>
                  </div>
                </template>
              </template>

              <div class="details-row">
                <span class="details-label">会话类型</span>
                <span>{{ threadKindLabel(activeThread.kind, activeThread.peerId) }}</span>
              </div>
              <div class="details-row">
                <span class="details-label">会话 ID</span>
                <code>{{ activeThread.id }}</code>
              </div>
              <div class="details-row">
                <span class="details-label">未读消息</span>
                <span>{{ activeThread.unreadCount ?? 0 }}</span>
              </div>
              <div class="details-row">
                <span class="details-label">置顶 / 免打扰</span>
                <span>{{ activeThread.pinned ? '已置顶' : '未置顶' }} · {{ activeThread.muted ? '已静音' : '正常' }}</span>
              </div>
            </div>

            <div class="details-actions">
              <button type="button" class="details-action" @click="markActiveThreadRead">
                <Icon name="check" :size="14" />
                标记已读
              </button>
              <button type="button" class="details-action" :disabled="manualRefreshing" @click="refreshActiveMessages">
                <Icon name="refresh" :size="14" :class="{ spin: manualRefreshing }" />
                刷新会话
              </button>
            </div>
          </section>
        </Transition>

        <div v-if="peerIsStranger" class="chat-banner stranger">
          <Icon name="contacts" :size="14" />
          <span>对方还不是你的朋友，暂请在手机微信上添加（桌面添加即将支持）</span>
        </div>

        <div v-if="connectionState !== 'online'" class="chat-banner">
          <Icon name="wifi-off" :size="14" />
          <span>
            微信{{ connectionState === 'pending' ? '正在连接' : '当前离线' }}，消息可能延迟
          </span>
          <button type="button" :disabled="manualRefreshing" @click="refreshAccount">
            立即刷新
          </button>
        </div>

        <div v-if="accountActionError" class="chat-banner error">
          <Icon name="alert" :size="14" />
          <span>{{ accountActionError }}</span>
          <button type="button" @click="accountActionError = ''">关闭</button>
        </div>

        <div v-if="threadsError" class="chat-banner error">
          <Icon name="alert" :size="14" />
          <span>{{ threadsError }}</span>
          <button type="button" @click="loadThreads">重试</button>
        </div>

        <div v-if="messageError" class="chat-banner error">
          <Icon name="alert" :size="14" />
          <span>{{ messageError }}</span>
        </div>

        <MessageList
          ref="messageList"
          :messages="messages"
          :thread="activeThread"
          :account="account"
          :media-by-message="mediaByMessage"
          :loading="messagesLoading"
          :older-loading="olderLoading"
          :has-more="Boolean(messagesCursor)"
          :highlight-id="messageHighlightId"
          @load-older="loadOlderMessages"
          @at-bottom="handleMessageListBottom"
          @reply="startReply"
          @preview="lightboxSrc = $event"
        />

        <!-- 图片放大预览：点击遮罩或按 Esc 关闭；表情包不触发。 -->
        <Transition name="fade">
          <div v-if="lightboxSrc" class="lightbox" @click="lightboxSrc = null">
            <img :src="lightboxSrc" alt="">
          </div>
        </Transition>

        <Transition name="jump">
          <button
            v-if="activeThread && unseenBelow > 0"
            type="button"
            class="new-message-jump"
            @click="jumpToLatestMessage"
          >
            <Icon name="chevron-down" :size="14" />
            {{ unseenBelow }} 条新消息
          </button>
        </Transition>

        <Composer
          v-if="activeThread && !activeThreadIsOfficial"
          ref="composer"
          v-model="draft"
          :attachments="stagedAttachments"
          :disabled="connectionState === 'offline'"
          :placeholder="`发消息给 ${threadName(activeThread)}`"
          :reply-to="replyToDisplay"
          :mention-available="activeThreadIsGroup"
          :mention-options="mentionOptions"
          :mention-loading="mentionLoading"
          @mention-open="ensureGroupMembers(activeThreadId ?? '')"
          @attach-files="stageFiles"
          @remove-attachment="removeAttachment"
          @cancel-reply="replyTo = null"
          @send="sendMessage"
        />
      </main>

      <ContactSearchDialog
        :open="contactDialogOpen"
        :account-id="account.id"
        @close="contactDialogOpen = false"
        @select="startChatWithContact"
        @start-id="startChatWithId"
      />
    </template>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}

.boot-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  color: var(--muted);
}

.boot-logo {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border-radius: 18px;
  color: #eafff3;
  background: linear-gradient(135deg, #22c55e, #0e9f6e);
  box-shadow: 0 16px 38px rgba(34, 197, 94, 0.24);
}

.boot-logo.error {
  color: #fecaca;
  background: linear-gradient(135deg, #ef4444, #b91c1c);
  box-shadow: 0 16px 38px rgba(239, 68, 68, 0.2);
}

.boot-spinner {
  display: inline-flex;
  color: var(--muted);
  margin-top: 4px;
}

.boot-screen p {
  margin: 0;
  max-width: 420px;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.6;
}

.boot-retry {
  margin-top: 8px;
  padding: 6px 18px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--panel-elevated);
  color: var(--text-soft);
  font-size: 12px;
}

.chat-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background:
    radial-gradient(circle at 82% 8%, var(--accent-faint), transparent 32%),
    var(--bg);
}

.chat-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
  height: 60px;
  padding: 0 18px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-glass);
  backdrop-filter: blur(12px);
}

.chat-avatar-button {
  position: relative;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  transition: transform 0.16s ease;
}

.chat-avatar-stream {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 10px;
  height: 10px;
  border: 2px solid var(--panel);
  border-radius: 50%;
  background: var(--muted-soft);
  transition: background 0.16s ease, box-shadow 0.16s ease;
}

.chat-avatar-stream[data-live="true"] {
  background: var(--success);
  box-shadow: 0 0 6px rgba(52, 211, 153, 0.5);
}

.chat-avatar-button:hover {
  transform: translateY(-1px);
}

.chat-avatar-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.chat-title {
  min-width: 0;
  flex: 1;
}

.chat-title h2 {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14.5px;
  font-weight: 600;
}

.chat-title p {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 11.5px;
}

.chat-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.icon-button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  transition: background 0.16s ease, color 0.16s ease;
}

.icon-button:hover:not(:disabled) {
  background: var(--panel-hover);
  color: var(--text);
}

.icon-button.active {
  background: var(--panel-hover);
  color: var(--text);
}

/* 会话内历史搜索面板：展开在聊天头部之下。 */
.thread-search-panel {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  max-height: 260px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-soft);
}

.thread-search-input {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  color: var(--muted);
}

.thread-search-input:focus-within {
  border-color: var(--accent);
}

.thread-search-input input {
  flex: 1;
  min-width: 0;
  height: 32px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
  outline: none;
}

.thread-search-clear {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
}

.thread-search-clear:hover {
  background: var(--panel-hover);
  color: var(--text);
}

.thread-search-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 4px 2px;
  color: var(--muted);
  font-size: 11.5px;
}

.thread-search-results {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  margin-top: 6px;
  overflow-y: auto;
}

.thread-search-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.thread-search-item:hover {
  background: var(--panel-hover);
}

.thread-search-item strong {
  flex: 0 0 auto;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
}

.thread-search-snippet {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted-soft);
  font-size: 12px;
}

.thread-search-item time {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 10.5px;
}

.brand-logo {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  color: #eafff3;
  background: linear-gradient(135deg, #22c55e, #0e9f6e);
  box-shadow: 0 8px 20px rgba(34, 197, 94, 0.22);
}

.chat-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 8px 20px;
  border-bottom: 1px solid rgba(251, 191, 36, 0.18);
  background: rgba(251, 191, 36, 0.06);
  color: var(--warning-text);
  font-size: 11.5px;
}

.chat-banner.error {
  border-bottom-color: rgba(248, 113, 113, 0.18);
  background: rgba(248, 113, 113, 0.06);
  color: var(--danger-text);
}

.chat-banner.stranger {
  border-bottom-color: color-mix(in srgb, var(--accent) 22%, transparent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  color: var(--text);
}

.chat-banner span {
  flex: 1;
  min-width: 0;
}

.chat-banner button {
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 11.5px;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.incoming-toasts {
  position: absolute;
  top: 72px;
  right: 18px;
  z-index: 24;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(320px, calc(100% - 36px));
  pointer-events: none;
}

.incoming-toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 12px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--popover-bg);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.32);
  outline: none;
  cursor: pointer;
  pointer-events: auto;
  transition: transform 0.15s ease, border-color 0.15s ease;
}

.incoming-toast:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}

.incoming-toast:focus-visible {
  box-shadow: 0 0 0 2px var(--accent-soft), 0 14px 34px rgba(0, 0, 0, 0.32);
}

.incoming-toast-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.incoming-toast-body strong {
  overflow: hidden;
  color: var(--text);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.incoming-toast-body span {
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.incoming-toast-close {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
}

.incoming-toast-close:hover {
  background: var(--accent-soft);
  color: var(--text);
}

.incoming-toast-enter-active,
.incoming-toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.incoming-toast-enter-from,
.incoming-toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.new-message-jump {
  position: absolute;
  bottom: 104px;
  left: 50%;
  z-index: 12;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--popover-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  transform: translateX(-50%);
  backdrop-filter: blur(10px);
}

.new-message-jump:hover {
  background: var(--accent-soft);
}

.jump-enter-active,
.jump-leave-active {
  transition: opacity 0.16s ease;
}

.jump-enter-from,
.jump-leave-to {
  opacity: 0;
}

.chat-details-backdrop {
  position: fixed;
  inset: 0;
  z-index: 25;
}

.chat-details {
  position: absolute;
  top: 66px;
  right: 16px;
  z-index: 30;
  width: 292px;
  padding: 14px;
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  background: var(--popover-bg);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(18px);
}

.details-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.details-head > div {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.details-head strong {
  font-size: 13px;
}

.details-head span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11px;
}

.details-close {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
}

.details-close:hover {
  background: var(--panel-hover);
  color: var(--text);
}

.details-body {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px 0;
}

.details-profile {
  display: flex;
  align-items: center;
  gap: 11px;
  padding-bottom: 11px;
  border-bottom: 1px solid var(--border);
}

.profile-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.profile-main strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.profile-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11px;
}

.details-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  color: var(--muted);
  font-size: 11.5px;
}

.details-hint.error {
  color: var(--danger-text);
}

.details-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  font-size: 11.5px;
  color: var(--text-soft);
}

.details-label {
  flex: 0 0 auto;
  color: var(--muted);
}

.details-row code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 170px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10.5px;
  color: var(--muted-soft);
}

.details-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.details-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-soft);
  color: var(--text-soft);
  font-size: 11.5px;
  transition: background 0.16s ease;
}

.details-action:hover:not(:disabled) {
  background: var(--panel-hover);
}

.popover-enter-active,
.popover-leave-active {
  transition: opacity 0.16s ease, transform 0.18s ease;
}

.popover-enter-from,
.popover-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
