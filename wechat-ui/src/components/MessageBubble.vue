<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { wechatApi } from '../api'
import { formatClock, isOwnMessage, messageText, threadName } from '../format'
import { splitEmoticonSegments } from '../emoticons'
import type { AccountSummary, LinkCard, LocalMessage, MediaAsset, MessageMedia, Thread } from '../types'
import Icon from './Icon.vue'
import ThreadAvatar from './ThreadAvatar.vue'
import VoiceBubble from './VoiceBubble.vue'

// 微信对部分转发卡片填充的版本占位标题，真实标题在描述字段。
const LINK_TITLE_PLACEHOLDER = '当前微信版本不支持展示该内容，请升级至最新版本。'

const props = defineProps<{
  message: LocalMessage
  thread: Thread
  account: AccountSummary
  media?: MessageMedia | null
  groupPosition?: 'single' | 'first' | 'middle' | 'last'
}>()

const own = computed(() => isOwnMessage(props.message))
// type 37 的发件方向副本不带申请 XML（无法解析出 friendRequest），按系统提示展示。
const system = computed(() =>
  props.message.type === 10000
  || (props.message.type === 37 && !props.message.friendRequest)
  || (!props.message.senderId && !props.message.direction),
)
const systemText = computed(() =>
  props.message.type === 37 && !props.message.friendRequest
    ? '已发出好友申请，等待对方通过'
    : messageText(props.message),
)
const isGroup = computed(() => props.thread.kind === 'group')
const groupPosition = computed(() => props.groupPosition ?? 'single')
const isGroupStart = computed(() => groupPosition.value === 'single' || groupPosition.value === 'first')
const groupedBubble = computed(() => groupPosition.value === 'first' || groupPosition.value === 'middle')

const senderName = computed(() => {
  if (!isGroup.value)
    return threadName(props.thread)
  const senderId = props.message.senderId
  if (!senderId)
    return '群成员'
  const member = props.thread.avatarMembers?.find(item => item.id === senderId)
  return member?.displayName || senderId
})

const senderUsername = computed(() => {
  return isGroup.value ? props.message.senderId : props.thread.peerId
})

const ownAvatarName = computed(() => {
  return props.account.ownUsername?.trim() || '我'
})

const emit = defineEmits<{ reply: [] }>()

// 引用回复需要平台权威 serverId；本地刚发出、尚未回显的消息没有，不提供引用。
const canReply = computed(() => Boolean(props.message.serverId?.trim()))

const quoteSender = computed(() => props.message.quote?.senderName?.trim() ?? '')

/** 引用内容预览：链接引用展示标题而非 daemon 生成的 [Link] 原文，其余按类型给占位。 */
const quotePreview = computed(() => {
  const quote = props.message.quote
  if (!quote)
    return ''
  const linkTitle = quote.embeddedLink?.title?.trim() ?? ''
  if (linkTitle)
    return linkTitle
  const raw = quote.embeddedText?.trim() ?? ''
  if (raw.startsWith('[Link]')) {
    // 无 embeddedLink 元数据时兜底：剥掉 [Link] 前缀只留首行标题。
    return raw.replace(/^\[Link\]\s*/, '').split('\n')[0]?.trim() || raw
  }
  if (raw)
    return raw
  if (quote.embeddedImage)
    return '[图片]'
  switch (quote.type) {
    case 34:
      return '[语音]'
    case 43:
      return '[视频]'
    case 47:
      return '[表情]'
    case 49:
      return quote.embeddedLink?.url ? '[链接]' : '[卡片]'
    default:
      return ''
  }
})

const quoteLinkUrl = computed(() => props.message.quote?.embeddedLink?.url?.trim() ?? '')

async function openExternalLink(url: string): Promise<void> {
  try {
    await wechatApi.openExternalUrl(url)
  }
  catch {
    // 后端不可用时退回嵌入式浏览器打开。
    window.open(url, '_blank', 'noopener')
  }
}

function openQuoteLink(): void {
  const url = quoteLinkUrl.value
  if (!url)
    return
  void openExternalLink(url)
}

const linkCard = computed(() => {
  const link = props.message.link
  if (!link)
    return null
  const title = link.title?.trim() ?? ''
  const description = link.description?.trim() ?? ''
  if (!title && !description && !link.url?.trim())
    return null
  // 微信部分转发卡片把真实标题放在描述里，title 是版本占位文案，此时交换展示。
  let card = link
  if (title === LINK_TITLE_PLACEHOLDER && description)
    card = { ...link, title: description, description: '' }
  // 公众号文章等卡片没有来源名时，用会话对方名称补充，界面更像微信原生卡片。
  const sourceName = card.sourceName?.trim()
    || (isOfficialPeer.value ? threadName(props.thread) : '')
  if (sourceName && sourceName !== (card.sourceName ?? ''))
    card = { ...card, sourceName }
  return card
})

// 公众号（gh_ 开头）与小程序/OpenIM 会话：无需好友关系即可收发，不算陌生人。
const isOfficialPeer = computed(() => {
  const peer = (props.thread.peerId || props.thread.id).trim()
  return peer.startsWith('gh_') || peer.endsWith('@openim')
})

async function openLinkCard(link: LinkCard): Promise<void> {
  const url = link.url?.trim()
  if (!url)
    return
  await openExternalLink(url)
}

const locationText = computed(() => {
  const location = props.message.location
  if (!location)
    return ''
  return [location.name, location.address].filter(Boolean).join(' · ')
    || `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
})

type MediaRenderKind = 'image' | 'voice' | 'video' | 'file'

const mediaKind = computed<MediaRenderKind | null>(() => {
  if (props.message.localMedia)
    return null
  switch (props.message.type) {
    case 3:
    case 47:
      return 'image'
    case 34:
      return 'voice'
    case 43:
      return 'video'
    case 49:
      return props.message.appMessageType === 6 ? 'file' : null
    default:
      return null
  }
})

const mediaAssets = computed<MediaAsset[]>(() => props.media?.assets ?? [])

function assetMatches(asset: MediaAsset, kind: MediaRenderKind): boolean {
  const text = `${asset.kind ?? ''} ${asset.contentType ?? ''}`.toLowerCase()
  switch (kind) {
    case 'image':
      return text.includes('image') || text.includes('sticker')
    case 'voice':
      return text.includes('audio') || text.includes('voice')
    case 'video':
      return text.includes('video')
    default:
      return text.includes('file') || text.includes('document') || Boolean(asset.filename?.trim())
  }
}

function assetRank(asset: MediaAsset): number {
  const variant = (asset.variant ?? '').toLowerCase()
  if (variant.includes('standard'))
    return 0
  if (variant.includes('best') || variant.includes('original') || variant.includes('source') || variant.includes('full'))
    return 1
  if (variant.includes('thumb') || variant.includes('preview') || variant.includes('small'))
    return 3
  return 2
}

function pickAsset(kind: MediaRenderKind): MediaAsset | null {
  const available = mediaAssets.value
    .filter(asset => asset.state === 'available' && Boolean(asset.contentUrl?.trim()))
    .slice()
    .sort((a, b) => assetRank(a) - assetRank(b))
  if (available.length === 0)
    return null

  const matched = available.filter(asset => assetMatches(asset, kind))
  if (matched.length > 0)
    return matched[0]

  // 上游未提供 kind/contentType 时，单个资源可直接作为该类型的媒体使用。
  const generic = available.filter(asset => !asset.kind && !asset.contentType)
  return generic[0] ?? null
}

const imageAsset = computed(() => (mediaKind.value === 'image' ? pickAsset('image') : null))
const voiceAsset = computed(() => (mediaKind.value === 'voice' ? pickAsset('voice') : null))
const videoAsset = computed(() => (mediaKind.value === 'video' ? pickAsset('video') : null))
const fileAsset = computed(() => (mediaKind.value === 'file' ? pickAsset('file') : null))

// 媒体字节以 <img>/<audio>/<video> 展示，无法携带 Authorization 头；
// 统一改为带鉴权取回字节转 object URL，失败时退回占位标签。
// 视频例外：只自动加载首帧海报（thumbnail），完整视频在点击播放时才下载。
const imageObjectUrl = ref<string | null>(null)
const voiceObjectUrl = ref<string | null>(null)
const videoObjectUrl = ref<string | null>(null)
const fileObjectUrl = ref<string | null>(null)
const videoPosterUrl = ref<string | null>(null)
const videoPlayState = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle')
// 本组件私有（直连加载、不经共享缓存）的 blob URL：卸载/替换时需要 revoke。
// 共享缓存（loadMediaCached）返回的 URL 归缓存所有，任何情况下都不能在这里
// revoke，否则缓存里留下失效地址，切回会话时所有媒体一次性加载失败。
const ownedObjectUrls = new Set<string>()
let mediaLoadSeq = 0
let videoPlaySeq = 0

const videoAttachment = computed(() => {
  if (mediaKind.value !== 'video')
    return null
  return mediaAssets.value.find(asset =>
    (asset.kind ?? '').toLowerCase().includes('video')
    || (asset.contentType ?? '').toLowerCase().includes('video'),
  ) ?? null
})

const videoPosterAsset = computed(() => {
  if (mediaKind.value !== 'video')
    return null
  const available = mediaAssets.value.filter(asset =>
    asset.state === 'available' && Boolean(asset.contentUrl?.trim()),
  )
  const poster = available.find(asset => asset.variant === 'thumbnail')
    ?? available.find(asset => (asset.contentType ?? '').toLowerCase().startsWith('image/'))
  if (!poster)
    return null
  return { url: poster.contentUrl ?? poster.preview?.contentUrl ?? null }
})

// 完整视频已缓存时直接加载字节（本地读取，无网络成本）；未缓存的等点击播放。
const videoReadyAsset = computed(() => {
  if (mediaKind.value !== 'video')
    return null
  const asset = videoAsset.value
  return asset && asset.state === 'available' && Boolean(asset.contentUrl?.trim()) ? asset : null
})

function trackObjectUrl(url: string | null, previous: string | null, owned: boolean): void {
  if (previous && previous.startsWith('blob:') && ownedObjectUrls.has(previous)) {
    ownedObjectUrls.delete(previous)
    URL.revokeObjectURL(previous)
  }
  if (url && url.startsWith('blob:') && owned)
    ownedObjectUrls.add(url)
}

async function loadMediaObjectUrl(
  slot: { value: string | null },
  contentUrl: string | null | undefined,
  seq: number,
  cached = true,
): Promise<void> {
  try {
    // 常规媒体走带内存缓存的加载；完整视频字节大，直连不走缓存。
    const url = await (cached ? wechatApi.loadMediaCached(contentUrl) : wechatApi.loadMedia(contentUrl))
    if (seq !== mediaLoadSeq) {
      if (url && url.startsWith('blob:') && !cached)
        URL.revokeObjectURL(url)
      return
    }
    trackObjectUrl(url, slot.value, !cached)
    slot.value = url
  }
  catch {
    if (seq === mediaLoadSeq) {
      trackObjectUrl(null, slot.value, false)
      slot.value = null
    }
  }
}

watch(
  () => [
    imageAsset.value?.contentUrl,
    voiceAsset.value?.contentUrl,
    fileAsset.value?.contentUrl,
    videoPosterAsset.value?.url,
    videoReadyAsset.value?.contentUrl,
  ],
  ([image, voice, file, poster, readyVideo]) => {
    const seq = ++mediaLoadSeq
    void loadMediaObjectUrl(imageObjectUrl, image, seq)
    void loadMediaObjectUrl(voiceObjectUrl, voice, seq)
    void loadMediaObjectUrl(fileObjectUrl, file, seq)
    void loadMediaObjectUrl(videoPosterUrl, poster, seq)
    void loadMediaObjectUrl(videoObjectUrl, readyVideo, seq, false)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  mediaLoadSeq += 1
  videoPlaySeq += 1
  // 只释放本组件私有的 blob URL；共享缓存里的 URL 保持有效，
  // 供下一次进入会话时直接复用（由缓存 LRU 淘汰管理内存）。
  for (const url of ownedObjectUrls)
    URL.revokeObjectURL(url)
  ownedObjectUrls.clear()
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function isTerminalJobState(state: string | undefined): boolean {
  return state === 'available'
    || state === 'accepted'
    || state === 'needs_review'
    || state === 'cancelled'
    || state === 'expired'
    || state === 'unsupported'
    || state === 'failed'
}

/** 用户点击播放后才下载完整视频：请求 normal 下载并轮询任务，完成后取字节渲染播放器。 */
async function playVideo(): Promise<void> {
  if (videoPlayState.value === 'loading')
    return
  const accountId = props.account.id
  const messageId = props.message.id
  const seq = ++videoPlaySeq
  videoPlayState.value = 'loading'
  try {
    let contentUrl = videoAsset.value?.contentUrl?.trim() || null
    if (!contentUrl) {
      const job = await wechatApi.requestMediaTransfer(accountId, messageId, 'normal')
      const jobId = job.id?.trim()
      for (let attempt = 0; attempt < 75 && jobId; attempt++) {
        await sleep(800)
        if (seq !== videoPlaySeq)
          return
        const state = await wechatApi.getJob(accountId, jobId)
        if (isTerminalJobState(state.state))
          break
      }
      const fresh = await wechatApi.lookupMedia(accountId, [messageId])
      const assets = fresh[0]?.assets ?? []
      const normal = assets.find(asset =>
        asset.state === 'available'
        && Boolean(asset.contentUrl?.trim())
        && (asset.contentType ?? '').toLowerCase().includes('video'),
      ) ?? assets.find(asset =>
        asset.state === 'available'
        && Boolean(asset.contentUrl?.trim())
        && asset.variant !== 'thumbnail',
      )
      contentUrl = normal?.contentUrl?.trim() || null
    }
    if (!contentUrl)
      throw new Error('video_unavailable')
    const url = await wechatApi.loadMedia(contentUrl)
    if (seq !== videoPlaySeq) {
      if (url && url.startsWith('blob:'))
        URL.revokeObjectURL(url)
      return
    }
    trackObjectUrl(url, videoObjectUrl.value, true)
    videoObjectUrl.value = url
    videoPlayState.value = 'ready'
  }
  catch {
    if (seq === videoPlaySeq)
      videoPlayState.value = 'failed'
  }
}

const imageUrl = computed(() => imageObjectUrl.value)
const voiceUrl = computed(() => voiceObjectUrl.value)
const videoUrl = computed(() => videoObjectUrl.value)
const fileUrl = computed(() => fileObjectUrl.value)
const fileName = computed(() => fileAsset.value?.filename?.trim() || '文件')
const fileSize = computed(() => fileAsset.value?.byteLength ?? 0)

const mediaPlaceholder = computed(() => {
  switch (mediaKind.value) {
    case 'image':
      return props.message.type === 47 ? '[表情]' : '[图片]'
    case 'voice':
      return '[语音]'
    case 'video':
      return '[视频]'
    case 'file':
      return '[文件]'
    default:
      return ''
  }
})

const mediaStateLabel = computed(() => {
  switch (props.media?.state) {
    case 'pending':
      return '加载中'
    case 'expired':
      return '已过期'
    case 'unsupported':
      return '不支持'
    case 'missing':
      return props.media?.error ? '获取失败' : ''
    default:
      return ''
  }
})

const isVoice = computed(() => {
  return props.message.localMedia?.kind === 'voice' || mediaKind.value === 'voice'
})

const voiceSrc = computed(() => {
  if (props.message.localMedia?.kind === 'voice')
    return props.message.localMedia.url
  return voiceUrl.value
})

const voiceStateLabel = computed(() => {
  if (voiceSrc.value)
    return ''
  if (props.message.localMedia)
    return '无法读取语音'
  return mediaStateLabel.value || '语音暂不可用'
})

const imageSrc = computed(() => {
  if (props.message.localMedia?.kind === 'image')
    return props.message.localMedia.url
  return imageUrl.value
})

const isImage = computed(() => {
  return props.message.localMedia?.kind === 'image' || mediaKind.value === 'image'
})

// 纯图片消息直接用图片作为气泡；带引用/链接/位置时保留原气泡结构。
const isImageOnly = computed(() => {
  if (!isImage.value)
    return false
  return !quotePreview.value && !linkCard.value && !locationText.value
})

const imageStateLabel = computed(() => {
  if (imageSrc.value)
    return ''
  if (props.message.localMedia)
    return '无法读取图片'
  return mediaStateLabel.value || '图片暂不可用'
})

// 好友验证消息（type 37）：展示申请人、附言，并提示到手机微信处理。
const friendRequestCard = computed(() => props.message.friendRequest ?? null)

const friendRequestName = computed(() => {
  const request = friendRequestCard.value
  if (!request)
    return ''
  return request.fromNickname?.trim() || request.fromUsername?.trim() || ''
})

// 头像加载失败时回退到昵称首字母占位。
const friendRequestAvatarBroken = ref(false)

const friendRequestInitial = computed(() => {
  const name = friendRequestName.value || '?'
  return Array.from(name)[0]?.toUpperCase() ?? '?'
})

const showText = computed(() => {
  if (props.message.localMedia)
    return false
  if (mediaKind.value)
    return false
  if (friendRequestCard.value)
    return false
  // 链接卡片已展示标题/描述/地址，原始 body（[Link] 标题\n链接）不再重复显示。
  if (linkCard.value)
    return false
  const text = messageText(props.message).trim()
  if (!text)
    return false
  if (locationText.value && text === locationText.value)
    return false
  return true
})

// 消息正文切分为文本段与黄豆表情段（[表情名] → emoji）。
const bubbleSegments = computed(() => splitEmoticonSegments(messageText(props.message)))

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024)
    return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

const sendStatus = computed(() => {
  if (!props.message.local && !props.message.pending && !props.message.sendState)
    return ''
  if (props.message.sendError)
    return props.message.sendError
  switch (props.message.sendState) {
    case 'accepted':
      return ''
    case 'failed':
      return '发送失败'
    case 'needs_review':
      return '发送结果待确认'
    case 'cancelled':
      return '已取消'
    default:
      return '发送中'
  }
})
</script>

<template>
  <div v-if="system" class="system-row">
    <span class="system-text">{{ systemText }}</span>
  </div>

  <div v-else class="message-row" :class="{ own, 'group-start': isGroupStart, grouped: !isGroupStart }">
    <ThreadAvatar
      v-if="!own"
      class="message-avatar"
      :account-id="account.id"
      :name="senderName || '?'"
      :username="senderUsername"
      :size="34"
    />

    <div class="message-stack">
      <div v-if="isImageOnly" class="image-line" :class="{ own }">
        <img
          v-if="imageSrc"
          class="image-content"
          :class="{ pending: message.pending, error: Boolean(message.sendError) }"
          :src="imageSrc"
          alt=""
        >
        <span v-else class="image-placeholder" :class="{ own }">
          <Icon name="image" :size="16" />
          <span>{{ mediaPlaceholder }}{{ imageStateLabel ? ` · ${imageStateLabel}` : '' }}</span>
        </span>
        <div class="image-meta" :class="{ error: Boolean(message.sendError) }">
          <span v-if="sendStatus" class="send-status">{{ sendStatus }}</span>
          <span>{{ formatClock(message.createdAt) }}</span>
          <Icon v-if="own && !sendStatus" name="check" :size="12" class="read-check" />
        </div>
      </div>

      <div v-else-if="isVoice" class="voice-line" :class="{ own }">
        <div class="bubble voice-bubble" :class="{ own, pending: message.pending, error: Boolean(message.sendError), 'grouped-bubble': groupedBubble }">
          <div class="voice-row">
            <VoiceBubble
              :src="voiceSrc"
              :own="own"
              :state-label="voiceStateLabel"
            />
          </div>
          <div class="bubble-meta">
            <span v-if="sendStatus" class="send-status">{{ sendStatus }}</span>
            <span class="bubble-time">{{ formatClock(message.createdAt) }}</span>
            <Icon v-if="own && !sendStatus" name="check" :size="12" class="read-check" />
          </div>
        </div>
      </div>

      <div v-else class="bubble" :class="{ own, pending: message.pending, error: Boolean(message.sendError), 'grouped-bubble': groupedBubble }">
        <div v-if="message.localMedia" class="local-media">
          <img
            v-if="message.localMedia.kind === 'image' && message.localMedia.url"
            :src="message.localMedia.url"
            alt=""
          >
          <video
            v-else-if="message.localMedia.kind === 'video' && message.localMedia.url"
            :src="message.localMedia.url"
            controls
            preload="metadata"
          />
          <div v-else class="local-file">
            <span class="local-file-icon"><Icon name="paperclip" :size="16" /></span>
            <span class="local-file-meta">
              <span class="local-file-name">{{ message.localMedia.name }}</span>
              <span class="local-file-size">{{ sizeLabel(message.localMedia.size) }}</span>
            </span>
          </div>
        </div>

        <div v-else-if="mediaKind && mediaKind !== 'voice'" class="local-media server-media">
          <template v-if="mediaKind === 'image'">
            <img v-if="imageUrl" :src="imageUrl" alt="">
            <span v-else class="media-placeholder">
              <Icon name="image" :size="14" />
              {{ mediaPlaceholder }}{{ mediaStateLabel ? ` · ${mediaStateLabel}` : '' }}
            </span>
          </template>

          <template v-else-if="mediaKind === 'video'">
            <video v-if="videoUrl" :src="videoUrl" controls autoplay preload="metadata" />
            <button
              v-else-if="videoPosterUrl || videoAttachment"
              type="button"
              class="video-poster"
              :disabled="videoPlayState === 'loading'"
              :title="videoPlayState === 'failed' ? '加载失败，点击重试' : '点击播放视频'"
              @click="playVideo"
            >
              <img v-if="videoPosterUrl" :src="videoPosterUrl" alt="">
              <span class="video-poster-mask">
                <Icon name="video" :size="20" />
                <span class="video-poster-label">
                  {{ videoPlayState === 'loading'
                    ? '视频加载中…'
                    : videoPlayState === 'failed'
                      ? '加载失败，点击重试'
                      : '点击播放视频' }}
                </span>
              </span>
            </button>
            <span v-else class="media-placeholder">
              <Icon name="video" :size="14" />
              {{ mediaPlaceholder }}{{ mediaStateLabel ? ` · ${mediaStateLabel}` : '' }}
            </span>
          </template>

          <template v-else>
            <a v-if="fileUrl" class="local-file server-file" :href="fileUrl" :download="fileName">
              <span class="local-file-icon"><Icon name="paperclip" :size="16" /></span>
              <span class="local-file-meta">
                <span class="local-file-name">{{ fileName }}</span>
                <span v-if="fileSize > 0" class="local-file-size">{{ sizeLabel(fileSize) }}</span>
              </span>
            </a>
            <span v-else class="media-placeholder">
              <Icon name="paperclip" :size="14" />
              {{ mediaPlaceholder }}{{ mediaStateLabel ? ` · ${mediaStateLabel}` : '' }}
            </span>
          </template>
        </div>

        <div
          v-if="quotePreview || quoteSender"
          class="quote-block"
          :class="{ clickable: quoteLinkUrl }"
          :title="quoteLinkUrl ? '打开引用的链接' : undefined"
          @click="openQuoteLink"
        >
          <span class="quote-bar" />
          <span class="quote-main">
            <span v-if="quoteSender" class="quote-sender">{{ quoteSender }}</span>
            <span class="quote-text">
              <Icon v-if="quoteLinkUrl" name="link" :size="11" class="quote-link-icon" />
              {{ quotePreview }}
            </span>
          </span>
        </div>

        <div v-if="locationText" class="location-card">
          <span class="card-icon"><Icon name="pin" :size="15" /></span>
          <span class="card-body">
            <span class="card-title">{{ locationText }}</span>
            <span class="card-meta">位置</span>
          </span>
        </div>

        <div v-if="friendRequestCard" class="friend-request-card">
          <div class="fr-avatar" :class="{ fallback: !friendRequestCard.avatar || friendRequestAvatarBroken }">
            <img
              v-if="friendRequestCard.avatar && !friendRequestAvatarBroken"
              :src="friendRequestCard.avatar"
              alt=""
              referrerpolicy="no-referrer"
              @error="friendRequestAvatarBroken = true"
            >
            <span v-else class="fr-initial">{{ friendRequestInitial }}</span>
            <span class="fr-badge"><Icon name="plus" :size="10" :stroke-width="2.4" /></span>
          </div>
          <div class="fr-body">
            <span class="fr-name">{{ friendRequestName || '新的朋友' }}</span>
            <span class="fr-greeting">{{ friendRequestCard.greeting?.trim() || '请求添加你为朋友' }}</span>
          </div>
          <div class="fr-foot">
            <Icon name="contacts" :size="12" />
            <span>请在手机微信上通过此申请</span>
          </div>
        </div>

        <a
          v-if="linkCard"
          class="link-card"
          :href="linkCard.url ?? undefined"
          target="_blank"
          rel="noreferrer"
          @click.prevent="openLinkCard(linkCard)"
        >
          <span class="card-body">
            <span class="card-title">{{ linkCard.title || linkCard.url }}</span>
            <span v-if="linkCard.description" class="card-meta">{{ linkCard.description }}</span>
            <span v-if="linkCard.sourceName" class="card-source">{{ linkCard.sourceName }}</span>
          </span>
          <span class="card-icon"><Icon name="link" :size="15" /></span>
        </a>

        <p v-if="showText" class="bubble-text"><template v-for="(segment, index) in bubbleSegments" :key="index"><span v-if="segment.kind === 'emoticon'" class="emoticon">{{ segment.value }}</span><template v-else>{{ segment.value }}</template></template></p>

        <div class="bubble-meta">
          <span v-if="sendStatus" class="send-status">{{ sendStatus }}</span>
          <span class="bubble-time">{{ formatClock(message.createdAt) }}</span>
          <Icon v-if="own && !sendStatus" name="check" :size="12" class="read-check" />
        </div>
      </div>

      <button
        v-if="canReply"
        type="button"
        class="reply-action"
        title="引用回复"
        @click="emit('reply')"
      >
        <Icon name="reply" :size="13" />
      </button>
    </div>

    <ThreadAvatar
      v-if="own"
      class="message-avatar"
      :account-id="account.id"
      :name="ownAvatarName"
      :username="account.ownUsername"
      :size="34"
    />
  </div>
</template>

<style scoped>
.message-row {
  display: flex;
  align-items: flex-end;
  gap: 9px;
  padding: 2px 0;
}

.message-row.group-start {
  padding-top: 9px;
}

.message-row.own {
  justify-content: flex-end;
}

.message-avatar {
  margin-bottom: 2px;
}

.message-stack {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: min(70%, 620px);
  gap: 3px;
}

.reply-action {
  position: absolute;
  top: -4px;
  right: -30px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: var(--muted);
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;
}

.message-row:hover .reply-action {
  opacity: 1;
}

.reply-action:hover {
  color: var(--accent);
  background: var(--panel-hover);
}

.message-row.own .reply-action {
  right: auto;
  left: -30px;
}

.message-row.own .message-stack {
  align-items: flex-end;
}

.bubble {
  position: relative;
  padding: 8px 12px 6px;
  border-radius: 17px 17px 17px 6px;
  background: var(--bubble-in-bg);
  color: var(--bubble-in-text, var(--text));
  box-shadow: var(--bubble-shadow);
}

.bubble.own {
  border-radius: 17px 17px 6px 17px;
  background: var(--bubble-out);
  color: var(--bubble-out-text, #fff);
  box-shadow: var(--bubble-out-shadow);
}

.bubble.grouped-bubble,
.bubble.own.grouped-bubble {
  border-radius: 17px;
}

.image-line {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  max-width: 100%;
}

.image-line.own {
  align-items: flex-end;
}

.image-content {
  display: block;
  width: auto;
  max-width: min(320px, 100%);
  max-height: 360px;
  border-radius: 14px;
  object-fit: contain;
  background: var(--panel-soft);
  box-shadow: var(--media-shadow);
}

.image-content.pending {
  opacity: 0.72;
}

.image-content.error {
  box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.55), var(--media-shadow);
}

.image-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 220px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--bubble-in);
  color: var(--text-soft);
  font-size: 12px;
  line-height: 1.4;
}

.image-placeholder.own {
  background: var(--bubble-out-surface);
  color: var(--bubble-out-text);
}

.image-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted-soft);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.image-meta.error .send-status {
  color: var(--danger-text);
}

.bubble.pending {
  opacity: 0.72;
}

.bubble.error {
  box-shadow: inset 0 0 0 1px rgba(248, 113, 113, 0.5);
}

.bubble-text {
  margin: 0;
  font-size: var(--bubble-font-size, 13.5px);
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.bubble-text .emoticon {
  font-size: 1.4em;
  line-height: 1;
  vertical-align: -0.18em;
}

.voice-line {
  display: flex;
  align-items: center;
  max-width: 100%;
}

.voice-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 1px 0 3px;
}

.voice-bubble {
  min-width: 104px;
  padding: 8px 12px 5px;
}

.local-media {
  margin: 1px 0 3px;
}

.local-media img,
.local-media video {
  display: block;
  max-width: min(320px, 100%);
  max-height: 320px;
  border-radius: 10px;
  object-fit: contain;
  background: var(--panel-soft);
}

.local-file {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 180px;
  padding: 8px 10px;
  border-radius: 9px;
  background: var(--bubble-in-surface);
}

.local-file-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border-radius: 8px;
  background: var(--bubble-in-surface);
}

.local-file-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 1px;
}

.local-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.local-file-size {
  font-size: 10px;
  opacity: 0.68;
}

.server-media {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.media-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border-radius: 9px;
  background: var(--bubble-in-surface);
  font-size: 11.5px;
  line-height: 1.4;
  opacity: 0.86;
}

.video-poster {
  position: relative;
  display: block;
  max-width: min(320px, 100%);
  padding: 0;
  border: none;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  background: var(--bubble-in-surface);
}

.video-poster:disabled {
  cursor: progress;
}

.video-poster img {
  display: block;
  max-width: 100%;
  max-height: 240px;
}

.video-poster-mask {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  color: #fff;
  background: rgba(0, 0, 0, 0.32);
  transition: background 0.15s ease;
}

.video-poster:hover .video-poster-mask {
  background: rgba(0, 0, 0, 0.45);
}

.video-poster-label {
  font-size: 11px;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}

.bubble.own .media-placeholder {
  background: var(--bubble-out-surface-strong);
}

.bubble.own .local-file,
.bubble.own .local-file-icon,
.bubble.own .quote-block,
.bubble.own .link-card,
.bubble.own .card-icon,
.bubble.own .location-card {
  background: var(--bubble-out-surface);
}

.bubble.own .server-file:hover,
.bubble.own .link-card:hover {
  background: var(--bubble-out-surface-strong);
}

.server-file {
  color: inherit;
  text-decoration: none;
}

.server-file:hover {
  background: var(--bubble-in-surface-strong);
}

.bubble-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  margin-top: 3px;
  color: var(--bubble-in-meta);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.bubble.own .bubble-meta {
  color: var(--bubble-out-meta);
}

.send-status {
  margin-right: 2px;
}

.bubble.error .send-status {
  color: var(--bubble-in-danger, var(--danger-text));
}

.bubble.own.error .send-status {
  color: var(--bubble-out-danger);
}

.read-check {
  opacity: 0.8;
}

.quote-block {
  display: flex;
  gap: 7px;
  margin: 1px 0 6px;
  padding: 6px 8px;
  border-radius: 9px;
  background: var(--bubble-in-surface);
}

.quote-bar {
  flex: 0 0 auto;
  width: 2px;
  align-self: stretch;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.4;
}

.quote-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.quote-sender {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.66;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.quote-text {
  font-size: 11.5px;
  line-height: 1.45;
  opacity: 0.82;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.quote-block.clickable {
  cursor: pointer;
  transition: background 0.15s ease;
}

.quote-block.clickable:hover {
  background: var(--bubble-in-surface-strong);
}

.quote-link-icon {
  flex: 0 0 auto;
  vertical-align: -1px;
  margin-right: 3px;
  opacity: 0.8;
}

.link-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 2px 0 6px;
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--bubble-in-surface);
  color: inherit;
  text-decoration: none;
}

.link-card:hover {
  background: var(--bubble-in-surface-strong);
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.card-title {
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.card-meta {
  font-size: 11px;
  line-height: 1.4;
  opacity: 0.72;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.card-source {
  font-size: 10.5px;
  opacity: 0.6;
}

.card-icon {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--bubble-in-surface);
  opacity: 0.9;
}

.location-card {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 2px 0 6px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--bubble-in-surface);
}

.friend-request-card {
  display: grid;
  grid-template-columns: 42px 1fr;
  grid-template-rows: auto auto;
  column-gap: 10px;
  width: 256px;
  margin: 2px 0 6px;
  padding: 12px 12px 0;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
  border-radius: 12px;
  background:
    linear-gradient(
      150deg,
      color-mix(in srgb, var(--accent) 8%, transparent),
      transparent 46%
    ),
    var(--bubble-in-surface);
  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.16);
}

.fr-avatar {
  position: relative;
  grid-column: 1;
  grid-row: 1;
  width: 42px;
  height: 42px;
}

.fr-avatar img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  background: var(--panel-soft);
}

.fr-initial {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: linear-gradient(140deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #fff));
  color: #fff;
  font-size: 16px;
  font-weight: 600;
}

.fr-badge {
  position: absolute;
  right: -1px;
  bottom: -1px;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  box-shadow: 0 0 0 2px var(--bubble-in-bg, var(--bubble-in-surface));
}

.fr-body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
}

.fr-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}

.fr-greeting {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-soft);
  opacity: 0.88;
}

.fr-foot {
  display: flex;
  align-items: center;
  gap: 5px;
  grid-column: 1 / -1;
  grid-row: 2;
  margin-top: 10px;
  padding: 7px 0 9px;
  border-top: 1px dashed color-mix(in srgb, currentColor 16%, transparent);
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.3;
  opacity: 0.82;
}

.system-row {
  display: flex;
  justify-content: center;
  padding: 6px 0;
}

.system-text {
  max-width: 72%;
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.1);
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
  text-align: center;
}
</style>
