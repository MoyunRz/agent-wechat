import { bootstrapI18n } from '../i18n/bootstrap'
import { initDesktopPlatform, saveDesktopFile } from './desktop'
import { isDesktop } from './env'
import { registerFileSaver } from './files'

/**
 * Prepares the runtime before React mounts: language catalogues, and the
 * desktop transport and bridges when running inside the Tauri shell.
 *
 * The desktop module is imported statically because the shell renders its
 * components; it only touches Tauri APIs behind isDesktop() guards.
 */
export async function initPlatform(): Promise<void> {
  bootstrapI18n()
  if (!isDesktop())
    return
  await initDesktopPlatform()
  registerFileSaver(saveDesktopFile)
}
