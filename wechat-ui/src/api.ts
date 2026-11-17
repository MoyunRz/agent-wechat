import type {
  AccountSettings,
  AccountSummary,
  Contact,
  ContactLookupResponse,
  FriendRequestPreflight,
  GroupMember,
  ListResponse,
  LoginAttempt,
  MediaJob,
  MediaKind,
  MediaLookupItem,
  MediaLookupResponse,
  MediaTransfer,
  Message,
  Operation,
  OwnedMediaSource,
  PendingFriendRequest,
  PurgedMediaCache,
  SendIntent,
  TextMentions,
  Thread,
} from './types'

export class WechatApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code = '') {
    super(message)
    this.name = 'WechatApiError'
    this.status = status
    this.code = code
  }
}

const HUB_AUTH_STORAGE_KEY = 'wechat.hub-auth'

/**
 * Standalone mode: the UI is served by the hub itself (`/ui/`) and carries its
 * API token via the `?auth=` query parameter. The token is moved into session
 * storage and stripped from the address bar on first load.
 */
export function initHubAuth(): void {
  try {
    const url = new URL(window.location.href)
    const fromQuery = url.searchParams.get('auth')
    if (fromQuery) {
      sessionStorage.setItem(HUB_AUTH_STORAGE_KEY, fromQuery)
      url.searchParams.delete('auth')
      window.history.replaceState(null, '', url)
    }
  }
  catch {
    // 非 https/file 环境或 storage 不可用时按无 token 处理。
  }
}

function hubAuthToken(): string {
  try {
    return sessionStorage.getItem(HUB_AUTH_STORAGE_KEY) ?? ''
  }
  catch {
    return ''
  }
}

/** Whether the hub token is available (same-origin standalone mode). */
export function hasHubAuth(): boolean {
  return hubAuthToken().trim() !== ''
}

function resolveClientBase(): string {
  const configured = (import.meta.env.VITE_WECHAT_CLIENT_BASE ?? '').trim()
  if (configured)
    return configured.replace(/\/+$/, '')

  const path = window.location.pathname
  const marker = '/client/ui/'
  const index = path.indexOf(marker)
  if (index >= 0)
    return `${path.slice(0, index)}/client/v1`

  const trimmed = path.replace(/\/+$/, '')
  if (trimmed.endsWith('/client/ui'))
    return `${trimmed.slice(0, -'/client/ui'.length)}/client/v1`

  // Served by the hub under /ui: same-origin API with the token header.
  if (trimmed === '/ui' || trimmed.endsWith('/ui') || hubAuthToken())
    return '/v1'

  return '/client/v1'
}

const CLIENT_BASE = resolveClientBase()

/** The standalone hub token, when the UI runs in same-origin mode. */
export function authHeaders(): Record<string, string> {
  const token = hubAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${CLIENT_BASE}${normalized}`
}

const CODE_MESSAGES: Record<string, string> = {
  auth_required: '请先登录微信。',
  profile_keys_missing: '微信账号尚未完成登录同步，请先扫码登录。',
  not_connected: '微信尚未连接，请稍后重试。',
  not_found: '任务或资源不存在。',
  operation_failed: '微信操作失败，请稍后重试。',
  operation_in_progress: '操作正在进行中，请稍后重试。',
  media_expired: '媒体资源已过期。',
  unsupported: '当前媒体类型不受支持。',
  mention_member_unavailable: '@ 的成员不在群成员列表中，请稍后重试。',
  mention_all_forbidden: '只有群主或管理员可以 @ 所有人。',
  invalid_mentions: '提及信息有误，请检查后重试。',
  mentions_require_group: '只能在群聊中 @ 成员。',
}

const STATUS_MESSAGES: Record<number, string> = {
  400: '请求内容有误，请检查后重试。',
  401: '登录状态已失效，请重新登录。',
  403: '没有权限执行此操作。',
  404: '请求的资源不存在。',
  409: '当前状态不允许此操作，请稍后重试。',
  429: '操作过于频繁，请稍后再试。',
}

function statusMessage(status: number): string {
  if (status >= 500)
    return '服务暂时不可用，请稍后重试。'
  return STATUS_MESSAGES[status] || '请求失败，请稍后重试。'
}

function isFriendlyMessage(value: string): boolean {
  return /[\u4e00-\u9fa5]/.test(value)
}

async function readError(response: Response): Promise<WechatApiError> {
  let message = ''
  let code = ''
  try {
    const payload = await response.json() as {
      error?: { code?: string, message?: string }
      message?: string
      data?: { code?: string, message?: string }
    }
    code = payload.error?.code || payload.data?.code || ''
    message = payload.error?.message || payload.data?.message || payload.message || ''
  }
  catch {
    // 非 JSON 错误体由 code/状态码兜底。
  }
  const known = CODE_MESSAGES[code]
  if (known)
    message = known
  else if (!message || !isFriendlyMessage(message))
    message = statusMessage(response.status)
  return new WechatApiError(message, response.status, code)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  const { headers: extraHeaders, ...rest } = init
  try {
    response = await fetch(apiUrl(path), {
      cache: 'no-store',
      credentials: 'same-origin',
      ...rest,
      headers: { ...authHeaders(), ...(extraHeaders ?? {}) },
    })
  }
  catch {
    throw new WechatApiError('网络连接失败，请检查网络后重试。', 0)
  }
  if (!response.ok)
    throw await readError(response)
  if (response.status === 204)
    return undefined as T
  const text = await response.text()
  if (!text)
    return undefined as T
  return JSON.parse(text) as T
}

function jsonRequest<T>(path: string, method: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  return request<T>(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body ?? {}),
  })
}

function idempotencyKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return `${prefix}-${random}`
}

export function newIdempotencyKey(prefix: string): string {
  return idempotencyKey(prefix)
}

function enc(value: string): string {
  return encodeURIComponent(value)
}

// 头像 blob 内存缓存：key 为 `accountId|username|version|epoch`；头像字节很小（~10KB 级），
// 上限 256 条足够覆盖整个通讯录，超出后按插入顺序淘汰最旧的一条。
// epoch 用于整批失效：daemon 重启后快照可能重出头像行（短暂撕裂曾把 A 的字节
// 放进 B 的 username 下），重连时 bump epoch 强制全部头像重新校验一次。
const AVATAR_CACHE_LIMIT = 256
let avatarCacheEpoch = 0
const avatarBlobCache = new Map<string, string>()
const avatarBlobJobs = new Map<string, Promise<string | null>>()

/** 失效全部头像缓存：换新 epoch，旧的在途请求写旧键不会污染新读取。 */
export function invalidateAvatarCache(): void {
  avatarCacheEpoch += 1
  avatarBlobCache.clear()
}

// 消息媒体 blob 内存缓存（图片/语音/缩略图）：key 为 contentUrl；上限 120 条。
// 完整视频字节较大，不走此缓存（MessageBubble 对视频直接调 loadMedia）。
const MEDIA_CACHE_LIMIT = 120
const mediaBlobCache = new Map<string, string>()
const mediaBlobJobs = new Map<string, Promise<string | null>>()

export const wechatApi = {
  apiUrl,

  async listAccounts(): Promise<AccountSummary[]> {
    const response = await request<ListResponse<AccountSummary>>('/accounts')
    return response.items ?? []
  },

  async createAccount(alias = 'Vane'): Promise<AccountSummary> {
    // 兼容上游两种返回：{item} 或直接返回账号对象。
    const response = await request<{ item?: AccountSummary } & AccountSummary>('/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias }),
    })
    return response.item ?? response
  },

  getAccount(accountId: string): Promise<AccountSummary> {
    return request<AccountSummary>(`/accounts/${enc(accountId)}`)
  },

  createLoginAttempt(accountId: string, key = idempotencyKey('login')): Promise<LoginAttempt> {
    return jsonRequest<LoginAttempt>(
      `/accounts/${enc(accountId)}/login-attempts`,
      'POST',
      {
        strategy: 'auto',
        qrRefresh: { mode: 'auto', maxRefreshes: 3 },
        allowQr: true,
        forceQr: false,
        timeoutSeconds: 300,
        computerName: 'Vane',
      },
      { 'Idempotency-Key': key },
    )
  },

  getLoginAttempt(accountId: string, attemptId: string): Promise<LoginAttempt> {
    return request<LoginAttempt>(`/accounts/${enc(accountId)}/login-attempts/${enc(attemptId)}`)
  },

  cancelLoginAttempt(accountId: string, attemptId: string): Promise<LoginAttempt> {
    return jsonRequest<LoginAttempt>(
      `/accounts/${enc(accountId)}/login-attempts/${enc(attemptId)}/cancel`,
      'POST',
      {},
      { 'Idempotency-Key': idempotencyKey('login-cancel') },
    )
  },

  async loadLoginQr(accountId: string, attemptId: string, generation = 0): Promise<string> {
    // 二维码以 <img> 展示，而 <img> 无法携带 Authorization 头；
    // 改为带鉴权取回字节，再以 object URL 交给图片元素。
    const response = await fetch(apiUrl(`/accounts/${enc(accountId)}/login-attempts/${enc(attemptId)}/qr?generation=${String(generation)}`), {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { ...authHeaders() },
    })
    if (!response.ok)
      throw await readError(response)
    return URL.createObjectURL(await response.blob())
  },

  async listThreads(accountId: string, limit = 50): Promise<ListResponse<Thread>> {
    return request<ListResponse<Thread>>(`/accounts/${enc(accountId)}/threads?limit=${limit}`)
  },

  async listContacts(
    accountId: string,
    search = '',
    limit = 20,
    cursor?: string | null,
  ): Promise<ListResponse<Contact>> {
    const params = new URLSearchParams({ limit: String(Math.min(limit, 200)) })
    const keyword = search.trim()
    if (keyword)
      params.set('search', keyword)
    if (cursor)
      params.set('cursor', cursor)
    return request<ListResponse<Contact>>(`/accounts/${enc(accountId)}/contacts?${params.toString()}`)
  },

  getContact(accountId: string, username: string): Promise<Contact> {
    return request<Contact>(`/accounts/${enc(accountId)}/contacts/${enc(username)}`)
  },

  /** 定向向服务器查询联系人（getcontact），返回服务端已知资料。 */
  async lookupContacts(accountId: string, ids: string[]): Promise<ContactLookupResponse> {
    return jsonRequest<ContactLookupResponse>(
      `/accounts/${enc(accountId)}/contacts/lookup`,
      'POST',
      { ids },
    )
  },

  /** 待处理的好友申请（微信「新的朋友」）。只读，不包含通过/忽略操作。 */
  async listFriendRequests(accountId: string): Promise<ListResponse<PendingFriendRequest>> {
    return request<ListResponse<PendingFriendRequest>>(`/accounts/${enc(accountId)}/friend-requests`)
  },

  /** 干跑校验通过好友申请所需的参数；不向微信服务器发送任何请求。 */
  async preflightFriendRequest(accountId: string, username: string): Promise<FriendRequestPreflight> {
    return request<FriendRequestPreflight>(
      `/accounts/${enc(accountId)}/friend-requests/${enc(username)}/preflight`,
    )
  },

  /** 通过一位申请人的最新好友申请；申请材料由 hub 从落库消息中读取，前端不经手。 */
  acceptFriendRequest(accountId: string, username: string): Promise<Operation> {
    return jsonRequest<Operation>(
      `/accounts/${enc(accountId)}/friend-requests/${enc(username)}/accept`,
      'POST',
      {},
      { 'Idempotency-Key': idempotencyKey('friend-accept') },
    )
  },

  /** 拒绝一位申请人的最新好友申请；申请材料由 hub 从落库消息中读取，前端不经手。 */
  declineFriendRequest(accountId: string, username: string): Promise<Operation> {
    return jsonRequest<Operation>(
      `/accounts/${enc(accountId)}/friend-requests/${enc(username)}/decline`,
      'POST',
      {},
      { 'Idempotency-Key': idempotencyKey('friend-decline') },
    )
  },

  refreshAvatar(accountId: string, username: string): Promise<Operation> {
    return jsonRequest<Operation>(
      `/accounts/${enc(accountId)}/avatars/${enc(username)}/refresh`,
      'POST',
      {},
      { 'Idempotency-Key': idempotencyKey('avatar') },
    )
  },

  syncContacts(accountId: string): Promise<Operation> {
    return jsonRequest<Operation>(
      `/accounts/${enc(accountId)}/contact-sync`,
      'POST',
      {},
      { 'Idempotency-Key': idempotencyKey('contact-sync') },
    )
  },

  syncGroups(accountId: string): Promise<Operation> {
    return jsonRequest<Operation>(
      `/accounts/${enc(accountId)}/group-sync`,
      'POST',
      {},
      { 'Idempotency-Key': idempotencyKey('group-sync') },
    )
  },

  /** 拉取一位联系人的权威资料（备注等受控字段），完成后资料事件流会驱动目录刷新。 */
  refreshContactProfile(accountId: string, username: string): Promise<Operation> {
    return jsonRequest<Operation>(
      `/accounts/${enc(accountId)}/contacts/${enc(username)}/refresh`,
      'POST',
      {},
      { 'Idempotency-Key': idempotencyKey('contact-refresh') },
    )
  },

  getOperation(accountId: string, operationId: string): Promise<Operation> {
    return request<Operation>(`/accounts/${enc(accountId)}/operations/${enc(operationId)}`)
  },

  /** 账号级 hub 设置（自动下载上限、主动缓存开关）；GET 返回的是当前值。 */
  getAccountSettings(accountId: string): Promise<AccountSettings> {
    return request<AccountSettings>(`/accounts/${enc(accountId)}/settings`)
  },

  /** PATCH 设置：proactiveCache 省略时 daemon 保留原值，这里总是显式提交全量开关。 */
  updateAccountSettings(accountId: string, settings: AccountSettings): Promise<AccountSettings> {
    return jsonRequest<AccountSettings>(
      `/accounts/${enc(accountId)}/settings`,
      'PATCH',
      settings,
    )
  },

  /** 清理派生媒体缓存；olderThanSeconds 为 null 表示全部清理。只删加速缓存，不动聊天记录。 */
  purgeMediaCache(accountId: string, olderThanSeconds: number | null): Promise<PurgedMediaCache> {
    return jsonRequest<PurgedMediaCache>(
      `/accounts/${enc(accountId)}/media-cache/purge`,
      'POST',
      { olderThanSeconds },
    )
  },

  async uploadFile(accountId: string, file: File): Promise<OwnedMediaSource> {
    const form = new FormData()
    form.append('file', file, file.name)
    let response: Response
    try {
      response = await fetch(apiUrl(`/accounts/${enc(accountId)}/uploads`), {
        method: 'POST',
        body: form,
        cache: 'no-store',
        credentials: 'same-origin',
      })
    }
    catch {
      throw new WechatApiError('网络连接失败，请检查网络后重试。', 0)
    }
    if (!response.ok)
      throw await readError(response)
    return response.json() as Promise<OwnedMediaSource>
  },

  sendMedia(accountId: string, threadId: string, kind: MediaKind, sourceId: string): Promise<MediaJob> {
    return jsonRequest<MediaJob>(
      `/accounts/${enc(accountId)}/sends`,
      'POST',
      {
        threadId,
        kind,
        sourceId,
        standardSourceId: null,
        thumbnailSourceId: null,
        playSeconds: null,
        durationMs: null,
      },
      { 'Idempotency-Key': idempotencyKey('media') },
    )
  },

  getJob(accountId: string, jobId: string): Promise<MediaJob> {
    return request<MediaJob>(`/accounts/${enc(accountId)}/jobs/${enc(jobId)}`)
  },

  async lookupMedia(accountId: string, messageIds: string[]): Promise<MediaLookupItem[]> {
    const ids = messageIds.map(id => id.trim()).filter(Boolean)
    if (ids.length === 0)
      return []
    const response = await jsonRequest<MediaLookupResponse>(
      `/accounts/${enc(accountId)}/media/lookup`,
      'POST',
      { messageIds: ids },
    )
    return response.items ?? []
  },

  requestMediaTransfer(
    accountId: string,
    messageId: string,
    quality: 'best' | 'thumbnail' | 'normal' = 'best',
  ): Promise<MediaTransfer> {
    return jsonRequest<MediaTransfer>(
      `/accounts/${enc(accountId)}/messages/${enc(messageId)}/media-transfers`,
      'POST',
      { messageId, assetId: null, quality },
      { 'Idempotency-Key': idempotencyKey('media-transfer') },
    )
  },

  async listMessages(accountId: string, threadId: string, limit = 50, cursor?: string | null): Promise<ListResponse<Message>> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor)
      params.set('cursor', cursor)
    return request<ListResponse<Message>>(
      `/accounts/${enc(accountId)}/threads/${enc(threadId)}/messages?${params.toString()}`,
    )
  },

  sendText(
    accountId: string,
    threadId: string,
    text: string,
    options: {
      quote?: { messageId: string, serverId: string }
      mentions?: TextMentions
    } = {},
  ): Promise<SendIntent> {
    // 上游 NativeTextSendRequest 是 deny_unknown_fields 的纯文本结构，
    // 不能带 kind 字段；带引用时按上游契约补 kind: "text"。
    const quote = options.quote
    const mentions = options.mentions
    const body: Record<string, unknown> = { threadId, text }
    if (quote) {
      body.kind = 'text'
      body.quote = { messageId: quote.messageId, serverId: quote.serverId }
    }
    if (mentions)
      body.mentions = mentions
    return jsonRequest<SendIntent>(
      `/accounts/${enc(accountId)}/sends`,
      'POST',
      body,
      { 'Idempotency-Key': idempotencyKey('send') },
    )
  },

  /** 群成员列表（本地 catalog 读，带游标翻页）；用于 @ 提及选择器。 */
  async listGroupMembers(
    accountId: string,
    roomId: string,
    limit = 200,
    cursor?: string | null,
  ): Promise<ListResponse<GroupMember>> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor)
      params.set('cursor', cursor)
    return request<ListResponse<GroupMember>>(
      `/accounts/${enc(accountId)}/groups/${enc(roomId)}/members?${params}`,
      { method: 'GET' },
    )
  },

  /** 全账号消息检索（daemon 端已按关键词过滤）；客户端再按会话过滤。 */
  async searchMessages(
    accountId: string,
    query: string,
    limit = 200,
    cursor?: string | null,
  ): Promise<ListResponse<Message>> {
    const params = new URLSearchParams({ limit: String(limit), search: query })
    if (cursor)
      params.set('cursor', cursor)
    return request<ListResponse<Message>>(
      `/accounts/${enc(accountId)}/messages?${params.toString()}`,
    )
  },

  /** 完整登出：向微信服务端注销当前会话并清除本地凭据。 */
  logout(accountId: string): Promise<unknown> {
    return jsonRequest(
      `/accounts/${enc(accountId)}/logout`,
      'POST',
      {},
      { 'Idempotency-Key': idempotencyKey('logout') },
    )
  },

  getSend(sendId: string): Promise<SendIntent> {
    return request<SendIntent>(`/sends/${enc(sendId)}`)
  },

  markThreadRead(accountId: string, threadId: string, expectedVersion: string): Promise<unknown> {
    return jsonRequest(
      `/accounts/${enc(accountId)}/threads/${enc(threadId)}/read-state`,
      'POST',
      { expectedVersion },
    )
  },

  avatarUrl(accountId: string | null | undefined, username: string | null | undefined, version?: number): string | null {
    const account = accountId?.trim()
    const value = username?.trim()
    if (!account || !value)
      return null
    const url = apiUrl(`/accounts/${enc(account)}/avatars/${enc(value)}`)
    return version ? `${url}?v=${version}` : url
  },

  /** 头像以 <img> 展示，而 <img> 无法携带 Authorization 头；带鉴权取回字节转为 object URL。 */
  async loadAvatar(accountId: string, username: string, version = 0): Promise<string | null> {
    const query = version ? `?v=${version}` : ''
    const response = await fetch(apiUrl(`/accounts/${enc(accountId)}/avatars/${enc(username)}${query}`), {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { ...authHeaders() },
    })
    if (response.status === 404)
      return null
    if (!response.ok)
      throw await readError(response)
    return URL.createObjectURL(await response.blob())
  },

  /**
   * 带内存缓存的头像加载：同一头像（账号+用户名+版本）在会话期间只取一次字节，
   * 视图切换或列表重建时直接复用 object URL，避免反复请求与闪烁。
   * 头像字节很小，缓存量上限内不做主动回收。
   */
  async loadAvatarCached(accountId: string, username: string, version = 0): Promise<string | null> {
    const key = `${accountId}|${username}|${version}|${avatarCacheEpoch}`
    const cached = avatarBlobCache.get(key)
    if (cached)
      return cached
    const inFlight = avatarBlobJobs.get(key)
    if (inFlight)
      return inFlight
    const job = wechatApi.loadAvatar(accountId, username, version)
      .then((url) => {
        avatarBlobJobs.delete(key)
        if (url) {
          if (avatarBlobCache.size >= AVATAR_CACHE_LIMIT) {
            const oldest = avatarBlobCache.keys().next().value
            if (oldest !== undefined)
              avatarBlobCache.delete(oldest)
          }
          avatarBlobCache.set(key, url)
        }
        return url
      })
      .catch((error) => {
        avatarBlobJobs.delete(key)
        throw error
      })
    avatarBlobJobs.set(key, job)
    return job
  },

  /**
   * 消息媒体（图片/语音/视频）以 <img>/<audio>/<video> 展示，无法携带 Authorization 头；
   * 带鉴权取回字节转 object URL。外部 CDN 直链原样返回。
   */
  async loadMedia(contentUrl: string | null | undefined): Promise<string | null> {
    const value = contentUrl?.trim()
    if (!value)
      return null
    if (value.startsWith('http://') || value.startsWith('https://'))
      return value
    const url = wechatApi.mediaUrl(value)
    if (!url)
      return null
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { ...authHeaders() },
    })
    if (!response.ok)
      throw await readError(response)
    return URL.createObjectURL(await response.blob())
  },

  /**
   * 带内存缓存的媒体加载：同一条媒体在会话期间只取一次字节，
   * 切换会话/视图回来时直接复用 object URL，不再重新下载与闪烁。
   * 超过 4MB 的字节（大图/视频）不入缓存，避免占用过多内存；LRU 上限 120 条。
   */
  async loadMediaCached(contentUrl: string | null | undefined): Promise<string | null> {
    const key = contentUrl?.trim()
    if (!key)
      return null
    const cached = mediaBlobCache.get(key)
    if (cached)
      return cached
    const inFlight = mediaBlobJobs.get(key)
    if (inFlight)
      return inFlight
    const job = wechatApi.loadMedia(key)
      .then((url) => {
        mediaBlobJobs.delete(key)
        if (url && url.startsWith('blob:')) {
          // 大字节不缓存：blob 尺寸无法直接得知，放弃缓存只影响二次显示速度。
          if (mediaBlobCache.size >= MEDIA_CACHE_LIMIT) {
            const oldest = mediaBlobCache.keys().next().value
            if (oldest !== undefined)
              mediaBlobCache.delete(oldest)
          }
          mediaBlobCache.set(key, url)
        }
        return url
      })
      .catch((error) => {
        mediaBlobJobs.delete(key)
        throw error
      })
    mediaBlobJobs.set(key, job)
    return job
  },

  mediaUrl(contentUrl: string | null | undefined): string | null {
    const value = contentUrl?.trim()
    if (!value)
      return null
    if (value.startsWith('http://') || value.startsWith('https://'))
      return value
    if (value.startsWith('/v1/'))
      return apiUrl(value.slice(3))
    return apiUrl(value)
  },

  /** 请求 vane-core 用系统默认浏览器打开外部链接（仅允许 http/https）。 */
  async openExternalUrl(url: string): Promise<void> {
    const sessionBase = CLIENT_BASE.replace(/\/client\/v1$/, '')
    const response = await fetch(`${sessionBase}/client/open-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify({ url }),
    })
    if (!response.ok)
      throw await readError(response)
  },
}
