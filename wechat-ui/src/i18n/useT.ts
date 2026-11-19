import { useCallback, useSyncExternalStore } from 'react'
import { applyDocumentLanguage, getLocale, setLocale, subscribeLocale, t, type Locale } from './index'

/** Re-renders the caller when the interface language changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}

export function useT(): typeof t {
  useLocale()
  return t
}

export function useSetLocale(): (locale: Locale) => void {
  return useCallback((locale: Locale) => {
    setLocale(locale)
    applyDocumentLanguage()
  }, [])
}
