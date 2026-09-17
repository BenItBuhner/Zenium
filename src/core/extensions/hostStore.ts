/**
 * The host-independent half of a store-backed extension host: where packages come from (a store
 * id or listing URL, a `.crx` or `.zip` file), how a download falls back from one store to the
 * other, what the install prompt shows, and the icon a package carries. Electron
 * (`src/main/platform/extensionStore.ts`) and Android (`src/android/extensionHost.ts`) both build
 * on this; the filesystem and the network primitive stay with the host.
 */
import type { ExtensionSource } from '../../shared/types'
import type { ZenWindow } from '../window'
import { base64Encode, utf8Encode } from './bytes'
import {
  installFromCrx,
  installFromZip,
  type ExtensionPackage,
  type UpdateCheckResult
} from './install'
import {
  StoreError,
  crxDownloadUrl,
  downloadCrx,
  isExtensionId,
  parseStorePageUrl,
  type StoreFetch,
  type StoreId
} from './store'

const STORE_ORDER: readonly StoreId[] = ['chrome-web-store', 'edge-add-ons']

// ---------------------------------------------------------------------------
// Where packages come from
// ---------------------------------------------------------------------------

export interface StoreRef {
  id: string
  /** The store the user pointed at (a listing URL names it); null when only an id was given. */
  store: StoreId | null
}

/** An extension id, or a Chrome Web Store / Edge Add-ons listing URL. */
export function parseStoreRef(ref: string): StoreRef | null {
  const trimmed = ref.trim()
  if (isExtensionId(trimmed)) return { id: trimmed, store: null }
  const page = parseStorePageUrl(trimmed)
  return page ? { id: page.id, store: page.store } : null
}

export interface StoreDownload {
  bytes: Uint8Array
  store: StoreId
  /** Stores that answered without a package, for the log. */
  skipped: Array<{ store: StoreId; status: number }>
}

/**
 * Downloads a CRX from the preferred store, falling back to the other one when the first has no
 * package for the id (the Chrome Web Store answers 204 for items it dropped, such as every
 * Manifest V2 extension since 2026-08-31, many of which live on in Edge Add-ons).
 */
export async function downloadFromStores(
  fetch: StoreFetch,
  id: string,
  preferred: StoreId | null,
  chromiumVersion: string
): Promise<StoreDownload> {
  const order = preferred
    ? [preferred, ...STORE_ORDER.filter((s) => s !== preferred)]
    : [...STORE_ORDER]
  const skipped: Array<{ store: StoreId; status: number }> = []
  for (const store of order) {
    const response = await fetch(crxDownloadUrl(store, id, { chromiumVersion }))
    if (response.status === 200 && response.bytes.length > 0)
      return { bytes: response.bytes, store, skipped }
    skipped.push({ store, status: response.status })
  }
  const detail = skipped.map((s) => `${storeLabel(s.store)}: HTTP ${s.status}`).join(', ')
  throw new StoreError('http', `No store has an extension with id ${id} (${detail})`)
}

export function storeLabel(store: StoreId): string {
  return store === 'chrome-web-store' ? 'Chrome Web Store' : 'Edge Add-ons'
}

/** Downloads the package an update check announced, verifying the hash it carried. */
export function downloadUpdate(
  fetch: StoreFetch,
  update: Extract<UpdateCheckResult, { status: 'update-available' }>
): Promise<Uint8Array> {
  return downloadCrx(fetch, update.codebase, { sha256: update.sha256 })
}

export interface PackageOptions {
  locale: string | null
  expectedId?: string
}

/** Verifies and unpacks a `.crx` (signed) or `.zip` (unsigned) file's bytes. */
export async function packageFromFile(
  fileName: string,
  bytes: Uint8Array,
  options: PackageOptions
): Promise<{ pkg: ExtensionPackage; kind: 'crx' | 'zip' }> {
  if (/\.zip$/i.test(fileName)) return { pkg: await packageFromZip(bytes, options), kind: 'zip' }
  if (/\.crx$/i.test(fileName)) return { pkg: await installFromCrx(bytes, options), kind: 'crx' }
  throw new Error('Choose a .crx or .zip file')
}

/**
 * A sideloaded zip has no publisher key, so its id is Zenium's choice. Chrome hashes the install
 * path for unpacked folders; a versioned layout cannot do that (the path contains the id), so the
 * id is derived from the extension's name instead. A later zip of the same extension then lands
 * on the same id and installs as an update rather than a duplicate.
 */
export async function packageFromZip(
  bytes: Uint8Array,
  options: PackageOptions
): Promise<ExtensionPackage> {
  const probe = await installFromZip(bytes, { ...options, idSeed: 'zenium-probe' })
  if (typeof probe.rawManifest.key === 'string') return probe
  return installFromZip(bytes, { ...options, idSeed: zipIdSeed(probe.rawManifest) })
}

/** The bytes whose SHA-256 is the id of an unsigned zip; also written as its `manifest.key`. */
export function zipIdSeed(rawManifest: Record<string, unknown>): Uint8Array {
  const name = typeof rawManifest.name === 'string' ? rawManifest.name : ''
  return utf8Encode(`zenium-sideload:${name}`)
}

/**
 * The `manifest.json` to write instead of the package's own: unsigned zips get a synthetic `key`
 * so a host that derives ids from it (Electron's `loadExtension`) lands on the id the package
 * carries. Null when the archive's manifest is written as is (signed packages already carry the
 * developer key, see `install.ts`).
 */
export function zipManifestOverride(pkg: ExtensionPackage): Uint8Array | null {
  if (pkg.signed || pkg.publicKey !== null) return null
  return utf8Encode(
    JSON.stringify({ ...pkg.rawManifest, key: base64Encode(zipIdSeed(pkg.rawManifest)) }, null, 2)
  )
}

// ---------------------------------------------------------------------------
// The install prompt
// ---------------------------------------------------------------------------

/** What the install prompt shows; the UI layer replaces `confirmInstall` to draw its own panel. */
export interface InstallConfirmation {
  /** A fresh install, a reinstall over an existing version, or approving an update's new permissions. */
  kind: 'install' | 'update' | 'permissions'
  name: string
  /** Data URL of the extension's icon when one is available. */
  icon: string | null
  /** Chrome's warning lines for the manifest, in Chrome's order. */
  warnings: string[]
  source: ExtensionSource
}

export type ConfirmInstall = (request: InstallConfirmation, win?: ZenWindow) => Promise<boolean>

/** The prompt's wording as a plain question, for hosts whose dialog is a native message box. */
export function installPromptText(request: InstallConfirmation): {
  message: string
  detail: string
  okLabel: string
} {
  const lines = request.warnings.map((w) => `\u2022 ${w}`)
  const message =
    request.kind === 'permissions'
      ? `"${request.name}" needs new permissions`
      : request.kind === 'update'
        ? `Update "${request.name}"?`
        : `Add "${request.name}"?`
  const detail =
    lines.length > 0 ? `It can:\n${lines.join('\n')}` : 'It needs no special permissions.'
  const okLabel =
    request.kind === 'permissions'
      ? 'Allow'
      : request.kind === 'update'
        ? 'Update extension'
        : 'Add extension'
  return { message, detail, okLabel }
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/** The manifest fields the icon lookup reads (validated or raw manifests alike). */
export interface IconManifest {
  icons?: Record<string, string>
  action?: { default_icon?: string | Record<string, string> }
  browser_action?: { default_icon?: string | Record<string, string> }
}

export const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

/** MIME type of an image file by its extension (`image/png` when unknown). */
export function imageMime(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  return IMAGE_MIME[ext] ?? 'image/png'
}

/** The manifest's icon candidates: the action icon, then the extension icons, 32 px or the largest. */
export function iconCandidates(manifest: IconManifest): string[] {
  const action = manifest.action ?? manifest.browser_action
  const candidates: Record<string, string> = {}
  if (typeof action?.default_icon === 'string') candidates['0'] = action.default_icon
  else if (action?.default_icon) Object.assign(candidates, action.default_icon)
  if (Object.keys(candidates).length === 0 && manifest.icons)
    Object.assign(candidates, manifest.icons)
  const sizes = Object.keys(candidates)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
  const pick = sizes.find((s) => s >= 32) ?? sizes[sizes.length - 1]
  const rel = pick === undefined ? Object.values(candidates)[0] : candidates[String(pick)]
  return rel ? [rel.replace(/^\/+/, '')] : []
}

/** The icon of a package that is not on disk yet, read from its files. */
export async function packageIcon(pkg: ExtensionPackage): Promise<string | null> {
  for (const rel of iconCandidates(pkg.manifest as IconManifest)) {
    const file = pkg.files.find((f) => f.path === rel)
    if (!file) continue
    try {
      return `data:${imageMime(rel)};base64,${base64Encode(await file.bytes())}`
    } catch {
      /* try the next candidate */
    }
  }
  return null
}
