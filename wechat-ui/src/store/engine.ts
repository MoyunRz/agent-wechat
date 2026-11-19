// The engine: everything App.vue did in onMounted/onBeforeUnmount. The shell
// calls startEngine() once and the returned function on unmount.

import { invalidateAvatarCache } from '../api'
import { sendFailureMessage } from '../errors'
import { consumeEventStream } from '../events'
import { threadName } from '../format'
import { t } from '../i18n'
import type { WechatEvent } from '../types'
import {
  clearAllTimers,
  clearTimer,
  counters,
  flags,
  handles,
  timers,
} from './caches'
import { getState, setMessages, setSession, store } from './state'
import { clearMessageMedia } from './actions/media'
import {
  clearStagedAttachments,
  revokeAllLocalMedia,
  scheduleMessageRefresh,
} from './actions/messages'
import {
  bootstrap,
  pollAccount,
  setQrObjectUrl,
  sleep,
} from './actions/session'
import {
  loadContactDirectory,
  loadContactProfile,
  resetContactProfile,
  scheduleAutoRead,
  scheduleThreadRefresh,
  selectActiveThread,
  selectDetailsPeerId,
  setNarrow,
  touchThreads,
} from './actions/threads'
import {
  applyUiSettings,
  clearToastTimers,
  dismissToast,
  scheduleIncomingToast,
  setLightboxSrc,
} from './actions/ui'

/**
 * Events replayed after a reconnect or a reload carry an old timestamp; they
 * must not raise unread badges or notification cards.
 */
function isFreshEvent(createdAt: string): boolean {
  const time = Date.parse(createdAt)
  if (!Number.isFinite(time))
    return true
  return time >= flags.bootedAt - 60_000
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && getState().messages.lightboxSrc)
    setLightboxSrc(null)
}

function handleNarrowChange(event: MediaQueryListEvent): void {
  setNarrow(event.matches)
}

/** Keeps the document title in sync with the account and open conversation. */
export function syncDocumentTitle(): void {
  const state = getState()
  const account = state.session.account
  const active = selectActiveThread(state)
  // Show the WeChat nickname, never the local slot alias.
  const accountLabel = account?.authenticated ? (state.session.selfName || t('微信')) : t('微信登录')
  const threadLabel = active ? ` · ${threadName(active)}` : ''
  document.title = `${accountLabel}${threadLabel}`
}

let lastTitleKey = ''
let lastProfileKey = ''

/** Mirrors the App.vue watchers that react to derived state changes. */
function syncWatchers(): void {
  const state = getState()
  const titleKey = [
    state.session.account?.ownUsername,
    state.session.account?.authenticated,
    state.session.selfName,
    selectActiveThread(state)?.displayName,
  ].join('|')
  if (titleKey !== lastTitleKey) {
    lastTitleKey = titleKey
    syncDocumentTitle()
  }
  const profileKey = [
    state.threads.detailsOpen,
    selectDetailsPeerId(state),
    state.session.account?.id,
  ].join('|')
  if (profileKey !== lastProfileKey) {
    lastProfileKey = profileKey
    if (state.threads.detailsOpen && selectDetailsPeerId(state))
      void loadContactProfile()
    else
      resetContactProfile()
  }
}

let unsubscribeWatchers: (() => void) | null = null

/** Starts the interface: bootstrap, stream, layout detection and watchers. */
export function startEngine(): () => void {
  flags.disposed = false
  // The reference fixes this at module load. Keep the first value so an engine
  // restart does not reclassify replayed events as fresh.
  if (!flags.bootedAt)
    flags.bootedAt = Date.now()
  applyUiSettings()
  void bootstrap()
  window.addEventListener('keydown', onGlobalKeydown)
  try {
    flags.narrowQuery = window.matchMedia('(max-width: 768px)')
    setNarrow(flags.narrowQuery.matches)
    flags.narrowQuery.addEventListener('change', handleNarrowChange)
  }
  catch {
    setNarrow(false)
  }
  unsubscribeWatchers = store.subscribe(syncWatchers)
  lastTitleKey = ''
  lastProfileKey = ''
  syncWatchers()
  return disposeEngine
}

/** Stops every timer, stream and listener; called when the shell unmounts. */
export function disposeEngine(): void {
  flags.disposed = true
  window.removeEventListener('keydown', onGlobalKeydown)
  flags.narrowQuery?.removeEventListener('change', handleNarrowChange)
  flags.narrowQuery = null
  setQrObjectUrl(null)
  clearAllTimers()
  clearMessageMedia()
  clearStagedAttachments()
  revokeAllLocalMedia()
  clearToastTimers()
  stopStream()
  unsubscribeWatchers?.()
  unsubscribeWatchers = null
}

/** Opens the event stream and reconnects with the last cursor. */
export function startStream(): void {
  const account = getState().session.account
  if (flags.streamActive || !account?.authenticated)
    return
  stopStream()
  flags.streamActive = true
  flags.lastCursor = null
  const token = ++counters.streamToken
  const currentAccountId = account.id
  // After a daemon restart the snapshot can briefly map another contact's
  // avatar bytes to a username, and the old bytes are cached: drop them all.
  let streamOpenedOnce = false

  void (async () => {
    while (!flags.disposed && token === counters.streamToken && getState().session.account?.authenticated) {
      const controller = new AbortController()
      flags.streamAbort = controller
      try {
        setSession({ streamStatus: 'reconnecting' })
        await consumeEventStream({
          accountId: currentAccountId,
          after: flags.lastCursor,
          signal: controller.signal,
          onOpen: () => {
            if (token !== counters.streamToken)
              return
            setSession({ streamStatus: 'live' })
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
        // An expired cursor (410) drops the cursor so the next connection starts
        // at the daemon's current event head; other failures keep it.
        if (error instanceof Error && error.message.includes('410'))
          flags.lastCursor = null
      }
      if (token !== counters.streamToken || flags.disposed)
        return
      setSession({ streamStatus: 'reconnecting' })
      await sleep(1_600)
    }
  })()
}

/** Closes the event stream. */
export function stopStream(): void {
  counters.streamToken += 1
  flags.streamActive = false
  setSession({ streamStatus: 'idle' })
  flags.streamAbort?.abort()
  flags.streamAbort = null
}

/** Applies one event from the stream. */
export function handleStreamEvent(event: WechatEvent): void {
  if (event.cursor)
    flags.lastCursor = event.cursor

  const kind = event.kind
  if (kind === 'message.committed' || kind === 'message.updated') {
    const threadId = String(event.data.threadId ?? '')
    // Only a genuinely new, fresh message counts as unread. message.updated
    // covers media completion, edits and read receipts on old messages and is
    // replayed when a page reloads or a conversation opens.
    const isNewMessage = kind === 'message.committed' && isFreshEvent(event.createdAt)
    const state = getState()
    if (threadId && threadId !== state.threads.activeThreadId) {
      const thread = state.threads.items.find(item => item.id === threadId)
      if (thread && isNewMessage) {
        thread.unreadCount = (thread.unreadCount ?? 0) + 1
        touchThreads()
        scheduleIncomingToast(threadId)
      }
    }
    if (threadId && threadId === state.threads.activeThreadId) {
      if (!handles.messageList?.isAtBottom())
        setMessages(current => ({ unseenBelow: current.unseenBelow + 1 }))
      scheduleMessageRefresh(threadId)
      // A new message in the open conversation is reported read immediately,
      // matching the official client; otherwise the daemon counts it unread.
      if (isNewMessage) {
        const thread = getState().threads.items.find(item => item.id === threadId)
        if (thread) {
          thread.unreadCount = 0
          touchThreads()
          scheduleAutoRead(thread)
        }
      }
    }
    scheduleThreadRefresh()
    return
  }

  if (kind === 'thread.read-state') {
    // Another device read the conversation: clear the badge, drop its cards and
    // refresh for the authoritative partial-read counts.
    const threadId = String(event.data.threadId ?? '')
    if (threadId) {
      const state = getState()
      const thread = state.threads.items.find(item => item.id === threadId)
      if (thread && (thread.unreadCount ?? 0) > 0) {
        thread.unreadCount = 0
        touchThreads()
      }
      for (const toast of [...state.ui.toasts]) {
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
    const sendState = String(event.data.state ?? '')
    if (sendId) {
      const local = getState().messages.items.find(item => item.local && item.sendId === sendId)
      if (local && sendState) {
        local.sendState = sendState
        if (sendState === 'accepted') {
          local.pending = false
          if (getState().threads.activeThreadId === local.threadId)
            scheduleMessageRefresh(local.threadId, 200)
        }
        else if (sendState === 'failed' || sendState === 'needs_review') {
          local.pending = false
          local.sendError = sendState === 'failed'
            ? sendFailureMessage(event.data.errorCode)
            : t('发送结果待确认，请检查聊天记录')
        }
        setMessages(current => ({ items: [...current.items] }))
      }
    }
    return
  }

  if (kind === 'account.updated' || kind === 'login.updated') {
    timers.accountRefresh = clearTimer(timers.accountRefresh)
    timers.accountRefresh = window.setTimeout(() => {
      void pollAccount()
    }, 800)
  }
}
