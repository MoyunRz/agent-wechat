// Applies a location hash to the store and writes the current view back to
// it. The hash is the only address the desktop shell and a browser reload
// share, so it must round-trip without losing the open conversation.

import { formatRoute, parseRoute, type Route } from './routes'
import {
  loadThreads,
  selectThread,
  setContactDialogOpen,
  setDetailsOpen,
  setRailView,
  setSettingsOpen,
} from '../store/actions'
import { getState } from '../store/state'
import type { Thread } from '../types'
import { viewRefs } from '../store/viewRefs'

/** The server segment used for this deployment: the browser has one hub. */
const SERVER_SEGMENT = 'hub'

/** True while a hash we wrote is being applied; blocks the echo loop. */
let applying = false

function routeForState(): Route | null {
  const state = getState()
  const account = state.session.account
  if (!account)
    return null
  const base = { server: SERVER_SEGMENT, account: account.id }
  if (state.ui.settingsOpen)
    return { name: 'settings', ...base }
  if (state.threads.contactDialogOpen)
    return { name: 'new-chat', ...base }
  if (state.ui.railView === 'contacts')
    return { name: 'contacts', ...base }
  if (state.ui.railView === 'requests')
    return { name: 'requests', ...base }
  if (state.ui.railView === 'ai')
    return { name: 'chats', ...base }
  const threadId = state.threads.activeThreadId
  if (!threadId)
    return { name: 'chats', ...base }
  if (state.threads.detailsOpen)
    return { name: 'info', ...base, thread: threadId }
  return { name: 'chat', ...base, thread: threadId }
}

/** Rewrites the address bar to match the store without adding history. */
export function syncLocationHash(): void {
  if (applying)
    return
  const route = routeForState()
  if (!route)
    return
  const hash = formatRoute(route)
  if (window.location.hash === hash)
    return
  try {
    window.history.replaceState(null, '', hash)
  }
  catch {
    // Some embedded webviews reject history writes; the view still works.
  }
}

function findThread(threadId: string): Thread | undefined {
  return getState().threads.items.find(thread => thread.id === threadId)
}

async function openThread(threadId: string): Promise<Thread | undefined> {
  let thread = findThread(threadId)
  if (!thread) {
    await loadThreads()
    thread = findThread(threadId)
  }
  if (thread)
    await selectThread(thread)
  return thread
}

/**
 * Applies a hash to the store. Returns true when the hash named a screen this
 * build can show; unknown or hub-picker routes leave the current view alone.
 */
export async function applyLocationHash(hash: string): Promise<boolean> {
  const route = parseRoute(hash)
  if (!route)
    return false
  applying = true
  try {
    if (route.name === 'servers' || route.name === 'accounts' || route.name === 'login')
      return false
    setSettingsOpen(route.name === 'settings')
    setContactDialogOpen(route.name === 'new-chat')
    if (route.name === 'contacts') {
      setRailView('contacts')
      return true
    }
    if (route.name === 'requests') {
      setRailView('requests')
      return true
    }
    setRailView('chats')
    if (route.name === 'chats') {
      setDetailsOpen(false)
      return true
    }
    // Only the conversation routes reach this point.
    if (route.name === 'new-chat' || route.name === 'settings')
      return true
    const thread = await openThread(route.thread)
    if (!thread)
      return false
    setDetailsOpen(route.name === 'info')
    if (route.name === 'message' || route.name === 'media') {
      // The list scrolls once the messages are in; a missing message leaves
      // the conversation open at its newest page. This build has no separate
      // photo viewer, so both routes land on the message itself.
      window.setTimeout(() => {
        viewRefs.messageList?.scrollToMessage(route.message)
      }, 300)
    }
    return true
  }
  finally {
    applying = false
  }
}

/** Applies the current address, then rewrites it to this deployment's form. */
export async function applyAndCanonicalize(): Promise<void> {
  const applied = await applyLocationHash(window.location.hash)
  if (applied)
    syncLocationHash()
}

/**
 * Applies the address the page was opened with and follows later hash changes.
 * Writing the hash back is the shell's job (syncLocationHash), so a state change
 * does not fight this listener.
 */
export function startRouter(): () => void {
  void applyAndCanonicalize()
  const onHashChange = (): void => {
    void applyAndCanonicalize()
  }
  window.addEventListener('hashchange', onHashChange)
  return () => {
    window.removeEventListener('hashchange', onHashChange)
  }
}
