// Saving a downloaded attachment. The browser downloads through an anchor; the
// desktop shell registers a native save dialog.

export type FileSaver = (blob: Blob, filename: string) => Promise<boolean>

let desktopSaver: FileSaver | null = null

/** Installed by the desktop platform bootstrap. */
export function registerFileSaver(saver: FileSaver | null): void {
  desktopSaver = saver
}

function browserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke after the click has been handled by the browser.
  window.setTimeout(() => URL.revokeObjectURL(url), 4_000)
}

/** Saves bytes under `filename`. Resolves false when the user cancels. */
export async function saveFile(blob: Blob, filename: string): Promise<boolean> {
  if (desktopSaver) {
    try {
      return await desktopSaver(blob, filename)
    }
    catch {
      return false
    }
  }
  browserDownload(blob, filename)
  return true
}
