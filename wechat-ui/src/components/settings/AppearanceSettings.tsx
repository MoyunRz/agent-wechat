// "Appearance" settings category: light/dark mode and the accent theme.

import { useT } from '../../i18n/useT'
import { setThemeId, setThemeMode, UI_THEMES } from '../../store/actions'
import { useStore } from '../../store/hooks'
import Icon from '../Icon'

export default function AppearanceSettings() {
  const t = useT()
  const themeId = useStore(state => state.ui.themeId)
  const themeMode = useStore(state => state.ui.themeMode)

  return (
    <>
      <div className="settings-section">
        <span className="settings-label">{t('主题模式')}</span>
        <div className="mode-switch">
          <button
            type="button"
            className={themeMode === 'dark' ? 'active' : undefined}
            onClick={() => setThemeMode('dark')}
          >
            {t('深色')}
          </button>
          <button
            type="button"
            className={themeMode === 'light' ? 'active' : undefined}
            onClick={() => setThemeMode('light')}
          >
            {t('浅色')}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <span className="settings-label">{t('界面颜色')}</span>
        <div className="theme-grid">
          {UI_THEMES.map(theme => (
            <button
              key={theme.id}
              type="button"
              className={`theme-swatch${theme.id === themeId ? ' active' : ''}`}
              style={{ background: theme.bubble }}
              title={theme.label}
              onClick={() => setThemeId(theme.id)}
            >
              {theme.id === themeId ? <Icon name="check" size={13} /> : null}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
