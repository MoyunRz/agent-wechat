import type {
  AccountSummary,
  Contact,
  ContactLookupResponse,
  FriendRequestPreflight,
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
  SendIntent,
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

  return '/client/v1'
}

const CLIENT_BASE = resolveClientBase()

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
  try {
    response = await fetch(apiUrl(path), {
      cache: 'no-store',
      credentials: 'same-origin',
      ...init,
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

  qrUrl(accountId: string, attemptId: string, generation = 0, nonce = 0): string {
    // 上游 wx 2.3.2 只接受 generation 查询参数；nonce 放在 fragment 里仅用于刷新图片，不发给服务端。
    const params = new URLSearchParams({ generation: String(generation) })
    const base = `${apiUrl(`/accounts/${enc(accountId)}/login-attempts/${enc(attemptId)}/qr`)}?${params.toString()}`
    return nonce ? `${base}#v=${nonce}` : base
  },

  async listThreads(accountId: string, limit = 50): Promise<ListResponse<Thread>> {
    return request<ListResponse<Thread>>(`/accounts/${enc(accountId)}/threads?limit=${limit}`)
  },

  async listContacts(accountId: string, search = '', limit = 20): Promise<ListResponse<Contact>> {
    const params = new URLSearchParams({ limit: String(limit) })
    const keyword = search.trim()
    if (keyword)
      params.set('search', keyword)
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

  getOperation(accountId: string, operationId: string): Promise<Operation> {
    return request<Operation>(`/accounts/${enc(accountId)}/operations/${enc(operationId)}`)
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

  requestMediaTransfer(accountId: string, messageId: string): Promise<MediaTransfer> {
    return jsonRequest<MediaTransfer>(
      `/accounts/${enc(accountId)}/messages/${enc(messageId)}/media-transfers`,
      'POST',
      { messageId, assetId: null, quality: 'best' },
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

  sendText(accountId: string, threadId: string, text: string): Promise<SendIntent> {
    // 上游 NativeTextSendRequest 是 deny_unknown_fields 的纯文本结构，
    // 不能带 kind 字段；quoted/mention 通过 quote/mentions 扩展。
    return jsonRequest<SendIntent>(
      `/accounts/${enc(accountId)}/sends`,
      'POST',
      { threadId, text },
      { 'Idempotency-Key': idempotencyKey('send') },
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
