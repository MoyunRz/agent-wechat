// "Media and cache" settings category: the proactive-cache switches and the
// per-age purge buttons, plus the in-app purge confirmation. The state and the
// requests come from useCacheSettings(); labels are translated here.

import { useT } from '../../i18n/useT'
import {
  CACHE_AGE_OPTIONS,
  CACHE_KIND_ITEMS,
  type CacheSettingsHandle,
  type PurgeConfirm,
} from './useCacheSettings'

export type CacheSettingsProps = {
  state: CacheSettingsHandle
}

export default function CacheSettings({ state }: CacheSettingsProps) {
  const t = useT()
  const proactive = state.settings?.proactiveCache ?? null

  return (
    <>
      <div className="settings-section">
        <div className="settings-row">
          <span className="settings-label">{t('主动缓存')}</span>
          {state.loading && <span className="settings-value">{t('读取中…')}</span>}
        </div>
        <div className="cache-kind-list">
          {CACHE_KIND_ITEMS.map((item) => {
            const on = proactive?.[item.key] ?? true
            return (
              <div
                key={item.key}
                className={`cache-kind-row${state.savingKey === item.key ? ' saving' : ''}`}
                role="switch"
                aria-checked={on}
                tabIndex={0}
                onClick={() => state.toggleKind(item.key)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    state.toggleKind(item.key)
                  }
                }}
              >
                <span className="cache-kind-text">
                  <span className="cache-kind-name">{t(item.label)}</span>
                  <span className="cache-kind-hint">{t(item.hint)}</span>
                </span>
                <span className={`toggle-switch${on ? ' on' : ''}`}>
                  <span className="toggle-knob" />
                </span>
              </div>
            )
          })}
        </div>
        {state.error && <span className="cache-error">{t(state.error)}</span>}
      </div>

      <div className="settings-section">
        <span className="settings-label">{t('清理媒体缓存')}</span>
        <div className="cache-purge-grid">
          {CACHE_AGE_OPTIONS.map(option => (
            <button
              key={option.label}
              type="button"
              className="cache-purge-btn"
              disabled={state.purging}
              onClick={() => state.requestPurge(option.seconds)}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
        {state.purgeResult && (
          <span className="cache-purge-result">
            {state.purgeResult === 'empty'
              ? t('没有需要清理的缓存')
              : t('已清理 {files} 个缓存文件 · {size}', {
                files: state.purgeResult.files,
                size: state.purgeResult.size,
              })}
          </span>
        )}
        {state.purging && <span className="settings-value">{t('清理中…')}</span>}
      </div>
    </>
  )
}

export type PurgeConfirmDialogProps = {
  pending: PurgeConfirm
  onCancel: () => void
  onConfirm: () => void
}

/** In-app replacement for the browser confirm dialog, layered above the modal. */
export function PurgeConfirmDialog({ pending, onCancel, onConfirm }: PurgeConfirmDialogProps) {
  const t = useT()

  return (
    <div
      className="confirm-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget)
          onCancel()
      }}
    >
      <div className="confirm-card" role="alertdialog" aria-modal="true" aria-label={t('警告提示')}>
        <h4>{t('警告提示')}</h4>
        <p>{t('清理 {label}之前的媒体缓存？只删除加速缓存文件，不影响聊天记录和收到的消息。', { label: t(pending.label) })}</p>
        <footer className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel}>{t('取消')}</button>
          <button type="button" className="confirm-danger" onClick={onConfirm}>{t('清理')}</button>
        </footer>
      </div>
    </div>
  )
}
