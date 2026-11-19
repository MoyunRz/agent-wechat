// Native notification preferences for the settings panel: the global switches
// plus an optional per-account switch for the hub that is currently connected.
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n/useT'
import { isDesktop } from '../../platform/env'
import {
  desktopErrorMessage,
  desktopServerId,
  loadAccountNotificationSettings,
  loadDesktopSettings,
  saveAccountNotificationSettings,
  setNotificationSoundEnabled,
  setNotificationsEnabled,
  useDesktopSession,
  type AccountNotificationPreference,
  type DesktopSettings,
} from '../../platform/desktop'
import '../../styles/components/desktop.css'

export type NotificationSettingsProps = {
  /** WeChat account the per-account switch applies to; omit for the global switches only. */
  accountId?: string | null
}

export function NotificationSettings({ accountId = null }: NotificationSettingsProps) {
  const t = useT()
  const { session } = useDesktopSession()
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [account, setAccount] = useState<AccountNotificationPreference | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const connectionId = session?.id ?? null
  const serverId = desktopServerId(session)

  const refresh = useCallback(async () => {
    const value = await loadDesktopSettings()
    setSettings(value)
    if (connectionId && serverId && accountId)
      setAccount(await loadAccountNotificationSettings(connectionId, serverId, accountId))
    else
      setAccount(null)
  }, [connectionId, serverId, accountId])

  useEffect(() => {
    if (!isDesktop())
      return
    void refresh().catch(() => {
      setError(t('无法读取通知设置。'))
    })
    const changed = () => {
      void refresh().catch(() => {})
    }
    window.addEventListener('desktop-notifications-changed', changed)
    return () => window.removeEventListener('desktop-notifications-changed', changed)
  }, [refresh, t])

  async function update(operation: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await operation()
      await refresh()
    }
    catch (reason) {
      setError(desktopErrorMessage(reason))
    }
    finally {
      setBusy(false)
    }
  }

  function statusText(status?: string): string {
    switch (status) {
      case 'Listening for new messages':
        return t('正在监听新消息')
      case 'Waiting for the hub':
        return t('等待 Hub')
      case 'Connect to a hub to receive notifications':
        return t('连接 Hub 后即可收到通知')
      case 'Notifications off':
        return t('通知已关闭')
      default: {
        const prefix = 'Listening for new messages; the last alert failed: '
        if (status?.startsWith(prefix))
          return t('正在监听新消息（上次提醒失败：{error}）', { error: status.slice(prefix.length) })
        return status || t('未静音会话中的新消息。')
      }
    }
  }

  if (!isDesktop())
    return null

  const notificationsEnabled = settings?.notificationsEnabled ?? true
  const soundEnabled = settings?.notificationSoundEnabled ?? true
  const accountScope = account && connectionId && serverId && accountId
    ? { preference: account, connectionId, serverId, accountId }
    : null

  return (
    <section className="notification-settings" aria-label={t('系统通知')}>
      <header className="notification-settings-head">
        <strong>{t('系统通知')}</strong>
      </header>

      <div className="setting">
        <span>
          {t('消息通知')}
          <small>{statusText(settings?.notificationStatus)}</small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={notificationsEnabled}
          aria-label={t('消息通知')}
          className={'toggle-switch' + (notificationsEnabled ? ' on' : '')}
          disabled={busy || !settings}
          onClick={() => {
            void update(async () => {
              await setNotificationsEnabled(!notificationsEnabled)
            })
          }}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      <div className="setting">
        <span>{t('通知声音')}</span>
        <button
          type="button"
          role="switch"
          aria-checked={soundEnabled}
          aria-label={t('通知声音')}
          className={'toggle-switch' + (soundEnabled ? ' on' : '')}
          disabled={busy || !settings}
          onClick={() => {
            void update(async () => {
              await setNotificationSoundEnabled(!soundEnabled)
            })
          }}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      {accountScope && (
        <div className="setting">
          <span>
            {t('本账号消息通知')}
            <small>{t('仅影响本机上的此账号。')}</small>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={accountScope.preference.enabled}
            aria-label={t('本账号消息通知')}
            className={'toggle-switch' + (accountScope.preference.enabled ? ' on' : '')}
            disabled={busy}
            onClick={() => {
              void update(async () => {
                await saveAccountNotificationSettings(
                  accountScope.connectionId,
                  accountScope.serverId,
                  accountScope.accountId,
                  !accountScope.preference.enabled,
                )
              })
            }}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      )}

      {accountScope && !accountScope.preference.desktopEnabled && (
        <p className="notification-settings-note">{t('桌面通知已关闭。')}</p>
      )}
      {error && <p role="alert" className="connection-error">{error}</p>}
    </section>
  )
}

export default NotificationSettings