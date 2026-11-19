// Account popover at the top of the rail: the signed-in identity, connection
// rows, refresh and sign-out. The parent owns the presence phase and actions.

import type { AccountSummary } from '../../types'
import { connectionLabel } from '../../format'
import { useT } from '../../i18n/useT'
import Icon from '../Icon'
import ThreadAvatar from '../ThreadAvatar'
import type { PresencePhase } from './usePresence'

export type AccountMenuProps = {
  account: AccountSummary
  /** WeChat nickname, falling back to the generic label. */
  accountLabel: string
  tone: 'online' | 'pending' | 'offline'
  accountRefreshing: boolean
  loggingOut: boolean
  phase: PresencePhase
  onClose: () => void
  onRefresh: () => void
  onLogout: () => void
}

export default function AccountMenu({
  account,
  accountLabel,
  tone,
  accountRefreshing,
  loggingOut,
  phase,
  onClose,
  onRefresh,
  onLogout,
}: AccountMenuProps) {
  const t = useT()

  return (
    <section
      className="rail-popover account-popover"
      data-phase={phase === 'idle' ? undefined : phase}
    >
      <header className="popover-head">
        <ThreadAvatar
          accountId={account.id}
          name={accountLabel}
          username={account.ownUsername}
          size={40}
        />
        <div className="popover-title">
          <strong>{accountLabel}</strong>
          <span>{account.ownUsername ? `@${account.ownUsername}` : t('尚未登录')}</span>
        </div>
        <button type="button" className="popover-close" title={t('关闭')} onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </header>

      <div className="popover-body">
        <div className="popover-row">
          <span className="row-label">{t('连接状态')}</span>
          <span className="row-value" data-tone={tone}>
            <span className="dot" />
            {t(connectionLabel(account.connection, account.authenticated))}
          </span>
        </div>
        <div className="popover-row">
          <span className="row-label">{t('会话模式')}</span>
          <span className="row-value">{t('独立 Hub')}</span>
        </div>
        <div className="popover-row">
          <span className="row-label">{t('离线调试模式')}</span>
          <span className="row-value" data-tone={account.offlineMode ? 'pending' : 'offline'}>
            <span className="dot" />
            {account.offlineMode ? t('已开启 · 只读本地缓存') : t('未开启')}
          </span>
        </div>
      </div>

      <div className="popover-actions">
        <button
          type="button"
          className="popover-action"
          disabled={accountRefreshing || loggingOut}
          onClick={onRefresh}
        >
          <Icon name="refresh" size={14} className={accountRefreshing ? 'spin' : undefined} />
          {t('刷新账号状态')}
        </button>
        <button
          type="button"
          className="popover-action danger"
          disabled={loggingOut}
          onClick={onLogout}
        >
          <Icon name="logout" size={14} className={loggingOut ? 'spin' : undefined} />
          {t('退出登录')}
        </button>
      </div>
    </section>
  )
}
