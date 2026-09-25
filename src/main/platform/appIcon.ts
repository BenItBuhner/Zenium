import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ICON_PRIVATE, appIconVariant, type AppIconId } from '../../shared/appIcon'

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
  return windowIconIn(join(iconsRoot(), appIconVariant(id).id))
}

/**
 * The private windows' image (`resources/icons/private/`: the mask on the private purple, os-56),
 * the same way; empty when the copy ships none, and the caller falls back to the variant's.
 */
export function privateWindowIcon(): NativeImage {
  return windowIconIn(join(iconsRoot(), APP_ICON_PRIVATE.folder))
}

function windowIconIn(dir: string): NativeImage {
  if (process.platform === 'win32') {
    const ico = nativeImage.createFromPath(join(dir, 'icon.ico'))
    if (!ico.isEmpty()) return ico
  }
  return nativeImage.createFromPath(join(dir, 'icon.png'))
}

/** The 512 PNG of a variant on disk (Windows toasts take an image path), or null when missing. */
export function iconPngPath(id: AppIconId): string | null {
  return existingPath(join(iconsRoot(), appIconVariant(id).id, 'icon.png'))
}

/**
 * The private icon's file on disk – the ICO a taskbar group's relaunch entry names, or the PNG
 * the AppUserModelId class key's `IconUri` takes – or null when the copy ships none.
 */
export function privateIconPath(kind: 'ico' | 'png'): string | null {
  return existingPath(join(iconsRoot(), APP_ICON_PRIVATE.folder, `icon.${kind}`))
}

function existingPath(path: string): string | null {
  return existsSync(path) ? path : null
}

/** The Dock image of a variant: the 1024 PNG drawn on macOS's icon grid (margin included). */
export function dockIcon(id: AppIconId): NativeImage {
  return nativeImage.createFromPath(join(iconsRoot(), appIconVariant(id).id, 'dock.png'))
}

/**
 * Show the app under `id` from now on. macOS keeps one icon per app in the Dock; Windows and
 * Linux take it per window (title bar, taskbar / dock entry). Installed shortcuts keep the icon
 * the installer stamped on them: on Windows the next update re-points them (below), which the
 * Settings hint says. `windows` are the browser's non-private ones: a private window keeps the
 * private icon whatever the variant.
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
