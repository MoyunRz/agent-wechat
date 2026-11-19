import { applyDocumentLanguage, installDictionaries } from './index'
import en from './dict/en/index'
import zh from './dict/zh/index'

let installed = false

/** Installs both catalogues and applies the detected language to <html>. */
export function bootstrapI18n(): void {
  if (installed)
    return
  installed = true
  installDictionaries({ en, zh })
  applyDocumentLanguage()
}
