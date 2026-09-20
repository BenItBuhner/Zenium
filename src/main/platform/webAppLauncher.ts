/**
 * The files a desktop launcher for an installed web app is made of (MW-22), as text and bytes –
 * no Electron here, so the rules are unit-tested: the `.desktop` entry Linux menus read, the
 * `Info.plist` and launcher script of a macOS `.app` bundle, the ICO and ICNS containers the
 * Windows and macOS shells want their icons in, the command a launcher runs (`zenium
 * --app=<url>`, Chrome's app mode) and the HTML the icon is rendered from. `shortcuts.ts` writes
 * them where each OS looks.
 */
import { createHash } from 'node:crypto'
import { tileInk, tileLetter, type ShortcutIconKind } from '../../shared/webApp'

/** Filesystem-safe handle for an app id (its manifest id or URL): 16 hex chars of its SHA-1. */
export function appSlug(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 16)
}

/**
 * The launcher's file name from the app's name: characters no filesystem or shell tool
 * struggles with, collapsed whitespace, at most 60 characters, never empty or dot-only.
 */
export function launcherFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()
  const noDots = cleaned.replace(/^\.+/, '').replace(/\.+$/, '')
  return noDots || 'Web app'
}

/** What a launcher runs: the program and its arguments (the last being `--app=<url>`). */
export interface LaunchCommand {
  program: string
  args: string[]
}

export interface LaunchEnvironment {
  execPath: string
  /** electron-builder's packaged app (true) or `electron <appPath>` in development. */
  isPackaged: boolean
  /** The app's directory in development (Electron's second argument). */
  appPath: string
  /** Linux: the AppImage the running copy was mounted from, when it was one. */
  appImage?: string | null
}

/**
 * The command that opens `url` in an app window of its own. A packaged copy is its executable
 * (the AppImage itself on Linux, since the mounted binary under /tmp is gone after the run); a
 * development copy is Electron with the app's path.
 */
export function launchCommand(url: string, env: LaunchEnvironment): LaunchCommand {
  const appArg = `--app=${url}`
  if (env.isPackaged) return { program: env.appImage || env.execPath, args: [appArg] }
  return { program: env.execPath, args: [env.appPath, appArg] }
}

/**
 * The `Exec=` value of a desktop entry: every argument double-quoted with the reserved
 * characters escaped as the Desktop Entry specification wants (`"`, `` ` ``, `$`, `\`), and `%`
 * doubled so a URL's escapes are not taken for field codes.
 */
export function desktopExecLine(command: LaunchCommand): string {
  return [command.program, ...command.args].map(quoteDesktopArg).join(' ')
}

function quoteDesktopArg(arg: string): string {
  const escaped = arg.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, '%%')
  return `"${escaped}"`
}

export interface DesktopEntryOptions {
  name: string
  /** The app's URL, shown as the entry's comment (Chrome writes the same). */
  url: string
  exec: string
  /** Absolute path of the PNG icon. */
  icon: string
  /** The WM_CLASS the browser's windows carry, so the entry matches them in the dock. */
  wmClass: string
}

/** A Linux desktop entry for an installed web app (Chrome's `chrome-<id>-Default.desktop`). */
export function desktopEntry(options: DesktopEntryOptions): string {
  const name = desktopValue(options.name)
  return [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    `Name=${name}`,
    `Comment=${desktopValue(options.url)}`,
    `Exec=${options.exec}`,
    `Icon=${desktopValue(options.icon)}`,
    'Terminal=false',
    `StartupWMClass=${desktopValue(options.wmClass)}`,
    'Categories=Network;WebBrowser;',
    'X-Zenium-WebApp=true',
    ''
  ].join('\n')
}

/** A desktop entry value on one line: control characters and newlines have no place in one. */
function desktopValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f]/g, ' ').trim()
}

export interface MacBundleOptions {
  name: string
  bundleId: string
  /** The name of the executable under Contents/MacOS. */
  executable: string
  /** The icon file's name under Contents/Resources. */
  iconFile: string
  /** The app's URL, kept in the plist for the uninstall pass and for curious users. */
  url: string
}

/** The `Info.plist` of a launcher bundle (`~/Applications/Zenium Apps/<name>.app`). */
export function macInfoPlist(options: MacBundleOptions): string {
  const entries: Array<[string, string]> = [
    ['CFBundleDevelopmentRegion', 'en'],
    ['CFBundleDisplayName', options.name],
    ['CFBundleExecutable', options.executable],
    ['CFBundleIconFile', options.iconFile],
    ['CFBundleIdentifier', options.bundleId],
    ['CFBundleInfoDictionaryVersion', '6.0'],
    ['CFBundleName', options.name],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', '1.0'],
    ['CFBundleVersion', '1'],
    ['LSMinimumSystemVersion', '11.0'],
    ['ZeniumWebAppURL', options.url]
  ]
  const body = entries
    .map(([key, value]) => `\t<key>${xml(key)}</key>\n\t<string>${xml(value)}</string>`)
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    body,
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}

function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The bundle's executable: a shell script that opens the app in the running Zenium (or starts
 * it). A packaged copy goes through `open -n` on the browser's bundle, so LaunchServices
 * launches the real binary and its single-instance lock forwards `--app=` to the running copy; a
 * development copy runs Electron directly.
 */
export function macLauncherScript(command: LaunchCommand, browserBundle: string | null): string {
  const args = command.args.map(shellQuote).join(' ')
  const run = browserBundle
    ? `exec open -n -a ${shellQuote(browserBundle)} --args ${args}`
    : `exec ${shellQuote(command.program)} ${args}`
  return `#!/bin/sh\n${run}\n`
}

/** The browser's `.app` bundle from its executable path, or null when not running from one. */
export function macBundleOf(execPath: string): string | null {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return match ? match[1] : null
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

// ---------------------------------------------------------------------------------------------
// Icon containers. Both formats take PNG payloads (ICO since Windows Vista, ICNS since 10.7), so
// no re-encoding is needed: the PNGs of each size go in as they are.
// ---------------------------------------------------------------------------------------------

export interface SizedPng {
  size: number
  png: Uint8Array
}

/** A Windows ICO holding the given PNGs (each one square, at most 256 px). */
export function encodeIco(images: SizedPng[]): Uint8Array {
  const entries = images.filter((i) => i.size > 0 && i.size <= 256)
  if (!entries.length) throw new Error('an ICO needs at least one image of 256 px or less')
  const headerSize = 6 + 16 * entries.length
  const total = headerSize + entries.reduce((sum, i) => sum + i.png.byteLength, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0, true)
  view.setUint16(2, 1, true)
  view.setUint16(4, entries.length, true)
  let offset = headerSize
  entries.forEach((image, index) => {
    const at = 6 + index * 16
    // 256 is written as 0 (the field is a byte).
    out[at] = image.size === 256 ? 0 : image.size
    out[at + 1] = image.size === 256 ? 0 : image.size
    out[at + 2] = 0
    out[at + 3] = 0
    view.setUint16(at + 4, 1, true)
    view.setUint16(at + 6, 32, true)
    view.setUint32(at + 8, image.png.byteLength, true)
    view.setUint32(at + 12, offset, true)
    out.set(image.png, offset)
    offset += image.png.byteLength
  })
  return out
}

/** The ICNS element type for a square PNG of `size` px, or null for a size ICNS has no slot for. */
export function icnsType(size: number): string | null {
  switch (size) {
    case 16:
      return 'icp4'
    case 32:
      return 'icp5'
    case 64:
      return 'icp6'
    case 128:
      return 'ic07'
    case 256:
      return 'ic08'
    case 512:
      return 'ic09'
    case 1024:
      return 'ic10'
    default:
      return null
  }
}

/** A macOS ICNS holding the given PNGs (sizes ICNS knows; others are skipped). */
export function encodeIcns(images: SizedPng[]): Uint8Array {
  const chunks = images
    .map((image) => ({ type: icnsType(image.size), png: image.png }))
    .filter((c): c is { type: string; png: Uint8Array } => c.type !== null)
  if (!chunks.length) throw new Error('an ICNS needs at least one image of a size it knows')
  const total = 8 + chunks.reduce((sum, c) => sum + 8 + c.png.byteLength, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  writeAscii(out, 0, 'icns')
  view.setUint32(4, total, false)
  let offset = 8
  for (const chunk of chunks) {
    writeAscii(out, offset, chunk.type)
    view.setUint32(offset + 4, 8 + chunk.png.byteLength, false)
    out.set(chunk.png, offset + 8)
    offset += 8 + chunk.png.byteLength
  }
  return out
}

function writeAscii(out: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
}

// ---------------------------------------------------------------------------------------------
// The icon itself, drawn as a small HTML document the host renders offscreen: the same three
// rules as the chrome's preview tile (`AppIcon`) and Android's launcher tile, so what the install
// sheet showed is what lands in the Start menu or Dock.
// ---------------------------------------------------------------------------------------------

export interface TileSpec {
  /** The manifest icon as a data URL the document can show, or null for a letter tile. */
  icon: string | null
  kind: ShortcutIconKind | null
  /** `#rrggbb` behind a letter tile and a monochrome glyph. */
  background: string
  /** The `any` icon's own background when the manifest names one; else transparent. */
  iconBackground: string | null
  name: string
  size: number
  /** Round the corners of a full-bleed tile (macOS draws its icons on a squircle). */
  rounded: boolean
}

/**
 * The document of a tile: a maskable icon fills the square (its safe zone is meant for it), an
 * `any` icon sits as it is inside the square (Chrome's desktop launchers keep it whole, on the
 * manifest's background colour when one is given), a monochrome glyph is inked on the theme
 * colour, and with no icon the app's first letter goes on the colour the sheet showed.
 */
export function tileHtml(spec: TileSpec): string {
  const size = Math.max(16, Math.round(spec.size))
  const radius = spec.rounded ? Math.round(size * 0.2237) : 0
  let body: string
  let style: string
  if (spec.icon && spec.kind === 'maskable') {
    style = `background:${cssColor(spec.background)};`
    body = `<img src="${attr(spec.icon)}" style="width:100%;height:100%;object-fit:cover">`
  } else if (spec.icon && spec.kind === 'monochrome') {
    style = `background:${cssColor(spec.background)};`
    const ink = tileInk(spec.background)
    body =
      `<div style="width:62%;height:62%;background:${cssColor(ink)};` +
      `-webkit-mask:url(&quot;${attr(spec.icon)}&quot;) center / contain no-repeat"></div>`
  } else if (spec.icon) {
    const bg = spec.iconBackground ? cssColor(spec.iconBackground) : 'transparent'
    style = `background:${bg};`
    const inset = spec.iconBackground ? '80%' : '100%'
    body = `<img src="${attr(spec.icon)}" style="width:${inset};height:${inset};object-fit:contain">`
  } else {
    style = `background:${cssColor(spec.background)};color:${tileInk(spec.background)};`
    const letter = tileLetter(spec.name)
    body =
      `<span style="font:600 ${Math.round(size * 0.46)}px/1 system-ui, -apple-system, ` +
      `'Segoe UI', Roboto, sans-serif">${text(letter)}</span>`
  }
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    `#tile{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;` +
    `border-radius:${radius}px;overflow:hidden;${style}}` +
    'img{display:block}' +
    `</style></head><body><div id="tile">${body}</div></body></html>`
  )
}

/** A colour for a style attribute: hex and rgb() forms only; anything else falls to grey. */
function cssColor(color: string): string {
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(color.trim()) ? color.trim() : '#8a8a8e'
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function text(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The sizes the OS icon containers get, from the one 512 px rendering. */
export const ICO_SIZES = [16, 32, 48, 64, 128, 256] as const
export const ICNS_SIZES = [16, 32, 64, 128, 256, 512] as const
export const TILE_SIZE = 512

/**
 * What `unpin` has to remove: the files and directories a `pin` wrote, kept next to the icon so
 * an app installed by an older build is still cleaned up by a newer one.
 */
export interface LauncherManifest {
  id: string
  name: string
  url: string
  files: string[]
  directories: string[]
}
