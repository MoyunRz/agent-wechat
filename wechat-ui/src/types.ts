export type ThreadFilter = 'all' | 'unread' | 'direct' | 'groups' | 'mini' | 'official'

export type RailView = 'chats' | 'contacts' | 'requests' | 'ai'

export type ThemeMode = 'dark' | 'light'

export type UiTheme = {
  id: string
  label: string
  accent: string
  accentStrong: string
  accentSoft: string
  accentFaint: string
  bubble: string
}

export type AccountSummary = {
  id: string
  alias: string | null
  authenticated: boolean
  /** 已保存登录材料但会话未在线（如离线模式）：UI 以此区分"登录过但离线"与"从未登录"。 */
  savedLogin?: boolean
  connection: string
  ownUsername: string | null
  contactSyncReady?: boolean
  nativeRuntime?: boolean
  storageMode?: string
  offlineMode?: boolean
}

export type ThreadPreview = {
  id: string
  senderId: string | null
  senderName: string | null
  direction: string | null
  type: number
  text: string
  createdAt: string | null
}

export type ThreadAvatarMember = {
  id: string
  displayName: string
}

/** 群成员（catalog 列表）；mentionName 是服务端写入提及名单时使用的名字。 */
export type GroupMember = {
  id: string
  username: string
  displayName?: string | null
  roomDisplayName?: string | null
  mentionName?: string | null
}

/** 发送文本携带的提及信息（仅群聊）；positions 为正文里的 UTF-16 区间。 */
export type TextMentions = {
  userIds?: string[]
  all?: boolean
  positions?: Array<{ start: number, end: number, index: number }>
}

/** @ 选择器条目；all 表示「@所有人」（需要群主/管理员权限）。 */
export type MentionOption = {
  id: string
  label: string
  all?: boolean
}

export type Thread = {
  id: string
  accountId: string
  peerId: string
  kind: string
  displayName: string | null
  unreadCount: number | null
  muted?: boolean | null
  pinned?: boolean | null
  readStateVersion: string
  lastMessage?: ThreadPreview | null
  avatarMembers?: ThreadAvatarMember[]
  /** 本地新建、尚未出现在上游 thread 列表中的草稿会话。 */
  isDraft?: boolean
}

export type Contact = {
  id: string
  username: string
  displayName: string | null
  nickname?: string | null
  remark?: string | null
  alias?: string | null
  relation?: string
  localType?: number | null
  contactFlag?: number | null
  deleteFlag?: number | null
  verifyFlag?: number | null
  /** Relationship privacy read from the official profile, when available. */
  privacy?: ContactPrivacySettings | null
  /** Version required when saving privacy or a remark for this contact. */
  privacyVersion?: string | null
  /** True while an accepted privacy change is waiting for contact sync. */
  privacyPending?: boolean | null
  /** True while an accepted remark is waiting for WeChat's saved value. */
  remarkPending?: boolean | null
  /** Why privacy cannot be edited yet; see the daemon's contact contract. */
  privacyUnavailable?: string | null
  classification?: {
    category?: string | null
    namespace?: string | null
    businessKind?: string | null
    businessType?: string | null
  }
}

/** Relationship privacy the account owner can set for one contact. */
export type ContactPrivacySettings = {
  chatsOnly: boolean
  hideMyPosts: boolean
  hideTheirPosts: boolean
}

export type MediaKind = 'image' | 'video' | 'voice' | 'file'

export type StagedAttachment = {
  id: string
  file: File
  name: string
  size: number
  kind: MediaKind
  previewUrl: string | null
}

export type LocalMedia = {
  kind: MediaKind
  url: string | null
  name: string
  size: number
  contentType: string
}

export type OwnedMediaSource = {
  id: string
  name?: string
  mediaType?: string
  byteLength?: number
}

export type MediaJob = {
  id: string
  accountId: string
  kind: string
  state: string
  phase: string
  reason: string | null
  serverMessageId: string | null
  sourceId: string | null
  threadId: string | null
}

export type MediaAssetState = 'pending' | 'available' | 'expired' | 'unsupported'

export type MediaAssetPreview = {
  contentUrl?: string | null
  contentType?: string | null
  byteLength?: number | null
}

export type MediaAsset = {
  id: string
  kind?: string | null
  variant?: string | null
  state: MediaAssetState
  contentType?: string | null
  byteLength?: number | null
  filename?: string | null
  contentUrl?: string | null
  preview?: MediaAssetPreview | null
}

export type MediaLookupItem = {
  messageId: string
  assets?: MediaAsset[] | null
  error?: string | { code?: string, message?: string } | null
}

export type MediaLookupResponse = {
  items?: MediaLookupItem[]
}

export type MediaTransfer = {
  id?: string
  messageId?: string
  assetId?: string | null
  state?: string
  error?: string | null
}

export type MessageMediaState = MediaAssetState | 'missing'

export type MessageMedia = {
  messageId: string
  assets: MediaAsset[]
  state: MessageMediaState
  error?: string | null
}

export type MessageMediaMap = Record<string, MessageMedia>

export type QuoteReference = {
  serverId: string
  type: number
  state?: string
  senderId?: string
  senderName?: string
  direction?: string
  embeddedText?: string
  embeddedImage?: boolean
  embeddedLink?: LinkCard
}

export type LinkCard = {
  title: string | null
  description: string | null
  url: string | null
  sourceName: string | null
}

export type LocationCard = {
  latitude: number
  longitude: number
  name: string | null
  address: string | null
}

/** 好友验证消息（type 37）携带的申请信息。原始 XML 与 ticket 不会下发。 */
export type FriendRequest = {
  fromUsername: string | null
  fromNickname: string | null
  encryptUsername: string | null
  scene: number | null
  greeting: string | null
  status?: 'pending' | 'accepted' | 'declined' | null
  avatar?: string | null
}

/** One saved verification-history entry of a contact request. */
export type ContactRequestMessage = {
  serverId: string
  message: string
  createdAt: number
  direction: string
}

/**
 * One per-peer friend-request conversation. The ID and version come from the
 * daemon's canonical request rows; accept/delete send the version back as a
 * precondition.
 */
export type ContactRequest = {
  id: string
  peerId: string
  displayName: string
  direction: string
  message: string
  updatedAt: number
  version: string
  isContact: boolean
  actionable: boolean
  attention: boolean
  state: string
  history: ContactRequestMessage[]
}

export type ContactRequestPage = {
  items: ContactRequest[]
  nextCursor: string | null
  sourceGeneration: string
  coverage?: unknown
  pendingIncomingCount: number
  asOfEventCursor: string
}

/** A person discovered on WeChat before a friend request is sent. */
export type ContactDiscovery = {
  displayName: string
  /** Opaque send reference; null when this match cannot receive a request. */
  recipientRef: string | null
  expiresAt: number
  source: string
  request: ContactRequest | null
  /** Saved contact ID when membership is already established. */
  contactId?: string | null
}

/** 定向联系人查询（服务端 getcontact）返回的单条结果。 */
export type ContactLookupItem = {
  id: string
  displayName?: string | null
  profileProjection?: string
}

export type ContactLookupResponse = {
  items?: ContactLookupItem[]
  results?: number[]
}

export type Message = {
  id: string
  accountId: string
  threadId: string
  serverId: string | null
  senderId: string | null
  type: number
  appMessageType?: number
  quote?: QuoteReference
  link?: LinkCard
  location?: LocationCard
  friendRequest?: FriendRequest | null
  recall?: {
    observedAt: string
    recalledAt?: string
    replacementText?: string | null
  }
  direction: string | null
  body: string | null
  createdAt: string | null
  mentions?: {
    state: string
    userIds: string[]
    self: boolean | null
    all: boolean | null
  }
  version: string
}

export type LoginAttempt = {
  id: string
  accountId: string
  kind: string
  state: string
  result: {
    expiresAt?: number | null
    lanChallenge?: unknown
    qrAvailable?: boolean
    qrGeneration?: number
    /** 扫码成功后 daemon 自动归位到的既有账号槽位 id；未发生归位（含字段缺省）时为 null。 */
    adoptedAccountId?: string | null
    /** 归位失败时 daemon 指出的原槽位 id（needs_slot_login）。 */
    accountId?: string | null
    /** 终态失败原因（daemon `login_worker` 写入，成功时为空）。 */
    code?: string | null
    reason?: string | null
    hint?: string | null
    serviceCode?: number | null
  }
  createdAt: string
  updatedAt: string
}

export type Operation = {
  id: string
  accountId?: string
  kind: string
  state: string
  result?: Record<string, unknown> | null
  createdAt?: string
  updatedAt?: string
}

export type SendIntent = {
  id: string
  accountId: string
  destination: string
  state: string
  clientId: string | null
  serverId: string | null
  errorCode: string | null
  localMessageId?: string
  createdAt: string
}

export type ListResponse<T> = {
  items: T[]
  nextCursor?: string | null
}

export type WechatEvent = {
  cursor: string
  kind: string
  data: Record<string, unknown>
  createdAt: string
}

export type LocalMessage = Message & {
  local?: boolean
  pending?: boolean
  sendState?: string
  sendError?: string | null
  sendId?: string
  localMedia?: LocalMedia
}

/** 主动缓存开关：对应 daemon 账号设置里的 proactiveCache，全部默认开启。 */
export type ProactiveCacheKinds = {
  image: boolean
  sticker: boolean
  file: boolean
  video: boolean
  voice: boolean
}

/** daemon 账号设置；proactiveCache 在 GET 里总是返回当前值。 */
export type AccountSettings = {
  autoDownloadMaxBytes: number
  proactiveCache: ProactiveCacheKinds | null
}

/** 一次媒体缓存清理移除的文件数与字节数。 */
export type PurgedMediaCache = {
  files: number
  bytes: number
}
