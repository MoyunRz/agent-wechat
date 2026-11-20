import { describe, expect, it } from 'vitest'
import { isTerminalOperation, operationOutcomeMessage } from './operations'

describe('isTerminalOperation', () => {
  it('stops polling on every state the daemon keeps unchanged', () => {
    for (const state of [
      'succeeded',
      'failed',
      'cancelled',
      'expired',
      'rejected',
      'needs_login',
      'needs_slot_login',
      'needs_review',
    ])
      expect(isTerminalOperation(state), state).toBe(true)
  })

  it('keeps polling while the operation can still progress', () => {
    for (const state of ['running', 'queued', 'submitting', 'pending', ''])
      expect(isTerminalOperation(state), state).toBe(false)
  })
})

describe('operationOutcomeMessage', () => {
  it('separates an unknown outcome from a known failure', () => {
    expect(operationOutcomeMessage('needs_review')).toBe('操作结果未知，请稍后刷新确认。')
    expect(operationOutcomeMessage('failed')).toBe('操作未成功，请稍后重试。')
  })
})
