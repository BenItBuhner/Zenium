import { net } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import {
  writeExtensionFiles,
  type ExtensionFile,
  type ExtensionPackage
} from '../../core/extensions/install'
import {
  installIntoLayout,
  pruneOtherVersions,
  removeInstall,
  sweepStaging,
  type LayoutFs
} from '../../core/extensions/installLayout'
import { zipManifestOverride } from '../../core/extensions/hostStore'
import {
  contentScriptPreludeFile,
  transformManifestBytes,
  withContentScriptPrelude
} from '../../core/extensions/contentScriptPrelude'
import type { StoreFetch } from '../../core/extensions/store'

/**
 * Electron's side of the store core: the network primitive, the files on disk, and the two ways
 * a package comes in (a store download, a local `.crx`/`.zip`). Nothing here touches sessions or
 * the registry; `ExtensionService` orchestrates those. The host-independent pieces (store refs,
 * the store fallback, package parsing) live in `core/extensions/hostStore.ts`, shared with
 * Android, and are re-exported here for the service.
 */

export {
  downloadFromStores,
  downloadUpdate,
  packageFromFile,
  packageFromZip,
  parseStoreRef,
  storeLabel,
  zipIdSeed,
  type PackageOptions,
  type StoreDownload,
  type StoreRef
} from '../../core/extensions/hostStore'

const DOWNLOAD_TIMEOUT_MS = 120_000

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
  const digest = createHash('sha256').update(unpackedIdBytes(path)).digest('hex').slice(0, 32)
  return digest.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)))
}

// ---------------------------------------------------------------------------
// Files on disk
// ---------------------------------------------------------------------------

/**
 * Writes a package to `<root>/<id>/<version>/` through a staging directory and returns the final
 * directory. Unsigned zips get a synthetic `manifest.key` so Electron derives the same id the
 * package carries (Chromium accepts any base64 bytes there and hashes them). Every install
 * directory also carries the content-script storage prelude, first in each `content_scripts[].js`
 * list of the manifest the engine loads (`core/extensions/contentScriptPrelude.ts`).
 */
export async function writePackage(root: string, pkg: ExtensionPackage): Promise<string> {
  const manifestOverride = zipManifestOverride(pkg)
  const prelude = contentScriptPreludeFile()
  return installIntoLayout(nodeLayoutFs, root, pkg.id, pkg.version, async (dir) => {
    const base = resolve(dir)
    const fileIn = (relative: string): string => {
      const target = resolve(base, relative)
      if (target !== base && !target.startsWith(base + sep))
        throw new Error(`Package entry escapes its directory: ${relative}`)
      return target
    }
    for (const directory of pkg.directories) await fs.mkdir(fileIn(directory), { recursive: true })
    const files: ExtensionFile[] = pkg.files
      .filter((file) => file.path !== prelude.path)
      .map((file) => {
        if (file.path !== 'manifest.json') return file
        const source = manifestOverride ? async () => manifestOverride : file.bytes
        const bytes = async (): Promise<Uint8Array> =>
          transformManifestBytes(await source(), (m) => withContentScriptPrelude(m).manifest)
        return { ...file, bytes }
      })
    files.push({ path: prelude.path, size: prelude.bytes.length, bytes: async () => prelude.bytes })
    await writeExtensionFiles(
      { files },
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

/**
 * An install directory written before the prelude existed (or by an older prelude) gets the
 * current one at load: the file is (re)written when its header differs, and the manifest gets
 * the prelude first in its content-script lists when it lacks it. Idempotent; a directory whose
 * manifest cannot be read is left to the engine's loader. Returns whether the prelude is there.
 */
export async function ensureContentScriptPrelude(dir: string): Promise<boolean> {
  const prelude = contentScriptPreludeFile()
  const preludePath = join(dir, prelude.path)
  try {
    const current = await fs.readFile(preludePath).catch(() => null)
    if (!current || !sameBytes(current, prelude.bytes))
      await fs.writeFile(preludePath, prelude.bytes)
    const manifestPath = join(dir, 'manifest.json')
    const bytes = await fs.readFile(manifestPath)
    let changed = false
    const next = transformManifestBytes(bytes, (manifest) => {
      const rewrite = withContentScriptPrelude(manifest)
      changed = rewrite.changed
      return rewrite.manifest
    })
    if (changed) await fs.writeFile(manifestPath, next)
    return true
  } catch (error) {
    console.warn(
      `[zen] extensions: could not add the storage prelude to ${dir}:`,
      (error as Error).message
    )
    return false
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// Unpacked folders: a shadow the engine loads in the folder's place
// ---------------------------------------------------------------------------

export const SHADOW_DIR = '.shadow'

/**
 * The developer's folder is never written to. What the engine loads instead is a shadow under
 * `<root>/.shadow/<id>/`: every top-level entry of the folder linked in (copied when the
 * platform refuses symlinks), the prelude beside them, and a manifest with the prelude first in
 * its content-script lists and a synthetic `key` that hashes to the id Chrome gives the folder
 * (`idForUnpackedPath`), so the id survives the move. Rebuilt on every load, so a reload picks
 * up the folder's manifest changes as it did before; links keep the other files live.
 */
export async function shadowUnpacked(root: string, id: string, path: string): Promise<string> {
  const dir = join(root, SHADOW_DIR, id)
  const staging = `${dir}.${process.pid.toString(36)}-${Date.now().toString(36)}`
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  const prelude = contentScriptPreludeFile()
  for (const entry of await fs.readdir(path, { withFileTypes: true })) {
    if (entry.name === 'manifest.json' || entry.name === prelude.path) continue
    const from = join(path, entry.name)
    const to = join(staging, entry.name)
    try {
      await fs.symlink(from, to, entry.isDirectory() ? 'junction' : 'file')
    } catch {
      await fs.cp(from, to, { recursive: true, dereference: true })
    }
  }
  const raw = await fs.readFile(join(path, 'manifest.json'))
  const manifest = transformManifestBytes(raw, (parsed) => ({
    ...withContentScriptPrelude(parsed).manifest,
    key: unpackedKeyFor(path)
  }))
  await fs.writeFile(join(staging, 'manifest.json'), manifest)
  await fs.writeFile(join(staging, prelude.path), prelude.bytes)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.rename(staging, dir)
  return dir
}

/** Removes an unpacked folder's shadow (the folder was unloaded for good). */
export async function removeShadow(root: string, id: string): Promise<void> {
  await fs.rm(join(root, SHADOW_DIR, id), { recursive: true, force: true })
}

/**
 * A `manifest.key` whose Chrome id is the folder's: Chromium hashes the decoded bytes of `key`
 * exactly as it hashes an unpacked folder's path (`idForUnpackedPath`), so encoding the very
 * bytes it would hash gives the same id.
 */
export function unpackedKeyFor(path: string): string {
  return unpackedIdBytes(path).toString('base64')
}

function unpackedIdBytes(path: string): Buffer {
  // Chromium hashes the path's native string: UTF-16LE on Windows (drive letter upper-cased).
  return process.platform === 'win32'
    ? Buffer.from(
        path.replace(/^[a-z]:/, (drive) => drive.toUpperCase()),
        'utf16le'
      )
    : Buffer.from(path, 'utf8')
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
