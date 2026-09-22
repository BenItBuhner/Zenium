import { useEffect, useState } from 'react'
import { cmd } from '@renderer/lib/api'

/**
 * The folder new downloads go to right now, for Settings › Downloads › Location (HB-20): the
 * engine's `download.directory` – `Settings.downloads.directory` when set and usable, else the
 * platform's Downloads folder by its path where the host can name one (the desktop shell), the
 * bare setting where it cannot (the phone's downloader has the system folder or the picked
 * tree), empty when neither knows. Chrome's row shows the path itself, so the row asks rather
 * than naming "the system folder".
 *
 * Asked while `enabled` (the section is the open one) and again whenever `key` – the setting
 * – changes, so a Change… or Use default moves the line once the engine has resolved it; null
 * before the first answer (the row falls back to the setting meanwhile).
 */
export function useDownloadDirectory(enabled: boolean, key: string | null): string | null {
  const [directory, setDirectory] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    cmd('download.directory', undefined).then(
      (dir) => {
        if (!cancelled) setDirectory(typeof dir === 'string' ? dir : '')
      },
      () => {
        if (!cancelled) setDirectory('')
      }
    )
    return () => {
      cancelled = true
    }
  }, [enabled, key])
  return directory
}
