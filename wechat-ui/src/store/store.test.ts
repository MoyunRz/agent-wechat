import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WechatApiError } from '../api'
import { t } from '../i18n'
import type { Thread } from '../types'
import {
  DEFAULT_BUBBLE_FONT_SIZE,
  DEFAULT_TOAST_DURATION,
  UI_SETTINGS_KEY,
  UI_THEMES,
  applyUiSettings,
  initializeUiSettings,
  loadUiSettings,
  persistUiSettings,
  setBubbleFontSize,
  setBubbleInColor,
  setBubbleOutColor,
  setThemeId,
  setThemeMode,
  setToastDurationMs,
  setToastEnabled,
} from './actions/ui'
import { selectActiveThread } from './actions/threads'
import {
  errorText,
  isSignedIn,
  selectConnectionState,
  selectStreamLabel,
} from './actions/session'
import { createStore } from './create'
import { getState, initialState, setMessages, setSession, setThreads, setUi, store } from './state'

function thread(patch: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    accountId: 'account-1',
    peerId: 'peer-1',
    kind: 'direct',
    displayName: 'Peer One',
    unreadCount: 0,
    readStateVersion: 'v1',
    ...patch,
  }
}

function resetStore(): void {
  store.setState(() => ({
    session: { ...initialState.session },
    threads: { ...initialState.threads, contactNames: new Map(), friendNames: new Set(), readAt: {} },
    messages: { ...initialState.messages, mediaByMessage: {}, attachments: [], searchResults: [] },
    ui: { ...initialState.ui, toasts: [] },
  }))
}

beforeEach(() => {
  window.localStorage.clear()
  resetStore()
  document.documentElement.removeAttribute('style')
  document.documentElement.className = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  resetStore()
  window.localStorage.clear()
})

describe('createStore', () => {
  it('returns the initial state and merges object patches', () => {
    const storeUnderTest = createStore({ count: 1, label: 'a' })
    expect(storeUnderTest.getState()).toEqual({ count: 1, label: 'a' })

    storeUnderTest.setState({ count: 2 })
    expect(storeUnderTest.getState()).toEqual({ count: 2, label: 'a' })
  })

  it('supports a functional patch that receives the current state', () => {
    const storeUnderTest = createStore({ count: 1 })
    const seen: number[] = []
    storeUnderTest.setState((state) => {
      seen.push(state.count)
      return { count: state.count + 1 }
    })
    expect(seen).toEqual([1])
    expect(storeUnderTest.getState().count).toBe(2)
  })

  it('replaces the state object instead of mutating the previous snapshot', () => {
    const storeUnderTest = createStore({ count: 1 })
    const before = storeUnderTest.getState()
    storeUnderTest.setState({ count: 2 })
    expect(before.count).toBe(1)
    expect(storeUnderTest.getState()).not.toBe(before)
  })

  it('ignores an empty patch and does not notify listeners', () => {
    const storeUnderTest = createStore({ count: 1 })
    const listener = vi.fn()
    storeUnderTest.subscribe(listener)
    storeUnderTest.setState({})
    expect(storeUnderTest.getState().count).toBe(1)
    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies every subscriber once per change and stops after unsubscribe', () => {
    const storeUnderTest = createStore({ count: 1 })
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribe = storeUnderTest.subscribe(first)
    storeUnderTest.subscribe(second)

    storeUnderTest.setState({ count: 2 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    unsubscribe()
    storeUnderTest.setState({ count: 3 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })
})

describe('state slices', () => {
  it('exposes the reference defaults for every slice', () => {
    const state = getState()
    expect(state.session).toEqual({
      booting: true,
      bootError: '',
      account: null,
      selfName: '',
      loginAttempt: null,
      accountSlots: [],
      loginBusy: false,
      loginError: '',
      qrFailed: false,
      qrObjectUrl: null,
      loggingOut: false,
      offlineToggling: false,
      accountActionError: '',
      streamStatus: 'idle',
      manualRefreshing: false,
      friendRequestCount: 0,
    })
    expect(state.threads.items).toEqual([])
    expect(state.threads.filterMode).toBe('all')
    expect(state.threads.activeThreadId).toBeNull()
    expect(state.threads.contactNames).toBeInstanceOf(Map)
    expect(state.threads.friendNames).toBeInstanceOf(Set)
    expect(state.threads.allReadAt).toBe(0)
    expect(state.threads.readAt).toEqual({})
    expect(state.messages.items).toEqual([])
    expect(state.messages.cursor).toBeNull()
    expect(state.messages.draft).toBe('')
    expect(state.messages.attachments).toEqual([])
    expect(state.messages.searchOpen).toBe(false)
    expect(state.ui).toEqual({
      themeId: 'blue',
      bubbleFontSize: DEFAULT_BUBBLE_FONT_SIZE,
      themeMode: 'dark',
      bubbleInColor: '',
      bubbleOutColor: '',
      toastDurationMs: DEFAULT_TOAST_DURATION,
      toastEnabled: true,
      railView: 'chats',
      toasts: [],
      contactEditorId: null,
      settingsOpen: false,
    })
  })

  it('patches one slice without touching the others', () => {
    setSession({ loggingOut: true })
    setThreads({ query: 'alice' })
    setMessages({ draft: 'hello' })
    setUi({ railView: 'contacts' })

    const state = getState()
    expect(state.session.loggingOut).toBe(true)
    expect(state.threads.query).toBe('alice')
    expect(state.messages.draft).toBe('hello')
    expect(state.ui.railView).toBe('contacts')
    // Untouched fields keep their defaults.
    expect(state.session.booting).toBe(true)
    expect(state.threads.filterMode).toBe('all')
    expect(state.messages.cursor).toBeNull()
    expect(state.ui.themeId).toBe('blue')
  })

  it('supports a functional patch per slice', () => {
    setThreads({ query: 'ali' })
    setThreads(slice => ({ query: slice.query + 'ce' }))
    setMessages({ unseenBelow: 1 })
    setMessages(slice => ({ unseenBelow: slice.unseenBelow + 2 }))
    expect(getState().threads.query).toBe('alice')
    expect(getState().messages.unseenBelow).toBe(3)
  })

  it('notifies subscribers once per slice update', () => {
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    setMessages({ draft: 'x' })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

describe('selectors', () => {
  it('resolves the active conversation from the list', () => {
    const first = thread({ id: 'a' })
    const second = thread({ id: 'b', displayName: 'Bee' })
    setThreads({ items: [first, second], activeThreadId: 'b' })
    expect(selectActiveThread(getState())).toBe(second)
  })

  it('returns null when no conversation is open or the active row is gone', () => {
    setThreads({ items: [thread()], activeThreadId: null })
    expect(selectActiveThread(getState())).toBeNull()
    setThreads({ activeThreadId: 'missing' })
    expect(selectActiveThread(getState())).toBeNull()
  })
})

describe('loadUiSettings', () => {
  it('returns the defaults when nothing was stored', () => {
    expect(loadUiSettings()).toEqual({
      themeId: 'blue',
      bubbleFontSize: DEFAULT_BUBBLE_FONT_SIZE,
      themeMode: 'dark',
      bubbleInColor: '',
      bubbleOutColor: '',
      toastDurationMs: DEFAULT_TOAST_DURATION,
      toastEnabled: true,
    })
  })

  it('returns the defaults for a corrupt payload', () => {
    window.localStorage.setItem(UI_SETTINGS_KEY, '{not json')
    expect(loadUiSettings().themeId).toBe('blue')
    expect(loadUiSettings().toastEnabled).toBe(true)
  })

  it('restores persisted settings verbatim', () => {
    window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({
      themeId: 'rose',
      bubbleFontSize: 15.5,
      themeMode: 'light',
      bubbleInColor: '#AABBCC',
      bubbleOutColor: '#001122',
      toastDurationMs: 5_000,
      toastEnabled: false,
    }))
    expect(loadUiSettings()).toEqual({
      themeId: 'rose',
      bubbleFontSize: 15.5,
      themeMode: 'light',
      bubbleInColor: '#aabbcc',
      bubbleOutColor: '#001122',
      toastDurationMs: 5_000,
      toastEnabled: false,
    })
  })

  it('rejects unknown themes and non-light modes', () => {
    window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ themeId: 'nope', themeMode: 'LIGHT' }))
    const settings = loadUiSettings()
    expect(settings.themeId).toBe('blue')
    expect(settings.themeMode).toBe('dark')
  })

  it('clamps the bubble font size to 12..18 px', () => {
    const load = (value: unknown) => {
      window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ bubbleFontSize: value }))
      return loadUiSettings().bubbleFontSize
    }
    expect(load(11)).toBe(12)
    expect(load(18.4)).toBe(18)
    expect(load(30)).toBe(18)
    expect(load('15')).toBe(DEFAULT_BUBBLE_FONT_SIZE)
    expect(load(null)).toBe(DEFAULT_BUBBLE_FONT_SIZE)
  })

  it('clamps the toast duration to 2000..30000 ms', () => {
    const load = (value: unknown) => {
      window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ toastDurationMs: value }))
      return loadUiSettings().toastDurationMs
    }
    expect(load(1_000)).toBe(2_000)
    expect(load(60_000)).toBe(30_000)
    expect(load(-5)).toBe(2_000)
    expect(load('4200')).toBe(DEFAULT_TOAST_DURATION)
    expect(load(undefined)).toBe(DEFAULT_TOAST_DURATION)
  })

  it('normalizes bubble colors and drops invalid values', () => {
    window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({
      bubbleInColor: ' #FFEEDD ',
      bubbleOutColor: 'red',
    }))
    const settings = loadUiSettings()
    expect(settings.bubbleInColor).toBe('#ffeedd')
    expect(settings.bubbleOutColor).toBe('')
  })

  it('treats a missing toastEnabled as enabled and only false as disabled', () => {
    const load = (value: unknown) => {
      window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ toastEnabled: value }))
      return loadUiSettings().toastEnabled
    }
    expect(load(undefined)).toBe(true)
    expect(load(0)).toBe(true)
    expect(load('false')).toBe(true)
    expect(load(false)).toBe(false)
  })
})

describe('ui settings store and persistence', () => {
  it('writes the persisted key with the reference field names', () => {
    setThemeId('purple')
    const raw = window.localStorage.getItem(UI_SETTINGS_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw as string) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual([
      'bubbleFontSize',
      'bubbleInColor',
      'bubbleOutColor',
      'themeId',
      'themeMode',
      'toastDurationMs',
      'toastEnabled',
    ])
    expect(parsed.themeId).toBe('purple')
  })

  it('updates the store and document root through the setters', () => {
    setThemeId('green')
    setThemeMode('light')
    setBubbleFontSize(16)
    setToastDurationMs(6_000)
    setToastEnabled(false)

    const ui = getState().ui
    expect(ui.themeId).toBe('green')
    expect(ui.themeMode).toBe('light')
    expect(ui.bubbleFontSize).toBe(16)
    expect(ui.toastDurationMs).toBe(6_000)
    expect(ui.toastEnabled).toBe(false)

    const root = document.documentElement
    expect(root.classList.contains('theme-light')).toBe(true)
    expect(root.style.getPropertyValue('--accent')).toBe('#22c55e')
    expect(root.style.getPropertyValue('--bubble-font-size')).toBe('16px')
    expect(JSON.parse(window.localStorage.getItem(UI_SETTINGS_KEY) as string).toastEnabled).toBe(false)
  })

  it('applies the saved theme, mode and sizes on initialize', () => {
    window.localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({
      themeId: 'orange',
      bubbleFontSize: 17,
      themeMode: 'light',
      toastDurationMs: 3_000,
      toastEnabled: false,
    }))
    initializeUiSettings()

    expect(getState().ui.themeId).toBe('orange')
    expect(getState().ui.bubbleFontSize).toBe(17)
    expect(getState().ui.themeMode).toBe('light')
    expect(document.documentElement.classList.contains('theme-light')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#f97316')
    expect(document.documentElement.style.getPropertyValue('--bubble-font-size')).toBe('17px')
  })

  it('falls back to the first theme when the stored id is unknown', () => {
    setUi({ themeId: 'not-a-theme' })
    applyUiSettings()
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(UI_THEMES[0].accent)
  })

  it('derives bubble variables from the theme and mode', () => {
    applyUiSettings()
    const root = document.documentElement
    expect(root.style.getPropertyValue('--bubble-in')).toBe('#1a212c')
    expect(root.style.getPropertyValue('--bubble-in-text')).toBe('#ffffff')
    expect(root.style.getPropertyValue('--bubble-out')).toBe('linear-gradient(135deg, #2f7cf6, #296dd8)')
    expect(root.style.getPropertyValue('--bubble-out-text')).toBe('#ffffff')
    expect(root.style.getPropertyValue('--bubble-out-meta')).toBe('rgba(255, 255, 255, 0.74)')

    setThemeMode('light')
    expect(document.documentElement.classList.contains('theme-light')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--bubble-in')).toBe('#ffffff')
    expect(document.documentElement.style.getPropertyValue('--bubble-in-text')).toBe('#0f172a')

    setThemeMode('dark')
    expect(document.documentElement.classList.contains('theme-light')).toBe(false)
  })

  it('honours custom bubble colors and switches the readable text color', () => {
    setBubbleInColor('#ffffff')
    setBubbleOutColor('#000000')
    const root = document.documentElement
    expect(root.style.getPropertyValue('--bubble-in')).toBe('#ffffff')
    expect(root.style.getPropertyValue('--bubble-in-text')).toBe('#0f172a')
    expect(root.style.getPropertyValue('--bubble-in-danger')).toBe('#b91c1c')
    expect(root.style.getPropertyValue('--bubble-in-bg')).toBe('linear-gradient(180deg, #ffffff, #ffffff)')
    expect(root.style.getPropertyValue('--bubble-out')).toBe('linear-gradient(135deg, #000000, #000000)')
    expect(root.style.getPropertyValue('--bubble-out-text')).toBe('#ffffff')
    expect(root.style.getPropertyValue('--bubble-out-danger')).toBe('#fecaca')
  })

  it('persists exactly the current store values', () => {
    setUi({
      themeId: 'green',
      bubbleFontSize: 14,
      themeMode: 'light',
      bubbleInColor: '#111111',
      bubbleOutColor: '#222222',
      toastDurationMs: 9_000,
      toastEnabled: false,
    })
    persistUiSettings()
    expect(JSON.parse(window.localStorage.getItem(UI_SETTINGS_KEY) as string)).toEqual({
      themeId: 'green',
      bubbleFontSize: 14,
      themeMode: 'light',
      bubbleInColor: '#111111',
      bubbleOutColor: '#222222',
      toastDurationMs: 9_000,
      toastEnabled: false,
    })
  })

  it('keeps working when localStorage writes fail', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => setThemeId('rose')).not.toThrow()
    expect(getState().ui.themeId).toBe('rose')
    setItem.mockRestore()
  })


  it('exposes the five reference themes in order', () => {
    expect(UI_THEMES.map(theme => theme.id)).toEqual(['blue', 'green', 'purple', 'orange', 'rose'])
    expect(UI_THEMES.map(theme => theme.accent)).toEqual(['#2f7cf6', '#22c55e', '#8b5cf6', '#f97316', '#f43f5e'])
    expect(UI_THEMES[0].label).toBe('默认蓝')
  })
})

describe('session helpers', () => {
  it('treats online and saved-login slots as signed in', () => {
    expect(isSignedIn(null)).toBe(false)
    expect(isSignedIn(undefined)).toBe(false)
    expect(isSignedIn({ id: 'a', alias: null, authenticated: false, connection: 'disconnected', ownUsername: null })).toBe(false)
    expect(isSignedIn({ id: 'a', alias: null, authenticated: true, connection: 'connected', ownUsername: null })).toBe(true)
    expect(isSignedIn({ id: 'a', alias: null, authenticated: false, savedLogin: true, connection: 'disconnected', ownUsername: null })).toBe(true)
  })

  it('maps API failures to the documented sentences', () => {
    expect(errorText(new WechatApiError('x', 401))).toBe(t('登录状态已失效，请重新登录微信。'))
    expect(errorText(new WechatApiError('x', 404))).toBe(t('没有找到对应的微信会话，请刷新后重试。'))
    expect(errorText(new WechatApiError('x', 409, 'operation_in_progress'))).toBe(t('登录正在进行中，请稍后重试。'))
    expect(errorText(new WechatApiError('x', 409))).toBe(t('微信尚未连接，请稍后重试。'))
    expect(errorText(new WechatApiError('x', 503))).toBe(t('微信服务暂时不可用，请稍后重试。'))
    expect(errorText(new Error('failure'))).toBe(t('微信操作失败，请稍后重试。'))
    // A Chinese business error passes through unchanged.
    expect(errorText(new WechatApiError('账号不存在', 500))).toBe('账号不存在')
    expect(errorText(new TypeError('Failed to fetch'))).toBe('网络连接失败，请检查网络后重试。')
  })

  it('derives the connection tone and stream label from the session slice', () => {
    expect(selectConnectionState()).toBe('offline')

    setSession({ account: { id: 'a', alias: null, authenticated: true, connection: 'connected', ownUsername: null } })
    expect(selectConnectionState()).toBe('online')

    setSession({ account: { id: 'a', alias: null, authenticated: true, connection: 'online', ownUsername: null } })
    expect(selectConnectionState()).toBe('online')

    setSession({ account: { id: 'a', alias: null, authenticated: false, connection: 'connecting', ownUsername: null } })
    expect(selectConnectionState()).toBe('pending')

    setSession({ account: { id: 'a', alias: null, authenticated: false, connection: 'disconnected', ownUsername: null } })
    expect(selectConnectionState()).toBe('offline')

    setSession({ streamStatus: 'live' })
    expect(selectStreamLabel()).toBe(t('实时同步中'))
    setSession({ streamStatus: 'reconnecting' })
    expect(selectStreamLabel()).toBe(t('正在重连'))
    setSession({ streamStatus: 'idle' })
    expect(selectStreamLabel()).toBe(t('未连接'))
  })
})
