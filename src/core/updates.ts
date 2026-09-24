import nacl from 'tweetnacl'
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_REPOSITORY,
  UPDATE_STARTUP_DELAY_MS,
  effectiveChannel,
  emptyUpdateStatus,
  isNewerVersion,
  manifestSource,
  parseUpdateManifest,
  pickUpdateAsset,
  releaseHighlights,
  releaseNotesFromList,
  selectReleaseFromList,
  updateModeFor,
  type UpdateChannel,
  type UpdateManifest,
  type UpdateNotes,
  type UpdateProgress,
  type UpdateRelease,
  type UpdateSignatureState,
  type UpdateStatus
} from '../shared/updates'
import type { Browser } from './browser'
import type { UpdateHost } from './platform'
import type { ZenWindow } from './window'

/** Progress broadcasts to the chrome are rate-limited to this many milliseconds apart. */
const PROGRESS_INTERVAL_MS = 250
/** Manifest fetches go through a GitHub redirect to its CDN; mobile networks need more than the hosts' default. */
const FETCH_TIMEOUT_MS = 15_000

/**
 * Automatic updates, the host-neutral half. Periodically reads the update manifest of the newest
 * GitHub release (see `shared/updates.ts` for the trust model), works out whether it is newer
 * than the running version and which package applies to this installation, and drives the host
 * through download and install. The whole state is one `UpdateStatus` value shown in Settings →
 * Updates; every change is broadcast through the UI state.
 */
export class UpdateService {
  private current: UpdateStatus
  private timer: ReturnType<typeof setTimeout> | null = null
  private checking: Promise<void> | null = null
  private cancelRequested = false
  private lastProgressAt = 0

  constructor(
    private readonly browser: Browser,
    private readonly host: UpdateHost
  ) {
    const version = browser.platform.info.version
    this.current = emptyUpdateStatus(version, host.target())
    this.current.channel = effectiveChannel(browser.state.settings.updates, version)
  }

  status(): UpdateStatus {
    return this.current
  }

  /** Arm the first automatic check; later ones follow every `UPDATE_CHECK_INTERVAL_MS`. */
  start(): void {
    this.schedule(UPDATE_STARTUP_DELAY_MS)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  onSettingsChanged(): void {
    const settings = this.browser.state.settings.updates
    const channel = effectiveChannel(settings, this.current.currentVersion)
    if (channel !== this.current.channel && this.current.phase !== 'downloading') {
      // Another channel means another "latest": forget what we found on the old one.
      this.set({
        channel,
        phase: 'idle',
        release: null,
        error: null,
        progress: null,
        downloadedPath: null,
        signerMismatch: false,
        packageChange: false
      })
    }
    this.schedule(settings.autoCheck ? 1_000 : 0)
  }

  /** Look for a newer release now. `manual` checks report their outcome as toasts. */
  check(opts: { manual: boolean }): Promise<void> {
    if (this.checking) return this.checking
    if (this.current.phase === 'downloading') return Promise.resolve()
    this.checking = this.doCheck(opts).finally(() => {
      this.checking = null
    })
    return this.checking
  }

  async download(): Promise<void> {
    const { release, mode, phase } = this.current
    if (phase === 'downloading' || phase === 'ready' || phase === 'checking') return
    if (!release) {
      await this.check({ manual: true })
      return
    }
    if (mode === 'manual' || !release.asset) {
      this.openRelease()
      return
    }
    if (this.current.signerMismatch) {
      this.browser.toast(
        'This release is signed with a different key than the installed app. Uninstall Zenium, then install the new APK.',
        'error'
      )
      return
    }
    const asset = release.asset
    this.cancelRequested = false
    this.set({
      phase: 'downloading',
      error: null,
      downloadedPath: null,
      progress: { percent: 0, transferred: 0, total: asset.size, bytesPerSecond: 0 }
    })
    try {
      const path = await this.host.download(release, asset, (progress) =>
        this.reportProgress(progress)
      )
      this.set({
        phase: 'ready',
        downloadedPath: path,
        progress: { percent: 100, transferred: asset.size, total: asset.size, bytesPerSecond: 0 }
      })
      this.browser.toast(
        mode === 'in-place'
          ? `Zenium ${release.version} is ready – restart to update.`
          : this.current.packageChange
            ? `Zenium ${release.version} downloaded – install it from Settings → Updates; it installs alongside this app, which you can then uninstall.`
            : `Zenium ${release.version} downloaded – install it from Settings → Updates.`
      )
    } catch (error) {
      if (this.cancelRequested || (error as Error)?.name === 'AbortError') {
        this.set({ phase: 'available', progress: null })
        return
      }
      const message = describeError(error)
      this.set({ phase: 'error', error: message, progress: null })
      this.browser.toast(`Update failed: ${message}`, 'error')
    }
  }

  /** Apply the downloaded update. In-place hosts restart into the new version from here. */
  async install(): Promise<void> {
    const { release, downloadedPath, phase } = this.current
    if (phase !== 'ready' || !release) return
    try {
      // Anything unsaved must hit the disk before an in-place install restarts the app.
      if (this.current.mode === 'in-place') this.browser.flushSync()
      await this.host.install(release, downloadedPath)
    } catch (error) {
      const message = describeError(error)
      this.set({ phase: 'error', error: message })
      this.browser.toast(`Could not install the update: ${message}`, 'error')
    }
  }

  cancel(): void {
    if (this.current.phase !== 'downloading') return
    this.cancelRequested = true
    this.host.cancel()
  }

  /** The release notes on GitHub, in a Zenium tab. */
  openRelease(win?: ZenWindow): void {
    const url = this.current.release?.notesUrl ?? `https://github.com/${UPDATE_REPOSITORY}/releases`
    this.browser.openExternalUrl(url, win)
  }

  // ---------------------------------------------------------------------------

  private schedule(delayMs: number): void {
    this.stop()
    const settings = this.browser.state.settings.updates
    if (!settings.autoCheck || delayMs <= 0 || this.current.target.kind === 'dev') return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check({ manual: false }).finally(() => this.schedule(UPDATE_CHECK_INTERVAL_MS))
    }, delayMs)
  }

  private async doCheck(opts: { manual: boolean }): Promise<void> {
    const settings = this.browser.state.settings.updates
    const version = this.current.currentVersion
    const channel = effectiveChannel(settings, version)
    this.set({ phase: 'checking', channel, error: null })
    try {
      const { manifest, signature, notes } = await this.fetchManifest(channel)
      const lastCheckedAt = Date.now()
      // The running version's notes ride along whatever the check finds (What's new reads
      // them); a check that brought none keeps the ones an earlier check did.
      const kept = notes ?? this.current.notes
      if (!isNewerVersion(manifest.version, version)) {
        this.set({
          phase: 'up-to-date',
          release: null,
          progress: null,
          downloadedPath: null,
          signerMismatch: false,
          packageChange: false,
          lastCheckedAt,
          signature,
          notes: kept
        })
        if (opts.manual) this.browser.toast(`Zenium ${version} is up to date.`)
        return
      }
      if (this.current.phase === 'ready' && this.current.release?.version === manifest.version) {
        // Already fetched exactly this version; nothing to redo.
        this.set({ lastCheckedAt, signature, notes: kept })
        return
      }
      const target = this.current.target
      const asset = pickUpdateAsset(manifest, target)
      const release: UpdateRelease = {
        version: manifest.version,
        tag: manifest.tag,
        prerelease: manifest.prerelease,
        publishedAt: manifest.publishedAt,
        releaseUrl: manifest.releaseUrl,
        notesUrl: manifest.notesUrl,
        asset
      }
      // Android accepts an APK over the installed app only from the same signing key – unless the
      // APK carries another applicationId, in which case it is a new app that installs alongside
      // whatever key it has (the way Zen became Zenium), and the key comparison says nothing.
      const installedPackage = target.kind === 'apk' ? this.host.packageName() : null
      const packageChange = Boolean(
        installedPackage && asset?.packageName && asset.packageName !== installedPackage
      )
      const installedSigner = target.kind === 'apk' && !packageChange ? this.host.signer() : null
      const signerMismatch = Boolean(
        installedSigner && asset?.signer && asset.signer !== installedSigner
      )
      this.set({
        phase: 'available',
        release,
        progress: null,
        downloadedPath: null,
        signerMismatch,
        packageChange,
        lastCheckedAt,
        signature,
        notes: kept
      })
      const mode = updateModeFor(target.kind)
      if (settings.autoDownload && mode === 'in-place' && asset && !signerMismatch) {
        void this.download()
      } else if (!opts.manual) {
        this.browser.toast(
          packageChange
            ? `Zenium ${manifest.version} is available as a new app – see Settings → Updates.`
            : `Zenium ${manifest.version} is available – see Settings → Updates.`
        )
      }
    } catch (error) {
      const message = describeError(error)
      this.set({ phase: 'error', error: message, lastCheckedAt: Date.now() })
      if (opts.manual) this.browser.toast(`Could not check for updates: ${message}`, 'error')
    }
  }

  /**
   * The newest release's manifest, verified, and – riding on the same requests – the running
   * version's release notes where either carried them: the beta channel's release list (its
   * entries' `body`), or the manifest itself when it is the running version's and carries
   * `notes` (the stable channel, once the pipeline writes them). Nothing is fetched for the
   * notes alone.
   */
  private async fetchManifest(channel: UpdateChannel): Promise<{
    manifest: UpdateManifest
    signature: UpdateSignatureState
    notes: UpdateNotes | null
  }> {
    const source = manifestSource(channel, UPDATE_REPOSITORY)
    const version = this.current.currentVersion
    let manifestUrl: string
    let signatureUrl: string | null
    let notes: UpdateNotes | null = null
    if (source.kind === 'latest') {
      manifestUrl = source.manifestUrl
      signatureUrl = source.signatureUrl
    } else {
      const list = await this.fetchText(source.url, {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      })
      const parsed: unknown = JSON.parse(list)
      const candidate = selectReleaseFromList(parsed)
      if (!candidate) throw new Error('no release with an update manifest has been published yet')
      manifestUrl = candidate.manifestUrl
      signatureUrl = candidate.signatureUrl
      notes = notesOf(version, releaseNotesFromList(parsed, version))
    }
    const manifestText = await this.fetchText(manifestUrl)
    const manifest = parseUpdateManifest(manifestText, UPDATE_REPOSITORY)
    if (!notes && manifest.version === version) notes = notesOf(version, manifest.notes ?? null)
    const keys = this.host.publicKeys()
    if (keys.length === 0) return { manifest, signature: 'unenforced', notes }
    if (!signatureUrl) throw new Error('the release manifest is not signed; refusing to update')
    const response = await this.browser.platform.net.fetchText(signatureUrl, {
      headers: { Accept: 'application/json' },
      timeoutMs: FETCH_TIMEOUT_MS
    })
    if (!response.ok) throw new Error('the release manifest is not signed; refusing to update')
    let envelope: unknown
    try {
      envelope = JSON.parse(response.text)
    } catch {
      throw new Error('the release manifest signature is unreadable; refusing to update')
    }
    if (!verifyManifestSignature(manifestText, envelope, keys))
      throw new Error('the release manifest signature does not match; refusing to update')
    return { manifest, signature: 'verified', notes }
  }

  private async fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
    const response = await this.browser.platform.net.fetchText(url, {
      headers: { Accept: 'application/json', ...headers },
      timeoutMs: FETCH_TIMEOUT_MS
    })
    if (response.ok) return response.text
    if (response.status === 404)
      throw new Error(
        url.includes('/releases/latest/')
          ? 'no release has been published yet'
          : 'the release is missing its update manifest'
      )
    if (response.status === 403 || response.status === 429)
      throw new Error('GitHub is rate-limiting update checks; try again later')
    throw new Error(
      response.status ? `GitHub answered ${response.status}` : 'you appear to be offline'
    )
  }

  private reportProgress(progress: UpdateProgress): void {
    const now = Date.now()
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS && progress.percent < 100) return
    this.lastProgressAt = now
    if (this.current.phase === 'downloading') this.set({ progress })
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.current = { ...this.current, ...patch }
    this.browser.state.commitVolatile()
  }
}

// ---------------------------------------------------------------------------
// Manifest signatures
// ---------------------------------------------------------------------------

/**
 * Check the detached ed25519 signature of a manifest against the keys built into this app. The
 * signature covers the manifest file's exact bytes; the envelope may name the key it was made
 * with, which must then be one of ours (a rotated key ships with a new app build).
 */
export function verifyManifestSignature(
  manifestText: string,
  envelope: unknown,
  pinnedPublicKeys: string[]
): boolean {
  if (!envelope || typeof envelope !== 'object') return false
  const e = envelope as Record<string, unknown>
  if (e.algorithm !== 'ed25519' || typeof e.signature !== 'string') return false
  const signature = decodeBase64(e.signature)
  if (!signature || signature.length !== nacl.sign.signatureLength) return false
  const message = new TextEncoder().encode(manifestText)
  for (const pinned of pinnedPublicKeys) {
    if (typeof e.publicKey === 'string' && e.publicKey !== pinned) continue
    const key = decodeBase64(pinned)
    if (!key || key.length !== nacl.sign.publicKeyLength) continue
    if (nacl.sign.detached.verify(message, signature, key)) return true
  }
  return false
}

function decodeBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text.trim())
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/** The highlights of a release's notes as What's new keeps them; null for none, or none worth a page. */
function notesOf(version: string, body: string | null): UpdateNotes | null {
  if (!body) return null
  const text = releaseHighlights(body)
  return text ? { version, text } : null
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error:\s*/, '') || 'unknown error'
}
