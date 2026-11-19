// Card chrome shared by every login state: header badge, state body and footer.
import type { ReactNode } from 'react'
import { useT } from '../i18n/useT'
import type { LoginVisualState } from '../login-status'
import '../styles/components/login.css'

export type LoginCardProps = {
  /** Connection badge tone in the top right: online / pending / offline. */
  badgeTone: string
  badgeText: string
  /** Current visual state, forwarded to the debug hook on the body element. */
  state: LoginVisualState
  /** Subtitle under the heading: currently only used for the scan instruction. */
  subtitle?: string
  status: ReactNode
  actions: ReactNode
}

export default function LoginCard({
  badgeTone,
  badgeText,
  state,
  subtitle,
  status,
  actions,
}: LoginCardProps) {
  const t = useT()
  return (
    <section className="login-card fade-in">
      <header className="login-header">
        <div className="login-heading">
          <h2>{t('微信扫码登录')}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <span className="connection-badge" data-tone={badgeTone}>
          <span className="dot" />
          {badgeText}
        </span>
      </header>

      <div className="login-body" data-state={state}>
        {status}
        <div className="login-actions">
          {actions}
        </div>
      </div>

      <footer className="login-footer">
        <span className="status-dot" data-tone={badgeTone} />
        {t('每个微信会话独立进程、独立数据，可同时登录多个账号')}
      </footer>
    </section>
  )
}
