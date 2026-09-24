/**
 * Automatic updates: the manifest every GitHub release publishes and the pure logic that decides
 * what to do with it. Shared by the browser core on both hosts and by the renderer; the pipeline
 * side (`.github/scripts/update-manifest.mjs`) writes exactly what `parseUpdateManifest` reads.
 *
 * Trust model: the manifest is fetched over HTTPS from GitHub; every asset URL must live under the
 * repository's own release downloads; every download is checked against the SHA-256 recorded in
 * the manifest (electron-updater additionally checks its own SHA-512); and when a public key is
 * built into the app, the manifest must carry a matching ed25519 signature.
 */
import type { Platform as PlatformOs } from './types'

export const UPDATE_REPOSITORY = 'BenItBuhner/Zenium'
export const UPDATE_MANIFEST_FILE = 'update-manifest.json'
export const UPDATE_SIGNATURE_FILE = 'update-manifest.json.sig'
export const UPDATE_MANIFEST_SCHEMA = 1

/** How often the browser looks for a new release on its own. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Delay before the first automatic check after startup (lets the session restore first). */
export const UPDATE_STARTUP_DELAY_MS = 20_000

export type UpdateChannel = 'stable' | 'beta'
export type UpdateOs = 'windows' | 'macos' | 'linux' | 'android'
export type UpdateArch = 'x64' | 'arm64' | 'universal'
export type UpdateAssetKind = 'nsis' | 'dmg' | 'zip' | 'appimage' | 'deb' | 'apk'

/** One downloadable package of a release. */
export interface UpdateAsset {
  os: UpdateOs
  arch: UpdateArch
  kind: UpdateAssetKind
  name: string
  url: string
  size: number
  /** Lower-case hex SHA-256 of the file. */
  sha256: string
  /** Code-signed by the pipeline (Authenticode / Developer ID / release keystore). */
  signed: boolean
  /** macOS only: notarized by Apple. */
  notarized?: boolean
  /** Android only: SHA-256 of the signing certificate (Android upgrades in place only when it matches). */
  signer?: string | null
  /**
   * Android only: the APK's applicationId. Another id than the installed app's means the release
   * installs as a separate app next to it (nothing can migrate); absent in manifests from before
   * the field existed.
   */
  packageName?: string | null
}

export interface UpdateManifest {
  schemaVersion: typeof UPDATE_MANIFEST_SCHEMA
  name: string
  version: string
  tag: string
  prerelease: boolean
  /** ISO 8601. */
  publishedAt: string
  commit: string
  releaseUrl: string
  notesUrl: string
  checksumsUrl: string
  assets: UpdateAsset[]
  /** electron-updater channel files (`latest*.yml`) of this release by target, e.g. `windows-x64`. */
  feeds: Record<string, string>
  /**
   * The release's notes as markdown, when the manifest carries them (a field the release
   * pipeline does not write yet: Settings › About › What's new reads the text from here on the
   * stable channel the day it does, and from the release list's `body` on the beta channel).
   */
  notes?: string
}

/** Detached signature envelope published next to the manifest. */
export interface UpdateSignature {
  algorithm: 'ed25519'
  /** Base64 of the raw 32-byte public key the signature was made with. */
  publicKey: string
  /** Base64 of the 64-byte signature over the manifest file's exact bytes. */
  signature: string
}

export interface UpdateSettings {
  /** Look for new releases on startup and every few hours. */
  autoCheck: boolean
  /** Fetch an update as soon as one is found (hosts that install in place only). */
  autoDownload: boolean
  channel: UpdateChannel
}

export type UpdatePhase =
  'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'

/**
 * How an update reaches this installation.
 * - `in-place`: downloaded and verified in the background, applied on restart (electron-updater).
 * - `installer`: downloaded and verified, then handed to the system (mounted DMG, Android's
 *   package installer, the distribution's package tool); the user confirms.
 * - `manual`: this build cannot be updated by the app – it opens the release page instead.
 */
export type UpdateMode = 'in-place' | 'installer' | 'manual'

/** How the running app was installed; decides the mode and the asset to fetch. */
export type UpdateInstallKind =
  | 'nsis'
  | 'appimage'
  | 'deb'
  | 'mac-signed'
  | 'mac-unsigned'
  | 'apk'
  | 'portable'
  | 'unpacked'
  | 'dev'

export interface UpdateTarget {
  os: UpdateOs
  arch: UpdateArch
  kind: UpdateInstallKind
}

export interface UpdateProgress {
  /** 0–100. */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** The newer release the browser knows about. */
export interface UpdateRelease {
  version: string
  tag: string
  prerelease: boolean
  publishedAt: string
  releaseUrl: string
  notesUrl: string
  /** The package for this installation, or null when the release has none for it. */
  asset: UpdateAsset | null
}

export type UpdateSignatureState =
  /** A key is built into this app and the manifest's signature verified against it. */
  | 'verified'
  /** No key is built into this app; the manifest was accepted on HTTPS + checksums alone. */
  | 'unenforced'

export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  channel: UpdateChannel
  target: UpdateTarget
  mode: UpdateMode
  release: UpdateRelease | null
  progress: UpdateProgress | null
  /** Verified download waiting to be opened (`installer` mode). */
  downloadedPath: string | null
  error: string | null
  lastCheckedAt: number | null
  signature: UpdateSignatureState | null
  /** Android: the release is signed with another key than the installed app – it cannot upgrade in place. */
  signerMismatch: boolean
  /**
   * Android: the release's APK has another applicationId than this app, so Android installs it
   * alongside instead of over it; the old app must be uninstalled afterwards by hand.
   */
  packageChange: boolean
  /**
   * The running version's release notes, when a check brought them (`releaseNotesFromList`, or
   * a manifest's `notes`): what Settings › About › What's new shows. Null until then – the
   * stable channel's manifest carries a link alone today – when the page offers the release's
   * page on GitHub instead. Never fetched on its own: the same request the check makes.
   */
  notes: UpdateNotes | null
}

/** A release's notes as the check found them: which version they describe, and the markdown. */
export interface UpdateNotes {
  version: string
  /** The notes' highlights as markdown (`releaseHighlights`), bounded. */
  text: string
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  autoCheck: true,
  autoDownload: true,
  channel: 'stable'
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  core: [number, number, number]
  pre: string[] | null
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** "1.2.3-beta.4" (or "v1.2.3") → comparable parts; null for anything that is not semver. */
export function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION.exec(text.trim())
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : null
  }
}

/** Semver precedence: numeric core, then a pre-release sorts below the final release. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  if (!x.pre && !y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  const length = Math.max(x.pre.length, y.pre.length)
  for (let i = 0; i < length; i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pNumeric = /^\d+$/.test(p)
    const qNumeric = /^\d+$/.test(q)
    if (pNumeric && qNumeric) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q)
    } else if (pNumeric !== qNumeric) {
      return pNumeric ? -1 : 1
    } else if (p !== q) {
      return p < q ? -1 : 1
    }
  }
  return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export function isPrereleaseVersion(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null && parsed.pre !== null
}

// ---------------------------------------------------------------------------
// Where the manifest lives
// ---------------------------------------------------------------------------

export function releaseDownloadBase(repository: string, tag: string): string {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}`
}

/**
 * The release page of a version (`releases/tag/v<version>`): where the What's new page sends
 * the reader for the whole of a release's notes, and its stand-in while a check has brought
 * none (SET-54).
 */
export function releasePageUrl(version: string, repository: string = UPDATE_REPOSITORY): string {
  return `https://github.com/${repository}/releases/tag/${encodeURIComponent(`v${version}`)}`
}

/**
 * `stable` reads the manifest of GitHub's "latest" release (never a pre-release, never a draft)
 * through the redirecting `releases/latest/download` URL: no API, no rate limit. `beta` needs
 * the release list from the API to find the newest release including pre-releases.
 */
export function manifestSource(
  channel: UpdateChannel,
  repository: string = UPDATE_REPOSITORY
): { kind: 'latest'; manifestUrl: string; signatureUrl: string } | { kind: 'list'; url: string } {
  if (channel === 'stable') {
    const base = `https://github.com/${repository}/releases/latest/download`
    return {
      kind: 'latest',
      manifestUrl: `${base}/${UPDATE_MANIFEST_FILE}`,
      signatureUrl: `${base}/${UPDATE_SIGNATURE_FILE}`
    }
  }
  return { kind: 'list', url: `https://api.github.com/repos/${repository}/releases?per_page=30` }
}

export interface ReleaseCandidate {
  tag: string
  version: string
  prerelease: boolean
  manifestUrl: string
  signatureUrl: string | null
}

/**
 * Pick the newest release (by semver, pre-releases included) that carries an update manifest
 * from a GitHub `GET /repos/{owner}/{repo}/releases` response. Drafts are never returned by the
 * API for anonymous callers, but are skipped anyway.
 */
export function selectReleaseFromList(list: unknown): ReleaseCandidate | null {
  if (!Array.isArray(list)) return null
  let best: ReleaseCandidate | null = null
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const release = entry as {
      tag_name?: unknown
      draft?: unknown
      prerelease?: unknown
      assets?: unknown
    }
    if (release.draft === true || typeof release.tag_name !== 'string') continue
    const parsed = parseVersion(release.tag_name)
    if (!parsed || !release.tag_name.startsWith('v')) continue
    const assets = Array.isArray(release.assets) ? release.assets : []
    const find = (name: string): string | null => {
      const asset = assets.find(
        (a) =>
          a &&
          typeof a === 'object' &&
          (a as { name?: unknown }).name === name &&
          typeof (a as { browser_download_url?: unknown }).browser_download_url === 'string'
      ) as { browser_download_url: string } | undefined
      return asset?.browser_download_url ?? null
    }
    const manifestUrl = find(UPDATE_MANIFEST_FILE)
    if (!manifestUrl) continue
    const version = release.tag_name.slice(1)
    if (best && compareVersions(version, best.version) <= 0) continue
    best = {
      tag: release.tag_name,
      version,
      prerelease: release.prerelease === true,
      manifestUrl,
      signatureUrl: find(UPDATE_SIGNATURE_FILE)
    }
  }
  return best
}

/**
 * The notes of the release tagged `v<version>` in a GitHub releases list – its `body`, as
 * markdown – or null when the list has no such release or it has no text. The beta channel's
 * check fetches the list anyway (`manifestSource`), so the running version's notes come at no
 * further request; the list is thirty releases deep, which reaches back well past the version
 * that is running.
 */
export function releaseNotesFromList(list: unknown, version: string): string | null {
  if (!Array.isArray(list)) return null
  const tag = `v${version}`
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const release = entry as { tag_name?: unknown; body?: unknown; draft?: unknown }
    if (release.draft === true || release.tag_name !== tag) continue
    return typeof release.body === 'string' && release.body.trim() ? release.body : null
  }
  return null
}

/** The most of a release's notes What's new keeps, in characters – a page of highlights, not the download table. */
export const RELEASE_HIGHLIGHTS_MAX = 8_000

/**
 * The part of a release's notes worth a What's new page: the `## Highlights` section as the
 * release notes write it (`.github/scripts/release-notes.mjs` puts the hand-written highlights
 * first, then the download table, the install notes and the changelog), up to the next `##`
 * heading. Notes without that heading keep what stands before their first `##` heading, or –
 * a body that opens on one – the first section whole. Trimmed and bounded
 * (`RELEASE_HIGHLIGHTS_MAX`); empty notes give ''.
 */
export function releaseHighlights(body: string): string {
  const text = body.replace(/\r\n?/g, '\n').trim()
  if (!text) return ''
  const lines = text.split('\n')
  const isSection = (line: string): boolean => /^##\s+\S/.test(line)
  const highlights = lines.findIndex((line) => /^##\s+highlights\s*$/i.test(line))
  let start: number
  if (highlights !== -1) start = highlights + 1
  else if (isSection(lines[0])) start = 1
  else start = 0
  let end = lines.length
  for (let i = start; i < lines.length; i++) {
    if (isSection(lines[i])) {
      end = i
      break
    }
  }
  const section = lines.slice(start, end).join('\n').trim()
  return section.length > RELEASE_HIGHLIGHTS_MAX
    ? `${section.slice(0, RELEASE_HIGHLIGHTS_MAX).trimEnd()}…`
    : section
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

const OSES: readonly UpdateOs[] = ['windows', 'macos', 'linux', 'android']
const ARCHES: readonly UpdateArch[] = ['x64', 'arm64', 'universal']
const KINDS: readonly UpdateAssetKind[] = ['nsis', 'dmg', 'zip', 'appimage', 'deb', 'apk']
/** An Android applicationId: dot-separated Java identifiers, at least two segments. */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/

export class UpdateManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpdateManifestError'
  }
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new UpdateManifestError(`manifest field "${field}" is missing`)
  return value
}

function expectHttpsUrl(value: unknown, field: string): string {
  const text = expectString(value, field)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new UpdateManifestError(`manifest field "${field}" is not a URL`)
  }
  if (url.protocol !== 'https:')
    throw new UpdateManifestError(`manifest field "${field}" must use https`)
  return text
}

/**
 * Validate a manifest document. Asset URLs must point at this repository's own release
 * downloads, so a tampered or mis-generated manifest can never make the app fetch a package
 * from somewhere else.
 */
export function parseUpdateManifest(
  input: unknown,
  repository: string = UPDATE_REPOSITORY
): UpdateManifest {
  let raw: unknown = input
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      throw new UpdateManifestError('manifest is not valid JSON')
    }
  }
  if (!raw || typeof raw !== 'object') throw new UpdateManifestError('manifest is not an object')
  const m = raw as Record<string, unknown>
  if (m.schemaVersion !== UPDATE_MANIFEST_SCHEMA)
    throw new UpdateManifestError(
      `unsupported manifest schema ${String(m.schemaVersion)} (this app reads ${UPDATE_MANIFEST_SCHEMA})`
    )
  const version = expectString(m.version, 'version')
  if (!parseVersion(version) || version.startsWith('v'))
    throw new UpdateManifestError(`manifest version "${version}" is not semver`)
  const tag = expectString(m.tag, 'tag')
  if (tag !== `v${version}`)
    throw new UpdateManifestError(`manifest tag "${tag}" does not match version ${version}`)
  const downloadPrefix = `${releaseDownloadBase(repository, tag)}/`
  const repoPrefix = `https://github.com/${repository}/`
  const releaseUrl = expectHttpsUrl(m.releaseUrl, 'releaseUrl')
  if (!releaseUrl.startsWith(repoPrefix))
    throw new UpdateManifestError('manifest releaseUrl points outside the repository')
  if (!Array.isArray(m.assets) || m.assets.length === 0)
    throw new UpdateManifestError('manifest lists no assets')
  const assets: UpdateAsset[] = m.assets.map((entry, index) => {
    if (!entry || typeof entry !== 'object')
      throw new UpdateManifestError(`asset #${index} is not an object`)
    const a = entry as Record<string, unknown>
    const field = (name: string): string => `assets[${index}].${name}`
    const os = expectString(a.os, field('os')) as UpdateOs
    const arch = expectString(a.arch, field('arch')) as UpdateArch
    const kind = expectString(a.kind, field('kind')) as UpdateAssetKind
    if (!OSES.includes(os)) throw new UpdateManifestError(`${field('os')} "${os}" is unknown`)
    if (!ARCHES.includes(arch))
      throw new UpdateManifestError(`${field('arch')} "${arch}" is unknown`)
    if (!KINDS.includes(kind))
      throw new UpdateManifestError(`${field('kind')} "${kind}" is unknown`)
    const name = expectString(a.name, field('name'))
    if (name.includes('/') || name.includes('\\') || name.startsWith('.'))
      throw new UpdateManifestError(`${field('name')} "${name}" is not a plain file name`)
    const url = expectHttpsUrl(a.url, field('url'))
    if (!url.startsWith(downloadPrefix))
      throw new UpdateManifestError(`${field('url')} is not a download of release ${tag}`)
    const size = a.size
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0)
      throw new UpdateManifestError(`${field('size')} must be a positive integer`)
    const sha256 = expectString(a.sha256, field('sha256')).toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new UpdateManifestError(`${field('sha256')} is not a hex SHA-256`)
    const asset: UpdateAsset = {
      os,
      arch,
      kind,
      name,
      url,
      size,
      sha256,
      signed: a.signed === true
    }
    if (typeof a.notarized === 'boolean') asset.notarized = a.notarized
    if (typeof a.signer === 'string' && /^[0-9a-f]{64}$/i.test(a.signer))
      asset.signer = a.signer.toLowerCase()
    else if (a.signer === null) asset.signer = null
    if (typeof a.packageName === 'string' && PACKAGE_NAME.test(a.packageName))
      asset.packageName = a.packageName
    else if (a.packageName === null) asset.packageName = null
    return asset
  })
  const feeds: Record<string, string> = {}
  if (m.feeds && typeof m.feeds === 'object') {
    for (const [key, value] of Object.entries(m.feeds as Record<string, unknown>)) {
      if (typeof value === 'string' && value.startsWith(downloadPrefix)) feeds[key] = value
    }
  }
  const manifest: UpdateManifest = {
    schemaVersion: UPDATE_MANIFEST_SCHEMA,
    name: typeof m.name === 'string' && m.name ? m.name : 'Zenium',
    version,
    tag,
    prerelease: m.prerelease === true || isPrereleaseVersion(version),
    publishedAt: typeof m.publishedAt === 'string' ? m.publishedAt : '',
    commit: typeof m.commit === 'string' ? m.commit : '',
    releaseUrl,
    notesUrl:
      typeof m.notesUrl === 'string' && m.notesUrl.startsWith(repoPrefix) ? m.notesUrl : releaseUrl,
    checksumsUrl:
      typeof m.checksumsUrl === 'string' && m.checksumsUrl.startsWith(downloadPrefix)
        ? m.checksumsUrl
        : `${downloadPrefix}SHA256SUMS.txt`,
    assets,
    feeds
  }
  // Text, not a field to validate: a manifest without it (every one published so far) is whole.
  if (typeof m.notes === 'string' && m.notes.trim()) manifest.notes = m.notes
  return manifest
}

// ---------------------------------------------------------------------------
// Which package, applied how
// ---------------------------------------------------------------------------

export function updateOsOf(os: PlatformOs): UpdateOs {
  switch (os) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macos'
    case 'android':
      return 'android'
    default:
      return 'linux'
  }
}

/** The `applicationIdSuffix` Android debug builds carry (`android/app/build.gradle.kts`). */
export const ANDROID_DEBUG_ID_SUFFIX = '.debug'

/**
 * Whether an Android applicationId is a debug build's. A debug build is not a release and no
 * release is an upgrade for it: like the desktop's unpacked development builds it gets the `dev`
 * target, which never looks for releases on its own (`UpdateService.schedule`) and cannot install
 * one; the Android host refuses to download or install for the same id (`Updates.kt`).
 */
export function isDebugApplicationId(applicationId: string | null): boolean {
  return applicationId?.endsWith(ANDROID_DEBUG_ID_SUFFIX) ?? false
}

export function updateModeFor(kind: UpdateInstallKind): UpdateMode {
  switch (kind) {
    case 'nsis':
    case 'appimage':
    case 'deb':
    case 'mac-signed':
      return 'in-place'
    case 'mac-unsigned':
    case 'apk':
      return 'installer'
    default:
      return 'manual'
  }
}

/** The package kind an installation updates from (what the manifest must offer). */
export function assetKindFor(target: UpdateTarget): UpdateAssetKind | null {
  switch (target.kind) {
    case 'nsis':
      return 'nsis'
    case 'appimage':
      return 'appimage'
    case 'deb':
      return 'deb'
    case 'mac-signed':
      return 'zip'
    case 'mac-unsigned':
      return 'dmg'
    case 'apk':
      return 'apk'
    default:
      // Builds the app cannot update itself: still name the package a person would download.
      switch (target.os) {
        case 'windows':
          return 'nsis'
        case 'macos':
          return 'dmg'
        case 'linux':
          return 'appimage'
        case 'android':
          return 'apk'
      }
  }
  return null
}

/** The asset of `manifest` this installation would update from, if the release ships one. */
export function pickUpdateAsset(
  manifest: UpdateManifest,
  target: UpdateTarget
): UpdateAsset | null {
  const kind = assetKindFor(target)
  if (!kind) return null
  const candidates = manifest.assets.filter((a) => a.os === target.os && a.kind === kind)
  return (
    candidates.find((a) => a.arch === target.arch) ??
    candidates.find((a) => a.arch === 'universal') ??
    null
  )
}

/** electron-updater feed key of a target (`windows-arm64`, `macos`, `linux-x64`). */
export function feedKeyFor(target: UpdateTarget): string {
  if (target.os === 'macos') return 'macos'
  return `${target.os}-${target.arch}`
}

/** One line for Settings explaining what "Install" does on this installation. */
export function describeUpdateTarget(target: UpdateTarget): string {
  switch (target.kind) {
    case 'nsis':
      return 'Updates download in the background and install when Zenium restarts.'
    case 'appimage':
      return 'Updates download in the background and replace this AppImage when Zenium restarts.'
    case 'deb':
      return 'Updates download in the background; installing asks for your password once (dpkg).'
    case 'mac-signed':
      return 'Updates download in the background and install when Zenium restarts.'
    case 'mac-unsigned':
      return 'This build is not signed by Apple, so macOS cannot swap it in place: Zenium downloads and opens the disk image and you drag the new Zenium over the old one.'
    case 'apk':
      return 'Zenium downloads the APK and hands it to Android, which asks you to confirm the install.'
    case 'portable':
      return 'Portable builds are not updated in place; download the new version from the release page.'
    case 'unpacked':
      return 'This unpacked build cannot update itself; download an installer from the release page.'
    case 'dev':
      return 'Development builds only check for releases.'
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function sanitizeUpdateSettings(
  raw: Partial<UpdateSettings> | undefined | null
): UpdateSettings {
  const d = DEFAULT_UPDATE_SETTINGS
  const r = raw ?? {}
  return {
    autoCheck: typeof r.autoCheck === 'boolean' ? r.autoCheck : d.autoCheck,
    autoDownload: typeof r.autoDownload === 'boolean' ? r.autoDownload : d.autoDownload,
    channel: r.channel === 'beta' ? 'beta' : 'stable'
  }
}

/** Pre-release builds follow the beta channel unless the user picked one explicitly. */
export function effectiveChannel(settings: UpdateSettings, currentVersion: string): UpdateChannel {
  if (settings.channel === 'beta') return 'beta'
  return isPrereleaseVersion(currentVersion) ? 'beta' : 'stable'
}

export function emptyUpdateStatus(currentVersion: string, target: UpdateTarget): UpdateStatus {
  return {
    phase: 'idle',
    currentVersion,
    channel: 'stable',
    target,
    mode: updateModeFor(target.kind),
    release: null,
    progress: null,
    downloadedPath: null,
    error: null,
    lastCheckedAt: null,
    signature: null,
    signerMismatch: false,
    packageChange: false,
    notes: null
  }
}
