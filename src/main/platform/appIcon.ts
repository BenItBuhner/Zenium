import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appIconVariant, type AppIconId } from '../../shared/appIcon'

/**
 * The per-variant icons `scripts/app-icons.ts` writes under `resources/icons/<id>/`. In a
 * packaged app they sit next to the asar (electron-builder's `asarUnpack: resources/**`), so
 * Chromium can read them by path.
 */
function iconsRoot(): string {
  if (app.isPackaged) {
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icons')
    if (existsSync(unpacked)) return unpacked
  }
  return join(app.getAppPath(), 'resources', 'icons')
}

/**
 * The window / taskbar image of a variant: on Windows the multi-size ICO (crisp at 16 and 32),
 * elsewhere the 512 PNG. Falls back to the PNG should the ICO not load.
 */
export function windowIcon(id: AppIconId): NativeImage {
  const dir = join(iconsRoot(), appIconVariant(id).id)
  if (process.platform === 'win32') {
    const ico = nativeImage.createFromPath(join(dir, 'icon.ico'))
    if (!ico.isEmpty()) return ico
  }
  return nativeImage.createFromPath(join(dir, 'icon.png'))
}

/** The Dock image of a variant: the 1024 PNG drawn on macOS's icon grid (margin included). */
export function dockIcon(id: AppIconId): NativeImage {
  return nativeImage.createFromPath(join(iconsRoot(), appIconVariant(id).id, 'dock.png'))
}

/**
 * Show the app under `id` from now on. macOS keeps one icon per app in the Dock; Windows and
 * Linux take it per window (title bar, taskbar / dock entry). Installed shortcuts keep the icon
 * the installer stamped on them: on Windows the next update re-points them (below), which the
 * Settings hint says.
 */
export function applyAppIcon(id: AppIconId, windows: Iterable<BrowserWindow>): void {
  if (process.platform === 'darwin') {
    const image = dockIcon(id)
    if (!image.isEmpty()) app.dock?.setIcon(image)
    return
  }
  const image = windowIcon(id)
  if (image.isEmpty()) return
  for (const win of windows) if (!win.isDestroyed()) win.setIcon(image)
  if (process.platform === 'win32' && app.isPackaged) rememberForInstaller(id)
}

/**
 * Windows: leave the choice where the installer reads it. `build/installer.nsh` re-creates the
 * Start menu and desktop shortcuts with the matching ICO on the next update, since a shortcut's
 * icon is set when the installer writes it.
 */
function rememberForInstaller(id: AppIconId): void {
  execFile(
    'reg',
    ['add', 'HKCU\\Software\\Zenium', '/v', 'AppIcon', '/t', 'REG_SZ', '/d', id, '/f'],
    { windowsHide: true },
    (error) => {
      if (error)
        console.warn(
          '[zen] app icon: could not record the choice for the installer:',
          error.message
        )
    }
  )
}
