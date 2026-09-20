import type { ImportKind, ImportSource, Platform as PlatformOs } from '../../shared/types'
import type { ImportHost } from '../platform'
import {
  BROWSER_NAMES,
  CHROMIUM_FILES,
  FIREFOX_FILES,
  SAFARI_FILES,
  chromiumLockPaths,
  chromiumUserDataDirs,
  firefoxLockPaths,
  firefoxRoots,
  joinPath,
  looksLikeChromiumProfileDir,
  parseLocalState,
  parseProfilesIni,
  safariDir,
  type ChromiumBrowser,
  type ImportEnvironment
} from './locations'

/**
 * Finding what an import can come from: every Chrome, Chromium, Edge and Firefox profile on the
 * machine (Safari on macOS), what each holds, and whether its browser is running. Probed afresh
 * on every `import.sources`, so a browser closed since the dialog opened is seen closed.
 */

export interface DiscoveryOptions {
  os: PlatformOs
  /** The history model takes imported visits (`historyImportSink`); off, no source offers history. */
  historyWritable: boolean
  /** The credential vault exists on this host (`capabilities.passwords`). */
  passwordsAvailable: boolean
}

export const FILE_SOURCE_IDS = { bookmarks: 'file:bookmarks', passwords: 'file:passwords' } as const

/** The file sources every host offers: a Netscape bookmarks HTML, a passwords CSV. */
export function fileSources(passwordsAvailable: boolean): ImportSource[] {
  const sources: ImportSource[] = [
    {
      id: FILE_SOURCE_IDS.bookmarks,
      browser: 'file',
      browserName: 'Bookmarks HTML file',
      profileId: 'bookmarks',
      name: 'Bookmarks HTML file',
      path: '',
      running: false,
      kinds: ['bookmarks'],
      limits: {}
    }
  ]
  if (passwordsAvailable)
    sources.push({
      id: FILE_SOURCE_IDS.passwords,
      browser: 'file',
      browserName: 'Passwords CSV file',
      profileId: 'passwords',
      name: 'Passwords CSV file',
      path: '',
      running: false,
      kinds: ['passwords'],
      limits: {}
    })
  return sources
}

/** The way round for passwords a source keeps where no other app can read them. */
export function passwordLimit(browser: ChromiumBrowser | 'firefox' | 'safari', os: PlatformOs): string {
  const name = BROWSER_NAMES[browser]
  if (browser === 'firefox')
    return `Firefox keeps its passwords in its own encrypted store. Export them from Firefox (Passwords, then Export passwords) and import the CSV file here.`
  if (browser === 'safari')
    return `Safari keeps its passwords in the Keychain. Export them from Safari (File, Export, Passwords) and import the CSV file here.`
  if (os === 'win32')
    return `${name} protects its passwords with your Windows account, so they cannot be read from here. Export them from ${name} (Passwords, then Export passwords) and import the CSV file here.`
  return `${name}'s passwords could not be read.`
}

/** Any of the lock markers present means the browser is (or crashed while) running. */
export async function isRunning(host: ImportHost, lockPaths: string[]): Promise<boolean> {
  for (const path of lockPaths) if ((await host.stat(path)) !== 'missing') return true
  return false
}

async function isFile(host: ImportHost, path: string): Promise<boolean> {
  return (await host.stat(path)) === 'file'
}

async function isDir(host: ImportHost, path: string): Promise<boolean> {
  return (await host.stat(path)) === 'dir'
}

async function readTextOrNull(host: ImportHost, path: string): Promise<string | null> {
  try {
    return await host.readText(path)
  } catch {
    return null
  }
}

async function chromiumSources(
  host: ImportHost,
  browser: ChromiumBrowser,
  env: ImportEnvironment,
  options: DiscoveryOptions
): Promise<ImportSource[]> {
  const sources: ImportSource[] = []
  for (const userData of chromiumUserDataDirs(browser, env)) {
    if (!(await isDir(host, userData))) continue
    const running = await isRunning(host, chromiumLockPaths(userData, options.os))
    const localState = await readTextOrNull(host, joinPath(userData, 'Local State'))
    let profiles = localState ? parseLocalState(localState).profiles : []
    if (profiles.length === 0) {
      const names = (await host.list(userData)).filter(looksLikeChromiumProfileDir).sort()
      profiles = names.map((dir) => ({ dir, name: dir }))
    }
    for (const profile of profiles) {
      const path = joinPath(userData, profile.dir)
      if (!(await isDir(host, path))) continue
      const kinds: ImportKind[] = []
      const limits: ImportSource['limits'] = {}
      if (await isFile(host, joinPath(path, CHROMIUM_FILES.bookmarks))) kinds.push('bookmarks')
      if (options.historyWritable && (await isFile(host, joinPath(path, CHROMIUM_FILES.history))))
        kinds.push('history')
      let hasLogins = false
      for (const file of CHROMIUM_FILES.logins)
        if (await isFile(host, joinPath(path, file))) hasLogins = true
      if (hasLogins && options.passwordsAvailable) {
        if (options.os === 'win32') limits.passwords = passwordLimit(browser, options.os)
        else kinds.push('passwords')
      }
      if (kinds.length === 0 && Object.keys(limits).length === 0) continue
      const source: ImportSource = {
        id: `${browser}:${path}`,
        browser,
        browserName: BROWSER_NAMES[browser],
        profileId: profile.dir,
        name: profile.name,
        path,
        running,
        kinds,
        limits
      }
      if (profile.email) source.email = profile.email
      sources.push(source)
    }
  }
  return sources
}

async function firefoxSources(
  host: ImportHost,
  env: ImportEnvironment,
  options: DiscoveryOptions
): Promise<ImportSource[]> {
  const sources: ImportSource[] = []
  for (const root of firefoxRoots(env)) {
    const ini = await readTextOrNull(host, joinPath(root, 'profiles.ini'))
    if (ini === null) continue
    for (const profile of parseProfilesIni(ini, root)) {
      if (!(await isDir(host, profile.path))) continue
      const places = await isFile(host, joinPath(profile.path, FIREFOX_FILES.places))
      const backups = await isDir(host, joinPath(profile.path, FIREFOX_FILES.backups))
      const kinds: ImportKind[] = []
      if (places || backups) kinds.push('bookmarks')
      if (places && options.historyWritable) kinds.push('history')
      if (kinds.length === 0) continue
      const limits: ImportSource['limits'] = {}
      if (options.passwordsAvailable) limits.passwords = passwordLimit('firefox', options.os)
      sources.push({
        id: `firefox:${profile.path}`,
        browser: 'firefox',
        browserName: BROWSER_NAMES.firefox,
        profileId: profile.path.split(/[\\/]/).pop() ?? profile.name,
        name: profile.name,
        path: profile.path,
        running: await isRunning(host, firefoxLockPaths(profile.path, options.os)),
        kinds,
        limits
      })
    }
  }
  return sources
}

async function safariSources(
  host: ImportHost,
  env: ImportEnvironment,
  options: DiscoveryOptions
): Promise<ImportSource[]> {
  const dir = safariDir(env)
  if (!dir || !(await isDir(host, dir))) return []
  const kinds: ImportKind[] = []
  // Without Full Disk Access macOS hides the directory's contents: the files stat as missing.
  // The bookmarks then stay on offer, and the read explains what to grant.
  const bookmarks = await isFile(host, joinPath(dir, SAFARI_FILES.bookmarks))
  const history = await isFile(host, joinPath(dir, SAFARI_FILES.history))
  const listable = (await host.list(dir)).length > 0
  if (bookmarks || !listable) kinds.push('bookmarks')
  if (options.historyWritable && (history || !listable)) kinds.push('history')
  if (kinds.length === 0) return []
  const limits: ImportSource['limits'] = {}
  if (options.passwordsAvailable) limits.passwords = passwordLimit('safari', options.os)
  return [
    {
      id: `safari:${dir}`,
      browser: 'safari',
      browserName: BROWSER_NAMES.safari,
      profileId: 'Safari',
      name: BROWSER_NAMES.safari,
      path: dir,
      running: false,
      kinds,
      limits
    }
  ]
}

/**
 * Every source on this machine in the dialog's order (Chrome, Chromium, Edge, Firefox, Safari,
 * then the file sources), each with what it can provide right now.
 */
export async function discoverSources(
  host: ImportHost | undefined,
  options: DiscoveryOptions
): Promise<ImportSource[]> {
  const sources: ImportSource[] = []
  if (host) {
    const env: ImportEnvironment = { os: options.os, homeDir: host.homeDir, env: host.env }
    for (const browser of ['chrome', 'chromium', 'edge'] as const)
      sources.push(...(await chromiumSources(host, browser, env, options)))
    sources.push(...(await firefoxSources(host, env, options)))
    sources.push(...(await safariSources(host, env, options)))
  }
  sources.push(...fileSources(options.passwordsAvailable))
  return sources
}
