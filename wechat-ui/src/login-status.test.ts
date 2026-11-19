import { describe, expect, it } from 'vitest'
import {
  formatQrExpiry,
  loginCanCancel,
  loginCanStart,
  loginFailureDetail,
  loginStatusHint,
  loginStatusTitle,
  loginVisualStateOf,
  shouldShowLanHint,
  shouldShowQr,
  type LoginVisualState,
} from './login-status'
import type { LoginAttempt } from './types'

function attempt(state: string): LoginAttempt {
  return { id: 'attempt-1', accountId: 'account-1', state, method: 'qr' } as unknown as LoginAttempt
}

describe('loginVisualStateOf', () => {
  it('maps the daemon attempt state and defaults to idle', () => {
    expect(loginVisualStateOf(null)).toBe('idle')
    expect(loginVisualStateOf(attempt('awaiting_scan'))).toBe('awaiting_scan')
    expect(loginVisualStateOf(attempt('authenticating'))).toBe('authenticating')
    expect(loginVisualStateOf(attempt('needs_login'))).toBe('needs_login')
  })
})

describe('loginCanStart', () => {
  it('allows starting outside active states and while idle', () => {
    expect(loginCanStart('idle', false)).toBe(true)
    expect(loginCanStart('failed', false)).toBe(true)
    expect(loginCanStart('expired', false)).toBe(true)
    expect(loginCanStart('awaiting_scan', false)).toBe(false)
    expect(loginCanStart('authenticating', false)).toBe(false)
    expect(loginCanStart('succeeded', false)).toBe(false)
    expect(loginCanStart('idle', true)).toBe(false)
  })
})

describe('loginCanCancel', () => {
  it('allows cancelling only the in-flight states', () => {
    expect(loginCanCancel('starting', false)).toBe(true)
    expect(loginCanCancel('awaiting_scan', false)).toBe(true)
    expect(loginCanCancel('awaiting_approval', false)).toBe(true)
    expect(loginCanCancel('authenticating', false)).toBe(true)
    expect(loginCanCancel('idle', false)).toBe(false)
    expect(loginCanCancel('succeeded', false)).toBe(false)
    expect(loginCanCancel('awaiting_scan', true)).toBe(false)
  })
})

describe('login text helpers', () => {
  it('returns the title and hint for each state', () => {
    expect(loginStatusTitle('awaiting_approval')).toBe('已扫码，请在手机上确认')
    expect(loginStatusTitle('awaiting_scan')).toBe('')
    expect(loginStatusTitle('idle')).toBe('')
    expect(loginStatusHint('expired')).toBe('二维码已失效，请重新生成。')
    expect(loginStatusHint('needs_slot_login')).toContain('既有槽位')
  })

  it('maps failure codes and leaves unknown codes empty', () => {
    expect(loginFailureDetail('login_failed')).toBe('微信拒绝了这次登录，请重试。')
    expect(loginFailureDetail('account_device_mismatch')).toContain('设备')
    expect(loginFailureDetail('something_else')).toBe('')
  })
})

describe('formatQrExpiry', () => {
  it('formats seconds as a local clock time', () => {
    const formatted = formatQrExpiry(1_700_000_000)
    expect(formatted).toMatch(/^\d{1,2}:\d{2}$/)
  })

  it('ignores missing or invalid input', () => {
    expect(formatQrExpiry(null)).toBe('')
    expect(formatQrExpiry('1700000000')).toBe('')
    expect(formatQrExpiry(Number.NaN)).toBe('')
  })
})

describe('shouldShowQr', () => {
  it('shows the code only while waiting for a scan with a usable image', () => {
    expect(shouldShowQr('awaiting_scan', 'blob:qr', false)).toBe(true)
    expect(shouldShowQr('awaiting_scan', 'blob:qr', true)).toBe(false)
    expect(shouldShowQr('awaiting_scan', null, false)).toBe(false)
    expect(shouldShowQr('awaiting_approval', 'blob:qr', false)).toBe(false)
  })
})

describe('shouldShowLanHint', () => {
  it('shows the LAN hint only for an approval-stage challenge', () => {
    const state: LoginVisualState = 'awaiting_approval'
    expect(shouldShowLanHint(state, 'waiting_for_phone')).toBe(true)
    expect(shouldShowLanHint(state, 'stopped')).toBe(false)
    expect(shouldShowLanHint(state, { waiting: true })).toBe(true)
    expect(shouldShowLanHint(state, {})).toBe(false)
    expect(shouldShowLanHint(state, null)).toBe(false)
    expect(shouldShowLanHint('awaiting_scan', 'waiting_for_phone')).toBe(false)
  })
})
