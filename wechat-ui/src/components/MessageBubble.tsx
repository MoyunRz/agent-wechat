// One timeline bubble. The Vue component's props become props and its emits
// become callbacks; every type it rendered is kept: text with emoticons, images,
// video, voice, files, quote blocks, link and location cards, friend request
// cards, group sender labels, send state and the media placeholder states.

import { Fragment, useEffect, useRef, useState } from 'react'
import { wechatApi } from '../api'
import { splitEmoticonSegments } from '../emoticons'
import { formatClock, isOwnMessage, messageText, messageTypeLabel, threadName } from '../format'
import { useT } from '../i18n/useT'
import type {
  AccountSummary,
  LinkCard,
  LocalMessage,
  MediaAsset,
  MessageMedia,
  Thread,
} from '../types'
import Icon from './Icon'
import ThreadAvatar from './ThreadAvatar'
import VoiceBubble from './VoiceBubble'
import '../styles/components/messages.css'

// Version placeholder WeChat puts in some forwarded card titles; the real title
// then lives in the description field.
const LINK_TITLE_PLACEHOLDER = '当前微信版本不支持展示该内容，请升级至最新版本。'

type MediaRenderKind = 'image' | 'voice' | 'video' | 'file'

/** Object-URL slots of one bubble: image, voice, file, video poster and video. */
type MediaSlot = 'image' | 'voice' | 'file' | 'poster' | 'video'

type GroupPosition = 'single' | 'first' | 'middle' | 'last'

export type MessageBubbleProps = {
  message: LocalMessage
  thread: Thread
  account: AccountSummary
  media?: MessageMedia | null
  groupPosition?: GroupPosition
  /** Flash class applied by the list after a jump to this message. */
  className?: string
  /** Target of the list's jump-to-message lookup (the Vue fallthrough attribute). */
  dataMid?: string
  onReply?: () => void
  onPreview?: (src: string) => void
}

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

/** Picks the best available asset of one render kind, like the Vue computed. */
function pickAsset(assets: MediaAsset[], kind: MediaRenderKind): MediaAsset | null {
  const available = assets
    .filter(asset => asset.state === 'available' && Boolean(asset.contentUrl?.trim()))
    .slice()
    .sort((a, b) => assetRank(a) - assetRank(b))
  if (available.length === 0)
    return null

  const matched = available.filter(asset => assetMatches(asset, kind))
  if (matched.length > 0)
    return matched[0]

  // The upstream may omit kind/contentType; a single generic asset still works.
  const generic = available.filter(asset => !asset.kind && !asset.contentType)
  return generic[0] ?? null
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

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024)
    return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

export default function MessageBubble({
  message,
  thread,
  account,
  media = null,
  groupPosition = 'single',
  className,
  dataMid,
  onReply,
  onPreview,
}: MessageBubbleProps) {
  const t = useT()

  const own = isOwnMessage(message)
  const isGroup = thread.kind === 'group'
  const isGroupStart = groupPosition === 'single' || groupPosition === 'first'
  const groupedBubble = groupPosition === 'first' || groupPosition === 'middle'
  const friendRequestCard = message.friendRequest ?? null

  // A type 37 copy without the request XML (the outgoing direction) has nothing
  // to parse, so it renders as a system notice.
  const system = message.type === 10000
    || (message.type === 37 && !message.friendRequest)
    || (!message.senderId && !message.direction)

  const baseText = messageText(message)
  // The body is content; only the type label fallback is translated.
  const displayText = message.body?.trim()
    ? baseText
    : t(messageTypeLabel(message.type, message.appMessageType))
  const systemText = message.type === 37 && !message.friendRequest
    ? t('已发出好友申请，等待对方通过')
    : displayText

  const senderName = (() => {
    if (!isGroup)
      return t(threadName(thread))
    const senderId = message.senderId
    if (!senderId)
      return t('群成员')
    const member = thread.avatarMembers?.find(item => item.id === senderId)
    return member?.displayName || senderId
  })()
  const senderUsername = isGroup ? message.senderId : thread.peerId
  const ownAvatarName = account.ownUsername?.trim() || t('我')

  const quoteSender = message.quote?.senderName?.trim() ?? ''

  /** Quoted content preview: a link quote shows its title, the rest a label. */
  const quotePreview = (() => {
    const quote = message.quote
    if (!quote)
      return ''
    const linkTitle = quote.embeddedLink?.title?.trim() ?? ''
    if (linkTitle)
      return linkTitle
    const raw = quote.embeddedText?.trim() ?? ''
    if (raw.startsWith('[Link]')) {
      // No embeddedLink metadata: strip the daemon's [Link] prefix and keep the
      // first line, which is the title.
      return raw.replace(/^\[Link\]\s*/, '').split('\n')[0]?.trim() || raw
    }
    if (raw)
      return raw
    if (quote.embeddedImage)
      return t('[图片]')
    switch (quote.type) {
      case 34:
        return t('[语音]')
      case 43:
        return t('[视频]')
      case 47:
        return t('[表情]')
      case 49:
        return quote.embeddedLink?.url ? t('[链接]') : t('[卡片]')
      default:
        return ''
    }
  })()

  const quoteLinkUrl = message.quote?.embeddedLink?.url?.trim() ?? ''

  async function openExternalLink(url: string): Promise<void> {
    try {
      await wechatApi.openExternalUrl(url)
    }
    catch {
      // Fall back to the embedded browser when the backend is unavailable.
      window.open(url, '_blank', 'noopener')
    }
  }

  function openQuoteLink(): void {
    if (!quoteLinkUrl)
      return
    void openExternalLink(quoteLinkUrl)
  }

  // Official accounts (gh_) and OpenIM customer service need no friendship.
  const isOfficialPeer = (() => {
    const peer = (thread.peerId || thread.id).trim()
    return peer.startsWith('gh_') || peer.endsWith('@openim')
  })()

  const linkCard = (() => {
    const link = message.link
    if (!link)
      return null
    const title = link.title?.trim() ?? ''
    const description = link.description?.trim() ?? ''
    if (!title && !description && !link.url?.trim())
      return null
    // Some forwarded cards put the real title in the description and a version
    // placeholder in the title: show them swapped.
    let card = link
    if (title === LINK_TITLE_PLACEHOLDER && description)
      card = { ...link, title: description, description: '' }
    // Article cards without a source name borrow the conversation title so the
    // card looks like the WeChat original.
    const sourceName = card.sourceName?.trim()
      || (isOfficialPeer ? t(threadName(thread)) : '')
    if (sourceName && sourceName !== (card.sourceName ?? ''))
      card = { ...card, sourceName }
    return card
  })()

  async function openLinkCard(link: LinkCard): Promise<void> {
    const url = link.url?.trim()
    if (!url)
      return
    await openExternalLink(url)
  }

  const locationText = (() => {
    const location = message.location
    if (!location)
      return ''
    return [location.name, location.address].filter(Boolean).join(' · ')
      || `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
  })()

  const mediaKind: MediaRenderKind | null = (() => {
    if (message.localMedia)
      return null
    switch (message.type) {
      case 3:
      case 47:
        return 'image'
      case 34:
        return 'voice'
      case 43:
        return 'video'
      case 49:
        return message.appMessageType === 6 ? 'file' : null
      default:
        return null
    }
  })()

  const mediaAssets = media?.assets ?? []
  const imageAsset = mediaKind === 'image' ? pickAsset(mediaAssets, 'image') : null
  const voiceAsset = mediaKind === 'voice' ? pickAsset(mediaAssets, 'voice') : null
  const videoAsset = mediaKind === 'video' ? pickAsset(mediaAssets, 'video') : null
  const fileAsset = mediaKind === 'file' ? pickAsset(mediaAssets, 'file') : null

  const videoAttachment = mediaKind === 'video'
    ? (mediaAssets.find(asset =>
      (asset.kind ?? '').toLowerCase().includes('video')
      || (asset.contentType ?? '').toLowerCase().includes('video'),
    ) ?? null)
    : null

  const videoPosterAsset = (() => {
    if (mediaKind !== 'video')
      return null
    const available = mediaAssets.filter(asset =>
      asset.state === 'available' && Boolean(asset.contentUrl?.trim()),
    )
    const poster = available.find(asset => asset.variant === 'thumbnail')
      ?? available.find(asset => (asset.contentType ?? '').toLowerCase().startsWith('image/'))
    if (!poster)
      return null
    return { url: poster.contentUrl ?? poster.preview?.contentUrl ?? null }
  })()

  // A fully cached video loads its bytes without a network cost; an uncached one
  // waits for the play button.
  const videoReadyAsset = (() => {
    if (mediaKind !== 'video')
      return null
    return videoAsset && videoAsset.state === 'available' && Boolean(videoAsset.contentUrl?.trim())
      ? videoAsset
      : null
  })()

  const ownedObjectUrls = useRef<Set<string>>(new Set())
  const mediaLoadSeq = useRef(0)
  const videoPlaySeq = useRef(0)
  const slotsRef = useRef<Record<MediaSlot, string | null>>({
    image: null,
    voice: null,
    file: null,
    poster: null,
    video: null,
  })
  const [slots, setSlots] = useState<Record<MediaSlot, string | null>>(slotsRef.current)
  const [videoPlayState, setVideoPlayState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')

  /**
   * Blob URLs this component created itself are revoked when replaced or
   * unmounted. Shared-cache URLs (loadMediaCached) belong to the cache and must
   * never be revoked here.
   */
  function setSlotUrl(slot: MediaSlot, next: string | null, owned: boolean): void {
    const previous = slotsRef.current[slot]
    if (previous && previous !== next && previous.startsWith('blob:') && ownedObjectUrls.current.has(previous)) {
      ownedObjectUrls.current.delete(previous)
      URL.revokeObjectURL(previous)
    }
    if (next && next.startsWith('blob:') && owned)
      ownedObjectUrls.current.add(next)
    if (previous === next)
      return
    const updated = { ...slotsRef.current, [slot]: next }
    slotsRef.current = updated
    setSlots(updated)
  }

  async function loadMediaObjectUrl(
    slot: MediaSlot,
    contentUrl: string | null | undefined,
    seq: number,
    cached = true,
  ): Promise<void> {
    try {
      // Regular media go through the memory cache; full video bytes are large
      // and load directly.
      const url = await (cached ? wechatApi.loadMediaCached(contentUrl) : wechatApi.loadMedia(contentUrl))
      if (seq !== mediaLoadSeq.current) {
        if (url && url.startsWith('blob:') && !cached)
          URL.revokeObjectURL(url)
        return
      }
      setSlotUrl(slot, url, !cached)
    }
    catch {
      if (seq === mediaLoadSeq.current)
        setSlotUrl(slot, null, false)
    }
  }

  const imageContentUrl = imageAsset?.contentUrl
  const voiceContentUrl = voiceAsset?.contentUrl
  const fileContentUrl = fileAsset?.contentUrl
  const posterContentUrl = videoPosterAsset?.url
  const readyVideoContentUrl = videoReadyAsset?.contentUrl

  useEffect(() => {
    const seq = ++mediaLoadSeq.current
    void loadMediaObjectUrl('image', imageContentUrl, seq)
    void loadMediaObjectUrl('voice', voiceContentUrl, seq)
    void loadMediaObjectUrl('file', fileContentUrl, seq)
    void loadMediaObjectUrl('poster', posterContentUrl, seq)
    void loadMediaObjectUrl('video', readyVideoContentUrl, seq, false)
    // The Vue watcher tracked exactly these five source URLs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageContentUrl, voiceContentUrl, fileContentUrl, posterContentUrl, readyVideoContentUrl])

  useEffect(() => () => {
    mediaLoadSeq.current += 1
    videoPlaySeq.current += 1
    // Only this component's own blob URLs are released; shared-cache URLs stay
    // valid for the next visit (the cache LRU manages its memory).
    for (const url of ownedObjectUrls.current)
      URL.revokeObjectURL(url)
    ownedObjectUrls.current.clear()
  }, [])

  /** Downloads the full video after a click: request a normal transfer, poll the
   *  job, then fetch the bytes for the player. */
  async function playVideo(): Promise<void> {
    if (videoPlayState === 'loading')
      return
    const accountId = account.id
    const messageId = message.id
    const seq = ++videoPlaySeq.current
    setVideoPlayState('loading')
    try {
      let contentUrl = videoAsset?.contentUrl?.trim() || null
      if (!contentUrl) {
        const job = await wechatApi.requestMediaTransfer(accountId, messageId, 'normal')
        const jobId = job.id?.trim()
        for (let attempt = 0; attempt < 75 && jobId; attempt++) {
          await sleep(800)
          if (seq !== videoPlaySeq.current)
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
      if (seq !== videoPlaySeq.current) {
        if (url && url.startsWith('blob:'))
          URL.revokeObjectURL(url)
        return
      }
      setSlotUrl('video', url, true)
      setVideoPlayState('ready')
    }
    catch {
      if (seq === videoPlaySeq.current)
        setVideoPlayState('failed')
    }
  }

  const imageObjectUrl = slots.image
  const voiceObjectUrl = slots.voice
  const videoObjectUrl = slots.video
  const fileObjectUrl = slots.file
  const videoPosterUrl = slots.poster

  const fileName = fileAsset?.filename?.trim() || t('文件')
  const fileSize = fileAsset?.byteLength ?? 0

  const mediaPlaceholder = (() => {
    switch (mediaKind) {
      case 'image':
        return message.type === 47 ? t('[表情]') : t('[图片]')
      case 'voice':
        return t('[语音]')
      case 'video':
        return t('[视频]')
      case 'file':
        return t('[文件]')
      default:
        return ''
    }
  })()

  const mediaStateLabel = (() => {
    switch (media?.state) {
      case 'pending':
        return t('加载中')
      case 'expired':
        return t('已过期')
      case 'unsupported':
        return t('不支持')
      case 'missing':
        return media?.error ? t('获取失败') : ''
      default:
        return ''
    }
  })()

  const isVoice = message.localMedia?.kind === 'voice' || mediaKind === 'voice'
  const voiceSrc = message.localMedia?.kind === 'voice'
    ? message.localMedia.url
    : voiceObjectUrl
  const voiceStateLabel = voiceSrc
    ? ''
    : message.localMedia
      ? t('无法读取语音')
      : mediaStateLabel || t('语音暂不可用')

  const isImage = message.localMedia?.kind === 'image' || mediaKind === 'image'
  const imageSrc = message.localMedia?.kind === 'image'
    ? message.localMedia.url
    : imageObjectUrl
  const imageStateLabel = imageSrc
    ? ''
    : message.localMedia
      ? t('无法读取图片')
      : mediaStateLabel || t('图片暂不可用')

  // A pure image message uses the image as the bubble; a quote, link or
  // location keeps the regular bubble structure.
  const isImageOnly = isImage && !quotePreview && !linkCard && !locationText

  // While the media is in flight the placeholder square shows a spinner.
  const isImageLoading = !imageSrc && media?.state === 'pending'

  const canReply = Boolean(message.serverId?.trim())

  function previewImage(src: string | null | undefined): void {
    if (message.type !== 47 && src)
      onPreview?.(src)
  }

  const friendRequestName = friendRequestCard
    ? (friendRequestCard.fromNickname?.trim() || friendRequestCard.fromUsername?.trim() || '')
    : ''
  // The server status wins; accepting or declining updates the card immediately
  // so the whole list does not have to reload.
  const friendRequestStatus = friendRequestCard?.status ?? 'pending'
  const [friendRequestLocalStatus, setFriendRequestLocalStatus] = useState<'pending' | 'accepted' | 'declined' | null>(null)
  const friendRequestEffectiveStatus = friendRequestLocalStatus ?? friendRequestStatus
  const [friendRequestProcessing, setFriendRequestProcessing] = useState(false)
  const [friendRequestError, setFriendRequestError] = useState('')

  async function actOnCard(action: 'accept' | 'decline'): Promise<void> {
    if (!friendRequestCard?.fromUsername?.trim() || friendRequestProcessing)
      return
    setFriendRequestProcessing(true)
    setFriendRequestError('')
    const failing = action === 'accept'
      ? t('未成功，请稍后在通讯录里重试。')
      : t('拒绝失败，请稍后重试。')
    try {
      let operation = action === 'accept'
        ? await wechatApi.acceptFriendRequest(account.id, friendRequestCard.fromUsername)
        : await wechatApi.declineFriendRequest(account.id, friendRequestCard.fromUsername)
      for (let attempt = 0; attempt < 20; attempt++) {
        if (['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.state))
          break
        await sleep(1000)
        operation = await wechatApi.getOperation(account.id, operation.id)
      }
      if (operation.state === 'succeeded')
        setFriendRequestLocalStatus(action === 'accept' ? 'accepted' : 'declined')
      else
        setFriendRequestError(failing)
    }
    catch {
      setFriendRequestError(t('操作失败，请稍后重试。'))
    }
    finally {
      setFriendRequestProcessing(false)
    }
  }

  const showText = (() => {
    if (message.localMedia)
      return false
    if (mediaKind)
      return false
    if (friendRequestCard)
      return false
    // The link card already shows title/description/address, so the raw body
    // ([Link] title + URL) is not repeated.
    if (linkCard)
      return false
    const text = baseText.trim()
    if (!text)
      return false
    if (locationText && text === locationText)
      return false
    return true
  })()

  // The body splits into text runs and emoji runs ([emoticon name] -> emoji).
  const bubbleSegments = splitEmoticonSegments(displayText)

  const sendStatus = (() => {
    if (!message.local && !message.pending && !message.sendState)
      return ''
    if (message.sendError)
      return message.sendError
    switch (message.sendState) {
      case 'accepted':
        return ''
      case 'failed':
        return t('发送失败')
      case 'needs_review':
        return t('发送结果待确认')
      case 'cancelled':
        return t('已取消')
      default:
        return t('发送中')
    }
  })()

  const rowClassName = [
    'message-row',
    own ? 'own' : '',
    isGroupStart ? 'group-start' : 'grouped',
    className,
  ].filter(Boolean).join(' ')

  if (system) {
    return (
      <div className={className ? `system-row ${className}` : 'system-row'} data-mid={dataMid}>
        <span className="system-text">{systemText}</span>
      </div>
    )
  }

  const bubbleClassName = [
    'bubble',
    own ? 'own' : '',
    message.pending ? 'pending' : '',
    message.sendError ? 'error' : '',
    groupedBubble ? 'grouped-bubble' : '',
  ].filter(Boolean).join(' ')

  const meta = (
    <div className="bubble-meta">
      {sendStatus ? <span className="send-status">{sendStatus}</span> : null}
      <span className="bubble-time">{formatClock(message.createdAt)}</span>
      {own && !sendStatus ? <Icon name="check" size={12} className="read-check" /> : null}
    </div>
  )

  const mediaPlaceholderTitle = `${mediaPlaceholder}${mediaStateLabel ? ` · ${mediaStateLabel}` : ''}`

  return (
    <div
      className={rowClassName}
      data-mid={dataMid}
    >
      {!own && (
        <ThreadAvatar
          className="message-avatar"
          accountId={account.id}
          name={senderName || '?'}
          username={senderUsername}
          size={34}
        />
      )}

      <div className="message-stack">
        {isImageOnly
          ? (
            <div className={own ? 'image-line own' : 'image-line'}>
              {imageSrc
                ? (
                  <img
                    className={[
                      'image-content',
                      message.pending ? 'pending' : '',
                      message.sendError ? 'error' : '',
                      message.type !== 47 ? 'clickable' : '',
                    ].filter(Boolean).join(' ')}
                    src={imageSrc}
                    alt=""
                    onClick={() => previewImage(imageSrc)}
                  />
                )
                : isImageLoading
                  ? (
                    <span className="image-loading-box">
                      <span className="image-spinner" />
                    </span>
                  )
                  : (
                    <span
                      className="image-placeholder"
                      title={`${mediaPlaceholder}${imageStateLabel ? ` · ${imageStateLabel}` : ''}`}
                    >
                      <Icon name="image" size={20} />
                    </span>
                  )}
              <div className={message.sendError ? 'image-meta error' : 'image-meta'}>
                {sendStatus ? <span className="send-status">{sendStatus}</span> : null}
                <span>{formatClock(message.createdAt)}</span>
                {own && !sendStatus ? <Icon name="check" size={12} className="read-check" /> : null}
              </div>
            </div>
          )
          : isVoice
            ? (
              <div className={own ? 'voice-line own' : 'voice-line'}>
                <div className={['bubble', 'voice-bubble', own ? 'own' : '', message.pending ? 'pending' : '', message.sendError ? 'error' : '', groupedBubble ? 'grouped-bubble' : ''].filter(Boolean).join(' ')}>
                  <div className="voice-row">
                    <VoiceBubble
                      src={voiceSrc}
                      own={own}
                      stateLabel={voiceStateLabel}
                    />
                  </div>
                  {meta}
                </div>
              </div>
            )
            : (
              <div className={bubbleClassName}>
                {message.localMedia
                  ? (
                    <div className="local-media">
                      {message.localMedia.kind === 'image' && message.localMedia.url
                        ? <img src={message.localMedia.url} alt="" />
                        : message.localMedia.kind === 'video' && message.localMedia.url
                          ? <video src={message.localMedia.url} controls preload="metadata" />
                          : (
                            <div className="local-file">
                              <span className="local-file-icon"><Icon name="paperclip" size={16} /></span>
                              <span className="local-file-meta">
                                <span className="local-file-name">{message.localMedia.name}</span>
                                <span className="local-file-size">{sizeLabel(message.localMedia.size)}</span>
                              </span>
                            </div>
                          )}
                    </div>
                  )
                  : null}

                {!message.localMedia && mediaKind
                  ? (
                    <div className="local-media server-media">
                      {mediaKind === 'image'
                        ? (
                          <>
                            {imageObjectUrl
                              ? (
                                <img
                                  src={imageObjectUrl}
                                  alt=""
                                  className="image-content clickable"
                                  onClick={() => previewImage(imageObjectUrl)}
                                />
                              )
                              : isImageLoading
                                ? (
                                  <span className="image-loading-box">
                                    <span className="image-spinner" />
                                  </span>
                                )
                                : (
                                  <span className="image-placeholder" title={mediaPlaceholderTitle}>
                                    <Icon name="image" size={20} />
                                  </span>
                                )}
                          </>
                        )
                        : mediaKind === 'video'
                          ? (
                            <>
                              {videoObjectUrl
                                ? <video src={videoObjectUrl} controls autoPlay preload="metadata" />
                                : videoPosterUrl || videoAttachment
                                  ? (
                                    <button
                                      type="button"
                                      className="video-poster"
                                      disabled={videoPlayState === 'loading'}
                                      title={videoPlayState === 'failed' ? t('加载失败，点击重试') : t('点击播放视频')}
                                      onClick={() => void playVideo()}
                                    >
                                      {videoPosterUrl ? <img src={videoPosterUrl} alt="" /> : null}
                                      <span className="video-poster-mask">
                                        <Icon name="video" size={20} />
                                        <span className="video-poster-label">
                                          {videoPlayState === 'loading'
                                            ? t('视频加载中…')
                                            : videoPlayState === 'failed'
                                              ? t('加载失败，点击重试')
                                              : t('点击播放视频')}
                                        </span>
                                      </span>
                                    </button>
                                  )
                                  : (
                                    <span className="media-placeholder">
                                      <Icon name="video" size={14} />
                                      {mediaPlaceholder}
                                      {mediaStateLabel ? ` · ${mediaStateLabel}` : ''}
                                    </span>
                                  )}
                            </>
                          )
                          : (
                            <>
                              {fileObjectUrl
                                ? (
                                  <a className="local-file server-file" href={fileObjectUrl} download={fileName}>
                                    <span className="local-file-icon"><Icon name="paperclip" size={16} /></span>
                                    <span className="local-file-meta">
                                      <span className="local-file-name">{fileName}</span>
                                      {fileSize > 0
                                        ? <span className="local-file-size">{sizeLabel(fileSize)}</span>
                                        : null}
                                    </span>
                                  </a>
                                )
                                : (
                                  <span className="media-placeholder">
                                    <Icon name="paperclip" size={14} />
                                    {mediaPlaceholder}
                                    {mediaStateLabel ? ` · ${mediaStateLabel}` : ''}
                                  </span>
                                )}
                            </>
                          )}
                    </div>
                  )
                  : null}

                {quotePreview || quoteSender
                  ? (
                    <div
                      className={quoteLinkUrl ? 'quote-block clickable' : 'quote-block'}
                      title={quoteLinkUrl ? t('打开引用的链接') : undefined}
                      onClick={openQuoteLink}
                    >
                      <span className="quote-bar" />
                      <span className="quote-main">
                        {quoteSender ? <span className="quote-sender">{quoteSender}</span> : null}
                        <span className="quote-text">
                          {quoteLinkUrl ? <Icon name="link" size={11} className="quote-link-icon" /> : null}
                          {quotePreview}
                        </span>
                      </span>
                    </div>
                  )
                  : null}

                {locationText
                  ? (
                    <div className="location-card">
                      <span className="card-icon"><Icon name="pin" size={15} /></span>
                      <span className="card-body">
                        <span className="card-title">{locationText}</span>
                        <span className="card-meta">{t('位置')}</span>
                      </span>
                    </div>
                  )
                  : null}

                {friendRequestCard
                  ? (
                    <div className="friend-request-card">
                      <div className="fr-avatar">
                        <ThreadAvatar
                          accountId={account.id}
                          name={friendRequestName || t('新的朋友')}
                          username={friendRequestCard.fromUsername || friendRequestName || 'new-friend'}
                          imageUrl={friendRequestCard.avatar ?? null}
                          size={42}
                        />
                        <span className="fr-badge"><Icon name="plus" size={10} strokeWidth={2.4} /></span>
                      </div>
                      <div className="fr-body">
                        <span className="fr-name">{friendRequestName || t('新的朋友')}</span>
                        <span className="fr-greeting">{friendRequestCard.greeting?.trim() || t('请求添加你为朋友')}</span>
                      </div>
                      <div className={[
                        'fr-foot',
                        friendRequestEffectiveStatus === 'accepted' ? 'fr-state-ok' : '',
                        friendRequestEffectiveStatus === 'declined' ? 'fr-state-no' : '',
                      ].filter(Boolean).join(' ')}>
                        {friendRequestEffectiveStatus === 'accepted'
                          ? (
                            <>
                              <Icon name="check" size={12} />
                              <span>{t('已添加')}</span>
                            </>
                          )
                          : friendRequestEffectiveStatus === 'declined'
                            ? <span>{t('已拒绝')}</span>
                            : friendRequestCard.scene == null
                              ? <span className="fr-note">{t('缺少来源信息，请在手机上处理')}</span>
                              : (
                                <>
                                  <button
                                    type="button"
                                    className="fr-accept"
                                    disabled={friendRequestProcessing}
                                    onClick={() => void actOnCard('accept')}
                                  >
                                    {friendRequestProcessing ? t('处理中') : t('同意')}
                                  </button>
                                  <button
                                    type="button"
                                    className="fr-decline"
                                    disabled={friendRequestProcessing}
                                    onClick={() => void actOnCard('decline')}
                                  >
                                    {t('拒绝')}
                                  </button>
                                  {friendRequestError ? <span className="fr-error">{friendRequestError}</span> : null}
                                </>
                              )}
                      </div>
                    </div>
                  )
                  : null}

                {linkCard
                  ? (
                    <a
                      className="link-card"
                      href={linkCard.url ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        event.preventDefault()
                        void openLinkCard(linkCard)
                      }}
                    >
                      <span className="card-body">
                        <span className="card-title">{linkCard.title || linkCard.url}</span>
                        {linkCard.description ? <span className="card-meta">{linkCard.description}</span> : null}
                        {linkCard.sourceName ? <span className="card-source">{linkCard.sourceName}</span> : null}
                      </span>
                      <span className="card-icon"><Icon name="link" size={15} /></span>
                    </a>
                  )
                  : null}

                {showText
                  ? (
                    <p className="bubble-text">
                      {bubbleSegments.map((segment, index) => segment.kind === 'emoticon'
                        ? <span key={index} className="emoticon">{segment.value}</span>
                        : <Fragment key={index}>{segment.value}</Fragment>)}
                    </p>
                  )
                  : null}

                {meta}
              </div>
            )}

        {canReply
          ? (
            <button
              type="button"
              className="reply-action"
              title={t('引用回复')}
              onClick={() => onReply?.()}
            >
              <Icon name="reply" size={13} />
            </button>
          )
          : null}
      </div>

      {own && (
        <ThreadAvatar
          className="message-avatar"
          accountId={account.id}
          name={ownAvatarName}
          username={account.ownUsername}
          size={34}
        />
      )}
    </div>
  )
}
