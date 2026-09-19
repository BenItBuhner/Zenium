import type { Platform } from '@shared/types'
import { describeUpdateTarget, type UpdateStatus } from '@shared/updates'
import { formatBytes, relativeTime } from '@renderer/lib/utils'

/**
 * Settings copy the desktop panel and the phone Settings page both say: kept apart from the
 * components so that the two surfaces cannot drift, and so that component files export only
 * components (Fast Refresh).
 */

/** What changing the app icon does on this host, in one breath. */
export const APP_ICON_HINT: Record<Platform, string> = {
  android:
    'Changes the icon on your home screen and in the app list at once. Some launchers take a moment to redraw it, and a home screen shortcut may need adding again.',
  win32:
    'Applies to the window and the taskbar now. The Start menu and desktop shortcuts keep the icon the installer gave them until the next update, when they take this one.',
  darwin:
    'Applies to the Dock while Zenium is running. Finder and Launchpad keep the icon inside the app bundle.',
  linux:
    'Applies to the window and its dock entry now. The app menu keeps the icon the package installed.'
}

/** What kind of build this is, as the row that says how it updates. */
export function installLabel(u: UpdateStatus): string {
  switch (u.target.kind) {
    case 'nsis':
      return 'Windows installer'
    case 'appimage':
      return 'Linux AppImage'
    case 'deb':
      return 'Debian package'
    case 'mac-signed':
      return 'macOS app (signed)'
    case 'mac-unsigned':
      return 'macOS app (unsigned)'
    case 'apk':
      return 'Android APK'
    case 'portable':
      return 'Portable build'
    case 'unpacked':
      return 'Unpacked build'
    case 'dev':
      return 'Development build'
  }
}

export function headline(u: UpdateStatus): string {
  switch (u.phase) {
    case 'idle':
      return `Zenium ${u.currentVersion}`
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return `Zenium ${u.currentVersion} is up to date`
    case 'available':
      return `Zenium ${u.release?.version ?? ''} is available`
    case 'downloading':
      return `Downloading Zenium ${u.release?.version ?? ''}…`
    case 'ready':
      return `Zenium ${u.release?.version ?? ''} is ready to install`
    case 'error':
      return 'Could not update'
  }
}

export function detail(u: UpdateStatus): string {
  const checked = u.lastCheckedAt ? `Last checked ${relativeTime(u.lastCheckedAt)}.` : ''
  switch (u.phase) {
    case 'idle':
      return u.target.kind === 'dev'
        ? 'Development build – checks are manual.'
        : 'No check has run yet in this session.'
    case 'checking':
      return `Looking up the latest ${u.channel === 'beta' ? 'pre-release or release' : 'release'} on GitHub…`
    case 'up-to-date':
      return `You are on the newest ${u.channel === 'beta' ? 'beta' : 'stable'} release. ${checked}`
    case 'available':
      if (u.signerMismatch)
        return 'This release is signed with a different key than the installed app: uninstall Zenium first, then install the new APK from the release page.'
      if (u.mode === 'manual' || !u.release?.asset)
        return 'This build cannot update itself – get the new version from the release page.'
      if (u.packageChange)
        return `This release is a new app (${u.release.asset.packageName}): Android installs it alongside this one instead of replacing it. Install it, then uninstall this app. ${checked}`
      return u.mode === 'in-place'
        ? `Downloading installs it in the background; Zenium switches over when it restarts. ${checked}`
        : `${describeUpdateTarget(u.target)} ${checked}`
    case 'downloading':
      return u.progress
        ? `${formatBytes(u.progress.transferred)} of ${formatBytes(u.progress.total)}${
            u.progress.bytesPerSecond > 0 ? ` · ${formatBytes(u.progress.bytesPerSecond)}/s` : ''
          }`
        : 'Starting download…'
    case 'ready':
      return u.target.kind === 'deb'
        ? 'Verified and staged. Restart to update runs dpkg, which asks for your password.'
        : u.mode === 'in-place'
          ? 'Verified and staged. It installs when Zenium restarts – now, or the next time you quit.'
          : u.target.kind === 'apk'
            ? u.packageChange
              ? 'Verified. Install hands the APK to Android; it installs as a new app next to this one, and this app can be uninstalled afterwards.'
              : 'Verified. Install hands the APK to Android, which asks you to confirm.'
            : `Verified and saved to ${u.downloadedPath ?? 'Downloads'}. Install opens it.`
    case 'error':
      return `${u.error ?? 'Unknown error'}. ${checked}`
  }
}
