import type { ExtensionPackage } from '@core/extensions/install'
import type { StoreFetch, StoreResponse } from '@core/extensions/store'
import type { Bridge } from './bridge'

/**
 * The bridge half of the Android extension store: what `ext/ExtensionStore.kt` does for the
 * TypeScript host (`extensionHost.ts`).
 *
 * Package bytes never travel through the JS bridge. Kotlin downloads (or copies a picked file)
 * to a temporary file under `cache/ext-packages/<token>` and answers with the token; the chrome
 * document reads the file through the WebView's asset loader
 * (`https://appassets.androidplatform.net/ext-packages/<token>`), which streams it into an
 * ArrayBuffer without a base64 detour or a multi-megabyte `evaluateJavascript` string. The core
 * verifies the CRX3 signature and parses the archive in memory; Kotlin then unpacks the same
 * file with a streaming zip reader straight into the staging directory (`extStore.unpack`), so
 * the decompressed files never cross the bridge either. Peak memory is therefore one copy of the
 * package in the chrome renderer plus one inflated entry at a time, on both sides.
 */

export const APP_ORIGIN = 'https://appassets.androidplatform.net'
/** Path prefix the chrome WebView's asset loader serves the temporary package files under. */
export const PACKAGES_PATH = '/ext-packages/'
/** Path prefix the asset loader serves installed extension files under (icons for the list). */
export const FILES_PATH = '/ext-files/'
/** Larger downloads are refused before they fill the cache (Adblock Plus, the largest, is 75 MB). */
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024

/** A package file Kotlin holds for the host: a download, a picked file or a sideload intent. */
export interface PackageHandle {
  token: string
  /** File name as the picker or the sending app reported it (decides `.crx` versus `.zip`). */
  name: string
  size: number
}

interface FetchReply {
  status: number
  url: string
  size: number
  /** Null when the response had no body worth keeping (204, errors). */
  token: string | null
}

export interface UnpackRequest {
  token: string
  /** Where the zip starts inside the file: the CRX3 header length, or 0 for a plain zip. */
  zipOffset: number
  id: string
  version: string
  /** Top-level folder wrapping the extension inside the archive (`''` when none). */
  rootPrefix: string
  /** Every file to write, relative to the extension root, as the core validated them. */
  files: string[]
  directories: string[]
  /** Replaces the archive's `manifest.json` when set (the key rewrite for unsigned zips). */
  manifest: string | null
  /** Sum of the files' uncompressed sizes; Kotlin stops an archive that inflates past it. */
  totalSize: number
}

export interface StoreIoOptions {
  /** Reads a package file by token; the default fetches it through the asset loader. */
  readPackage?: (token: string) => Promise<Uint8Array>
  /** Reads an installed file (path relative to the root); the default fetches it through the asset loader. */
  readFile?: (relativeToRoot: string) => Promise<Uint8Array | null>
  maxPackageBytes?: number
}

export class AndroidExtensionStoreIo {
  private readonly readPackage: (token: string) => Promise<Uint8Array>
  private readonly readFile: (relativeToRoot: string) => Promise<Uint8Array | null>
  private readonly maxPackageBytes: number
  /** Which temporary file the bytes of a package download came from (for `unpack` / `release`). */
  private readonly tokens = new WeakMap<Uint8Array, string>()

  /**
   * @param root `files/zen/extensions`, absolute (Kotlin names it in the boot payload): where
   *   installs live, and what every managed registry path starts with.
   */
  constructor(
    private readonly bridge: Bridge,
    readonly root: string,
    options: StoreIoOptions = {}
  ) {
    this.readPackage =
      options.readPackage ?? ((token) => fetchBytes(`${APP_ORIGIN}${PACKAGES_PATH}${token}`))
    this.readFile =
      options.readFile ??
      (async (relative) => {
        try {
          return await fetchBytes(`${APP_ORIGIN}${FILES_PATH}${relative}`)
        } catch {
          return null
        }
      })
    this.maxPackageBytes = options.maxPackageBytes ?? MAX_PACKAGE_BYTES
  }

  /** `StoreFetch` for update checks: the bytes come back and the temporary file goes at once. */
  readonly fetchText: StoreFetch = async (url) => {
    const { response, token } = await this.fetch(url)
    if (token) this.discard(token)
    return response
  }

  /**
   * `StoreFetch` for package downloads: the bytes come back and the file stays for `unpack`
   * until `release(bytes)`; `tokenOf(bytes)` finds it again.
   */
  readonly fetchPackage: StoreFetch = async (url) => {
    const { response, token } = await this.fetch(url)
    if (token) this.tokens.set(response.bytes, token)
    return response
  }

  private async fetch(url: string): Promise<{ response: StoreResponse; token: string | null }> {
    const reply = await this.bridge.call<FetchReply>('extStore.fetch', {
      url,
      maxBytes: this.maxPackageBytes
    })
    if (!reply.token)
      return {
        response: { status: reply.status, url: reply.url, bytes: new Uint8Array(0) },
        token: null
      }
    try {
      const bytes = await this.readPackage(reply.token)
      return { response: { status: reply.status, url: reply.url, bytes }, token: reply.token }
    } catch (error) {
      this.discard(reply.token)
      throw error
    }
  }

  /** The bytes of a picked or sideloaded package; `tokenOf(bytes)` then finds its file. */
  async readHandle(handle: PackageHandle): Promise<Uint8Array> {
    const bytes = await this.readPackage(handle.token)
    this.tokens.set(bytes, handle.token)
    return bytes
  }

  tokenOf(bytes: Uint8Array): string | undefined {
    return this.tokens.get(bytes)
  }

  /**
   * Unpacks the package file `bytes` came from into `<root>/<id>/<version>/` (staging, then an
   * atomic rename) and resolves with the final directory. The file stays until `release`.
   */
  async unpack(
    bytes: Uint8Array,
    pkg: ExtensionPackage,
    zipOffset: number,
    manifest: Uint8Array | null
  ): Promise<string> {
    const token = this.tokens.get(bytes)
    if (!token) throw new Error('The package file is no longer available')
    const request: UnpackRequest = {
      token,
      zipOffset,
      id: pkg.id,
      version: pkg.version,
      rootPrefix: pkg.rootPrefix,
      files: pkg.files.map((f) => f.path),
      directories: pkg.directories,
      manifest: manifest ? new TextDecoder().decode(manifest) : null,
      totalSize: pkg.totalSize + (manifest?.length ?? 0)
    }
    const reply = await this.bridge.call<{ dir: string }>('extStore.unpack', request)
    return reply.dir
  }

  /** Deletes the temporary file behind `bytes` (no-op when it is gone or was never kept). */
  release(bytes: Uint8Array): void {
    const token = this.tokens.get(bytes)
    if (!token) return
    this.tokens.delete(bytes)
    this.discard(token)
  }

  discard(token: string): void {
    this.bridge.send('extStore.discard', { token })
  }

  /** Removes every version directory of `id` and the storage the runtime kept for it. */
  remove(id: string): Promise<void> {
    return this.bridge.call('extStore.remove', { id })
  }

  /** Removes every version directory of `id` except `keep`; resolves with what went. */
  prune(id: string, keep: string): Promise<string[]> {
    return this.bridge.call<string[]>('extStore.prune', { id, keep })
  }

  /** Staging folders and package files an interrupted install left behind. */
  sweep(): Promise<{ staging: string[]; packages: number }> {
    return this.bridge.call<{ staging: string[]; packages: number }>('extStore.sweep')
  }

  /** The system document picker for a `.crx` or `.zip`; null when dismissed. */
  pick(): Promise<PackageHandle | null> {
    return this.bridge.call<PackageHandle | null>('extStore.pick')
  }

  /**
   * Packages other apps opened with or shared to Zenium (`VIEW` / `SEND` intents) that Kotlin
   * holds for the host: the `extension.sideload` host event announces them, and a cold start
   * collects what arrived before the chrome was up. Taking them empties the queue.
   */
  takeSideloads(): Promise<PackageHandle[]> {
    return this.bridge.call<PackageHandle[]>('extStore.takeSideloads')
  }

  /** An installed file by its directory (a registry path) and relative name; null when unreadable. */
  readInstalledFile(dir: string, relative: string): Promise<Uint8Array | null> {
    const prefix = `${this.root}/`
    if (!dir.startsWith(prefix)) return Promise.resolve(null)
    const inRoot = dir.slice(prefix.length)
    return this.readFile(`${inRoot}/${relative}`.replace(/\/+/g, '/'))
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Could not read ${url}: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}
