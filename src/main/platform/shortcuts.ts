import { app, BrowserWindow, nativeImage, net, shell, type NativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ShortcutHost, ShortcutRequest } from '../../core/platform'
import { LINUX_DESKTOP_ID } from './defaultBrowser'
import { windowIcon } from './appIcon'
import { APP_ICON_DEFAULT } from '../../shared/appIcon'
import { APP_USER_MODEL_ID } from './notifications'
import {
  appSlug,
  desktopEntry,
  desktopExecLine,
  encodeIcns,
  encodeIco,
  ICNS_SIZES,
  ICO_SIZES,
  launchCommand,
  launcherFileName,
  macBundleOf,
  macInfoPlist,
  macLauncherScript,
  tileHtml,
  TILE_SIZE,
  type LauncherManifest,
  type LaunchCommand,
  type SizedPng
} from './webAppLauncher'

/** The folder the launchers gather in (Chrome's "Chrome Apps"). */
export const LAUNCHER_FOLDER = 'Zenium Apps'
const ICON_FETCH_TIMEOUT_MS = 10_000
const ICON_MAX_BYTES = 5 * 1024 * 1024
const RENDER_TIMEOUT_MS = 8_000
const MANIFEST_FILE = 'launcher.json'

/** The pieces of the host the tests replace: what is drawn, and where the OS folders are. */
export interface ShortcutHostDeps {
  /** Render a tile document to a square PNG of `size` px; null when rendering is unavailable. */
  renderTile?: (html: string, size: number) => Promise<Uint8Array | null>
  /** Fetch an icon's bytes and type; null when it cannot be had. */
  fetchIcon?: (url: string) => Promise<{ bytes: Uint8Array; type: string } | null>
  /** The PNG used when nothing else can be drawn (Zenium's own icon). */
  fallbackIcon?: () => Uint8Array
  platform?: NodeJS.Platform
  paths?: Partial<LauncherPaths>
  execPath?: string
  isPackaged?: boolean
  appPath?: string
  appImage?: string | null
}

export interface LauncherPaths {
  /** Linux: `~/.local/share/applications`. */
  applications: string
  /** The user's Desktop, or null when there is none to put a shortcut on. */
  desktop: string | null
  /** Windows: `%APPDATA%\Microsoft\Windows\Start Menu\Programs`. */
  startMenuPrograms: string
  /** macOS: `~/Applications`. */
  userApplications: string
}

/**
 * Installed web apps on the desktop (MW-22): the launcher each OS understands – a Start menu and
 * desktop `.lnk` on Windows, a `.desktop` entry (applications menu and Desktop) on Linux, an
 * `.app` bundle under ~/Applications on macOS – running `zenium --app=<url>`, with the app's
 * icon rendered once from its manifest icon (or a letter tile) and written as PNG plus the ICO
 * or ICNS the shell wants. The icon and a manifest of what was written live under
 * `<profile>/webapps/<slug>/`, so `unpin` can take it all away again. `pin` confirms to the core
 * as soon as the files are on disk, with the icon's `file:` URL for the app window's frame.
 */
export class ElectronShortcuts implements ShortcutHost {
  private readonly platform: NodeJS.Platform
  private readonly paths: LauncherPaths
  private readonly renderTile: (html: string, size: number) => Promise<Uint8Array | null>
  private readonly fetchIcon: (url: string) => Promise<{ bytes: Uint8Array; type: string } | null>

  constructor(
    /** `<profile>/webapps`: icons and manifests. */
    private readonly dir: string,
    private readonly confirm: (id: string, details: { icon: string | null }) => void,
    private readonly deps: ShortcutHostDeps = {}
  ) {
    this.platform = deps.platform ?? process.platform
    this.paths = { ...defaultPaths(), ...deps.paths }
    this.renderTile = deps.renderTile ?? renderTileOffscreen
    this.fetchIcon = deps.fetchIcon ?? fetchIconBytes
  }

  async pin(request: ShortcutRequest): Promise<boolean> {
    const slug = appSlug(request.id)
    const appDir = join(this.dir, slug)
    try {
      // An earlier launcher of the same app (a reinstall, a renamed app) goes first.
      await this.unpin(request.id)
      await mkdir(appDir, { recursive: true })
      const icon = await this.renderIcon(request)
      const pngPath = join(appDir, 'icon.png')
      await writeFile(pngPath, icon.master)
      const manifest: LauncherManifest = {
        id: request.id,
        name: request.title,
        url: request.url,
        files: [pngPath],
        directories: []
      }
      const command = launchCommand(request.url, {
        execPath: this.deps.execPath ?? process.execPath,
        isPackaged: this.deps.isPackaged ?? app.isPackaged,
        appPath: this.deps.appPath ?? app.getAppPath(),
        appImage: this.deps.appImage ?? process.env['APPIMAGE'] ?? null
      })
      switch (this.platform) {
        case 'win32':
          await this.writeWindows(request, appDir, icon, command, manifest)
          break
        case 'darwin':
          await this.writeMac(request, slug, appDir, icon, command, manifest)
          break
        default:
          await this.writeLinux(request, slug, pngPath, command, manifest)
      }
      await writeFile(join(appDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2))
      this.confirm(request.id, { icon: pathToFileURL(pngPath).href })
      return true
    } catch (error) {
      console.warn('[zen] web app: could not create the launcher:', error)
      await rm(appDir, { recursive: true, force: true }).catch(() => undefined)
      return false
    }
  }

  async unpin(id: string): Promise<void> {
    const appDir = join(this.dir, appSlug(id))
    let manifest: LauncherManifest | null = null
    try {
      manifest = JSON.parse(await readFile(join(appDir, MANIFEST_FILE), 'utf8')) as LauncherManifest
    } catch {
      manifest = null
    }
    for (const file of manifest?.files ?? []) await rm(file, { force: true }).catch(() => undefined)
    for (const directory of manifest?.directories ?? [])
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    await rm(appDir, { recursive: true, force: true }).catch(() => undefined)
    if (manifest && this.platform === 'linux') refreshDesktopDatabase(this.paths.applications)
  }

  /** The Windows AppUserModelID an app's windows and launcher share (their own taskbar group). */
  static appUserModelId(appId: string): string {
    return `${APP_USER_MODEL_ID}.app.${appSlug(appId)}`
  }

  /** The command line Windows runs for a taskbar pin of an app window (`--app=<url>`). */
  static relaunchCommand(url: string): string {
    const command = launchCommand(url, {
      execPath: process.execPath,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      appImage: null
    })
    return [command.program, ...command.args].map(quoteWindowsArg).join(' ')
  }

  // --- The icon ---------------------------------------------------------------------------------

  /**
   * One 512 px rendering of the tile, from the manifest icon when it can be fetched (SVG
   * included: the renderer draws it) and the letter tile otherwise; the OS sizes scale from it.
   */
  private async renderIcon(request: ShortcutRequest): Promise<RenderedIcon> {
    let iconData: string | null = null
    if (request.iconUrl) {
      const fetched = await this.fetchIcon(request.iconUrl).catch(() => null)
      if (fetched)
        iconData = `data:${fetched.type};base64,${Buffer.from(fetched.bytes).toString('base64')}`
    }
    const html = tileHtml({
      icon: iconData,
      kind: iconData ? request.iconKind : null,
      background: request.background,
      iconBackground: request.iconBackground,
      name: request.title,
      size: TILE_SIZE,
      rounded: this.platform === 'darwin'
    })
    let master = await this.renderTile(html, TILE_SIZE).catch(() => null)
    if (!master && iconData) {
      // No renderer (a headless run without a GPU process): the raw icon, when Chromium's image
      // decoder reads it, scaled to the tile.
      const raw = nativeImage.createFromDataURL(iconData)
      if (!raw.isEmpty()) master = raw.resize({ width: TILE_SIZE, height: TILE_SIZE }).toPNG()
    }
    if (!master) master = (this.deps.fallbackIcon ?? zeniumIcon)()
    return { master, image: nativeImage.createFromBuffer(Buffer.from(master)) }
  }

  private sized(icon: RenderedIcon, sizes: readonly number[]): SizedPng[] {
    return sizes.map((size) => ({
      size,
      png:
        size === TILE_SIZE ? icon.master : icon.image.resize({ width: size, height: size }).toPNG()
    }))
  }

  // --- Windows ----------------------------------------------------------------------------------

  private async writeWindows(
    request: ShortcutRequest,
    appDir: string,
    icon: RenderedIcon,
    command: LaunchCommand,
    manifest: LauncherManifest
  ): Promise<void> {
    const icoPath = join(appDir, 'icon.ico')
    await writeFile(icoPath, encodeIco(this.sized(icon, ICO_SIZES)))
    manifest.files.push(icoPath)
    const name = launcherFileName(request.title)
    const options: Electron.ShortcutDetails = {
      target: command.program,
      args: command.args.map(quoteWindowsArg).join(' '),
      cwd: dirname(command.program),
      icon: icoPath,
      iconIndex: 0,
      description: request.url,
      appUserModelId: ElectronShortcuts.appUserModelId(request.id)
    }
    const startMenuDir = join(this.paths.startMenuPrograms, LAUNCHER_FOLDER)
    await mkdir(startMenuDir, { recursive: true })
    const startMenu = join(startMenuDir, `${name}.lnk`)
    if (!shell.writeShortcutLink(startMenu, 'create', options))
      throw new Error(`could not write ${startMenu}`)
    manifest.files.push(startMenu)
    if (this.paths.desktop) {
      const desktop = join(this.paths.desktop, `${name}.lnk`)
      if (shell.writeShortcutLink(desktop, 'create', options)) manifest.files.push(desktop)
    }
  }

  // --- macOS ------------------------------------------------------------------------------------

  private async writeMac(
    request: ShortcutRequest,
    slug: string,
    appDir: string,
    icon: RenderedIcon,
    command: LaunchCommand,
    manifest: LauncherManifest
  ): Promise<void> {
    const icnsPath = join(appDir, 'icon.icns')
    const icns = encodeIcns(this.sized(icon, ICNS_SIZES))
    await writeFile(icnsPath, icns)
    manifest.files.push(icnsPath)
    const folder = join(this.paths.userApplications, LAUNCHER_FOLDER)
    const bundle = join(folder, `${launcherFileName(request.title)}.app`)
    await rm(bundle, { recursive: true, force: true })
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    await mkdir(join(bundle, 'Contents', 'Resources'), { recursive: true })
    await writeFile(
      join(bundle, 'Contents', 'Info.plist'),
      macInfoPlist({
        name: request.title,
        bundleId: `${APP_USER_MODEL_ID}.app.${slug}`,
        executable: 'app',
        iconFile: 'app.icns',
        url: request.url
      })
    )
    const executable = join(bundle, 'Contents', 'MacOS', 'app')
    const browserBundle =
      (this.deps.isPackaged ?? app.isPackaged) ? macBundleOf(command.program) : null
    await writeFile(executable, macLauncherScript(command, browserBundle))
    await chmod(executable, 0o755)
    await writeFile(join(bundle, 'Contents', 'Resources', 'app.icns'), icns)
    manifest.directories.push(bundle)
    // Finder and LaunchServices notice a bundle whose modification time changed.
    touch(bundle)
  }

  // --- Linux ------------------------------------------------------------------------------------

  private async writeLinux(
    request: ShortcutRequest,
    slug: string,
    pngPath: string,
    command: LaunchCommand,
    manifest: LauncherManifest
  ): Promise<void> {
    const entry = desktopEntry({
      name: request.title,
      url: request.url,
      exec: desktopExecLine(command),
      icon: pngPath,
      wmClass: LINUX_DESKTOP_ID.replace(/\.desktop$/, '')
    })
    await mkdir(this.paths.applications, { recursive: true })
    const fileName = `zenium-webapp-${slug}.desktop`
    const menuEntry = join(this.paths.applications, fileName)
    await writeFile(menuEntry, entry)
    await chmod(menuEntry, 0o755)
    manifest.files.push(menuEntry)
    if (this.paths.desktop && existsSync(this.paths.desktop)) {
      // The Desktop copy carries the app's name, like Chrome's; the menu entry keeps the slug so
      // two apps of one name never clash.
      const desktop = join(this.paths.desktop, `${launcherFileName(request.title)}.desktop`)
      await writeFile(desktop, entry)
      await chmod(desktop, 0o755)
      manifest.files.push(desktop)
    }
    refreshDesktopDatabase(this.paths.applications)
  }
}

interface RenderedIcon {
  /** The 512 px PNG. */
  master: Uint8Array
  image: NativeImage
}

function defaultPaths(): LauncherPaths {
  const home = homedir()
  return {
    applications: join(
      process.env['XDG_DATA_HOME'] || join(home, '.local', 'share'),
      'applications'
    ),
    desktop: safePath(() => app.getPath('desktop')),
    startMenuPrograms: join(
      safePath(() => app.getPath('appData')) ?? join(home, 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    ),
    userApplications: join(home, 'Applications')
  }
}

/** Zenium's own icon at the tile size: the last resort for an app without a drawable icon. */
function zeniumIcon(): Uint8Array {
  return windowIcon(APP_ICON_DEFAULT).resize({ width: TILE_SIZE, height: TILE_SIZE }).toPNG()
}

function safePath(get: () => string): string | null {
  try {
    return get()
  } catch {
    return null
  }
}

/** A Windows command-line argument: quoted when it has spaces, inner quotes escaped. */
function quoteWindowsArg(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

/** `update-desktop-database` refreshes the menus' cache where it exists; harmless without it. */
function refreshDesktopDatabase(applications: string): void {
  execFile('update-desktop-database', [applications], { timeout: 10_000 }, () => undefined)
}

function touch(path: string): void {
  execFile('touch', [path], { timeout: 5_000 }, () => undefined)
}

/**
 * Bytes of an icon: a data URL decoded on the spot, anything else fetched over the network with
 * a time and size limit. Null when it cannot be had – the tile then shows a letter.
 */
async function fetchIconBytes(url: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(url)
  if (data) {
    const type = data[1] || 'application/octet-stream'
    const bytes = data[2]
      ? Buffer.from(data[3], 'base64')
      : Buffer.from(decodeURIComponent(data[3]), 'utf8')
    return bytes.byteLength ? { bytes, type } : null
  }
  if (!/^https?:\/\//i.test(url)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ICON_FETCH_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!bytes.byteLength || bytes.byteLength > ICON_MAX_BYTES) return null
    const type = response.headers.get('content-type')?.split(';')[0].trim() || sniffType(bytes)
    return { bytes, type }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function sniffType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x3c) return 'image/svg+xml'
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp'
  return 'image/x-icon'
}

/**
 * Draw a tile document in an offscreen window and read it back as a PNG with its transparency.
 * The window never shows; it is gone once the frame is captured (or the wait runs out).
 */
async function renderTileOffscreen(html: string, size: number): Promise<Uint8Array | null> {
  const win = new BrowserWindow({
    show: false,
    width: size,
    height: size,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      images: true,
      zoomFactor: 1
    }
  })
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), RENDER_TIMEOUT_MS))
  const render = (async (): Promise<Uint8Array | null> => {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    // Images decode after load; wait for every one before reading the frame.
    await win.webContents.executeJavaScript(
      `Promise.all([...document.images].map((i) => i.decode().catch(() => undefined)))` +
        `.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`,
      true
    )
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
    if (image.isEmpty()) return null
    const { width } = image.getSize()
    return (width === size ? image : image.resize({ width: size, height: size })).toPNG()
  })()
  try {
    return await Promise.race([render, timeout])
  } catch {
    return null
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
