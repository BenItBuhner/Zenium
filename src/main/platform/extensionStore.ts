import { net } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { writeExtensionFiles, type ExtensionPackage } from '../../core/extensions/install'
import {
  installIntoLayout,
  pruneOtherVersions,
  removeInstall,
  sweepStaging,
  type LayoutFs
} from '../../core/extensions/installLayout'
import { zipManifestOverride } from '../../core/extensions/hostStore'
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
// Files on disk
// ---------------------------------------------------------------------------

/**
 * Writes a package to `<root>/<id>/<version>/` through a staging directory and returns the final
 * directory. Unsigned zips get a synthetic `manifest.key` so Electron derives the same id the
 * package carries (Chromium accepts any base64 bytes there and hashes them).
 */
export async function writePackage(root: string, pkg: ExtensionPackage): Promise<string> {
  const manifestOverride = zipManifestOverride(pkg)
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
