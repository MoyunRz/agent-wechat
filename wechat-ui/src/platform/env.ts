// Runtime detection. The same bundle runs in a browser served by the hub and
// inside the Tauri desktop shell; desktop-only capabilities are gated on this.

export type PlatformKind = 'web' | 'desktop'

/** True when the page runs inside the Tauri webview (v2 exposes the internals). */
export function isDesktop(): boolean {
  if (typeof window === 'undefined')
    return false
  const scope = window as unknown as Record<string, unknown>
  return '__TAURI_INTERNALS__' in scope || '__TAURI__' in scope
}

export function platformKind(): PlatformKind {
  return isDesktop() ? 'desktop' : 'web'
}
