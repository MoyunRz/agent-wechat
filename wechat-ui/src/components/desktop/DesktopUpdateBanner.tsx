// Bottom-right update notice. Hidden until a release is available and while
// nothing is downloading or installing.
import { useState } from 'react'
import { useT } from '../../i18n/useT'
import { installUpdate, useDesktopUpdates } from '../../platform/desktop'
import '../../styles/components/desktop.css'

export function DesktopUpdateBanner() {
  const t = useT()
  const { settings, error } = useDesktopUpdates()
  const [dismissed, setDismissed] = useState('')

  if (!settings)
    return null
  const { status } = settings
  const available = status.phase === 'available'
  const installing = status.phase === 'installing'
  const downloading = status.phase === 'downloading'
  if (!available && !downloading && !installing)
    return null
  if (available && dismissed === status.version)
    return null

  const busy = downloading || installing
  const percent = status.total
    ? Math.min(100, Math.round((status.downloaded / status.total) * 100))
    : null
  const description = downloading
    ? t('正在下载') + (percent === null ? '…' : ' · ' + String(percent) + '%')
    : installing
      ? t('正在安装…')
      : t('版本 {version} 已就绪', { version: status.version ?? '' })

  return (
    <aside className="desktop-update-notice" aria-label={t('应用更新')}>
      <span>{description}</span>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void installUpdate()}
      >
        {busy ? t('正在更新…') : t('立即安装并重启')}
      </button>
      {available && (
        <button
          type="button"
          className="text-button"
          aria-label={t('关闭更新提示')}
          onClick={() => setDismissed(status.version ?? '')}
        >
          {t('稍后')}
        </button>
      )}
      {downloading && (
        <progress
          aria-label={t('更新下载')}
          value={status.total ? status.downloaded : undefined}
          max={status.total || undefined}
        />
      )}
      <small>{t('本机 Hub 将重启。')}</small>
      {(error || status.error) && <small role="alert">{error || status.error}</small>}
    </aside>
  )
}

export default DesktopUpdateBanner
