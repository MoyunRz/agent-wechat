// Restores the stored theme before the first paint. This used to be an inline
// <script> in index.html, which the desktop shell's Content-Security-Policy
// blocks; running it from a module keeps the same ordering without inline code.

const UI_SETTINGS_KEY = 'vane.wechat.ui-settings'

export function restoreThemeBeforePaint(): void {
  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_KEY)
    if (raw && JSON.parse(raw).themeMode === 'light')
      document.documentElement.classList.add('theme-light')
  }
  catch {
    // Reading the settings can fail in private modes; keep the default theme.
  }
}

restoreThemeBeforePaint()
