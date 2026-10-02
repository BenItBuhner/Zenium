import { app, net, shell } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { promisify } from 'node:util'
import {
  downloadPrefixFor,
  parseUpdateBaseUrl,
  UPDATE_REPOSITORY,
  updateOsOf,
  type UpdateArch,
  type UpdateAsset,
  type UpdateProgress,
  type UpdateRelease,
  type UpdateSourceOverride,
  type UpdateTarget
} from '../../shared/updates'
import type { UpdateHost, UpdateRestart } from '../../core/platform'
import { downloadDir, uniquePath } from './downloads'
import {
  appImageSwapPlan,
  detectInstallKind,
  macAppBundleOf,
  macSwapScript,
  relaunchArgs,
  type InstallProbeFs
} from './updateInstall'

const execFileAsync = promisify(execFile)

/**
 * Automatic updates on the desktop.
 *
 * Electron ships no Omaha / Keystone; its update machinery is Squirrel (`electron.autoUpdater`),
 * which `electron-updater` wraps together with NSIS, AppImage and deb installers and feeds from
 * the `latest*.yml` files electron-builder publishes with every release. The core has already
 * validated the release manifest and chosen the release, so electron-updater is pointed at that
 * exact release's download folder (a "generic" feed) rather than left to discover "latest" on its
 * own. It verifies the SHA-512 from the feed and downloads deltas where a `.blockmap` exists.
 *
 * Installing is this host's own, per package, because electron-updater's `quitAndInstall` ends
 * in `app.quit()` – which the browser answers with its quit questions (`before-quit`), leaving
 * the old app standing with a question in its window while the new one is already running
 * beside it (the AppImage) or killing it mid-write (NSIS). The core asks the questions first
 * (`UpdateService.install`); the host then does what can fail while the app still runs, calls
 * `restart.quit()` (the browser's shutdown and final write) and ends the process with the new
 * version on its way:
 *   - NSIS: the installer is spawned silent with `--force-run`; it waits for this process.
 *   - AppImage: the download is renamed over the running file (the mount keeps the old inode)
 *     and the app relaunches from the new path.
 *   - deb: electron-updater runs `dpkg -i` (through pkexec, or directly as root), then the app
 *     relaunches from the replaced /opt binary.
 *   - macOS, ad-hoc signed (every published build – there is no Developer ID, so Squirrel.Mac
 *     refuses): the release's zip is downloaded, checked against the manifest, extracted and
 *     verified (`codesign`, the bundle's version), and a detached /bin/sh helper swaps the
 *     bundle once this process has exited and opens the new one (`macSwapScript`). Nothing
 *     here writes a quarantine attribute, so Gatekeeper has nothing new to ask.
 * What cannot be swapped in place – a macOS app running translocated from a disk image or from
 * a folder the user cannot write, a portable or unpacked build – is served by a checksummed
 * download of the user-facing package that is then opened.
 */
export class ElectronUpdateHost implements UpdateHost {
  private readonly resolvedTarget: UpdateTarget
  private readonly override: UpdateSourceOverride | null
  private abort: AbortController | null = null
  private inPlaceActive = false
  private configured = false
  /** The file electron-updater downloaded last (NSIS installer, AppImage, deb). */
  private staged: string | null = null

  constructor() {
    this.resolvedTarget = detectTarget()
    // The desktop update proof's local release folder (`.github/workflows/desktop-update-proof.yml`).
    // Read here, in the main process, and nowhere near the renderer: whoever can set this
    // process's environment already runs code as the user, so the variable adds no reach –
    // and `parseUpdateBaseUrl` accepts nothing but loopback http or https anyway.
    this.override = parseUpdateBaseUrl(process.env.ZEN_UPDATE_BASE_URL)
    if (this.override) console.warn(`[zen] updates read from ${this.override.baseUrl}`)
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

  packageName(): null {
    return null
  }

  sourceOverride(): UpdateSourceOverride | null {
    return this.override
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
      case 'mac-adhoc':
        this.staged = await this.downloadFile(asset, onProgress, macStagingDir())
        return null
      case 'mac-unsigned':
        return this.downloadFile(asset, onProgress, downloadDir())
      default:
        throw new Error('this build cannot download updates')
    }
  }

  async install(
    release: UpdateRelease,
    downloadedPath: string | null,
    restart?: UpdateRestart
  ): Promise<void> {
    if (downloadedPath) {
      // macOS, not swappable: mount the disk image; Finder shows the drag-to-Applications window.
      const error = await shell.openPath(downloadedPath)
      if (error) throw new Error(error)
      return
    }
    if (!restart) throw new Error('an in-place install needs the restart')
    switch (this.resolvedTarget.kind) {
      case 'nsis':
        return this.installNsis(restart)
      case 'appimage':
        return this.installAppImage(restart)
      case 'deb':
        return this.installDeb(restart)
      case 'mac-adhoc':
        return this.installMacAdhoc(release, restart)
      case 'mac-signed':
        return this.installMacSigned(restart)
      default:
        throw new Error('this build cannot install updates')
    }
  }

  cancel(): void {
    this.abort?.abort()
  }

  // ---------------------------------------------------------------------------
  // Installing
  // ---------------------------------------------------------------------------

  /**
   * NSIS: the installer runs silent and detached, waits for this process to go (it closes a
   * still-running app itself after a moment, so the profile is written before it starts) and
   * relaunches the app. Spawn failures surface as electron-updater errors on the next tick;
   * the ones it knows (no rights) it answers itself with `elevate.exe`.
   */
  private async installNsis(restart: UpdateRestart): Promise<void> {
    await restart.quit()
    await this.runUpdaterInstall(true, true)
    await delay(150)
    app.quit()
  }

  /**
   * AppImage: electron-updater's own install would spawn the new file at once and quit
   * through `app.quit()`; this one renames the download over the running AppImage (the
   * running mount keeps the old inode alive) while the app still runs – the only step that
   * can fail – and relaunches from the new path once the profile is written.
   */
  private async installAppImage(restart: UpdateRestart): Promise<void> {
    const appImage = process.env.APPIMAGE
    if (!appImage || !appImage.startsWith('/'))
      throw new Error('this AppImage does not say where it runs from (APPIMAGE)')
    const installer = this.staged
    if (!installer || !existsSync(installer)) throw new Error('the downloaded AppImage is gone')
    const plan = appImageSwapPlan(appImage, installer)
    moveFile(installer, plan.staging)
    chmodSync(plan.staging, 0o755)
    renameSync(plan.staging, plan.destination)
    if (plan.removeOld) rmSync(appImage, { force: true })
    this.staged = null
    resetUpdaterInstallFlag()
    await restart.quit()
    app.relaunch({ execPath: plan.destination, args: relaunchArgs(process.argv) })
    app.quit()
  }

  /**
   * deb: `dpkg -i` through pkexec (as root: directly), synchronously, while the app still runs
   * – a dismissed password prompt or a dpkg failure is an error here, nothing has quit – then
   * the app relaunches from the replaced binary.
   */
  private async installDeb(restart: UpdateRestart): Promise<void> {
    await this.runUpdaterInstall(true, false)
    await restart.quit()
    app.relaunch({ args: relaunchArgs(process.argv) })
    app.quit()
  }

  /** macOS with a Developer ID: Squirrel.Mac swaps the bundle on quit. Not yet a published build. */
  private async installMacSigned(restart: UpdateRestart): Promise<void> {
    await restart.quit()
    await this.runUpdaterInstall(true, true)
    await delay(150)
    app.quit()
  }

  /**
   * macOS, ad-hoc signed: extract the verified zip, check the bundle, and leave a detached
   * helper to swap it once this process has exited and open the new one.
   */
  private async installMacAdhoc(release: UpdateRelease, restart: UpdateRestart): Promise<void> {
    const zip = this.staged
    if (!zip || !existsSync(zip)) throw new Error('the downloaded update is gone')
    const bundle = macAppBundleOf(process.execPath)
    if (!bundle) throw new Error('this app does not run from an app bundle')
    const stage = join(dirname(zip), 'staged')
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    // ditto keeps the bundle's symlinks, resource forks and signature intact; unzip does not.
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zip, stage])
    const staged = readdirSync(stage)
      .filter((name) => name.endsWith('.app'))
      .map((name) => join(stage, name))[0]
    if (!staged) throw new Error('the update contains no app bundle')
    try {
      await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged])
    } catch (error) {
      throw new Error(`the downloaded app fails its signature check: ${describe(error)}`)
    }
    const version = plistVersion(join(staged, 'Contents', 'Info.plist'))
    if (version !== release.version)
      throw new Error(
        `the downloaded app is ${version ?? 'unversioned'}, the release ${release.version}`
      )
    const logPath = join(dirname(zip), 'swap.log')
    const script = join(dirname(zip), 'swap.sh')
    writeFileSync(
      script,
      macSwapScript({
        pid: process.pid,
        appPath: bundle,
        stagedAppPath: staged,
        logPath,
        relaunchArgs: relaunchArgs(process.argv)
      }),
      { mode: 0o700 }
    )
    rmSync(zip, { force: true })
    this.staged = null
    await restart.quit()
    const helper = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' })
    helper.unref()
    app.quit()
  }

  /**
   * electron-updater's install step for the package it downloaded (`BaseUpdater.install`: no
   * quit of its own). Its failures only surface as an "error" event, dispatched synchronously,
   * so one is caught here and turned into the rejection the core shows; the one-shot flag it
   * sets is reset, so a later attempt is not ignored.
   */
  private runUpdaterInstall(silent: boolean, forceRun: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let failure: Error | null = null
      const onError = (error: Error): void => {
        failure = error
      }
      autoUpdater.on('error', onError)
      let installed = false
      try {
        installed = (autoUpdater as unknown as InstallingUpdater).install(silent, forceRun)
      } finally {
        autoUpdater.removeListener('error', onError)
      }
      if (installed) {
        resolve()
        return
      }
      resetUpdaterInstallFlag()
      reject(failure ?? new Error('the updater did not start the installer'))
    })
  }

  // ---------------------------------------------------------------------------
  // Downloading
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
        // A staged NSIS update installs silently when the user quits anyway. The AppImage and
        // deb installs are this host's own (above); electron-updater's quit-time versions would
        // spawn the new AppImage mid-quit or surface a password prompt out of nowhere.
        autoUpdater.autoInstallOnAppQuit = this.resolvedTarget.kind === 'nsis'
        autoUpdater.allowPrerelease = true
        autoUpdater.allowDowngrade = false
        this.configured = true
      }
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: downloadPrefixFor(UPDATE_REPOSITORY, release.tag, this.override).replace(/\/$/, ''),
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
        const files = await autoUpdater.downloadUpdate(token ?? undefined)
        this.staged = files.find((file) => existsSync(file)) ?? null
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

  /** Fetch a package into `dir` and verify it against the manifest's size and checksum. */
  private async downloadFile(
    asset: UpdateAsset,
    onProgress: (progress: UpdateProgress) => void,
    dir: string
  ): Promise<string> {
    mkdirSync(dir, { recursive: true })
    const destination = uniquePath(dir, asset.name, existsSync)
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

function describe(error: unknown): string {
  const e = error as { stderr?: unknown; message?: unknown }
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : ''
  return stderr || (typeof e?.message === 'string' ? e.message : String(error))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * What `electron-updater` types as `AppUpdater` is a `BaseUpdater` on every desktop OS: its
 * `install` (public, no quit of its own) and the one-shot flag it sets before it tries and
 * leaves set when the try fails (only `quitAndInstall` resets it), after which every later call
 * is "ignored" with no error at all.
 */
interface InstallingUpdater {
  install(isSilent: boolean, isForceRunAfter: boolean): boolean
  quitAndInstallCalled: boolean
}

/** Reset the one-shot flag, so the next Restart to update is a real attempt. */
function resetUpdaterInstallFlag(): void {
  ;(autoUpdater as unknown as InstallingUpdater).quitAndInstallCalled = false
}

/** Rename, or copy and remove when the two paths are on different file systems. */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

/** Where the macOS zip is downloaded and extracted: the user's cache, never Downloads. */
function macStagingDir(): string {
  return join(homedir(), 'Library', 'Caches', 'zenium-updater', 'swap')
}

/** `CFBundleShortVersionString` of an Info.plist (XML, as electron-builder writes it). */
function plistVersion(path: string): string | null {
  let xml = ''
  try {
    xml = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)
  return match ? match[1].trim() : null
}

/** How this process was installed, from what electron-builder left next to it. */
export function detectTarget(): UpdateTarget {
  const os = updateOsOf(process.platform as 'linux' | 'win32' | 'darwin')
  const arch: UpdateArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const kind = detectInstallKind({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    env: process.env,
    macSigned: import.meta.env.VITE_ZEN_MAC_SIGNED === 'true',
    fs: realProbeFs
  })
  return { os, arch, kind }
}

const realProbeFs: InstallProbeFs = {
  exists: (path) => existsSync(path),
  readdir: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  },
  writable: (path) => {
    try {
      accessSync(path, constants.W_OK)
      return true
    } catch {
      return false
    }
  }
}
