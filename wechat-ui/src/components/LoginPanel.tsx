// Login screen: brand panel plus the login card for the current attempt.
import brandLogoUrl from '../assets/agent-wechat-logo.svg'
import { connectionLabel, connectionTone } from '../format'
import {
  loginCanCancel,
  loginCanStart,
  loginFailureDetail,
  loginStatusHint,
  loginVisualStateOf,
} from '../login-status'
import { useT } from '../i18n/useT'
import type { AccountSummary, LoginAttempt } from '../types'
import Icon from './Icon'
import LoginCard from './LoginCard'
import LoginStatusVisual from './LoginStatusVisual'
import '../styles/components/login.css'

export type LoginPanelProps = {
  account: AccountSummary
  attempt: LoginAttempt | null
  qrUrl: string | null
  qrFailed: boolean
  busy: boolean
  error: string
  onStart: () => void
  onCancel: () => void
  onRefresh: () => void
  onRetryQr: () => void
  onQrError: () => void
}

export default function LoginPanel({
  account,
  attempt,
  qrUrl,
  qrFailed,
  busy,
  error,
  onStart,
  onCancel,
  onRefresh,
  onRetryQr,
  onQrError,
}: LoginPanelProps) {
  const t = useT()

  // Card visual state maps directly to the attempt state sent by the daemon.
  const state = loginVisualStateOf(attempt)
  const tone = connectionTone(account.connection, account.authenticated)
  const badgeText = t(connectionLabel(account.connection, account.authenticated))

  const canStart = loginCanStart(state, busy)
  const canCancel = loginCanCancel(state, busy)

  // While waiting for a scan the instruction moves to the card header subtitle
  // so the body does not repeat it.
  const headerSubtitle = state === 'awaiting_scan' ? t(loginStatusHint(state)) : ''

  // Daemon failure reason and raw code: only exposed for the failed state.
  const failureDetail = state === 'failed' ? t(loginFailureDetail(attempt?.result?.code)) : ''
  const rawCode = attempt?.result?.code
  const failureCode = state === 'failed' && typeof rawCode === 'string' ? rawCode : ''

  return (
    <div className="login-shell">
      <div className="login-backdrop" aria-hidden="true" />

      <div className="login-layout">
        <aside className="brand-panel">
          <div className="brand-mark">
            <img src={brandLogoUrl} alt="Agent WeChat" width={56} height={56} />
          </div>

          <h1>{t('把微信会话')}<br />{t('放进同一个工作台')}</h1>
          <p className="brand-copy">{t('扫码登录，会话独立、数据隔离')}</p>
          <ul className="brand-points">
            <li>
              <Icon name="check" size={13} />
              {t('多账号独立登录与运行')}
            </li>
            <li>
              <Icon name="check" size={13} />
              {t('本地数据隔离，互不干扰')}
            </li>
            <li>
              <Icon name="check" size={13} />
              {t('登录后实时同步消息与会话')}
            </li>
          </ul>
        </aside>

        <LoginCard
          badgeTone={tone}
          badgeText={badgeText}
          state={state}
          subtitle={headerSubtitle}
          status={(
            <LoginStatusVisual
              state={state}
              qrUrl={qrUrl}
              qrFailed={qrFailed}
              expiresAt={attempt?.result?.expiresAt ?? null}
              lanChallenge={attempt?.result?.lanChallenge ?? null}
              error={error}
              failureDetail={failureDetail}
              failureCode={failureCode}
              suppressHint={state === 'awaiting_scan'}
              onRetryQr={onRetryQr}
              onQrError={onQrError}
            />
          )}
          actions={(
            <>
              {canStart
                ? (
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busy}
                      onClick={onStart}
                    >
                      <Icon name="qr" size={18} />
                      {t('生成登录二维码')}
                    </button>
                  )
                : null}

              {canCancel
                ? (
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={busy}
                      onClick={onCancel}
                    >
                      {t('取消登录')}
                    </button>
                  )
                : null}

              <div className="secondary-row">
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  title={t('从 daemon 重新拉取账号登录状态')}
                  onClick={onRefresh}
                >
                  <Icon name="refresh" size={13} />
                  {t('刷新账号状态')}
                </button>
              </div>
            </>
          )}
        />
      </div>
    </div>
  )
}
