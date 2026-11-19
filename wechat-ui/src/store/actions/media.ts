// Media assets for messages: lookup, transfer requests, retries and the
// per-message media state the bubbles render.

import { wechatApi } from '../../api'
import { t } from '../../i18n'
import type { LocalMessage, MediaAsset, MessageMedia } from '../../types'
import {
  MEDIA_BATCH_DELAY,
  MEDIA_BATCH_SIZE,
  MEDIA_MAX_RETRIES,
  MEDIA_RETRY_DELAY,
  clearTimer,
  flags,
  localMediaUrls,
  mediaInFlight,
  mediaRetryCounts,
  mediaTransferRequested,
  timers,
} from '../caches'
import { getState, setMessages } from '../state'

// Batch sizing lives with the other module constants; re-exported here because
// this module owns the media loading loop.
export {
  MEDIA_BATCH_DELAY,
  MEDIA_BATCH_SIZE,
  MEDIA_MAX_RETRIES,
  MEDIA_RETRY_DELAY,
} from '../caches'

/** True when the message carries media that the daemon serves on demand. */
export function isMediaMessage(message: LocalMessage): boolean {
  if (message.local || message.localMedia)
    return false
  if (message.type === 3 || message.type === 34 || message.type === 43 || message.type === 47)
    return true
  return message.type === 49 && message.appMessageType === 6
}

/** Collapses the asset states of one message into the state its bubble shows. */
export function resolveMediaState(assets: MediaAsset[]): MessageMedia['state'] {
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

/** Turns a lookup error payload into a short message; null when there is none. */
export function mediaErrorText(error: unknown): string | null {
  if (!error)
    return null
  if (typeof error === 'string')
    return error
  if (typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim())
      return message
  }
  return t('媒体资源获取失败')
}

/** Stores the media state of one message. */
export function setMessageMedia(entry: MessageMedia): void {
  setMessages(state => ({ mediaByMessage: { ...state.mediaByMessage, [entry.messageId]: entry } }))
}

/** Revokes an object URL and forgets it. */
export function revokeUrl(url: string | null | undefined): void {
  if (!url)
    return
  URL.revokeObjectURL(url)
  localMediaUrls.delete(url)
}

/** Asks the daemon to start one transfer; each message and quality is requested once. */
export async function requestTransferOnce(
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
    // A rejected transfer keeps the placeholder; a later lookup can ask again.
    mediaTransferRequested.delete(requestKey)
  }
}

/** Schedules one retry round for messages whose media is still pending. */
export function scheduleMediaRetry(): void {
  if (timers.mediaRetry !== null || flags.disposed)
    return
  timers.mediaRetry = window.setTimeout(() => {
    timers.mediaRetry = null
    void retryPendingMedia()
  }, MEDIA_RETRY_DELAY)
}

/** Re-looks up pending media, bounded by the per-message retry budget. */
export async function retryPendingMedia(): Promise<void> {
  const current = getState().session.account
  if (!current || flags.disposed)
    return
  const ids: string[] = []
  for (const entry of Object.values(getState().messages.mediaByMessage)) {
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

  const hasPending = Object.values(getState().messages.mediaByMessage).some(
    entry => entry.state === 'pending'
      && (mediaRetryCounts.get(entry.messageId) ?? 0) < MEDIA_MAX_RETRIES,
  )
  if (hasPending)
    scheduleMediaRetry()
}

/** Looks up the media state of one batch of messages and updates their bubbles. */
export async function lookupMediaBatch(accountId: string, messageIds: string[]): Promise<void> {
  const ids = messageIds.filter(id => !mediaInFlight.has(id))
  if (ids.length === 0)
    return
  for (const id of ids)
    mediaInFlight.add(id)

  try {
    const items = await wechatApi.lookupMedia(accountId, ids)
    if (flags.disposed || getState().session.account?.id !== accountId)
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
        // Videos only download the poster frame automatically; the full file
        // waits until the user presses play.
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
    // A failed lookup never blocks the message list; the next refresh retries.
  }
  finally {
    for (const id of ids)
      mediaInFlight.delete(id)
  }
}

/** Looks up media for the messages that do not have a state yet, newest first. */
export async function loadMediaForMessages(items: LocalMessage[]): Promise<void> {
  const current = getState().session.account
  if (!current || flags.disposed || !current.authenticated)
    return

  const ids: string[] = []
  const seen = new Set<string>()
  const known = getState().messages.mediaByMessage
  for (const item of items) {
    if (!isMediaMessage(item) || seen.has(item.id))
      continue
    if (known[item.id] || mediaInFlight.has(item.id))
      continue
    seen.add(item.id)
    ids.push(item.id)
  }

  // The viewport sits at the bottom when a conversation opens, so the newest
  // media is visible first: load in reverse order and yield between batches.
  const ordered = [...ids].reverse()
  for (let index = 0; index < ordered.length; index += MEDIA_BATCH_SIZE) {
    await lookupMediaBatch(current.id, ordered.slice(index, index + MEDIA_BATCH_SIZE))
    if (index + MEDIA_BATCH_SIZE < ordered.length)
      await sleep(MEDIA_BATCH_DELAY)
  }
}

/** Drops every media state and retry guard (sign-out, unmount). */
export function clearMessageMedia(): void {
  timers.mediaRetry = clearTimer(timers.mediaRetry)
  setMessages({ mediaByMessage: {} })
  mediaInFlight.clear()
  mediaTransferRequested.clear()
  mediaRetryCounts.clear()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}
