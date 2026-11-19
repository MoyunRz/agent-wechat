// "Bubble style" settings category: preset and custom bubble colours plus the
// bubble font size. Empty colours mean "follow the accent theme".

import type { ChangeEvent } from 'react'
import { useT } from '../../i18n/useT'
import {
  setBubbleFontSize,
  setBubbleInColor,
  setBubbleOutColor,
  UI_THEMES,
} from '../../store/actions'
import { useStore } from '../../store/hooks'

const INCOMING_PRESETS = ['#eef1f6', '#ffffff', '#e8f1ff', '#e9f7ef', '#f1ecff', '#1a212c']
const OUTGOING_PRESETS = ['#2f7cf6', '#22c55e', '#8b5cf6', '#f97316', '#f43f5e']

export default function BubbleSettings() {
  const t = useT()
  const themeId = useStore(state => state.ui.themeId)
  const themeMode = useStore(state => state.ui.themeMode)
  const bubbleFontSize = useStore(state => state.ui.bubbleFontSize)
  const bubbleInColor = useStore(state => state.ui.bubbleInColor)
  const bubbleOutColor = useStore(state => state.ui.bubbleOutColor)

  const activeTheme = UI_THEMES.find(theme => theme.id === themeId) ?? UI_THEMES[0]
  // Preview colours mirror the variables the theme applies when no custom
  // colour is chosen.
  const incomingPreview = bubbleInColor || (themeMode === 'light' ? '#ffffff' : '#1a212c')
  const outgoingPreview = bubbleOutColor || activeTheme?.accent || '#2f7cf6'

  function onFontSizeInput(event: ChangeEvent<HTMLInputElement>): void {
    const value = Number(event.target.value)
    if (Number.isFinite(value))
      setBubbleFontSize(value)
  }

  return (
    <>
      <div className="settings-section">
        <span className="settings-label">{t('气泡颜色')}</span>

        <div className="bubble-color-row">
          <span className="bubble-color-label">{t('对方')}</span>
          <div className="bubble-color-controls">
            {INCOMING_PRESETS.map(color => (
              <button
                key={color}
                type="button"
                className={`bubble-swatch${bubbleInColor === color ? ' active' : ''}`}
                style={{ background: color }}
                title={color}
                onClick={() => setBubbleInColor(color)}
              />
            ))}
            <label className="custom-color" title={t('自定义对方气泡颜色')}>
              <span className="custom-color-preview" style={{ background: incomingPreview }} />
              <input
                type="color"
                value={incomingPreview}
                onChange={event => setBubbleInColor(event.target.value)}
              />
            </label>
            <button
              type="button"
              className={`color-auto${bubbleInColor ? '' : ' active'}`}
              onClick={() => setBubbleInColor('')}
            >
              {t('自动')}
            </button>
          </div>
        </div>

        <div className="bubble-color-row">
          <span className="bubble-color-label">{t('我方')}</span>
          <div className="bubble-color-controls">
            {OUTGOING_PRESETS.map(color => (
              <button
                key={color}
                type="button"
                className={`bubble-swatch${bubbleOutColor === color ? ' active' : ''}`}
                style={{ background: color }}
                title={color}
                onClick={() => setBubbleOutColor(color)}
              />
            ))}
            <label className="custom-color" title={t('自定义我方气泡颜色')}>
              <span className="custom-color-preview" style={{ background: outgoingPreview }} />
              <input
                type="color"
                value={outgoingPreview}
                onChange={event => setBubbleOutColor(event.target.value)}
              />
            </label>
            <button
              type="button"
              className={`color-auto${bubbleOutColor ? '' : ' active'}`}
              onClick={() => setBubbleOutColor('')}
            >
              {t('自动')}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-row">
          <span className="settings-label">{t('气泡字号')}</span>
          <span className="settings-value">{bubbleFontSize}px</span>
        </div>
        <input
          className="font-slider"
          type="range"
          min="12"
          max="18"
          step="0.5"
          value={bubbleFontSize}
          onChange={onFontSizeInput}
        />
      </div>
    </>
  )
}
