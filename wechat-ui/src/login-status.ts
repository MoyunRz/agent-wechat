import type { LoginAttempt } from './types'

/**
 * 登录卡片展示的状态，与 daemon 下发的 `attempt.state` 一一对应，
 * 尚未发起登录时为 `idle`。
 *
 * 状态集合是 `@agent-wechat/shared` 内 `login-states.ts` 的镜像
 * （`wechat-ui/` 是独立 npm 工程，不能依赖 workspace 包，两边保持同步）。
 * 后端 `login_worker`（`wechat-core/src/runtime.rs`）额外下发的
 * `authenticating`（手机已确认，正在 `252 secmanualauth` 换凭证）与
 * `needs_login`（无可用 saved 信任又不许弹码）也必须显式处理，
 * 不能掉进默认分支显示“未登录”。
 */
export type LoginVisualState =
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
  | 'idle'

export function loginVisualStateOf(attempt: LoginAttempt | null): LoginVisualState {
  return (attempt?.state as LoginVisualState | undefined) ?? 'idle'
}

export function loginStatusTitle(state: LoginVisualState): string {
  switch (state) {
    case 'starting':
      return '正在启动登录'
    case 'awaiting_scan':
      // 标题与指引由卡片头副标题承载，正文只留二维码。
      return ''
    case 'awaiting_approval':
      return '已扫码，请在手机上确认'
    case 'authenticating':
      return '正在完成登录'
    case 'needs_login':
      return '需要登录'
    case 'needs_slot_login':
      return '请在原槽位重新登录'
    case 'succeeded':
      return '登录成功'
    case 'cancelled':
      return '登录已取消'
    case 'failed':
      return '登录失败'
    case 'rejected':
      return '登录已被拒绝'
    case 'expired':
      return '二维码已过期'
    default:
      return ''
  }
}

export function loginStatusHint(state: LoginVisualState): string {
  switch (state) {
    case 'starting':
      return '正在申请二维码，请稍候。'
    case 'awaiting_scan':
      return '手机微信扫一扫，在手机上确认。'
    case 'awaiting_approval':
      return '在手机上确认后自动进入会话列表。'
    case 'authenticating':
      return '手机已确认，正在同步账号信息...'
    case 'needs_login':
      return '无可用登录凭证，请扫码登录。'
    case 'needs_slot_login':
      return '该微信号已绑定既有槽位，请在该槽位重新扫码登录。'
    case 'succeeded':
      return '正在进入会话列表...'
    case 'cancelled':
      return '登录已取消，可重新生成二维码。'
    case 'failed':
      return '微信拒绝了这次登录，请重试。'
    case 'rejected':
      return '手机端拒绝了本次登录。'
    case 'expired':
      return '二维码已失效，请重新生成。'
    default:
      return '登录后即可查看会话、收发消息并同步通讯录。'
  }
}

const ACTIVE_STATES: ReadonlySet<string> = new Set([
  'starting',
  'resuming',
  'awaiting_scan',
  'awaiting_approval',
  'authenticating',
  'succeeded',
])

const CANCELLABLE_STATES: ReadonlySet<string> = new Set([
  'starting',
  'awaiting_scan',
  'awaiting_approval',
  // complete 进行中取消：daemon 侧标 authenticationMayBeActive 后置 cancelled，
  // 前端允许取消并按终态收尾。
  'authenticating',
])

/** 除进行中的状态外都允许重新生成，避免终态无按钮可点。 */
export function loginCanStart(state: LoginVisualState, busy: boolean): boolean {
  return !busy && !ACTIVE_STATES.has(state)
}

export function loginCanCancel(state: LoginVisualState, busy: boolean): boolean {
  return !busy && CANCELLABLE_STATES.has(state)
}

export function formatQrExpiry(expiresAt: unknown): string {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))
    return ''
  const date = new Date(expiresAt * 1000)
  if (Number.isNaN(date.getTime()))
    return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 是否展示二维码：等待扫码且图片可用。 */
export function shouldShowQr(
  state: LoginVisualState,
  qrUrl: string | null,
  qrFailed: boolean,
): boolean {
  return state === 'awaiting_scan' && Boolean(qrUrl) && !qrFailed
}

/**
 * 是否提示局域网风控：daemon 在 `result.lanChallenge` 里透出
 * `waiting_for_phone` 等非 stopped 状态时，手机确认页可能要求同网确认。
 */
export function shouldShowLanHint(state: LoginVisualState, lanChallenge: unknown): boolean {
  if (state !== 'awaiting_approval' || lanChallenge == null)
    return false
  if (typeof lanChallenge === 'string')
    return lanChallenge !== '' && lanChallenge !== 'stopped'
  if (typeof lanChallenge === 'object')
    return Object.keys(lanChallenge).length > 0
  return false
}

/** daemon 下发的失败码 → 可操作的中文说明；未收录的返回空，由调用方回退通用文案。 */
export function loginFailureDetail(code: unknown): string {
  switch (code) {
    case 'login_lan_challenge_failed':
      return '微信要求局域网验证：请确认手机与本机在同一 Wi-Fi，并能直接访问本机（8050–8100 端口），然后重新生成二维码。'
    case 'login_poll_failed':
      return '登录轮询被微信拒绝，可能是新设备风控。请稍后重试，仍失败请换网络环境再试。'
    case 'account_device_mismatch':
      return '该槽位绑定的设备与微信号不符。请用“登录新账号”创建独立槽位扫码。'
    case 'auth_required':
      return '微信拒绝了这次授权，请重新扫码。'
    case 'login_failed':
      return '微信拒绝了这次登录，请重试。'
    default:
      return ''
  }
}
