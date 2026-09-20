import type { ImportBrowser, Platform as PlatformOs } from '../../shared/types'

/**
 * Where the other browsers keep their profiles on each OS, and how they name them. Pure path
 * arithmetic over the host's home directory and environment; the probing (`stat`, `list`,
 * `readText`) is `sources.ts`'s.
 */

export type ProfileBrowser = Exclude<ImportBrowser, 'file'>
export type ChromiumBrowser = 'chrome' | 'chromium' | 'edge'

export const BROWSER_NAMES: Record<ImportBrowser, string> = {
  chrome: 'Google Chrome',
  chromium: 'Chromium',
  edge: 'Microsoft Edge',
  firefox: 'Firefox',
  safari: 'Safari',
  file: 'File'
}

/** Chrome's folder names for an import that could not merge into an empty bookmarks bar. */
export const IMPORTED_FOLDER_TITLES: Record<ImportBrowser, string> = {
  chrome: 'Imported From Chrome',
  chromium: 'Imported From Chromium',
  edge: 'Imported From Edge',
  firefox: 'Imported From Firefox',
  safari: 'Imported From Safari',
  file: 'Imported'
}

export interface ImportEnvironment {
  os: PlatformOs
  homeDir: string
  env: Readonly<Record<string, string | undefined>>
}

/** Join with forward slashes; Node's file APIs take them on Windows too. */
export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== '')
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/')
}

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

export function dirName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? '' : trimmed.slice(0, at)
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function configHome(env: ImportEnvironment): string {
  return env.env.XDG_CONFIG_HOME || joinPath(env.homeDir, '.config')
}

function localAppData(env: ImportEnvironment): string {
  return env.env.LOCALAPPDATA || joinPath(env.homeDir, 'AppData', 'Local')
}

function roamingAppData(env: ImportEnvironment): string {
  return env.env.APPDATA || joinPath(env.homeDir, 'AppData', 'Roaming')
}

/**
 * The "User Data" directories a Chromium-family browser may have: the native install first,
 * then the sandboxed packagings (Flatpak, Snap) that keep their own copy.
 */
export function chromiumUserDataDirs(browser: ChromiumBrowser, env: ImportEnvironment): string[] {
  const home = env.homeDir
  switch (env.os) {
    case 'linux': {
      const config = configHome(env)
      const flatpak = (app: string, dir: string): string =>
        joinPath(home, '.var', 'app', app, 'config', dir)
      if (browser === 'chrome')
        return [joinPath(config, 'google-chrome'), flatpak('com.google.Chrome', 'google-chrome')]
      if (browser === 'edge')
        return [joinPath(config, 'microsoft-edge'), flatpak('com.microsoft.Edge', 'microsoft-edge')]
      return [
        joinPath(config, 'chromium'),
        joinPath(home, 'snap', 'chromium', 'common', 'chromium'),
        flatpak('org.chromium.Chromium', 'chromium')
      ]
    }
    case 'darwin': {
      const support = joinPath(home, 'Library', 'Application Support')
      if (browser === 'chrome') return [joinPath(support, 'Google', 'Chrome')]
      if (browser === 'edge') return [joinPath(support, 'Microsoft Edge')]
      return [joinPath(support, 'Chromium')]
    }
    case 'win32': {
      const local = localAppData(env)
      if (browser === 'chrome') return [joinPath(local, 'Google', 'Chrome', 'User Data')]
      if (browser === 'edge') return [joinPath(local, 'Microsoft', 'Edge', 'User Data')]
      return [joinPath(local, 'Chromium', 'User Data')]
    }
    default:
      return []
  }
}

/** The directories holding Firefox's `profiles.ini`. */
export function firefoxRoots(env: ImportEnvironment): string[] {
  const home = env.homeDir
  switch (env.os) {
    case 'linux':
      return [
        joinPath(home, '.mozilla', 'firefox'),
        joinPath(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
        joinPath(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')
      ]
    case 'darwin':
      return [joinPath(home, 'Library', 'Application Support', 'Firefox')]
    case 'win32':
      return [joinPath(roamingAppData(env), 'Mozilla', 'Firefox')]
    default:
      return []
  }
}

/** Safari keeps one profile's data under `~/Library/Safari`; nothing outside macOS. */
export function safariDir(env: ImportEnvironment): string | null {
  return env.os === 'darwin' ? joinPath(env.homeDir, 'Library', 'Safari') : null
}

// ---------------------------------------------------------------------------
// Chrome's `Local State`
// ---------------------------------------------------------------------------

export interface ChromiumProfileInfo {
  /** The profile directory's name (`Default`, `Profile 3`). */
  dir: string
  /** What Chrome's profile menu shows. */
  name: string
  email?: string
}

/** Chrome's own profile directories that are never a user's: the guest and the system profile. */
const CHROMIUM_INTERNAL_PROFILES = new Set(['Guest Profile', 'System Profile'])

/**
 * The profiles Chrome records in `Local State` (`profile.info_cache`), in the order Chrome lists
 * them: the last used first, then the rest by name. A profile's display name is its Google
 * account's name when it uses the default local name, else the local name.
 */
export function parseLocalState(text: string): {
  profiles: ChromiumProfileInfo[]
  lastUsed: string | null
} {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { profiles: [], lastUsed: null }
  }
  const profile = record(record(data)?.profile)
  const cache = record(profile?.info_cache)
  const lastUsed = typeof profile?.last_used === 'string' ? profile.last_used : null
  const profiles: ChromiumProfileInfo[] = []
  for (const [dir, raw] of Object.entries(cache ?? {})) {
    if (CHROMIUM_INTERNAL_PROFILES.has(dir)) continue
    const info = record(raw) ?? {}
    const local = str(info.name)
    const gaia = str(info.gaia_name) || str(info.gaia_given_name)
    const usingDefaultName = info.is_using_default_name !== false
    const name = (usingDefaultName && gaia) || local || gaia || dir
    const email = str(info.user_name)
    profiles.push(email ? { dir, name, email } : { dir, name })
  }
  profiles.sort((a, b) => {
    if (a.dir === lastUsed) return -1
    if (b.dir === lastUsed) return 1
    return a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir)
  })
  return { profiles, lastUsed }
}

/** Directory names under a User Data dir that look like Chrome profiles. */
export function looksLikeChromiumProfileDir(name: string): boolean {
  return name === 'Default' || /^Profile \d+$/.test(name)
}

// ---------------------------------------------------------------------------
// Firefox's `profiles.ini`
// ---------------------------------------------------------------------------

export interface FirefoxProfileInfo {
  name: string
  /** Absolute profile directory. */
  path: string
  /** The profile Firefox opens by default (an `[Install…]` section's `Default`, or `Default=1`). */
  isDefault: boolean
}

/**
 * The `[ProfileN]` sections of `profiles.ini`, resolved against `root` when `IsRelative=1`.
 * Default profiles lead, then the rest in file order.
 */
export function parseProfilesIni(text: string, root: string): FirefoxProfileInfo[] {
  const sections = new Map<string, Map<string, string>>()
  let current: Map<string, string> | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      current = new Map()
      sections.set(header[1], current)
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1 || !current) continue
    current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const installDefaults = new Set<string>()
  for (const [name, section] of sections) {
    if (!name.startsWith('Install')) continue
    const def = section.get('Default')
    if (def) installDefaults.add(def)
  }
  const profiles: FirefoxProfileInfo[] = []
  for (const [name, section] of sections) {
    if (!/^Profile\d+$/.test(name)) continue
    const rel = section.get('Path')
    if (!rel) continue
    const relative = section.get('IsRelative') !== '0' && !isAbsolutePath(rel)
    const path = relative ? joinPath(root, rel) : rel
    profiles.push({
      name: section.get('Name') || baseName(rel),
      path,
      isDefault: installDefaults.has(rel) || section.get('Default') === '1'
    })
  }
  profiles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  return profiles
}

// ---------------------------------------------------------------------------
// Files and locks
// ---------------------------------------------------------------------------

/** The files each kind lives in, relative to the profile directory. */
export const CHROMIUM_FILES = {
  bookmarks: 'Bookmarks',
  history: 'History',
  /** The profile's logins; `Login Data For Account` holds the account-store ones (Chrome 8x+). */
  logins: ['Login Data', 'Login Data For Account']
} as const

export const FIREFOX_FILES = {
  places: 'places.sqlite',
  backups: 'bookmarkbackups'
} as const

export const SAFARI_FILES = {
  bookmarks: 'Bookmarks.plist',
  history: 'History.db'
} as const

/** SQLite's companions a copy has to take along for the database to open consistently. */
export function sqliteCompanions(path: string): string[] {
  return [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
}

/**
 * The process-singleton markers a Chromium browser leaves in its User Data directory while it
 * runs: a `SingletonLock` symlink (`hostname-pid`) plus the socket and cookie on Linux and
 * macOS, a `lockfile` on Windows.
 */
export function chromiumLockPaths(userDataDir: string, os: PlatformOs): string[] {
  const names =
    os === 'win32' ? ['lockfile'] : ['SingletonLock', 'SingletonSocket', 'SingletonCookie']
  return names.map((n) => joinPath(userDataDir, n))
}

/** Firefox's profile lock: a `lock` symlink and `.parentlock` on Linux / macOS, `parent.lock` on Windows. */
export function firefoxLockPaths(profileDir: string, os: PlatformOs): string[] {
  const names = os === 'win32' ? ['parent.lock'] : ['lock', '.parentlock']
  return names.map((n) => joinPath(profileDir, n))
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
