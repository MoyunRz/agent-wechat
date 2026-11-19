// Settings popover and its category modal. The popover is a directory of
// categories; each category opens a modal that holds the actual controls. The
// panel stays mounted while the AppRail is on screen so the lazily loaded cache
// settings survive closing and reopening it.

import { useRef, useState } from 'react'
import { useT } from '../../i18n/useT'
import Icon, { type IconName } from '../Icon'
import AccountConnectionSettings from './AccountConnectionSettings'
import AppearanceSettings from './AppearanceSettings'
import BubbleSettings from './BubbleSettings'
import CacheSettings, { PurgeConfirmDialog } from './CacheSettings'
import NotifySettings from './NotifySettings'
import { useCacheSettings } from './useCacheSettings'
import { phaseAttribute, usePresence } from './usePresence'
import '../../styles/components/settings.css'

export type SettingsCategory = 'account' | 'appearance' | 'bubble' | 'notify' | 'cache'

type SettingsCategoryEntry = {
  key: SettingsCategory
  label: string
  icon: IconName
  hint: string
}

const SETTINGS_CATEGORIES: ReadonlyArray<SettingsCategoryEntry> = [
  { key: 'account', label: '账号与连接', icon: 'wifi', hint: '离线模式与连接状态' },
  { key: 'appearance', label: '外观主题', icon: 'panel', hint: '深浅模式与界面颜色' },
  { key: 'bubble', label: '气泡样式', icon: 'message', hint: '气泡颜色与字号' },
  { key: 'notify', label: '消息通知', icon: 'clock', hint: '新消息提示卡片与时长' },
  { key: 'cache', label: '媒体与缓存', icon: 'image', hint: '主动缓存与清理' },
]

/** Durations of the Vue <Transition> wrappers: fade 0.16s, popover 0.18s. */
const FADE_MS = 160
const POPOVER_MS = 180

export type SettingsPanelProps = {
  open: boolean
  onClose: () => void
}

export default function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const t = useT()
  const [activeCategory, setActiveCategory] = useState<SettingsCategory | null>(null)

  const popover = usePresence(open, POPOVER_MS)
  const modal = usePresence(activeCategory !== null, FADE_MS)
  const cache = useCacheSettings(open)

  // The leaving modal keeps rendering the category that was open, so its
  // content stays visible until the fade finishes.
  const lastCategory = useRef<SettingsCategory | null>(null)
  if (activeCategory)
    lastCategory.current = activeCategory
  const shownCategory = activeCategory ?? lastCategory.current
  const shownMeta = SETTINGS_CATEGORIES.find(category => category.key === shownCategory) ?? null

  function closeCategory(): void {
    setActiveCategory(null)
  }

  function categoryBody(category: SettingsCategory | null) {
    switch (category) {
      case 'appearance':
        return <AppearanceSettings />
      case 'bubble':
        return <BubbleSettings />
      case 'notify':
        return <NotifySettings />
      case 'account':
        return <AccountConnectionSettings />
      case 'cache':
        return <CacheSettings state={cache} />
      default:
        return null
    }
  }

  return (
    <>
      {popover.mounted && (
        <section className="rail-popover settings-popover" data-phase={phaseAttribute(popover.phase)}>
          <header className="settings-head">
            <div>
              <strong>{t('界面设置')}</strong>
              <span>{t('仅影响本机微信界面')}</span>
            </div>
            <button type="button" className="popover-close" title={t('关闭')} onClick={onClose}>
              <Icon name="close" size={13} />
            </button>
          </header>

          {/* Directory: one row per category, opening the matching modal. */}
          <div className="settings-directory">
            {SETTINGS_CATEGORIES.map(category => (
              <button
                key={category.key}
                type="button"
                className="directory-row"
                onClick={() => setActiveCategory(category.key)}
              >
                <span className="directory-icon">
                  <Icon name={category.icon} size={15} />
                </span>
                <span className="directory-text">
                  <span className="directory-label">{t(category.label)}</span>
                  <span className="directory-hint">{t(category.hint)}</span>
                </span>
                <Icon className="directory-chevron" name="chevron-right" size={14} />
              </button>
            ))}
          </div>
        </section>
      )}

      {modal.mounted && (
        <div
          className="settings-overlay"
          data-phase={phaseAttribute(modal.phase)}
          onClick={(event) => {
            if (event.target === event.currentTarget)
              closeCategory()
          }}
        >
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label={shownMeta ? t(shownMeta.label) : undefined}
          >
            <header className="settings-modal-head">
              <div>
                <strong>{shownMeta ? t(shownMeta.label) : ''}</strong>
                <span>{shownMeta ? t(shownMeta.hint) : ''}</span>
              </div>
              <button type="button" className="popover-close" title={t('关闭')} onClick={closeCategory}>
                <Icon name="close" size={13} />
              </button>
            </header>

            <div className="settings-modal-body">
              {categoryBody(shownCategory)}
            </div>
          </section>

          {cache.purgeConfirm && (
            <PurgeConfirmDialog
              pending={cache.purgeConfirm}
              onCancel={cache.cancelPurge}
              onConfirm={cache.confirmPurge}
            />
          )}
        </div>
      )}
    </>
  )
}
