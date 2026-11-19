// Appearance settings, incoming-message toast cards, the image lightbox and
// the rail view. Everything here is pure interface state.

import { previewText, threadName, threadNoNotify } from '../../format'
import { t } from '../../i18n'
import type { IncomingToast, UiState } from '../state'
import type { ThemeMode, UiTheme } from '../../types'
import { TOAST_RECENT_WINDOW_MS, toastDelayTimers, toastTimers } from '../caches'
import { getState, setMessages, setThreads, setUi } from '../state'
import { loadThreads, selectThread } from './threads'

export const UI_SETTINGS_KEY = 'vane.wechat.ui-settings'
export const DEFAULT_BUBBLE_FONT_SIZE = 13.5
/** Default time an incoming toast stays on screen, adjustable in settings. */
export const DEFAULT_TOAST_DURATION = 4200
/** Maximum number of toast cards stacked at once. */
export const TOAST_LIMIT = 3

// Labels are getters so the catalogue lookup happens when a component renders,
// not when this module is first imported.
export const UI_THEMES: UiTheme[] = [
  {
    id: 'blue',
    get label() { return t('默认蓝') },
    accent: '#2f7cf6',
    accentStrong: '#1f6feb',
    accentSoft: 'rgba(47, 124, 246, 0.16)',
    accentFaint: 'rgba(47, 124, 246, 0.06)',
    bubble: 'linear-gradient(135deg, #2f7cf6, #245fdc)',
  },
  {
    id: 'green',
    get label() { return t('微信绿') },
    accent: '#22c55e',
    accentStrong: '#0e9f6e',
    accentSoft: 'rgba(34, 197, 94, 0.16)',
    accentFaint: 'rgba(34, 197, 94, 0.06)',
    bubble: 'linear-gradient(135deg, #22c55e, #0e9f6e)',
  },
  {
    id: 'purple',
    get label() { return t('紫罗兰') },
    accent: '#8b5cf6',
    accentStrong: '#6d28d9',
    accentSoft: 'rgba(139, 92, 246, 0.16)',
    accentFaint: 'rgba(139, 92, 246, 0.06)',
    bubble: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
  },
  {
    id: 'orange',
    get label() { return t('暖橙') },
    accent: '#f97316',
    accentStrong: '#ea580c',
    accentSoft: 'rgba(249, 115, 22, 0.16)',
    accentFaint: 'rgba(249, 115, 22, 0.06)',
    bubble: 'linear-gradient(135deg, #f97316, #ea580c)',
  },
  {
    id: 'rose',
    get label() { return t('玫红') },
    accent: '#f43f5e',
    accentStrong: '#e11d48',
    accentSoft: 'rgba(244, 63, 94, 0.16)',
    accentFaint: 'rgba(244, 63, 94, 0.06)',
    bubble: 'linear-gradient(135deg, #f43f5e, #e11d48)',
  },
]

function normalizeHexColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : ''
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function mixHex(base: string, target: string, ratio: number): string {
  const from = hexToRgb(base)
  const to = hexToRgb(target)
  const channel = (index: number) => Math.round(from[index] + (to[index] - from[index]) * ratio)
  return `#${channel(0).toString(16).padStart(2, '0')}${channel(1).toString(16).padStart(2, '0')}${channel(2).toString(16).padStart(2, '0')}`
}

function rgbaColor(hex: string, alpha: number): string {
  const [red, green, blue] = hexToRgb(hex)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function relativeLuminance(hex: string): number {
  const channel = (value: number) => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }
  const [red, green, blue] = hexToRgb(hex)
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

function readableTextColor(hex: string): string {
  return relativeLuminance(hex) > 0.5 ? '#0f172a' : '#ffffff'
}

export interface StoredUiSettings {
  themeId: string
  bubbleFontSize: number
  themeMode: ThemeMode
  bubbleInColor: string
  bubbleOutColor: string
  toastDurationMs: number
  toastEnabled: boolean
}

function defaultUiSettings(): StoredUiSettings {
  return {
    themeId: 'blue',
    bubbleFontSize: DEFAULT_BUBBLE_FONT_SIZE,
    themeMode: 'dark',
    bubbleInColor: '',
    bubbleOutColor: '',
    toastDurationMs: DEFAULT_TOAST_DURATION,
    toastEnabled: true,
  }
}

/** Reads the persisted appearance settings, falling back to the defaults. */
export function loadUiSettings(): StoredUiSettings {
  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_KEY)
    if (!raw)
      return defaultUiSettings()
    const parsed = JSON.parse(raw) as {
      themeId?: unknown
      bubbleFontSize?: unknown
      themeMode?: unknown
      bubbleInColor?: unknown
      bubbleOutColor?: unknown
      toastDurationMs?: unknown
      toastEnabled?: unknown
    }
    const themeId = typeof parsed.themeId === 'string' && UI_THEMES.some(theme => theme.id === parsed.themeId)
      ? parsed.themeId
      : 'blue'
    const size = typeof parsed.bubbleFontSize === 'number' && Number.isFinite(parsed.bubbleFontSize)
      ? Math.min(18, Math.max(12, parsed.bubbleFontSize))
      : DEFAULT_BUBBLE_FONT_SIZE
    const themeMode = parsed.themeMode === 'light' ? 'light' : 'dark'
    const toastDuration = typeof parsed.toastDurationMs === 'number' && Number.isFinite(parsed.toastDurationMs)
      ? Math.min(30_000, Math.max(2_000, parsed.toastDurationMs))
      : DEFAULT_TOAST_DURATION
    return {
      themeId,
      bubbleFontSize: size,
      themeMode,
      bubbleInColor: normalizeHexColor(parsed.bubbleInColor),
      bubbleOutColor: normalizeHexColor(parsed.bubbleOutColor),
      toastDurationMs: toastDuration,
      toastEnabled: parsed.toastEnabled !== false,
    }
  }
  catch {
    return defaultUiSettings()
  }
}

/** Writes the theme variables onto the document root. */
export function applyUiSettings(): void {
  if (typeof document === 'undefined')
    return
  const ui = getState().ui
  const theme = UI_THEMES.find(item => item.id === ui.themeId) ?? UI_THEMES[0]
  const root = document.documentElement
  root.style.setProperty('--accent', theme.accent)
  root.style.setProperty('--accent-strong', theme.accentStrong)
  root.style.setProperty('--accent-soft', theme.accentSoft)
  root.style.setProperty('--accent-faint', theme.accentFaint)
  root.style.setProperty('--bubble-font-size', `${ui.bubbleFontSize}px`)
  root.classList.toggle('theme-light', ui.themeMode === 'light')

  const incoming = normalizeHexColor(ui.bubbleInColor)
    || (ui.themeMode === 'light' ? '#ffffff' : '#1a212c')
  const outgoing = normalizeHexColor(ui.bubbleOutColor) || theme.accent
  const incomingText = readableTextColor(incoming)
  const outgoingText = readableTextColor(outgoing)

  root.style.setProperty('--bubble-in', incoming)
  root.style.setProperty('--bubble-in-bg', `linear-gradient(180deg, ${mixHex(incoming, '#ffffff', 0.05)}, ${incoming})`)
  root.style.setProperty('--bubble-in-text', incomingText)
  root.style.setProperty('--bubble-in-meta', rgbaColor(incomingText, 0.58))
  root.style.setProperty('--bubble-in-surface', rgbaColor(incomingText, 0.08))
  root.style.setProperty('--bubble-in-surface-strong', rgbaColor(incomingText, 0.14))
  root.style.setProperty('--bubble-in-danger', incomingText === '#ffffff' ? '#fecaca' : '#b91c1c')

  root.style.setProperty('--bubble-out', `linear-gradient(135deg, ${outgoing}, ${mixHex(outgoing, '#000000', 0.12)})`)
  root.style.setProperty('--bubble-out-text', outgoingText)
  root.style.setProperty('--bubble-out-meta', rgbaColor(outgoingText, 0.74))
  root.style.setProperty('--bubble-out-surface', rgbaColor(outgoingText, 0.12))
  root.style.setProperty('--bubble-out-surface-strong', rgbaColor(outgoingText, 0.18))
  root.style.setProperty('--bubble-out-danger', outgoingText === '#ffffff' ? '#fecaca' : '#b91c1c')
  root.style.setProperty('--bubble-out-shadow', `0 3px 12px ${rgbaColor(outgoing, 0.24)}, inset 0 1px 0 ${rgbaColor(outgoingText, 0.14)}`)
}

/** Persists the appearance settings to localStorage. */
export function persistUiSettings(): void {
  try {
    const ui = getState().ui
    window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({
      themeId: ui.themeId,
      bubbleFontSize: ui.bubbleFontSize,
      themeMode: ui.themeMode,
      bubbleInColor: ui.bubbleInColor,
      bubbleOutColor: ui.bubbleOutColor,
      toastDurationMs: ui.toastDurationMs,
      toastEnabled: ui.toastEnabled,
    }))
  }
  catch {
    // Storage may be unavailable in private modes; the current session keeps working.
  }
}

/** Restores persisted settings into the store and applies them. */
export function initializeUiSettings(): void {
  const stored = loadUiSettings()
  setUi({
    themeId: stored.themeId,
    bubbleFontSize: stored.bubbleFontSize,
    themeMode: stored.themeMode,
    bubbleInColor: stored.bubbleInColor,
    bubbleOutColor: stored.bubbleOutColor,
    toastDurationMs: stored.toastDurationMs,
    toastEnabled: stored.toastEnabled,
  })
  applyUiSettings()
}

// Applied while the module graph loads so the first paint already uses the
// saved theme; the engine re-applies it when it starts.
if (typeof window !== 'undefined')
  initializeUiSettings()

function updateUi(patch: Partial<UiState>): void {
  setUi(patch)
  applyUiSettings()
  persistUiSettings()
}

export function setThemeId(themeId: string): void {
  updateUi({ themeId })
}

export function setThemeMode(themeMode: ThemeMode): void {
  updateUi({ themeMode })
}

export function setBubbleFontSize(bubbleFontSize: number): void {
  updateUi({ bubbleFontSize })
}

export function setBubbleInColor(bubbleInColor: string): void {
  updateUi({ bubbleInColor })
}

export function setBubbleOutColor(bubbleOutColor: string): void {
  updateUi({ bubbleOutColor })
}

export function setToastDurationMs(toastDurationMs: number): void {
  updateUi({ toastDurationMs })
}

export function setToastEnabled(toastEnabled: boolean): void {
  updateUi({ toastEnabled })
}

export function setRailView(railView: UiState['railView']): void {
  setUi({ railView })
}

/** Opens the contact detail card for one saved contact. */
export function openContactEditor(contactId: string): void {
  const id = contactId.trim()
  if (id)
    setUi({ contactEditorId: id })
}

/** Closes the contact detail card. */
export function closeContactEditor(): void {
  setUi({ contactEditorId: null })
}

/** Opens the image lightbox at the given source; null closes it. */
export function setLightboxSrc(lightboxSrc: string | null): void {
  setMessages({ lightboxSrc })
}

export function closeLightbox(): void {
  setMessages({ lightboxSrc: null })
}

/** Removes one toast card and its timer. */
export function dismissToast(id: string): void {
  const timer = toastTimers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    toastTimers.delete(id)
  }
  setUi(state => ({ toasts: state.toasts.filter(item => item.id !== id) }))
}

/** Pushes a toast card for a conversation whose newest message is recent. */
export function pushIncomingToast(threadId: string): void {
  const state = getState()
  if (!state.ui.toastEnabled)
    return
  const thread = state.threads.items.find(item => item.id === threadId)
  if (!thread)
    return
  // Muted conversations and official accounts never raise a card; their unread
  // badge stays, matching the official client.
  if (threadNoNotify(thread))
    return
  if ((thread.lastMessage?.direction ?? '') === 'outgoing')
    return
  // Only unread conversations notify; the open conversation is already read.
  if ((thread.unreadCount ?? 0) <= 0)
    return
  // Only the newest message counts: a backfilled history import is silent even
  // when the event itself is fresh.
  const latestAt = Date.parse(thread.lastMessage?.createdAt ?? '')
  if (!Number.isFinite(latestAt) || Date.now() - latestAt > TOAST_RECENT_WINDOW_MS)
    return
  const preview = previewText(thread).trim()
  if (!preview)
    return

  for (const item of [...state.ui.toasts]) {
    if (item.threadId === threadId)
      dismissToast(item.id)
  }

  const toast: IncomingToast = {
    id: `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    name: threadName(thread),
    preview,
  }
  setUi(state => ({ toasts: [toast, ...state.toasts].slice(0, TOAST_LIMIT) }))
  toastTimers.set(toast.id, window.setTimeout(() => dismissToast(toast.id), getState().ui.toastDurationMs))
}

/** Waits for the list refresh to carry the new preview, then shows the card. */
export function scheduleIncomingToast(threadId: string): void {
  const existing = toastDelayTimers.get(threadId)
  if (existing !== undefined)
    window.clearTimeout(existing)
  toastDelayTimers.set(threadId, window.setTimeout(() => {
    toastDelayTimers.delete(threadId)
    pushIncomingToast(threadId)
  }, 500))
}

/** Opens the conversation a toast card points at. */
export function openToast(toast: IncomingToast): void {
  dismissToast(toast.id)
  const thread = getState().threads.items.find(item => item.id === toast.threadId)
  if (thread)
    void selectThread(thread)
  else
    void loadThreads()
}

/** Clears every toast timer (sign-out, unmount). */
export function clearToastTimers(): void {
  for (const timer of toastTimers.values())
    window.clearTimeout(timer)
  toastTimers.clear()
  for (const timer of toastDelayTimers.values())
    window.clearTimeout(timer)
  toastDelayTimers.clear()
}

/** Opens or closes the settings popover. */
export function setSettingsOpen(settingsOpen: boolean): void {
  setUi({ settingsOpen })
}

/** Opens or closes the contact search dialog. */
export function setContactDialogOpen(open: boolean): void {
  setThreads({ contactDialogOpen: open })
}
