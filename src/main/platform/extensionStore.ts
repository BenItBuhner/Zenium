import { net } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { base64Encode, utf8Encode } from '../../core/extensions/bytes'
import {
  installFromCrx,
  installFromZip,
  writeExtensionFiles,
  type ExtensionPackage,
  type UpdateCheckResult
} from '../../core/extensions/install'
import {
  installIntoLayout,
  pruneOtherVersions,
  removeInstall,
  sweepStaging,
  type LayoutFs
} from '../../core/extensions/installLayout'
import {
  StoreError,
  crxDownloadUrl,
  downloadCrx,
  isExtensionId,
  parseStorePageUrl,
  type StoreFetch,
  type StoreId
} from '../../core/extensions/store'

/**
 * Electron's side of the store core: the network primitive, the files on disk, and the two ways
 * a package comes in (a store download, a local `.crx`/`.zip`). Nothing here touches sessions or
 * the registry; `ExtensionService` orchestrates those.
 */

const DOWNLOAD_TIMEOUT_MS = 120_000
const STORE_ORDER: readonly StoreId[] = ['chrome-web-store', 'edge-add-ons']

/** `StoreFetch` over Chromium's network stack; follows the store's redirect to its CDN. */
export const electronStoreFetch: StoreFetch = async (url) => {
  const response = await net.fetch(url, {
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  return { status: response.status, url: response.url, bytes }
}

export const nodeLayoutFs: LayoutFs = {
  mkdir: async (path) => {
    await fs.mkdir(path, { recursive: true })
  },
  rename: (from, to) => fs.rename(from, to),
  remove: (path) => fs.rm(path, { recursive: true, force: true }),
  list: async (path) => {
    try {
      return await fs.readdir(path)
    } catch {
      return []
    }
  },
  exists: async (path) => {
    try {
      await fs.access(path)
      return true
    } catch {
      return false
    }
  },
  join: (...parts) => join(...parts)
}

/** Chrome's id for an unpacked folder: the first 128 bits of SHA-256 over the path, in a-p. */
export function idForUnpackedPath(path: string): string {
  // Chromium hashes the path's native string: UTF-16LE on Windows (drive letter upper-cased).
  const bytes =
    process.platform === 'win32'
      ? Buffer.from(
          path.replace(/^[a-z]:/, (drive) => drive.toUpperCase()),
          'utf16le'
        )
      : Buffer.from(path, 'utf8')
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  return digest.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)))
}

// ---------------------------------------------------------------------------
// Where packages come from
// ---------------------------------------------------------------------------

export interface StoreRef {
  id: string
  /** The store the user pointed at (a listing URL names it); null when only an id was given. */
  store: StoreId | null
}

/** An extension id, or a Chrome Web Store / Edge Add-ons listing URL. */
export function parseStoreRef(ref: string): StoreRef | null {
  const trimmed = ref.trim()
  if (isExtensionId(trimmed)) return { id: trimmed, store: null }
  const page = parseStorePageUrl(trimmed)
  return page ? { id: page.id, store: page.store } : null
}

export interface StoreDownload {
  bytes: Uint8Array
  store: StoreId
  /** Stores that answered without a package, for the log. */
  skipped: Array<{ store: StoreId; status: number }>
}

/**
 * Downloads a CRX from the preferred store, falling back to the other one when the first has no
 * package for the id (the Chrome Web Store answers 204 for items it dropped, such as every
 * Manifest V2 extension since 2026-08-31, many of which live on in Edge Add-ons).
 */
export async function downloadFromStores(
  fetch: StoreFetch,
  id: string,
  preferred: StoreId | null,
  chromiumVersion: string
): Promise<StoreDownload> {
  const order = preferred
    ? [preferred, ...STORE_ORDER.filter((s) => s !== preferred)]
    : [...STORE_ORDER]
  const skipped: Array<{ store: StoreId; status: number }> = []
  for (const store of order) {
    const response = await fetch(crxDownloadUrl(store, id, { chromiumVersion }))
    if (response.status === 200 && response.bytes.length > 0)
      return { bytes: response.bytes, store, skipped }
    skipped.push({ store, status: response.status })
  }
  const detail = skipped.map((s) => `${storeLabel(s.store)}: HTTP ${s.status}`).join(', ')
  throw new StoreError('http', `No store has an extension with id ${id} (${detail})`)
}

export function storeLabel(store: StoreId): string {
  return store === 'chrome-web-store' ? 'Chrome Web Store' : 'Edge Add-ons'
}

/** Downloads the package an update check announced, verifying the hash it carried. */
export function downloadUpdate(
  fetch: StoreFetch,
  update: Extract<UpdateCheckResult, { status: 'update-available' }>
): Promise<Uint8Array> {
  return downloadCrx(fetch, update.codebase, { sha256: update.sha256 })
}

export interface PackageOptions {
  locale: string | null
  expectedId?: string
}

/** Verifies and unpacks a `.crx` (signed) or `.zip` (unsigned) file's bytes. */
export async function packageFromFile(
  fileName: string,
  bytes: Uint8Array,
  options: PackageOptions
): Promise<{ pkg: ExtensionPackage; kind: 'crx' | 'zip' }> {
  if (/\.zip$/i.test(fileName)) return { pkg: await packageFromZip(bytes, options), kind: 'zip' }
  if (/\.crx$/i.test(fileName)) return { pkg: await installFromCrx(bytes, options), kind: 'crx' }
  throw new Error('Choose a .crx or .zip file')
}

/**
 * A sideloaded zip has no publisher key, so its id is Zenium's choice. Chrome hashes the install
 * path for unpacked folders; a versioned layout cannot do that (the path contains the id), so the
 * id is derived from the extension's name instead. A later zip of the same extension then lands
 * on the same id and installs as an update rather than a duplicate.
 */
export async function packageFromZip(
  bytes: Uint8Array,
  options: PackageOptions
): Promise<ExtensionPackage> {
  const probe = await installFromZip(bytes, { ...options, idSeed: 'zenium-probe' })
  if (typeof probe.rawManifest.key === 'string') return probe
  return installFromZip(bytes, { ...options, idSeed: zipIdSeed(probe.rawManifest) })
}

/** The bytes whose SHA-256 is the id of an unsigned zip; also written as its `manifest.key`. */
export function zipIdSeed(rawManifest: Record<string, unknown>): Uint8Array {
  const name = typeof rawManifest.name === 'string' ? rawManifest.name : ''
  return utf8Encode(`zenium-sideload:${name}`)
}

// ---------------------------------------------------------------------------
// Files on disk
// ---------------------------------------------------------------------------

/**
 * Writes a package to `<root>/<id>/<version>/` through a staging directory and returns the final
 * directory. Unsigned zips get a synthetic `manifest.key` so Electron derives the same id the
 * package carries (Chromium accepts any base64 bytes there and hashes them).
 */
export async function writePackage(root: string, pkg: ExtensionPackage): Promise<string> {
  const manifestOverride =
    !pkg.signed && pkg.publicKey === null
      ? utf8Encode(
          JSON.stringify(
            { ...pkg.rawManifest, key: base64Encode(zipIdSeed(pkg.rawManifest)) },
            null,
            2
          )
        )
      : null
  return installIntoLayout(nodeLayoutFs, root, pkg.id, pkg.version, async (dir) => {
    const base = resolve(dir)
    const fileIn = (relative: string): string => {
      const target = resolve(base, relative)
      if (target !== base && !target.startsWith(base + sep))
        throw new Error(`Package entry escapes its directory: ${relative}`)
      return target
    }
    for (const directory of pkg.directories) await fs.mkdir(fileIn(directory), { recursive: true })
    await writeExtensionFiles(
      {
        files: pkg.files.map((file) =>
          file.path === 'manifest.json' && manifestOverride
            ? { ...file, size: manifestOverride.length, bytes: async () => manifestOverride }
            : file
        )
      },
      {
        writeFile: async (relative, bytes) => {
          const target = fileIn(relative)
          await fs.mkdir(dirname(target), { recursive: true })
          await fs.writeFile(target, bytes)
        }
      }
    )
  })
}

export function pruneOldVersions(root: string, id: string, keep: string): Promise<string[]> {
  return pruneOtherVersions(nodeLayoutFs, root, id, keep)
}

export function removeInstalledFiles(root: string, id: string): Promise<void> {
  return removeInstall(nodeLayoutFs, root, id)
}

export function sweepStagingDirs(root: string): Promise<string[]> {
  return sweepStaging(nodeLayoutFs, root)
}
