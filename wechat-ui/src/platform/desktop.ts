// Desktop platform bridge. Loaded only inside the Tauri shell (see ./index.ts).
// The hub access key never reaches web storage: remote keys are handed to
// desktop_remote, which keeps them in the Rust credential store, and this
// module removes any token an earlier browser handoff left behind.

import { useEffect, useSyncExternalStore } from 'react'
import { getLocale, subscribeLocale, t, type Locale } from '../i18n'
import { isDesktop } from './env'
import { setFetchTransport, type FetchLike } from './transport'

/* ---------------------------------------------------------------------------
 * Tauri IPC
 * ------------------------------------------------------------------------- */

interface TauriInternals {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>
  transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number
  unregisterCallback: (id: number) => void
}

function tauriInternals(): TauriInternals {
  const scope = window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
  const value = scope.__TAURI_INTERNALS__
  if (!value)
    throw new Error('The desktop bridge is unavailable')
  return value
}

/** Invokes one command registered by the Tauri shell. */
export function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauriInternals().invoke<T>(command, args)
}

// The IPC serializer calls this key on objects and sends the returned value, so
// a channel reaches Rust as the "__CHANNEL__:<id>" string.
const SERIALIZE_TO_IPC_FN = '__TAURI_TO_IPC_KEY__'

interface ChannelEnvelope {
  index: number
  message?: unknown
  end?: unknown
}

/** Streaming counterpart of tauri::ipc::Channel; delivers messages in order. */
class IpcChannel {
  readonly id: number
  onmessage: (message: unknown) => void = () => {}

  private next = 0
  private pending = new Map<number, unknown>()
  private endedAt = -1

  constructor() {
    this.id = tauriInternals().transformCallback(raw => this.receive(raw as ChannelEnvelope))
  }

  private receive(raw: ChannelEnvelope): void {
    if ('end' in raw) {
      this.endedAt = raw.index
      this.releaseIfDone()
      return
    }
    if (raw.index !== this.next) {
      this.pending.set(raw.index, raw.message)
      return
    }
    this.next += 1
    this.onmessage(raw.message)
    while (this.pending.has(this.next)) {
      const message = this.pending.get(this.next)
      this.pending.delete(this.next)
      this.next += 1
      this.onmessage(message)
    }
    this.releaseIfDone()
  }

  private releaseIfDone(): void {
    if (this.endedAt !== this.next)
      return
    try {
      tauriInternals().unregisterCallback(this.id)
    }
    catch {
      // The webview is already closing.
    }
  }

  [SERIALIZE_TO_IPC_FN](): string {
    return '__CHANNEL__:' + String(this.id)
  }

  toJSON(): string {
    return '__CHANNEL__:' + String(this.id)
  }
}

interface TauriEvent<T> {
  payload: T
}

/** Subscribes to one webview event; resolves with the unsubscribe function. */
async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const handlerId = tauriInternals().transformCallback(raw => handler((raw as TauriEvent<T>).payload))
  const eventId = await desktopInvoke<number>('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: handlerId,
  })
  return async () => {
    try {
      const scope = window as unknown as {
        __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener?: (event: string, id: number) => void }
      }
      scope.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(event, eventId)
    }
    catch {
      // The listener is also removed when the window closes.
    }
    try {
      await desktopInvoke('plugin:event|unlisten', { event, eventId })
    }
    catch {
      // Already unregistered.
    }
  }
}

/* ---------------------------------------------------------------------------
 * Types shared with the shell
 * ------------------------------------------------------------------------- */

export interface DesktopSession {
  id: string
  endpoint: string
  local: boolean
  /** Hub identity returned when the session was activated. */
  status?: Record<string, unknown> | null
}

export interface DesktopHubConnection {
  id: string
  name: string
  endpoint: string
  local: boolean
  serverId: string | null
  certificate: string | null
}

export interface DesktopSettings {
  connections: DesktopHubConnection[]
  active: string | null
  localPort: number
  networkPort: number
  networkEnabled: boolean
  networkAddresses: string[]
  certificate: string | null
  cliPath: string
  notificationsEnabled: boolean
  notificationSoundEnabled: boolean
  notificationStatus: string
  /** Whether this device's hub keeps running while another hub is selected. */
  keepLocalHubRunning: boolean
  /** Why this device's hub last failed to start, until it starts. */
  localHubError: string | null
  /** A hub from an earlier run of the app holds the local port and can be stopped. */
  leftoverHub: boolean
}

export interface DesktopSessionState {
  session: DesktopSession | null
  /** False until the bootstrap attempt finished; the shell shows a boot screen. */
  ready: boolean
  error: string
}

export interface RemoteHubOptions {
  name: string
  endpoint: string
  token: string
  certificate?: string | null
}

export interface LocalHubSettings {
  localPort: number
  networkPort: number
  networkEnabled: boolean
}

export interface DesktopNotificationTarget {
  connectionId: string
  serverId: string
  accountId: string
  threadId: string
  /** The message that raised the alert, when the notification knows it. */
  messageId?: string
}

export interface DesktopNotificationFocus {
  connectionId: string
  accountId?: string | null
  threadId?: string | null
}

export interface AccountNotificationPreference {
  enabled: boolean
  desktopEnabled: boolean
}

export interface DesktopUpdateStatus {
  phase: string
  version: string | null
  downloaded: number
  total: number | null
  error: string | null
}

export interface DesktopUpdateSettings {
  currentVersion: string
  automatic: boolean
  prereleases: boolean
  status: DesktopUpdateStatus
}

export interface DesktopUpdatePreferences {
  automatic: boolean
  prereleases: boolean
}

export interface DesktopUpdatesState {
  settings: DesktopUpdateSettings | null
  ready: boolean
  error: string
}

/* ---------------------------------------------------------------------------
 * Small subscribable state used by the shell hooks
 * ------------------------------------------------------------------------- */

interface BridgeStore<T extends object> {
  getState: () => T
  setState: (patch: Partial<T> | ((state: T) => Partial<T>)) => void
  subscribe: (listener: () => void) => () => void
}

function createBridgeStore<T extends object>(initial: T): BridgeStore<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch
      state = { ...state, ...next }
      for (const listener of listeners)
        listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const sessionStore = createBridgeStore<DesktopSessionState>({ session: null, ready: false, error: '' })
const updateStore = createBridgeStore<DesktopUpdatesState>({ settings: null, ready: false, error: '' })

let activeSession: DesktopSession | null = null
let settleSessionReady: (session: DesktopSession | null) => void = () => {}
const sessionReady = new Promise<DesktopSession | null>((resolve) => {
  settleSessionReady = resolve
})

/**
 * Resolves once the bootstrap attempt finished, with the latched session or
 * null when the connect screen should show. In desktop mode the shell must not
 * start the engine before this resolves.
 */
export function whenDesktopSessionReady(): Promise<DesktopSession | null> {
  return sessionReady
}

function latchSession(session: DesktopSession | null): void {
  activeSession = session
  sessionStore.setState({ session })
}

/** The hub identity's stable id, used by per-account notification settings. */
export function desktopServerId(session: DesktopSession | null): string | null {
  const status = session?.status
  if (!status || typeof status !== 'object')
    return null
  const value = (status as Record<string, unknown>).serverId
  return typeof value === 'string' && value ? value : null
}

/** Turns a rejected command (usually the Rust error string) into display text. */
export function desktopErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error)
    return error
  if (error instanceof Error && error.message)
    return error.message
  return t('操作未能完成。')
}

/* ---------------------------------------------------------------------------
 * Authenticated request transport
 * ------------------------------------------------------------------------- */

interface HubResponseHead {
  status: number
  headers: Record<string, string>
}

type ResponsePacket = { type: 'data', bytes: string } | { type: 'end' } | { type: 'error' }

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

/** Maps a client API URL onto the hub's /v1 API. */
function hubUrl(session: DesktopSession, href: string): URL {
  const base = session.endpoint.endsWith('/') ? session.endpoint : session.endpoint + '/'
  const url = new URL(href, base)
  if (url.origin !== new URL(session.endpoint).origin)
    throw new Error('Unexpected hub origin')
  if (url.pathname === '/client/v1' || url.pathname.startsWith('/client/v1/')) {
    const rest = url.pathname.slice('/client/v1'.length)
    url.pathname = rest || '/'
  }
  if (!url.pathname.startsWith('/v1/') && url.pathname !== '/health')
    throw new Error('Unexpected hub path')
  return url
}

/** WebKit cannot always expose a FormData request body, so encode it here. */
function encodeMultipart(form: FormData): { body: Blob, contentType: string } {
  const boundary = '----agentwechat-' + crypto.randomUUID()
  const quote = (value: string) => value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22')
  const parts: BlobPart[] = []
  for (const [name, value] of form) {
    let header = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + quote(name) + '"'
    if (typeof value === 'string') {
      parts.push(header + '\r\n\r\n', value.replace(/\r\n|\r|\n/g, '\r\n'), '\r\n')
    }
    else {
      header += '; filename="' + quote(value.name) + '"\r\nContent-Type: '
        + (value.type || 'application/octet-stream')
      parts.push(header + '\r\n\r\n', value, '\r\n')
    }
  }
  parts.push('--' + boundary + '--\r\n')
  const contentType = 'multipart/form-data; boundary=' + boundary
  return { body: new Blob(parts, { type: contentType }), contentType }
}

const CHUNK_SIZE = 65_536

async function uploadToShell(body: Blob | ReadableStream<Uint8Array>, id: string): Promise<void> {
  await desktopInvoke('http_body_begin', { id })
  const reader = (body instanceof Blob ? body.stream() : body).getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done)
        break
      for (let offset = 0; offset < next.value.length; offset += CHUNK_SIZE) {
        await desktopInvoke('http_body_chunk', {
          id,
          bytes: Array.from(next.value.subarray(offset, offset + CHUNK_SIZE)),
        })
      }
    }
  }
  finally {
    reader.releaseLock()
  }
}

async function desktopRequest(session: DesktopSession, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const source = typeof input === 'string' || input instanceof URL ? null : input
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = hubUrl(session, href)
  const form = init?.body instanceof FormData ? init.body : null
  const multipart = form ? encodeMultipart(form) : null
  const headers = new Headers(init?.headers ?? source?.headers)
  if (multipart) {
    headers.set('Content-Type', multipart.contentType)
    headers.delete('content-length')
  }
  const request = new Request(url, {
    ...(source ? { method: source.method } : {}),
    ...init,
    headers,
    body: multipart ? null : init?.body,
  })

  const id = crypto.randomUUID()
  let finished = false
  let ended = false
  let waiting = false
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const queued: Uint8Array[] = []

  const cleanup = () => request.signal.removeEventListener('abort', abort)
  const cancel = () => {
    if (finished)
      return
    finished = true
    cleanup()
    void desktopInvoke('http_cancel', { id }).catch(() => {})
  }
  const abort = () => {
    cancel()
    try {
      controller?.error(request.signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    catch {
      // The stream was already closed.
    }
  }
  const pump = () => {
    if (finished || !controller)
      return
    if (waiting && queued.length) {
      waiting = false
      controller.enqueue(queued.shift()!)
      void desktopInvoke('http_ack', { id }).catch(() => {})
    }
    if (ended && !queued.length) {
      finished = true
      cleanup()
      controller.close()
    }
  }

  request.signal.addEventListener('abort', abort, { once: true })
  try {
    throwIfAborted(request.signal)
    const hasBody = Boolean(multipart) || request.body !== null
    if (hasBody) {
      if (multipart)
        await uploadToShell(multipart.body, id)
      else
        await uploadToShell(request.body!, id)
    }
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
      pull() {
        waiting = true
        pump()
      },
      cancel,
    }, { highWaterMark: 0 })
    const channel = new IpcChannel()
    channel.onmessage = (message) => {
      if (finished)
        return
      const packet = message as ResponsePacket
      if (packet.type === 'data') {
        const raw = atob(packet.bytes)
        queued.push(Uint8Array.from(raw, character => character.charCodeAt(0)))
        pump()
      }
      else if (packet.type === 'end') {
        ended = true
        pump()
      }
      else {
        cancel()
        try {
          controller?.error(new Error('The hub connection was interrupted'))
        }
        catch {
          // The stream was already closed.
        }
      }
    }
    // The transport attaches the hub key on the Rust side.
    const requestHeaders = Object.fromEntries(
      [...request.headers].filter(([name]) => name !== 'authorization'),
    )
    const head = await desktopInvoke<HubResponseHead>('http_request', {
      request: {
        id,
        connectionId: session.id,
        path: url.pathname + url.search,
        method: request.method,
        headers: requestHeaders,
        body: hasBody,
      },
      channel,
    })
    throwIfAborted(request.signal)
    if ([101, 204, 205, 304].includes(head.status) || request.method === 'HEAD') {
      cancel()
      return new Response(null, head)
    }
    return new Response(stream, head)
  }
  catch (error) {
    cancel()
    throw error
  }
}

/**
 * Request transport that proxies the client API through the shell. Requests
 * issued while the saved hub is still starting wait for the bootstrap attempt.
 */
export const desktopFetch: FetchLike = async (input, init) => {
  let session = activeSession
  if (!session) {
    session = await sessionReady
    if (!session)
      throw new Error('Connect to a hub first')
  }
  return desktopRequest(session, input, init)
}

/* ---------------------------------------------------------------------------
 * Files
 * ------------------------------------------------------------------------- */

/** Saves a blob through the native save dialog; false when the user cancels. */
export async function saveDesktopFile(blob: Blob, filename: string): Promise<boolean> {
  const id = crypto.randomUUID()
  let saved = false
  try {
    await uploadToShell(blob, id)
    saved = await desktopInvoke<boolean>('desktop_save_file', { id, name: filename })
  }
  catch {
    saved = false
  }
  finally {
    void desktopInvoke('http_cancel', { id }).catch(() => {})
  }
  return saved
}

/* ---------------------------------------------------------------------------
 * Hub session bridge
 * ------------------------------------------------------------------------- */

/** Restores the hub selected during the previous run of the app. */
export async function bootstrapDesktopSession(): Promise<DesktopSession | null> {
  try {
    const session = await desktopInvoke<DesktopSession | null>('desktop_bootstrap')
    latchSession(session)
    sessionStore.setState({ error: '' })
    return session
  }
  catch (error) {
    sessionStore.setState({ error: desktopErrorMessage(error) })
    return null
  }
  finally {
    sessionStore.setState({ ready: true })
    settleSessionReady(activeSession)
  }
}

async function activateHub(command: string, args?: Record<string, unknown>): Promise<DesktopSession> {
  const session = await desktopInvoke<DesktopSession>(command, args)
  sessionStore.setState({ error: '' })
  latchSession(session)
  return session
}

/** Starts this device's hub and selects it. */
export function selectLocalHub(): Promise<DesktopSession> {
  return activateHub('desktop_local')
}

/** Saves and selects a hub reachable over the network. */
export function selectRemoteHub(options: RemoteHubOptions): Promise<DesktopSession> {
  return activateHub('desktop_remote', {
    name: options.name,
    endpoint: options.endpoint,
    key: options.token,
    certificate: options.certificate ?? null,
  })
}

/** Selects a hub saved by an earlier connection. */
export function selectSavedHub(id: string): Promise<DesktopSession> {
  return activateHub('desktop_select', { id })
}

/** Reads every saved hub, port choice and notification state. */
export function loadDesktopSettings(): Promise<DesktopSettings> {
  return desktopInvoke<DesktopSettings>('desktop_settings')
}

/** Applies local hub ports and restarts the hub when needed. */
export async function saveLocalHubSettings(settings: LocalHubSettings): Promise<DesktopSession | null> {
  const session = await desktopInvoke<DesktopSession | null>('desktop_save_local', { settings })
  if (session)
    latchSession(session)
  return session
}

/** Keeps this device's hub running while another hub is selected. */
export function keepLocalHubRunning(enabled: boolean): Promise<void> {
  return desktopInvoke('desktop_keep_local_hub', { enabled })
}

/** Stops a hub an earlier run of the app left on the local port. */
export async function stopLeftoverHub(): Promise<DesktopSession | null> {
  const session = await desktopInvoke<DesktopSession | null>('desktop_stop_leftover_hub')
  if (session)
    latchSession(session)
  return session
}

/** Forgets a saved remote hub and its access key. */
export async function forgetHub(id: string): Promise<void> {
  await desktopInvoke('desktop_forget', { id })
  if (activeSession?.id === id)
    latchSession(null)
}

/** Copies a saved hub access key to the system clipboard. */
export function copyHubKey(id: string): Promise<void> {
  return desktopInvoke('desktop_copy_key', { id })
}

/** Reports the interface language for tray and notification text. */
export function syncDesktopLanguage(locale: Locale): Promise<void> {
  return desktopInvoke('desktop_language', { language: locale === 'en' ? 'en' : 'zh-CN' })
}

/* ---------------------------------------------------------------------------
 * Notifications
 * ------------------------------------------------------------------------- */

/** Tells the shell which conversation is on screen, for notification clicks. */
export function setNotificationContext(focus: DesktopNotificationFocus | null): Promise<void> {
  return desktopInvoke('notifications_context', { focus })
}

export function setNotificationsEnabled(enabled: boolean): Promise<void> {
  return desktopInvoke('notifications_enabled', { enabled })
}

export function setNotificationSoundEnabled(enabled: boolean): Promise<void> {
  return desktopInvoke('notifications_sound_enabled', { enabled })
}

export function loadAccountNotificationSettings(
  connectionId: string,
  serverId: string,
  accountId: string,
): Promise<AccountNotificationPreference> {
  return desktopInvoke<AccountNotificationPreference>('notifications_account_settings', {
    connectionId,
    serverId,
    accountId,
  })
}

export function saveAccountNotificationSettings(
  connectionId: string,
  serverId: string,
  accountId: string,
  enabled: boolean,
): Promise<AccountNotificationPreference> {
  return desktopInvoke<AccountNotificationPreference>('notifications_account_settings', {
    connectionId,
    serverId,
    accountId,
    enabled,
  })
}

/**
 * Calls `open` with the target of every notification the user clicks on this
 * hub. Clicks for another window's connection stay pending.
 */
export function subscribeDesktopNotifications(open: (target: DesktopNotificationTarget) => void): () => void {
  let stopped = false
  let unlisten: (() => void) | undefined
  const take = async () => {
    // Name this window's connection so a target for another connection stays pending.
    const session = activeSession
    if (!session)
      return
    const target = await desktopInvoke<DesktopNotificationTarget | null>('notifications_take_target', {
      connectionId: session.id,
    })
    if (!target || stopped || target.connectionId !== activeSession?.id)
      return
    open(target)
  }
  void listenEvent('desktop-open-thread', () => {
    void take().catch(() => {})
  }).then((stop) => {
    if (stopped)
      void stop()
    else
      unlisten = stop
  }).catch(() => {})
  const focus = () => {
    void take().catch(() => {})
  }
  window.addEventListener('focus', focus)
  focus()
  return () => {
    stopped = true
    window.removeEventListener('focus', focus)
    if (unlisten)
      void unlisten()
  }
}

/* ---------------------------------------------------------------------------
 * Shell helpers
 * ------------------------------------------------------------------------- */

/** Opens an http(s) address in the user's browser. */
export function openExternal(url: string): Promise<void> {
  return desktopInvoke('plugin:opener|open_url', { url })
}

/** Shows a saved file in the system file manager. */
export function revealInFolder(path: string): Promise<void> {
  return desktopInvoke('plugin:opener|reveal_item_in_dir', { path })
}

/** Stops this device's hub and quits the app. */
export function quitDesktopApp(): Promise<void> {
  return desktopInvoke('desktop_quit')
}

async function saveBlobUrl(url: string, name: string): Promise<void> {
  const response = await globalThis.fetch(url)
  await saveDesktopFile(await response.blob(), name)
}

/**
 * Sends link clicks outside the app: blob downloads through the save dialog,
 * http(s) links to the browser. Without this a link would navigate the webview.
 */
function installDesktopLinks(): void {
  const click = (event: MouseEvent) => {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]')
    if (!link || event.defaultPrevented)
      return
    if (link.hasAttribute('download') && link.href.startsWith('blob:')) {
      event.preventDefault()
      void saveBlobUrl(link.href, link.download || 'download').catch(() => {
        globalThis.dispatchEvent(new CustomEvent('desktop-error', {
          detail: t('文件保存失败，请重新下载。'),
        }))
      })
    }
    else if (/^https?:/.test(link.href)) {
      event.preventDefault()
      void openExternal(link.href).catch(() => {})
    }
  }
  document.addEventListener('click', click)
}

/* ---------------------------------------------------------------------------
 * Updates
 * ------------------------------------------------------------------------- */

/** Reads update preferences and progress. */
export async function loadUpdateSettings(): Promise<DesktopUpdateSettings> {
  const settings = await desktopInvoke<DesktopUpdateSettings>('updates_status')
  updateStore.setState({ settings, ready: true })
  return settings
}

/** Starts a manual check; the result arrives through the update state. */
export async function checkForUpdates(): Promise<void> {
  updateStore.setState({ error: '' })
  try {
    await desktopInvoke('updates_check')
  }
  catch (error) {
    updateStore.setState({ error: desktopErrorMessage(error) })
  }
  await loadUpdateSettings().catch(() => {})
}

/** Downloads, verifies and installs the pending update, then restarts. */
export async function installUpdate(): Promise<void> {
  updateStore.setState({ error: '' })
  try {
    await desktopInvoke('updates_install')
  }
  catch (error) {
    updateStore.setState({ error: desktopErrorMessage(error) })
  }
  await loadUpdateSettings().catch(() => {})
}

/** Saves automatic/pre-release update preferences. */
export async function saveUpdatePreferences(preferences: DesktopUpdatePreferences): Promise<void> {
  await desktopInvoke('updates_preferences', { preferences })
  await loadUpdateSettings().catch(() => {})
}

/* ---------------------------------------------------------------------------
 * React bindings
 * ------------------------------------------------------------------------- */

export function useDesktopSession(): DesktopSessionState {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getState, sessionStore.getState)
}

export function useDesktopUpdates(): DesktopUpdatesState {
  const state = useSyncExternalStore(updateStore.subscribe, updateStore.getState, updateStore.getState)
  const phase = state.settings?.status.phase ?? ''
  useEffect(() => {
    if (!isDesktop())
      return
    let active = true
    let stop: (() => void) | undefined
    void listenEvent<DesktopUpdateStatus>('desktop-update-status', (status) => {
      updateStore.setState(current => current.settings
        ? { settings: { ...current.settings, status }, ...(status.error ? {} : { error: '' }) }
        : {})
    }).then((unlisten) => {
      if (active)
        stop = unlisten
      else
        void unlisten()
    }).catch(() => {})
    void loadUpdateSettings().catch((error) => {
      if (!active)
        return
      updateStore.setState({ ready: true, error: desktopErrorMessage(error) })
    })
    return () => {
      active = false
      if (stop)
        void stop()
    }
  }, [])
  useEffect(() => {
    if (!isDesktop())
      return
    const delay = phase === 'downloading' || phase === 'installing' ? 1000 : 15_000
    const timer = window.setInterval(() => {
      void loadUpdateSettings().catch(() => {})
    }, delay)
    return () => window.clearInterval(timer)
  }, [phase])
  return state
}

/* ---------------------------------------------------------------------------
 * Bootstrap
 * ------------------------------------------------------------------------- */

/** Key used by the browser handoff for the ?auth= hub token. */
const HUB_AUTH_STORAGE_KEY = 'wechat.hub-auth'

/**
 * Installs the authenticated transport and starts restoring the saved hub.
 * Resolves immediately; the shell gates its engine on whenDesktopSessionReady().
 */
export async function initDesktopPlatform(): Promise<void> {
  // The desktop shell never carries a browser handoff token, so remove one an
  // earlier visit may have stored before any request could use it.
  try {
    window.sessionStorage.removeItem(HUB_AUTH_STORAGE_KEY)
  }
  catch {
    // Storage may be unavailable; the transport does not read it.
  }
  try {
    window.localStorage.removeItem(HUB_AUTH_STORAGE_KEY)
  }
  catch {
    // Same as above.
  }
  setFetchTransport(desktopFetch, { providesAuth: true })
  installDesktopLinks()
  subscribeLocale(() => {
    void syncDesktopLanguage(getLocale()).catch(() => {})
  })
  void syncDesktopLanguage(getLocale()).catch(() => {})
  void bootstrapDesktopSession()
}