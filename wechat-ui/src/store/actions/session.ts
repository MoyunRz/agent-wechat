// Account lifecycle: bootstrap, the signed-in slot, sign-in (QR) flows,
// sign-out, offline mode and the friend-request badge.

import { hasHubAuth, newIdempotencyKey, wechatApi, WechatApiError } from '../../api'
import { userFacingErrorMessage } from '../../errors'
import { connectionTone } from '../../format'
import { t } from '../../i18n'
import type { AccountSummary } from '../../types'
import {
  clearTimer,
  counters,
  flags,
  recentMessages,
  threadMessagesCache,
  timers,
} from '../caches'
import { getState, setMessages, setSession, setThreads, setUi, type AppState } from '../state'
import { startStream, stopStream } from '../engine'
import { clearMessageMedia } from './media'
import {
  clearStagedAttachments,
  ensureCacheAccountMatch,
  loadCachedSessionData,
  revokeAllLocalMedia,
} from './messages'
import { loadContactDirectory, loadThreads } from './threads'
import { clearToastTimers } from './ui'

export const LAST_ACCOUNT_KEY = 'wx-last-account-id'
/** Prefix of the temporary slot the unbound scan login creates. */
export const PENDING_LOGIN_PREFIX = 'pending-login-'
/** Idempotency key storage so a reload resumes the same login attempt. */
export const LOGIN_ATTEMPT_STORAGE_KEY = 'vane.wechat.login-attempt-key'

const FRIEND_REQUEST_POLL_INTERVAL = 20_000
const LOGIN_CONFLICT_MAX_RETRIES = 6
const LOGIN_CONFLICT_RETRY_DELAY_MS = 3_000

/** Resolves after `ms` milliseconds. */
export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => window.setTimeout(resolve, ms))
}

/** Turns an API failure into a short sentence the interface can show. */
export function errorText(error: unknown): string {
  if (error instanceof WechatApiError) {
    switch (error.status) {
      case 401:
        return t('登录状态已失效，请重新登录微信。')
      case 404:
        return t('没有找到对应的微信会话，请刷新后重试。')
      case 409:
        return error.code === 'operation_in_progress'
          ? t('登录正在进行中，请稍后重试。')
          : t('微信尚未连接，请稍后重试。')
      case 503:
        return t('微信服务暂时不可用，请稍后重试。')
      default:
        break
    }
    return userFacingErrorMessage(error, t('微信操作失败，请稍后重试。'))
  }
  return userFacingErrorMessage(error, t('微信操作失败，请稍后重试。'))
}

/** A slot counts as signed in when it is online or its login material is saved. */
export function isSignedIn(item: AccountSummary | null | undefined): boolean {
  return Boolean(item && (item.authenticated || item.savedLogin))
}

/** Connection tone of the current account for the header banner. */
export function selectConnectionState(state: AppState = getState()): 'online' | 'pending' | 'offline' {
  const current = state.session.account
  if (!current)
    return 'offline'
  return connectionTone(current.connection, current.authenticated)
}

/** Human label of the live event stream. */
export function selectStreamLabel(state: AppState = getState()): string {
  if (state.session.streamStatus === 'live')
    return t('实时同步中')
  if (state.session.streamStatus === 'reconnecting')
    return t('正在重连')
  return t('未连接')
}

function isPendingLoginSlot(item: AccountSummary): boolean {
  return item.id.startsWith(PENDING_LOGIN_PREFIX)
    || Boolean(item.alias?.startsWith(PENDING_LOGIN_PREFIX))
}

/** Remembers the slot to restore on the next load. */
export function rememberAccountId(id: string): void {
  try {
    window.localStorage.setItem(LAST_ACCOUNT_KEY, id)
  }
  catch {
    // Storage can be unavailable; remembering the slot is only a convenience.
  }
}

/** Releases a temporary scan-login slot; a 409 race retries once. */
export function releasePendingSlot(accountId: string): void {
  const once = (allowRetry: boolean): Promise<void> =>
    wechatApi.removeAccount(accountId).then(() => undefined).catch((error) => {
      const text = String(error)
      if (allowRetry && (text.includes('operation_in_progress') || text.includes('409'))) {
        window.setTimeout(() => void once(false), 1500)
        return
      }
      // A failed release is silent; the leftover slot is cleaned up later.
    })
  void once(true)
}

function loadLoginAttemptKey(accountId: string): string {
  try {
    const raw = window.localStorage.getItem(LOGIN_ATTEMPT_STORAGE_KEY)
    if (!raw)
      return ''
    const parsed = JSON.parse(raw) as { accountId?: unknown, key?: unknown }
    if (parsed.accountId === accountId && typeof parsed.key === 'string' && parsed.key)
      return parsed.key
  }
  catch {
    // A corrupt entry starts a fresh login.
  }
  return ''
}

function saveLoginAttemptKey(accountId: string, key: string): void {
  try {
    window.localStorage.setItem(LOGIN_ATTEMPT_STORAGE_KEY, JSON.stringify({ accountId, key }))
  }
  catch {
    // A failed write only loses login resumption across reloads.
  }
}

function clearLoginAttemptKey(): void {
  flags.loginAttemptKey = ''
  try {
    window.localStorage.removeItem(LOGIN_ATTEMPT_STORAGE_KEY)
  }
  catch {
    // Cleanup failures do not block sign-out.
  }
}

/**
 * Picks the account slot to open: the last used one first, even when signed
 * out, then the first signed-in slot, then the first real slot. Temporary
 * scan-login slots are never a default landing point.
 */
export async function ensureAccount(): Promise<AccountSummary> {
  let items = await wechatApi.listAccounts()
  const lastId = window.localStorage.getItem(LAST_ACCOUNT_KEY)
  const chosen = (lastId && items.find(item => item.id === lastId))
    ?? items.find(item => item.authenticated && !isPendingLoginSlot(item))
    ?? items.find(item => isSignedIn(item) && !isPendingLoginSlot(item))
    ?? items.find(item => !isPendingLoginSlot(item))
    ?? items[0]
  if (chosen) {
    rememberAccountId(chosen.id)
    return chosen
  }

  try {
    return await wechatApi.createAccount()
  }
  catch (error) {
    // Creating an account can persist while the operation reports failure:
    // read the list again before giving up.
    items = await wechatApi.listAccounts()
    if (items.length > 0)
      return items[0]
    throw error
  }
}

/** Reads the WeChat nickname of the signed-in account. */
export async function loadSelfProfile(): Promise<void> {
  const current = getState().session.account
  const username = current?.ownUsername?.trim()
  if (!current || !current.authenticated || !username)
    return
  try {
    // The account is not in its own address book, so the local row is usually
    // empty: ask the server for the nickname first.
    let name = ''
    try {
      const lookup = await wechatApi.lookupContacts(current.id, [username])
      const item = lookup.items?.find(candidate => candidate.id === username)
      const display = item?.displayName?.trim() ?? ''
      if (display && display !== username)
        name = display
    }
    catch {
      // Fall back to the local contact row when the lookup fails.
    }
    if (!name) {
      const contact = await wechatApi.getContact(current.id, username)
      const display = contact.displayName?.trim() || ''
      const nickname = contact.nickname?.trim() || ''
      name = [display, nickname].find(value => value && value !== username) || ''
    }
    setSession({ selfName: name })
  }
  catch {
    // A failed profile read falls back to the generic label.
  }
}

let lastQrKey = ''

/** Reloads the QR image when the account, attempt or generation changed. */
export function syncLoginQrForAttempt(): void {
  const state = getState().session
  const key = [
    state.account?.id,
    state.loginAttempt?.id,
    state.loginAttempt?.result?.qrGeneration,
    counters.qrNonce,
  ].join('|')
  if (key === lastQrKey)
    return
  lastQrKey = key
  setSession({ qrFailed: false })
  void loadQrImage()
}

/** Starts the interface: restores the session, then either opens it or logs in. */
export async function bootstrap(): Promise<void> {
  setSession({ booting: true, bootError: '' })
  try {
    // Paint the last saved list and directory first; the refresh replaces them.
    loadCachedSessionData()
    const next = await ensureAccount()
    setSession({ account: next })
    void refreshAccountSlots()
    ensureCacheAccountMatch(next.ownUsername)
    if (isSignedIn(next)) {
      // Offline (savedLogin) slots take the same path: the thread list and the
      // directory read local caches and do not need an online session.
      await loadSelfProfile()
      await loadThreads()
      void loadContactDirectory()
      void startCatalogSync()
      startStream()
      startFriendRequestPoll()
    }
    else if (!flags.autoLoginTriggered && hasHubAuth()) {
      // Generate the login QR automatically, with the manual button as fallback.
      flags.autoLoginTriggered = true
      void startLogin()
    }
    scheduleAccountPoll()
    syncLoginQrForAttempt()
  }
  catch (error) {
    setSession({ bootError: errorText(error) })
  }
  finally {
    setSession({ booting: false })
  }
}

/** Schedules the next account poll. */
export function scheduleAccountPoll(delay = 12_000): void {
  timers.account = clearTimer(timers.account)
  if (flags.disposed)
    return
  timers.account = window.setTimeout(() => {
    void pollAccount()
  }, delay)
}

/** Polls the account slot and reacts to sign-in, sign-out and reconnect. */
export async function pollAccount(): Promise<void> {
  const current = getState().session.account
  if (!current || flags.disposed) {
    scheduleAccountPoll()
    return
  }

  try {
    const next = await wechatApi.getAccount(current.id)
    const wasAuthenticated = current.authenticated
    const wasConnected = current.connection
    setSession({ account: next })

    if (!wasAuthenticated && next.authenticated)
      await afterAuthenticated()
    else if (wasAuthenticated && !next.authenticated)
      handleSignedOut()
    else if (next.authenticated && next.connection === 'connected' && wasConnected !== 'connected')
      await loadThreads()
    if (next.authenticated && !getState().session.selfName)
      await loadSelfProfile()
  }
  catch (error) {
    if (error instanceof WechatApiError && error.status === 401)
      setSession({ bootError: errorText(error) })
  }

  scheduleAccountPoll()
}

/** Resets the interface after the account signed out. */
export function handleSignedOut(explicit = false): void {
  stopStream()
  stopFriendRequestPoll()
  setSession({ loginAttempt: null, selfName: '' })
  setThreads({
    items: [],
    activeThreadId: null,
    error: '',
    detailsOpen: false,
    contactDialogOpen: false,
    friendNames: new Set(),
    contactNames: new Map(),
    directoryContacts: [],
    directoryReady: false,
  })
  revokeAllLocalMedia()
  clearMessageMedia()
  threadMessagesCache.clear()
  setMessages({
    replyTo: null,
    items: [],
    cursor: null,
    error: '',
    unseenBelow: 0,
  })
  // Only an explicit sign-out clears the persisted caches; a dropped session
  // keeps them so signing back into the same account is instant. A different
  // account is handled by ensureCacheAccountMatch.
  if (explicit) {
    recentMessages.clear()
    setThreads({ allReadAt: 0 })
    try {
      window.localStorage.removeItem('vane.wechat.ui-cache')
      window.localStorage.removeItem('vane.wechat.directory-cache')
      window.localStorage.removeItem('vane.wechat.read-cursor')
    }
    catch {
      // Cleanup failures do not block sign-out.
    }
  }
  clearLoginAttemptKey()
  flags.loginConflictRetries = 0
  timers.loginRetry = clearTimer(timers.loginRetry)
  setUi({ toasts: [] })
  clearToastTimers()
  clearStagedAttachments()
  // Mirrors the old watcher: an attempt id change drops the QR object URL.
  syncLoginQrForAttempt()
}

/** Continues after a successful sign-in. */
export async function afterAuthenticated(): Promise<void> {
  setSession({ loginAttempt: null, loginError: '', qrFailed: false })
  ensureCacheAccountMatch(getState().session.account?.ownUsername)
  await loadSelfProfile()
  // Staged loading: the conversation list first, then contact profiles; history
  // is fetched when the user opens a conversation.
  await loadThreads()
  void loadContactDirectory()
  void startCatalogSync()
  startStream()
  startFriendRequestPoll()
}

/** Asks the daemon to sync contacts and group profiles. */
export async function startCatalogSync(): Promise<void> {
  const current = getState().session.account
  if (!current?.authenticated)
    return
  try {
    await wechatApi.syncContacts(current.id)
  }
  catch {
    // A failed directory sync does not block the interface; the events or a
    // manual refresh fill it in later.
  }
  try {
    await wechatApi.syncGroups(current.id)
  }
  catch {
    // Same for group profiles.
  }
}

/** Manual account refresh from the header. */
export async function refreshAccount(): Promise<void> {
  const current = getState().session.account
  if (!current)
    return
  setSession({ manualRefreshing: true })
  try {
    const next = await wechatApi.getAccount(current.id)
    const wasAuthenticated = current.authenticated
    setSession({ account: next })
    if (!wasAuthenticated && next.authenticated)
      await afterAuthenticated()
    else if (wasAuthenticated && !next.authenticated)
      handleSignedOut()
    else if (next.authenticated && getState().threads.items.length === 0)
      await loadThreads()
    if (next.authenticated)
      await loadSelfProfile()
  }
  catch (error) {
    setSession({ loginError: errorText(error) })
  }
  finally {
    setSession({ manualRefreshing: false })
  }
}

/** Loads every account slot for the login screen; failures stay silent. */
export async function refreshAccountSlots(): Promise<void> {
  try {
    setSession({ accountSlots: await wechatApi.listAccounts() })
  }
  catch {
    // Keep the previous list.
  }
}

/** Full sign-out: revokes the session on the daemon and clears the interface. */
export async function logoutAccount(): Promise<void> {
  const current = getState().session.account
  if (!current || getState().session.loggingOut)
    return
  setSession({ loggingOut: true, accountActionError: '' })
  try {
    await wechatApi.logout(current.id)
    setSession({
      account: {
        ...current,
        authenticated: false,
        connection: 'disconnected',
        ownUsername: null,
      },
    })
    handleSignedOut(true)
    setSession({ loginAttempt: null, loginError: '', qrFailed: false })
    syncLoginQrForAttempt()
  }
  catch (error) {
    setSession({ accountActionError: errorText(error) })
  }
  finally {
    setSession({ loggingOut: false })
  }
}

/** Clears the account action banner (the banner close button). */
export function clearAccountActionError(): void {
  setSession({ accountActionError: '' })
}

/** Offline debug mode: the daemon stops calling WeChat and serves local data. */
export async function toggleOfflineMode(enabled: boolean): Promise<void> {
  const current = getState().session.account
  if (!current || getState().session.offlineToggling)
    return
  setSession({ offlineToggling: true, accountActionError: '' })
  try {
    await wechatApi.setOfflineMode(current.id, enabled)
    setSession({ account: await wechatApi.getAccount(current.id) })
  }
  catch (error) {
    setSession({ accountActionError: errorText(error) })
  }
  finally {
    setSession({ offlineToggling: false })
  }
}

/** True when the daemon reports a login conflict (another login in progress). */
function isLoginConflict(error: unknown): boolean {
  return error instanceof WechatApiError
    && (error.status === 409 || error.code === 'operation_in_progress')
}

/**
 * Starts a scan login. The attempt is not bound to a slot: the daemon creates a
 * pending-login-* slot for the QR code and adopts an existing slot afterwards.
 */
export async function startLogin(isRetry = false): Promise<void> {
  if (getState().session.loginBusy)
    return
  if (!isRetry) {
    // A user-initiated start clears the conflict wait.
    flags.loginConflictRetries = 0
    timers.loginRetry = clearTimer(timers.loginRetry)
  }
  setSession({
    loginBusy: true,
    loginError: '',
    accountActionError: '',
    qrFailed: false,
    loginAttempt: null,
  })
  try {
    // Reuse the persisted idempotency key so a reload resumes the running
    // attempt instead of requesting a second QR code.
    if (!flags.loginAttemptKey)
      flags.loginAttemptKey = loadLoginAttemptKey('unbound') || newIdempotencyKey('login')
    saveLoginAttemptKey('unbound', flags.loginAttemptKey)
    const attempt = await wechatApi.createUnboundLoginAttempt(flags.loginAttemptKey)
    setSession({ loginAttempt: attempt })
    flags.pendingLoginAccountId = attempt.accountId
    rememberAccountId(flags.pendingLoginAccountId)
    // Show the login progress on the temporary slot; the adoption result
    // switches back to the real account.
    try {
      setSession({ account: await wechatApi.getAccount(flags.pendingLoginAccountId) })
    }
    catch {
      // A failed summary read does not block polling: it uses attempt.accountId.
    }
    flags.loginConflictRetries = 0
    syncLoginQrForAttempt()
    scheduleLoginPoll()
  }
  catch (error) {
    if (!flags.disposed && isLoginConflict(error) && flags.loginConflictRetries < LOGIN_CONFLICT_MAX_RETRIES) {
      // Another login is running: stay quiet and retry with the same key.
      flags.loginConflictRetries += 1
      setSession({ loginError: t('检测到已有登录正在进行，等待完成后自动继续…') })
      timers.loginRetry = window.setTimeout(() => {
        if (!flags.disposed)
          void startLogin(true)
      }, LOGIN_CONFLICT_RETRY_DELAY_MS)
    }
    else {
      flags.loginConflictRetries = 0
      // Retries exhausted: the occupying login worker belongs to another key
      // (another browser, terminal or old page), so this page cannot address
      // it. The account poll takes over once it succeeds.
      setSession({ loginError: t('已有其他登录在进行（其他页面、终端或旧标签页）。它完成后本页会自动进入；也可等它超时后重试，或重启 daemon。') })
      // No attempt is running on this page, so no QR should be shown.
      syncLoginQrForAttempt()
    }
  }
  finally {
    setSession({ loginBusy: false })
  }
}

/** Schedules the next login poll. */
export function scheduleLoginPoll(delay = 900): void {
  timers.login = clearTimer(timers.login)
  if (flags.disposed)
    return
  timers.login = window.setTimeout(() => {
    void pollLogin()
  }, delay)
}

/** Polls the running login attempt and handles its terminal states. */
export async function pollLogin(): Promise<void> {
  const state = getState().session
  const current = state.account
  const attempt = state.loginAttempt
  if (!current || !attempt || flags.disposed)
    return

  try {
    const next = await wechatApi.getLoginAttempt(current.id, attempt.id)
    setSession({ loginAttempt: next })
    // The QR belongs to the attempt's slot; pollLogin may switch the account
    // below, so sync again after that switch.
    syncLoginQrForAttempt()

    if (next.state === 'succeeded') {
      // The daemon may adopt an existing slot for the scanned identity: use the
      // attempt result, falling back to the slot that started the attempt.
      const adoptedId = next.result?.adoptedAccountId
      const finalId = typeof adoptedId === 'string' && adoptedId ? adoptedId : current.id
      const latest = await wechatApi.getAccount(finalId)
      setSession({ account: latest })
      rememberAccountId(finalId)
      syncLoginQrForAttempt()
      // Release the temporary slot once adopted; a brand-new identity keeps it.
      if (flags.pendingLoginAccountId && flags.pendingLoginAccountId === next.accountId && finalId !== next.accountId) {
        flags.pendingLoginAccountId = ''
        releasePendingSlot(next.accountId)
      }
      void refreshAccountSlots()
      if (latest.authenticated) {
        clearLoginAttemptKey()
        await afterAuthenticated()
        return
      }
      scheduleLoginPoll(700)
      return
    }

    if (next.state === 'needs_slot_login') {
      // The WeChat account is bound to an existing slot and the adoption did not
      // finish: release the temporary slot and return to the original one.
      clearLoginAttemptKey()
      flags.loginConflictRetries = 0
      timers.loginRetry = clearTimer(timers.loginRetry)
      if (flags.pendingLoginAccountId && flags.pendingLoginAccountId === next.accountId) {
        flags.pendingLoginAccountId = ''
        releasePendingSlot(next.accountId)
      }
      const boundId = next.result?.accountId
      if (typeof boundId === 'string' && boundId) {
        try {
          setSession({ account: await wechatApi.getAccount(boundId) })
          rememberAccountId(boundId)
          syncLoginQrForAttempt()
        }
        catch {
          // A failed summary read does not prevent ending this login round.
        }
      }
      void refreshAccountSlots()
      return
    }

    if (next.state === 'failed' || next.state === 'cancelled' || next.state === 'expired' || next.state === 'rejected') {
      clearLoginAttemptKey()
      flags.loginConflictRetries = 0
      timers.loginRetry = clearTimer(timers.loginRetry)
      // A terminal state releases the temporary slot so the account list does
      // not accumulate leftovers.
      if (flags.pendingLoginAccountId && flags.pendingLoginAccountId === next.accountId) {
        flags.pendingLoginAccountId = ''
        releasePendingSlot(next.accountId)
      }
      return
    }

    scheduleLoginPoll(next.state === 'awaiting_approval' ? 1500 : 900)
  }
  catch (error) {
    setSession({ loginError: errorText(error) })
    scheduleLoginPoll(1800)
  }
}

/** Cancels the running login attempt. */
export async function cancelLogin(): Promise<void> {
  const state = getState().session
  const current = state.account
  const attempt = state.loginAttempt
  if (!current || !attempt)
    return
  timers.login = clearTimer(timers.login)
  timers.loginRetry = clearTimer(timers.loginRetry)
  flags.loginConflictRetries = 0
  setSession({ loginBusy: true })
  try {
    setSession({ loginAttempt: await wechatApi.cancelLoginAttempt(current.id, attempt.id) })
    // The cancelled attempt no longer accepts a scan: clear the bitmap so a
    // stale code cannot be scanned.
    syncLoginQrForAttempt()
    clearLoginAttemptKey()
  }
  catch (error) {
    setSession({ loginError: errorText(error) })
  }
  finally {
    setSession({ loginBusy: false })
  }
}

/** Regenerates the QR image (the daemon keeps the same attempt). */
export function retryQr(): void {
  counters.qrNonce += 1
  syncLoginQrForAttempt()
}

/** Sets the QR image failure flag (the image element reports decode errors). */
export function setQrFailed(qrFailed: boolean): void {
  setSession({ qrFailed })
}

/** Replaces the QR object URL, revoking the previous one. */
export function setQrObjectUrl(url: string | null): void {
  const previous = getState().session.qrObjectUrl
  if (previous && previous !== url)
    URL.revokeObjectURL(previous)
  setSession({ qrObjectUrl: url })
}

/** Fetches the QR image bytes as an object URL. */
export async function loadQrImage(): Promise<void> {
  const state = getState().session
  const current = state.account
  const attempt = state.loginAttempt
  if (!current || !attempt) {
    setQrObjectUrl(null)
    return
  }
  // Only fetch once the daemon reports a QR code as ready.
  if (!attempt.result?.qrAvailable && attempt.state !== 'awaiting_scan') {
    setQrObjectUrl(null)
    return
  }
  const generation = attempt.result?.qrGeneration ?? 0
  const seq = ++counters.qrLoad
  try {
    const url = await wechatApi.loadLoginQr(current.id, attempt.id, generation)
    if (seq !== counters.qrLoad) {
      URL.revokeObjectURL(url)
      return
    }
    setQrObjectUrl(url)
    setSession({ qrFailed: false })
  }
  catch {
    if (seq === counters.qrLoad) {
      setQrObjectUrl(null)
      setSession({ qrFailed: true })
    }
  }
}

/** Refreshes the pending friend-request badge; a failure keeps the last value. */
export async function refreshFriendRequestCount(): Promise<void> {
  const current = getState().session.account
  if (!current?.authenticated)
    return
  try {
    const page = await wechatApi.listContactRequests(current.id, { direction: 'incoming', actionable: true, limit: 1 })
    setSession({ friendRequestCount: page.pendingIncomingCount ?? page.items.length })
  }
  catch {
    // Older hubs have no such endpoint; the badge stays at zero.
  }
}

/** Starts polling the pending friend-request count. */
export function startFriendRequestPoll(): void {
  if (timers.friendRequest !== null)
    return
  void refreshFriendRequestCount()
  timers.friendRequest = window.setInterval(() => {
    void refreshFriendRequestCount()
  }, FRIEND_REQUEST_POLL_INTERVAL)
}

/** Stops the friend-request poll and clears the badge. */
export function stopFriendRequestPoll(): void {
  timers.friendRequest = clearTimer(timers.friendRequest)
  setSession({ friendRequestCount: 0 })
}
