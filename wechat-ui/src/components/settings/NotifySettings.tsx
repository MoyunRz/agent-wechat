// "Message notifications" settings category: the incoming-message toast card
// switches, plus the desktop notification panel inside the Tauri shell.

import { lazy, Suspense, type ChangeEvent } from 'react'
import { useT } from '../../i18n/useT'
import { isDesktop } from '../../platform/env'
import { setToastDurationMs, setToastEnabled } from '../../store/actions'
import { useStore } from '../../store/hooks'

/**
 * Desktop-only panel. The module is fetched on the first desktop render, so the
 * browser bundle never loads it; outside Tauri the local UI is all there is.
 */
const DesktopNotificationSettings = lazy(() => import('../desktop/NotificationSettings'))

export default function NotifySettings() {
  const t = useT()
  const toastEnabled = useStore(state => state.ui.toastEnabled)
  const toastDurationMs = useStore(state => state.ui.toastDurationMs)
  const accountId = useStore(state => state.session.account?.id ?? '')

  const toastSeconds = Math.round(toastDurationMs / 1000)

  function onToastDurationInput(event: ChangeEvent<HTMLInputElement>): void {
    const value = Number(event.target.value)
    if (Number.isFinite(value))
      setToastDurationMs(Math.round(value * 1000))
  }

  return (
    <>
      <div className="settings-section">
        <label className="settings-row settings-toggle">
          <span className="settings-label">{t('新消息提示卡片')}</span>
          <span
            className={`toggle-switch${toastEnabled ? ' on' : ''}`}
            role="switch"
            aria-checked={toastEnabled}
            onClick={() => setToastEnabled(!toastEnabled)}
          >
            <span className="toggle-knob" />
          </span>
        </label>
      </div>

      {toastEnabled && (
        <div className="settings-section">
          <div className="settings-row">
            <span className="settings-label">{t('新消息卡片消失时间')}</span>
            <span className="settings-value">{t('{seconds} 秒', { seconds: toastSeconds })}</span>
          </div>
          <input
            className="font-slider"
            type="range"
            min="2"
            max="30"
            step="1"
            value={toastSeconds}
            onChange={onToastDurationInput}
          />
        </div>
      )}

      {isDesktop() && (
        <section className="settings-section">
          <Suspense fallback={<span className="settings-value">{t('正在加载桌面通知设置…')}</span>}>
            <DesktopNotificationSettings accountId={accountId || null} />
          </Suspense>
        </section>
      )}
    </>
  )
}
