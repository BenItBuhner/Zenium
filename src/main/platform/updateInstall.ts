import { basename, dirname, join, posix, win32 } from 'node:path'
import type { UpdateInstallKind } from '../../shared/updates'

/**
 * The decisions behind an in-place update, apart from Electron and the file system so that
 * every OS branch runs under vitest on any OS (`__tests__/updateInstall.test.ts`). The
 * `ElectronUpdateHost` (`updates.ts`) feeds them the real process and acts on what they return.
 */

/** What `detectInstallKind` may ask of the file system; every call answers, none throws. */
export interface InstallProbeFs {
  exists(path: string): boolean
  /** The names in a directory; [] when it cannot be read. */
  readdir(path: string): string[]
  /** A small text file's contents; '' when it cannot be read. */
  readFile(path: string): string
  /** Whether this process may write `path` (a file or a directory). */
  writable(path: string): boolean
}

export interface InstallProbe {
  platform: string
  isPackaged: boolean
  execPath: string
  resourcesPath: string
  env: Readonly<Record<string, string | undefined>>
  /** Built with a Developer ID certificate (`VITE_ZEN_MAC_SIGNED`), which Squirrel.Mac can swap. */
  macSigned: boolean
  fs: InstallProbeFs
}

/** How this process was installed, from what electron-builder left next to it. */
export function detectInstallKind(probe: InstallProbe): UpdateInstallKind {
  if (!probe.isPackaged) return 'dev'
  const { fs } = probe
  // The probe's paths are the probed OS's, whichever OS runs this (the tests run every branch).
  const path = probe.platform === 'win32' ? win32 : posix
  const hasUpdateConfig = fs.exists(path.join(probe.resourcesPath, 'app-update.yml'))
  switch (probe.platform) {
    case 'win32': {
      if (probe.env.PORTABLE_EXECUTABLE_DIR) return 'portable'
      const installed = fs
        .readdir(path.dirname(probe.execPath))
        .some((name) => /^Uninstall .*\.exe$/i.test(name))
      return hasUpdateConfig && installed ? 'nsis' : 'unpacked'
    }
    case 'darwin': {
      // Gatekeeper runs an app opened straight from a disk image from a read-only random path.
      if (probe.execPath.includes('/AppTranslocation/')) return 'mac-unsigned'
      if (probe.macSigned && hasUpdateConfig) return 'mac-signed'
      const bundle = macAppBundleOf(probe.execPath)
      if (!bundle) return 'mac-unsigned'
      // The swap renames the bundle within its folder, so both must be ours to write – which
      // rules out a read-only disk image and an administrator's /Applications on a standard
      // account alike.
      return fs.writable(bundle) && fs.writable(path.dirname(bundle)) ? 'mac-adhoc' : 'mac-unsigned'
    }
    default: {
      const appImage = probe.env.APPIMAGE
      if (appImage) {
        return appImage.startsWith('/') &&
          fs.writable(appImage) &&
          fs.writable(path.dirname(appImage))
          ? 'appimage'
          : 'unpacked'
      }
      const packageType = fs.readFile(path.join(probe.resourcesPath, 'package-type')).trim()
      return packageType === 'deb' && hasUpdateConfig ? 'deb' : 'unpacked'
    }
  }
}

/** The steps of an install that hands over to an installer after the quit (NSIS, Squirrel.Mac). */
export interface HandoverInstallSteps {
  /** Whether the package the installer needs is still where it was downloaded. */
  installerPresent(): boolean
  /** Clear the updater's one-shot "already tried" flag, so this try is a real one. */
  resetOneShot(): void
  /** The core's `UpdateRestart.quit()`: the browser's shutdown and the profile's final write. */
  quit(): Promise<void>
  /** Start the installer; rejects when it could not be started. */
  runInstaller(): Promise<void>
  /** End this process – after a successful start, and after a failed one just the same. */
  endProcess(): Promise<void>
  log(message: string): void
}

/**
 * An install whose last step is an installer that waits for this process to go (NSIS with
 * `--force-run`; Squirrel.Mac) obeys the core's contract – `quit()` is called once nothing
 * can fail any more, and the process ends right after it: what can be checked is checked
 * before the quit (the package still there, the one-shot flag clear); an installer that still
 * fails to start after it is logged and the process ends anyway, so the user is never left
 * with a shut-down window that no longer quits. The update stays staged for the next launch.
 */
export async function installByHandover(steps: HandoverInstallSteps): Promise<void> {
  if (!steps.installerPresent()) throw new Error('the downloaded installer is gone')
  steps.resetOneShot()
  await steps.quit()
  try {
    await steps.runInstaller()
  } catch (error) {
    steps.log(
      `the installer did not start after the quit: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    await steps.endProcess()
  }
}

/** The `.app` bundle an executable runs from (`…/Zenium.app/Contents/MacOS/Zenium`), or null. */
export function macAppBundleOf(execPath: string): string | null {
  let dir = execPath
  for (;;) {
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
    if (dir.endsWith('.app')) return dir
  }
}

/**
 * Where the downloaded AppImage goes, the way electron-updater names it: a file the user
 * renamed (no version in its name), or one named exactly like the download, is overwritten in
 * place; a versioned name gets the download's name next to it and the old file is removed.
 */
export function appImageSwapPlan(
  appImageFile: string,
  installerPath: string
): { destination: string; staging: string; removeOld: boolean } {
  const existing = basename(appImageFile)
  const keepName = basename(installerPath) === existing || !/\d+\.\d+\.\d+/.test(existing)
  const destination = keepName ? appImageFile : join(dirname(appImageFile), basename(installerPath))
  return {
    destination,
    // Moved next to the destination first, so the final step is one rename on one file system.
    staging: `${destination}.zenium-update`,
    removeOld: destination !== appImageFile
  }
}

/**
 * The arguments the relaunched app gets: this process's own, without the inspector and
 * remote-debugging switches a test harness attaches to it (a detached relaunch has no one on
 * the other end of those pipes).
 */
export function relaunchArgs(argv: readonly string[]): string[] {
  return argv
    .slice(1)
    .filter(
      (arg) =>
        !/^--(inspect|inspect-brk|remote-debugging-port|remote-debugging-pipe)(=|$)/.test(arg)
    )
}

/** `text` as one word for /bin/sh. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

export interface MacSwapOptions {
  /** The running app's process; the helper waits for it to exit before touching the bundle. */
  pid: number
  /** The bundle in use, e.g. /Applications/Zenium.app. */
  appPath: string
  /** The verified new bundle, extracted next to the download. */
  stagedAppPath: string
  /** Where the helper writes what it did. */
  logPath: string
  relaunchArgs: readonly string[]
  /** How long to wait for the app to exit, in seconds. */
  waitSeconds?: number
}

/**
 * The /bin/sh program that swaps the macOS bundle once the app has quit: the old bundle is
 * moved aside, the new one moved into its place (one rename each, on one volume), the old one
 * removed, quarantine cleared from the new one, and the app opened again. Any failure puts the
 * old bundle back, so the user is never left without an app.
 */
export function macSwapScript(options: MacSwapOptions): string {
  const q = shellQuote
  const wait = Math.max(1, Math.floor(options.waitSeconds ?? 90))
  const open = ['open', '-n', q(options.appPath)]
  if (options.relaunchArgs.length > 0) open.push('--args', ...options.relaunchArgs.map(q))
  return [
    '#!/bin/sh',
    `PID=${Math.floor(options.pid)}`,
    `APP=${q(options.appPath)}`,
    `NEW=${q(options.stagedAppPath)}`,
    `LOG=${q(options.logPath)}`,
    'OLD="$APP.old"',
    'exec >>"$LOG" 2>&1',
    'echo "$(date) waiting for pid $PID"',
    `i=0; while kill -0 "$PID" 2>/dev/null; do i=$((i+1)); if [ "$i" -ge ${wait * 5} ]; then echo "pid $PID still alive after ${wait}s; giving up"; exit 1; fi; sleep 0.2; done`,
    'rm -rf "$OLD"',
    'if ! mv "$APP" "$OLD"; then echo "could not move the old app aside"; exit 1; fi',
    'if ! mv "$NEW" "$APP"; then echo "could not move the new app into place; restoring"; mv "$OLD" "$APP"; exit 1; fi',
    'rm -rf "$OLD"',
    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null',
    'echo "$(date) swapped; opening"',
    open.join(' '),
    ''
  ].join('\n')
}
