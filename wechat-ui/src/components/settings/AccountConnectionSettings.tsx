// "Account and connection" settings category: the connection rows and the
// offline debug mode switch (moved here from the account menu).

import { connectionLabel, connectionTone } from '../../format'
import { useT } from '../../i18n/useT'
import { toggleOfflineMode } from '../../store/actions'
import { useStore } from '../../store/hooks'

export default function AccountConnectionSettings() {
  const t = useT()
  const account = useStore(state => state.session.account)
  const offlineToggling = useStore(state => state.session.offlineToggling)

  if (!account)
    return null

  const tone = connectionTone(account.connection, account.authenticated)
  const offline = Boolean(account.offlineMode)

  function toggleOffline(): void {
    if (offlineToggling)
      return
    void toggleOfflineMode(!offline)
  }

  return (
    <>
      <div className="settings-section">
        <div className="settings-row">
          <span className="settings-label">{t('连接状态')}</span>
          <span className="settings-value" data-tone={tone}>
            <span className="dot" />
            {t(connectionLabel(account.connection, account.authenticated))}
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-label">{t('会话模式')}</span>
          <span className="settings-value">{t('独立 Hub')}</span>
        </div>
        <div className="settings-row">
          <span className="settings-label">{t('离线调试模式')}</span>
          <span className="settings-value" data-tone={offline ? 'pending' : 'offline'}>
            <span className="dot" />
            {offline ? t('已开启 · 只读本地缓存') : t('未开启')}
          </span>
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-label">{t('离线模式')}</span>
        <div
          className={`cache-kind-row${offlineToggling ? ' saving' : ''}`}
          role="switch"
          aria-checked={offline}
          tabIndex={0}
          title={offline ? t('关闭后重新连接微信服务器并恢复收发') : t('开启后不请求微信服务器，只读本地缓存，适合调试 UI')}
          onClick={toggleOffline}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              toggleOffline()
            }
          }}
        >
          <span className="cache-kind-text">
            <span className="cache-kind-name">{offline ? t('关闭离线模式') : t('开启离线模式')}</span>
            <span className="cache-kind-hint">{offline ? t('关闭后重新连接微信服务器') : t('开启后不请求微信服务器，只读本地缓存')}</span>
          </span>
          <span className={`toggle-switch${offline ? ' on' : ''}`}>
            <span className="toggle-knob" />
          </span>
        </div>
      </div>
    </>
  )
}
