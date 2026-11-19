// Login status body: spinner, QR code, state icons, titles and hints.
import {
  formatQrExpiry,
  loginStatusHint,
  loginStatusTitle,
  shouldShowLanHint,
  shouldShowQr,
  type LoginVisualState,
} from '../login-status'
import { useT } from '../i18n/useT'
import Icon from './Icon'
import '../styles/components/login.css'

export type LoginStatusVisualProps = {
  state: LoginVisualState
  qrUrl: string | null
  qrFailed: boolean
  expiresAt: unknown
  lanChallenge: unknown
  error: string
  /** Suppress the generic hint: the card header subtitle carries it instead. */
  suppressHint?: boolean
  /**
   * Failure detail forwarded by the login panel. The Vue child declared no
   * props for it and dropped the values as fallthrough attributes, so the
   * React port accepts them for API parity and intentionally renders neither.
   */
  failureDetail?: string
  failureCode?: string
  onRetryQr: () => void
  onQrError: () => void
}

export default function LoginStatusVisual({
  state,
  qrUrl,
  qrFailed,
  expiresAt,
  lanChallenge,
  error,
  suppressHint = false,
  onRetryQr,
  onQrError,
}: LoginStatusVisualProps) {
  const t = useT()
  const showQr = shouldShowQr(state, qrUrl, qrFailed)
  const title = loginStatusTitle(state)
  const hint = loginStatusHint(state)
  const expiry = formatQrExpiry(expiresAt)
  const lanHint = shouldShowLanHint(state, lanChallenge)

  return (
    <>
      {state === 'starting' || state === 'succeeded' || state === 'authenticating'
        ? (
            <div className="state-icon spinning">
              <Icon name="refresh" size={30} />
            </div>
          )
        : showQr
          ? (
              <>
                <div className="qr-frame">
                  <img
                    src={qrUrl ?? undefined}
                    alt={t('微信登录二维码')}
                    draggable={false}
                    onError={onQrError}
                  />
                </div>
                {expiry
                  ? (
                      <p className="qr-expiry">
                        <Icon name="clock" size={13} />
                        {t('二维码有效期至 {expiry}', { expiry })}
                      </p>
                    )
                  : null}
              </>
            )
          : state === 'awaiting_scan' && qrFailed
            ? (
                <>
                  <div className="state-icon warning">
                    <Icon name="alert" size={28} />
                  </div>
                  <button className="qr-retry" type="button" onClick={onRetryQr}>
                    {t('二维码加载失败，点击重试')}
                  </button>
                </>
              )
            : state === 'awaiting_approval'
              ? (
                  <div className="state-icon success">
                    <Icon name="check" size={32} />
                  </div>
                )
              : state === 'failed' || state === 'cancelled' || state === 'expired' || state === 'rejected' || state === 'needs_login'
                ? (
                    <div className="state-icon danger">
                      <Icon name="alert" size={28} />
                    </div>
                  )
                : (
                    <div className="state-icon idle">
                      <Icon name="qr" size={40} />
                    </div>
                  )}

      {title ? <h3 className="state-title">{t(title)}</h3> : null}
      {suppressHint ? null : <p className="state-hint">{t(hint)}</p>}
      {lanHint ? (
        <p className="lan-hint">
          {t('如长时间无反应，请确认手机与本机在同一局域网。')}
        </p>
      ) : null}

      {error ? (
        <p className="login-error">
          <Icon name="alert" size={13} />
          <span>{error}</span>
        </p>
      ) : null}
    </>
  )
}
