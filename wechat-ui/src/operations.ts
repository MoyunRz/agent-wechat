// Operation states reported by the daemon's operations table. Rows reach one of
// the terminal states and never change again, so callers must stop polling when
// one arrives. `needs_review` is terminal too: the request may have reached
// WeChat, but the recorded outcome is unknown, so the caller reports that
// instead of waiting for a result that will never come or retrying blindly.
const TERMINAL_OPERATION_STATES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'rejected',
  'needs_login',
  'needs_slot_login',
  'needs_review',
])

/** Whether the operation state will never change again. */
export function isTerminalOperation(state: string): boolean {
  return TERMINAL_OPERATION_STATES.has(state)
}

/** Source message for a finished operation that did not simply succeed. */
export function operationOutcomeMessage(state: string): string {
  return state === 'needs_review' ? '操作结果未知，请稍后刷新确认。' : '操作未成功，请稍后重试。'
}
