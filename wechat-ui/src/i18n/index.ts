// Source-string translation. UI code passes the Chinese source text to `t()`;
// the English catalogue maps that text to a translation. An unknown source
// string falls back to the source text, so a missing entry degrades to Chinese
// instead of showing a key.

export type Locale = 'zh' | 'en'

export const SUPPORTED_LOCALES: readonly Locale[] = ['zh', 'en']

const LOCALE_STORAGE_KEY = 'vane.wechat.locale'

const listeners = new Set<() => void>()

let dictionaries: Record<Locale, Record<string, string>> = { en: {}, zh: {} }

let currentLocale: Locale = detectLocale()

function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en'
}

function detectLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isLocale(stored))
      return stored
  }
  catch {
    // Storage can be unavailable in private modes; fall through to the browser.
  }
  try {
    const languages = Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language]
    for (const language of languages) {
      const tag = String(language ?? '').toLowerCase()
      if (tag.startsWith('zh'))
        return 'zh'
      if (tag.startsWith('en'))
        return 'en'
    }
  }
  catch {
    // Ignore and use the default below.
  }
  return 'zh'
}

/** Registers the merged catalogue. Called once from the i18n bootstrap module. */
export function installDictionaries(next: Record<Locale, Record<string, string>>): void {
  dictionaries = next
  notify()
}

function notify(): void {
  for (const listener of listeners)
    listener()
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale)
    return
  currentLocale = locale
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  }
  catch {
    // Persisting the choice is best effort.
  }
  applyDocumentLanguage()
  notify()
}

export function applyDocumentLanguage(): void {
  try {
    document.documentElement.lang = currentLocale === 'en' ? 'en' : 'zh-CN'
  }
  catch {
    // Non-browser environments have no document.
  }
}

export type TranslationVars = Record<string, string | number>

/**
 * Translate a Chinese source string. `vars` fills `{name}` placeholders after
 * the catalogue lookup, so translations can reorder them.
 */
export function t(source: string, vars?: TranslationVars): string {
  const dictionary = dictionaries[currentLocale]
  const template = dictionary?.[source] ?? source
  if (!vars)
    return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}
