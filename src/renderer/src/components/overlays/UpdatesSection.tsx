import type { JSX } from 'react'
import { Download, ExternalLink, RefreshCw, RotateCw, ShieldCheck, X } from 'lucide-react'
import type { Settings, UIState } from '@shared/types'
import { describeUpdateTarget, type UpdateChannel, type UpdateStatus } from '@shared/updates'
import { run } from '@renderer/lib/api'
import { formatBytes, relativeTime } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Switch } from '../ui/switch'
import { Group, Row, Segmented } from './SettingsPrimitives'

/**
 * Settings → Updates. One status card driven by the core's `UpdateStatus` (check → available →
 * downloading → ready), plus the automatic-check preferences. Releases come from GitHub; how an
 * update is applied depends on how this copy of Zenium was installed (`describeUpdateTarget`).
 */
export function UpdatesSection({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const u = state.updates
  const prefs = state.settings.updates
  const inPlace = u.mode === 'in-place'
  const canDownload = u.mode !== 'manual' && Boolean(u.release?.asset) && !u.signerMismatch
  return (
    <>
      <StatusCard status={u} canDownload={canDownload} />
      <Group title="Automatic updates">
        <Row
          label="Check for updates automatically"
          hint="On startup and every six hours. Nothing is installed without you seeing it here first."
        >
          <Switch
            checked={prefs.autoCheck}
            onCheckedChange={(v) => set({ updates: { ...prefs, autoCheck: v } })}
          />
        </Row>
        {inPlace && (
          <Row
            label="Download updates in the background"
            hint="Fetch a new version as soon as it is found; it installs when you restart Zenium."
          >
            <Switch
              checked={prefs.autoDownload}
              disabled={!prefs.autoCheck}
              onCheckedChange={(v) => set({ updates: { ...prefs, autoDownload: v } })}
            />
          </Row>
        )}
        <Row
          label="Release channel"
          hint={
            u.channel === 'beta' && prefs.channel !== 'beta'
              ? 'Pre-release builds follow the beta channel until a final release replaces them.'
              : 'Beta receives pre-releases (x.y.z-beta.n) as well as final releases.'
          }
        >
          <Segmented<UpdateChannel>
            label="Release channel"
            value={prefs.channel}
            onChange={(v) => set({ updates: { ...prefs, channel: v } })}
            options={[
              { value: 'stable', label: 'Stable' },
              { value: 'beta', label: 'Beta' }
            ]}
          />
        </Row>
      </Group>
      <Group title="How updates are applied">
        <Row label={installLabel(u)} hint={describeUpdateTarget(u.target)}>
          <span className="zen-settings-hint">
            {u.target.os}
            {u.target.arch !== 'universal' ? ` · ${u.target.arch}` : ''}
          </span>
        </Row>
        <Row
          label="Verification"
          hint={
            u.signature === 'verified'
              ? 'Release manifests are signed; this build checks the signature before trusting a release, then verifies every download against its SHA-256.'
              : 'Every download is verified against the SHA-256 the release publishes. Releases also carry Sigstore build-provenance attestations (gh attestation verify).'
          }
        >
          <ShieldCheck
            className={`h-4 w-4 ${u.signature === 'verified' ? 'text-[var(--zen-ok)]' : 'text-[var(--zen-muted)]'}`}
          />
        </Row>
      </Group>
    </>
  )
}

function installLabel(u: UpdateStatus): string {
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

function StatusCard({
  status: u,
  canDownload
}: {
  status: UpdateStatus
  canDownload: boolean
}): JSX.Element {
  const release = u.release
  const busy = u.phase === 'checking' || u.phase === 'downloading'
  return (
    <section className="zen-settings-rows">
      <div className="zen-settings-row items-start py-2">
        <StatusGlyph status={u} busy={busy} />
        <div className="zen-settings-text">
          <div className="zen-settings-label font-medium">{headline(u)}</div>
          <div className="zen-settings-hint">{detail(u)}</div>
        </div>
        <div className="zen-settings-control">
          {u.phase === 'downloading' ? (
            <Button variant="secondary" size="sm" onClick={() => run('updates.cancel', undefined)}>
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
          ) : u.phase === 'ready' ? (
            <Button size="sm" onClick={() => run('updates.install', undefined)}>
              {u.mode === 'in-place' ? (
                <>
                  <RotateCw className="h-3.5 w-3.5" /> Restart to update
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" /> Install
                </>
              )}
            </Button>
          ) : u.phase === 'available' && canDownload ? (
            <Button size="sm" onClick={() => run('updates.download', undefined)}>
              <Download className="h-3.5 w-3.5" /> Download {release?.version}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => run('updates.check', undefined)}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'zen-spin' : ''}`} /> Check now
            </Button>
          )}
        </div>
      </div>
      {u.phase === 'downloading' && u.progress && (
        <div className="px-2.5 pb-2 pl-[58px]">
          <div className="h-1 overflow-hidden rounded-full bg-[var(--zen-element-bg-active)]">
            <div
              className="h-full rounded-full bg-[var(--zen-accent-fill)] transition-[width]"
              style={{ width: `${Math.max(2, Math.min(100, u.progress.percent))}%` }}
            />
          </div>
        </div>
      )}
      {release && (
        <div className="zen-settings-row">
          <div className="zen-settings-hint min-w-0 flex-1 truncate tabular-nums">
            {release.tag}
            {release.prerelease ? ' · pre-release' : ''}
            {release.asset ? ` · ${release.asset.name} (${formatBytes(release.asset.size)})` : ''}
          </div>
          <Button variant="ghost" size="sm" onClick={() => run('updates.openRelease', undefined)}>
            <ExternalLink className="h-3.5 w-3.5" /> Release notes
          </Button>
        </div>
      )}
    </section>
  )
}

/** The state of the update at a glance: a status glyph in a pill tint of its ink. */
function StatusGlyph({ status: u, busy }: { status: UpdateStatus; busy: boolean }): JSX.Element {
  const tone =
    u.phase === 'error'
      ? 'text-[var(--zen-danger)] bg-[rgb(var(--zen-danger-rgb)/0.14)]'
      : u.phase === 'up-to-date' || u.phase === 'ready'
        ? 'text-[var(--zen-ok)] bg-[rgb(var(--zen-ok-rgb)/0.14)]'
        : 'text-[var(--zen-accent-ink)] bg-[rgb(var(--zen-accent-rgb)/0.16)]'
  const Icon =
    u.phase === 'error'
      ? X
      : u.phase === 'up-to-date'
        ? ShieldCheck
        : u.phase === 'ready'
          ? RotateCw
          : u.phase === 'available' || u.phase === 'downloading'
            ? Download
            : RefreshCw
  return (
    <span
      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone}`}
    >
      <Icon className={`h-4 w-4 ${busy && u.phase === 'checking' ? 'zen-spin' : ''}`} />
    </span>
  )
}

function headline(u: UpdateStatus): string {
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

function detail(u: UpdateStatus): string {
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
