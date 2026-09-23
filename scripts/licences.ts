import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { Plugin } from 'vite'
import type { LicenceEntry } from '../src/shared/licences'

/**
 * The open-source licences list, generated at build time (Settings › About › Open-source
 * licences, `zen://licences`; Chrome's chrome://credits). A Vite plugin both hosts' configs run:
 * it walks the package tree the build installs – `package.json`'s `dependencies`, what each of
 * them depends on (Node's resolution, nested copies included), and the React the bundles carry
 * out of `devDependencies` – reads every package's name, version, declared licence and licence
 * file, and serves the list as the `virtual:zenium-licences` module the renderer's page imports
 * lazily (its own chunk: the texts run to a few hundred kilobytes nothing else needs). The
 * desktop build adds Electron itself from `node_modules/electron`; Chromium's own credits are
 * the twenty-megabyte `LICENSES.chromium.html` beside the packaged executable, which the main
 * process serves as a document instead (`src/main/platform/licences.ts`).
 *
 * The tree is the packaged app's: electron-builder ships every `dependencies` package as a node
 * module whether or not the main bundle inlined it, so the desktop list is what the app carries.
 * The Android chrome bundles the renderer's and the core's part of the same tree, so its list
 * carries the main-process-only packages too (electron-updater, mpris-service) – a superset,
 * named as such for the Android program. Nothing is read from the network, and nothing is
 * generated into the source tree.
 */

/** The module id the renderer imports the list from (`pages/licences/LicencesPage.tsx`). */
export const LICENCES_MODULE_ID = 'virtual:zenium-licences'
const RESOLVED_ID = `\0${LICENCES_MODULE_ID}`

/**
 * Dev dependencies the bundles carry all the same: React and its DOM renderer come from
 * `devDependencies` because electron-vite inlines them into the chrome and electron-builder
 * never packages them as node modules.
 */
export const BUNDLED_DEV_DEPENDENCIES: readonly string[] = ['react', 'react-dom']

/** The one licence file a package directory is read for, by preference: the plainest name first. */
const LICENCE_FILE_RE = /^(licen[cs]e|copying|unlicen[cs]e)(?:[-_.].*)?$/i

interface PackageManifest {
  name?: string
  version?: string
  license?: string | { type?: string }
  licenses?: ReadonlyArray<string | { type?: string }>
  homepage?: string
  repository?: string | { url?: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export interface CollectOptions {
  /** The project root: where `package.json` and `node_modules` are. */
  root: string
  /** Add Electron (the desktop build carries it; the Android chrome does not). */
  electron?: boolean
}

function readManifest(dir: string): PackageManifest | null {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageManifest
  } catch {
    return null
  }
}

/**
 * Node's resolution for a package required from `fromDir`: the nearest `node_modules/<name>`
 * walking up from there, stopping at the project root (a nested copy beats the hoisted one, as
 * it does at runtime). `null` when the package is not installed (an optional dependency the
 * platform skipped).
 */
export function resolvePackageDir(name: string, fromDir: string, root: string): string | null {
  let dir = resolve(fromDir)
  const stop = resolve(root)
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === stop) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The declared licence as one SPDX-ish string: `license`, or the legacy `licenses` list joined. */
export function licenceIdOf(manifest: PackageManifest): string {
  const one = manifest.license
  if (typeof one === 'string') return one.trim()
  if (one && typeof one === 'object' && typeof one.type === 'string') return one.type.trim()
  const many = manifest.licenses
  if (Array.isArray(many)) {
    const types = many
      .map((l) => (typeof l === 'string' ? l : l?.type))
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim())
    if (types.length > 0) return types.length === 1 ? types[0] : `(${types.join(' OR ')})`
  }
  return ''
}

/** The package's homepage, else its repository as a browsable URL; undefined when it names neither. */
export function packageUrlOf(manifest: PackageManifest): string | undefined {
  if (typeof manifest.homepage === 'string' && /^https?:\/\//.test(manifest.homepage))
    return manifest.homepage.trim()
  const repo = manifest.repository
  const raw = typeof repo === 'string' ? repo : repo?.url
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let url = raw.trim()
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url)
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}`
  url = url.replace(/^git\+/, '').replace(/\.git(?:#.*)?$/, '')
  const ssh = /^git@([^:]+):(.+)$/.exec(url)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  if (/^git:\/\//.test(url)) return url.replace(/^git:/, 'https:')
  if (/^https?:\/\//.test(url)) return url
  return undefined
}

/** The licence file's name in a package directory, when it ships one. */
export function licenceFileOf(dir: string): string | null {
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && LICENCE_FILE_RE.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    return null
  }
  if (names.length === 0) return null
  // LICENSE before LICENSE.md before LICENSE-MIT before COPYING: the shortest name, then a
  // licence file before a copying file, so a package with both reads its licence.
  names.sort(
    (a, b) =>
      Number(/^copying/i.test(a)) - Number(/^copying/i.test(b)) ||
      a.length - b.length ||
      a.localeCompare(b)
  )
  return names[0]
}

function licenceTextOf(dir: string): string | undefined {
  const file = licenceFileOf(dir)
  if (!file) return undefined
  try {
    const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n?/g, '\n').trimEnd()
    return text.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Every package the build carries, one entry per name and version, in the page's order. The
 * walk starts at the root's `dependencies` and the bundled dev dependencies and follows each
 * package's `dependencies` and installed `optionalDependencies`; `devDependencies` of a
 * dependency are never part of what ships.
 */
export function collectLicences(options: CollectOptions): LicenceEntry[] {
  const root = resolve(options.root)
  const rootManifest = readManifest(root) ?? {}
  const seen = new Set<string>()
  const entries = new Map<string, LicenceEntry>()
  const queue: Array<{ name: string; from: string }> = []
  for (const name of Object.keys(rootManifest.dependencies ?? {})) queue.push({ name, from: root })
  for (const name of BUNDLED_DEV_DEPENDENCIES)
    if (rootManifest.devDependencies?.[name] !== undefined) queue.push({ name, from: root })
  while (queue.length > 0) {
    const { name, from } = queue.shift()!
    const dir = resolvePackageDir(name, from, root)
    if (!dir) continue
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      real = dir
    }
    if (seen.has(real)) continue
    seen.add(real)
    const manifest = readManifest(real)
    if (!manifest) continue
    const version = manifest.version ?? ''
    const key = `${name}@${version}`
    if (!entries.has(key)) {
      const entry: LicenceEntry = { name, version, licence: licenceIdOf(manifest) }
      const url = packageUrlOf(manifest)
      if (url) entry.url = url
      const text = licenceTextOf(real)
      if (text) entry.text = text
      entries.set(key, entry)
    }
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dep, from: dir })
    for (const dep of Object.keys(manifest.optionalDependencies ?? {}))
      queue.push({ name: dep, from: dir })
  }
  if (options.electron) {
    const dir = resolvePackageDir('electron', root, root)
    const manifest = dir ? readManifest(dir) : null
    if (dir && manifest) {
      const entry: LicenceEntry = {
        name: 'electron',
        version: manifest.version ?? '',
        licence: licenceIdOf(manifest) || 'MIT',
        url: 'https://www.electronjs.org'
      }
      // The framework's own licence rides in its binary distribution, not beside package.json.
      const text = licenceTextOf(join(dir, 'dist')) ?? licenceTextOf(dir)
      if (text) entry.text = text
      entries.set(`electron@${entry.version}`, entry)
    }
  }
  return [...entries.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
      a.version.localeCompare(b.version, 'en', { numeric: true })
  )
}

/**
 * The module's source: the entries and their texts as two JSON string literals parsed on import
 * (a string literal parses faster than an object literal of the same size and survives
 * minification untouched), the texts deduplicated – the eleven MPL-2.0 packages carry one
 * text between them – and joined back on import, so the default export is `LicenceEntry[]`.
 */
export function licencesModuleSource(entries: readonly LicenceEntry[]): string {
  const texts: string[] = []
  const index = new Map<string, number>()
  const slim = entries.map(({ text, ...rest }) => {
    if (text === undefined) return rest
    let at = index.get(text)
    if (at === undefined) {
      at = texts.length
      texts.push(text)
      index.set(text, at)
    }
    return { ...rest, t: at }
  })
  return [
    `const texts = JSON.parse(${JSON.stringify(JSON.stringify(texts))})`,
    `const entries = JSON.parse(${JSON.stringify(JSON.stringify(slim))})`,
    'export default entries.map(({ t, ...entry }) => (t === undefined ? entry : { ...entry, text: texts[t] }))',
    ''
  ].join('\n')
}

/**
 * The Vite plugin: `virtual:zenium-licences` is the list, collected once per build on first
 * request, so a dev server that never opens the page never reads a licence file.
 */
export function licencesPlugin(options: { electron: boolean; root?: string }): Plugin {
  let cache: string | null = null
  return {
    name: 'zenium:licences',
    resolveId(id) {
      return id === LICENCES_MODULE_ID ? RESOLVED_ID : null
    },
    load(id) {
      if (id !== RESOLVED_ID) return null
      cache ??= licencesModuleSource(
        collectLicences({ root: options.root ?? process.cwd(), electron: options.electron })
      )
      return cache
    }
  }
}
