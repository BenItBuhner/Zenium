import type { CheckupState, PasswordsStatus, Platform } from '@shared/types'
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

// ---------------------------------------------------------------------------
// Settings › Passwords: the desktop section, the phone category and the manager's own settings
// view say the same things about the same rows.
// ---------------------------------------------------------------------------

/** How long one re-authentication covers reveals, copies and exports (`reauthGraceSeconds`). */
export const PASSWORD_GRACE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Every time' },
  { value: '30', label: 'After 30 seconds' },
  { value: '60', label: 'After 1 minute' },
  { value: '300', label: 'After 5 minutes' },
  { value: '900', label: 'After 15 minutes' },
  { value: '3600', label: 'After 1 hour' }
]

export const PASSWORDS_COPY = {
  manage: 'Manage passwords',
  checkup: 'Check passwords',
  offerToSave: {
    label: 'Offer to save passwords',
    description:
      'Ask to save logins typed into websites. The prompt itself arrives with in-page filling.'
  },
  grace: {
    label: 'Ask again before showing or copying',
    description: 'How long one verification covers reveals, copies and exports.'
  },
  /**
   * Chrome's label for its leak detection (ID-31); the description keeps to the phone row's two
   * lines (the lookup sends a hash prefix, never the password).
   */
  leakDetection: {
    label: 'Warn you if passwords are exposed in a data breach',
    description:
      'Checks passwords you sign in with against known breaches. They never leave this device.'
  },
  protection: { label: 'Vault protection' },
  lock: {
    label: 'Lock the vault',
    description: 'Forget the key until the manager is opened again.',
    locked: 'The vault is locked.'
  },
  importCsv: {
    label: 'Import passwords',
    description: 'A CSV exported by Chrome, Edge, Firefox, Safari, Bitwarden, LastPass or KeePass.'
  },
  exportCsv: {
    label: 'Export passwords',
    description: 'Write every login to a CSV that Chrome and other managers can import.',
    armed:
      'The file is plain text: anyone who opens it can read every password. Delete it once it has been imported elsewhere.'
  }
} as const

/** What the manager holds, in one line: the count, or why there is none to count yet. */
export function passwordsSavedLabel(status: PasswordsStatus): string {
  if (!status.locked) return `${status.count} ${status.count === 1 ? 'login' : 'logins'} saved`
  return status.protection.os || status.protection.passphrase
    ? 'The vault is locked'
    : 'No vault yet'
}

/** How the vault's key is protected – or, before there is a vault, how it will be. */
export function vaultProtectionLabel(status: PasswordsStatus): string {
  const { os, passphrase } = status.protection
  if (os && passphrase) return 'Device keychain and passphrase'
  if (os) return 'Device keychain'
  if (passphrase) return 'Passphrase'
  return status.osKeystore
    ? 'Device keychain, created with the first login'
    : 'A passphrase, created with the first login'
}

/**
 * The checkup in one line: its progress while it runs, what it found and when it last ran, or
 * what it would look for. The count is of distinct logins across the three findings, the way
 * the checkup view's headline counts them.
 */
export function checkupLabel(checkup: CheckupState): string {
  if (checkup.running) return `Checking ${checkup.checked} of ${checkup.total}`
  if (checkup.finishedAt === null)
    return 'Finds passwords that appeared in data breaches, are reused across sites or are easy to guess.'
  const issues = new Set([...checkup.compromised, ...checkup.weak, ...checkup.reused.flat()]).size
  const found =
    issues === 0
      ? 'No problems found'
      : `${issues} ${issues === 1 ? 'password needs' : 'passwords need'} attention`
  const when = relativeTime(checkup.finishedAt)
  return `${found} · Last checked ${when === 'Just now' ? 'just now' : when}`
}
