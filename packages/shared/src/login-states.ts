/**
 * Shared login-attempt state machine.
 *
 * Canonical source for the daemon login operation states surfaced through
 * `POST /v1/accounts/{a}/login-attempts` polling (`wechat-core/src/runtime.rs`
 * `login_worker`). Framework-agnostic on purpose: the React interface
 * (`wechat-ui`) renders its own components, but must agree on which states are
 * terminal, restartable, or cancellable.
 *
 * NOTE: `wechat-ui/src/login-status.ts` vendors a copy of the state sets below
 * because `wechat-ui/` is a standalone npm project (own lockfile, no workspace
 * dependency). Keep the sets in sync when the daemon adds a state.
 *
 * `idle` is client-only (no attempt started yet); every other value comes from
 * the daemon. Unknown future states fall through every predicate as `false`,
 * so new daemon states fail closed instead of enabling the wrong button.
 */
export type LoginOperationState =
  | 'starting'
  | 'resuming'
  | 'awaiting_scan'
  | 'awaiting_approval'
  | 'authenticating'
  | 'needs_login'
  | 'needs_slot_login'
  | 'succeeded'
  | 'cancelled'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'idle';

/** Terminal states: the worker will not move the operation any further. */
const TERMINAL_LOGIN_STATES: ReadonlySet<string> = new Set([
  'succeeded',
  'cancelled',
  'failed',
  'rejected',
  'expired',
  'needs_login',
  // Unbound login routed to a bound slot: the UI switches slots and restarts there.
  'needs_slot_login',
]);

/**
 * Failed terminal states: terminal but not `succeeded`. Used when success is
 * handled on a separate path (resume session) and everything else funnels
 * into "try again".
 */
const FAILED_LOGIN_STATES: ReadonlySet<string> = new Set([
  'cancelled',
  'failed',
  'rejected',
  'expired',
  'needs_login',
]);

/**
 * Active states: a login is in flight, so starting another one must be
 * blocked (the daemon enforces one worker per account and answers 409
 * `operation_in_progress`).
 */
const ACTIVE_LOGIN_STATES: ReadonlySet<string> = new Set([
  'starting',
  'resuming',
  'awaiting_scan',
  'awaiting_approval',
  'authenticating',
  'succeeded',
]);

const CANCELLABLE_LOGIN_STATES: ReadonlySet<string> = new Set([
  'starting',
  'awaiting_scan',
  'awaiting_approval',
  // Cancelling during `authenticating` still cancels the operation; the daemon
  // marks `authenticationMayBeActive` because credentials may already exist.
  'authenticating',
]);

export function isTerminalLoginState(state: string): boolean {
  return TERMINAL_LOGIN_STATES.has(state);
}

export function isFailedLoginState(state: string): boolean {
  return FAILED_LOGIN_STATES.has(state);
}

/** Restarting is allowed everywhere except while a login is active. */
export function loginCanStart(state: string, busy: boolean): boolean {
  return !busy && !ACTIVE_LOGIN_STATES.has(state);
}

export function loginCanCancel(state: string, busy: boolean): boolean {
  return !busy && CANCELLABLE_LOGIN_STATES.has(state);
}

/** `expiresAt` arrives as unix seconds; render as local `HH:MM`, else ''. */
export function formatLoginQrExpiry(expiresAt: unknown): string {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return '';
  const date = new Date(expiresAt * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** Show the QR image only while waiting for a scan and the bytes loaded. */
export function shouldShowLoginQr(
  state: string,
  qrAvailable: boolean,
  qrFailed: boolean,
): boolean {
  return state === 'awaiting_scan' && qrAvailable && !qrFailed;
}

/**
 * Surface the LAN-challenge hint while awaiting approval: a non-empty
 * `result.lanChallenge` means the daemon waits for same-network phone proof
 * (`wechat-protocol/src/lan_login.rs`).
 */
export function shouldShowLoginLanHint(state: string, lanChallenge: unknown): boolean {
  if (state !== 'awaiting_approval' || lanChallenge == null) return false;
  if (typeof lanChallenge === 'string') return lanChallenge !== '' && lanChallenge !== 'stopped';
  if (typeof lanChallenge === 'object') return Object.keys(lanChallenge).length > 0;
  return false;
}
