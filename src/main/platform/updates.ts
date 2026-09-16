import { app, net, shell } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import {
  releaseDownloadBase,
  UPDATE_REPOSITORY,
  updateOsOf,
  type UpdateArch,
  type UpdateAsset,
  type UpdateInstallKind,
  type UpdateProgress,
  type UpdateRelease,
  type UpdateTarget
} from '../../shared/updates'
import type { UpdateHost } from '../../core/platform'
import { downloadDir, uniquePath } from './downloads'

/**
 * Automatic updates on the desktop.
 *
 * Electron ships no Omaha / Keystone; its update machinery is Squirrel (`electron.autoUpdater`),
 * which `electron-updater` wraps together with NSIS, AppImage and deb installers and feeds from
 * the `latest*.yml` files electron-builder publishes with every release. The core has already
 * validated the release manifest and chosen the release, so electron-updater is pointed at that
 * exact release's download folder (a "generic" feed) rather than left to discover "latest" on its
 * own. It verifies the SHA-512 from the feed, downloads deltas where a `.blockmap` exists, and
 * knows how to swap each package format in place.
 *
 * What cannot be swapped in place – an unsigned macOS app (Squirrel.Mac refuses unsigned or
 * mismatching signatures, and there is no free Developer ID), a portable or unpacked build – is
 * served by a checksummed download of the user-facing package that is then opened.
 */
export class ElectronUpdateHost implements UpdateHost {
  private readonly resolvedTarget: UpdateTarget
  private abort: AbortController | null = null
  private inPlaceActive = false
  private configured = false

  constructor() {
    this.resolvedTarget = detectTarget()
  }

  target(): UpdateTarget {
    return this.resolvedTarget
  }

  publicKeys(): string[] {
    return (import.meta.env.VITE_ZEN_UPDATE_PUBLIC_KEY ?? '')
      .split(/[\s,]+/)
      .map((k) => k.trim())
      .filter(Boolean)
  }

  signer(): null {
    return null
  }

  async download(
    release: UpdateRelease,
    asset: UpdateAsset,
    onProgress: (progress: UpdateProgress) => void
  ): Promise<string | null> {
    switch (this.resolvedTarget.kind) {
      case 'nsis':
      case 'appimage':
      case 'deb':
      case 'mac-signed':
        await this.downloadInPlace(release, asset, onProgress)
        return null
      case 'mac-unsigned':
        return this.downloadFile(asset, onProgress)
      default:
        throw new Error('this build cannot download updates')
    }
  }

  async install(_release: UpdateRelease, downloadedPath: string | null): Promise<void> {
    if (downloadedPath) {
      // macOS: mount the disk image; Finder shows the drag-to-Applications window.
      const error = await shell.openPath(downloadedPath)
      if (error) throw new Error(error)
      return
    }
    // Spawns the installer (NSIS: silent, relaunch), replaces the AppImage, runs dpkg through
    // pkexec, or lets Squirrel.Mac swap the bundle – then quits. Failures (a dismissed password
    // prompt, a read-only AppImage) only surface as an "error" event, so listen briefly.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, 3000)
      const cleanup = (): void => {
        clearTimeout(timer)
        autoUpdater.removeListener('error', onError)
      }
      autoUpdater.once('error', onError)
      autoUpdater.quitAndInstall(true, true)
    })
  }

  cancel(): void {
    this.abort?.abort()
  }

  // ---------------------------------------------------------------------------

  private async downloadInPlace(
    release: UpdateRelease,
    asset: UpdateAsset,
    onProgress: (progress: UpdateProgress) => void
  ): Promise<void> {
    if (this.inPlaceActive) throw new Error('a download is already running')
    this.inPlaceActive = true
    const channel =
      process.platform === 'win32' && this.resolvedTarget.arch === 'arm64'
        ? 'latest-arm64'
        : 'latest'
    const onDownloadProgress = (info: ProgressInfo): void =>
      onProgress({
        percent: info.percent,
        transferred: info.transferred,
        total: info.total || asset.size,
        bytesPerSecond: info.bytesPerSecond
      })
    try {
      if (!this.configured) {
        // Every failure is also rejected to the caller; without a listener the emitter would throw.
        autoUpdater.on('error', (error: Error) => console.warn('[zen] updater:', error.message))
        autoUpdater.autoDownload = false
        autoUpdater.autoRunAppAfterInstall = true
        // Installing a deb at quit time would surface a password prompt out of nowhere.
        autoUpdater.autoInstallOnAppQuit = this.resolvedTarget.kind !== 'deb'
        autoUpdater.allowPrerelease = true
        autoUpdater.allowDowngrade = false
        this.configured = true
      }
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: releaseDownloadBase(UPDATE_REPOSITORY, release.tag),
        channel,
        useMultipleRangeRequest: false
      })
      const result = await autoUpdater.checkForUpdates()
      const found = result?.updateInfo.version
      if (!found)
        throw new Error('this build cannot update itself (updater inactive); use the release page')
      if (found !== release.version)
        throw new Error(`release ${release.tag} publishes update info for ${found}`)
      if (!result.isUpdateAvailable)
        throw new Error(`the updater considers ${found} not newer than ${app.getVersion()}`)
      autoUpdater.on('download-progress', onDownloadProgress)
      const token = result.cancellationToken
      this.abort = new AbortController()
      this.abort.signal.addEventListener('abort', () => token?.cancel(), { once: true })
      try {
        await autoUpdater.downloadUpdate(token ?? undefined)
      } catch (error) {
        if (this.abort.signal.aborted) throw abortError()
        throw error
      }
    } finally {
      autoUpdater.removeListener('download-progress', onDownloadProgress)
      this.abort = null
      this.inPlaceActive = false
    }
  }

  /** Fetch a user-facing package into Downloads and verify it against the manifest checksum. */
  private async downloadFile(
    asset: UpdateAsset,
    onProgress: (progress: UpdateProgress) => void
  ): Promise<string> {
    const destination = uniquePath(downloadDir(), asset.name, existsSync)
    this.abort = new AbortController()
    const { signal } = this.abort
    try {
      const response = await net.fetch(asset.url, {
        signal,
        cache: 'no-store',
        headers: { Accept: 'application/octet-stream' }
      })
      if (!response.ok || !response.body)
        throw new Error(`download failed (HTTP ${response.status})`)
      const total = Number(response.headers.get('content-length')) || asset.size
      const hash = createHash('sha256')
      const file = createWriteStream(destination)
      const startedAt = Date.now()
      let transferred = 0
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          hash.update(value)
          transferred += value.byteLength
          if (!file.write(value)) await once(file, 'drain')
          const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000)
          onProgress({
            percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
            transferred,
            total,
            bytesPerSecond: transferred / seconds
          })
        }
        await new Promise<void>((resolve, reject) => {
          file.once('error', reject)
          file.end(() => resolve())
        })
      } catch (error) {
        file.destroy()
        throw error
      }
      if (transferred !== asset.size)
        throw new Error(`the download is ${transferred} bytes, the release lists ${asset.size}`)
      const digest = hash.digest('hex')
      if (digest !== asset.sha256)
        throw new Error('the downloaded file is corrupt (checksum mismatch)')
      return destination
    } catch (error) {
      rmSync(destination, { force: true })
      if (signal.aborted) throw abortError()
      throw error
    } finally {
      this.abort = null
    }
  }
}

function abortError(): Error {
  const error = new Error('cancelled')
  error.name = 'AbortError'
  return error
}

/** How this process was installed, from what electron-builder left next to it. */
export function detectTarget(): UpdateTarget {
  const os = updateOsOf(process.platform as 'linux' | 'win32' | 'darwin')
  const arch: UpdateArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return { os, arch, kind: detectInstallKind() }
}

function detectInstallKind(): UpdateInstallKind {
  if (!app.isPackaged) return 'dev'
  const resources = process.resourcesPath
  const hasUpdateConfig = existsSync(join(resources, 'app-update.yml'))
  switch (process.platform) {
    case 'win32': {
      if (process.env.PORTABLE_EXECUTABLE_DIR) return 'portable'
      let installed = false
      try {
        installed = readdirSync(dirname(process.execPath)).some((name) =>
          /^Uninstall .*\.exe$/i.test(name)
        )
      } catch {
        installed = false
      }
      return hasUpdateConfig && installed ? 'nsis' : 'unpacked'
    }
    case 'darwin': {
      const signed = import.meta.env.VITE_ZEN_MAC_SIGNED === 'true'
      // Gatekeeper runs apps opened straight from a disk image from a read-only random path.
      const translocated = process.execPath.includes('/AppTranslocation/')
      return signed && hasUpdateConfig && !translocated ? 'mac-signed' : 'mac-unsigned'
    }
    default: {
      const appImage = process.env.APPIMAGE
      if (appImage) {
        try {
          accessSync(appImage, constants.W_OK)
          return 'appimage'
        } catch {
          return 'unpacked'
        }
      }
      let packageType = ''
      try {
        packageType = readFileSync(join(resources, 'package-type'), 'utf8').trim()
      } catch {
        packageType = ''
      }
      return packageType === 'deb' && hasUpdateConfig ? 'deb' : 'unpacked'
    }
  }
}
