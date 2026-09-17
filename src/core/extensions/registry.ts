/**
 * The installed-extensions registry: what a host persists about each extension (where it came
 * from, where its files are, what the user decided) and the migration from the first schema,
 * which only remembered `{ path, enabled }` for unpacked folders.
 *
 * Platform-agnostic on purpose: Electron and the Android host both keep a document of this shape,
 * and the fields mirror what the management UI shows (`ExtensionInfo` in shared/types).
 */
import type { CrxPublisher } from './crx'
import { isMatchPattern } from './manifest'
import type { StoreId } from './store'

export type ExtensionSource = StoreId | 'crx' | 'zip' | 'unpacked'

export interface ExtensionRecord {
  id: string
  source: ExtensionSource
  /** The directory the host loads; for managed installs `<root>/<id>/<version>`. */
  path: string
  version: string
  /** Who signed the package (`null` for unpacked folders and unsigned zips). */
  publisher: CrxPublisher | null
  /** `manifest.update_url`, or the store's update endpoint for store installs; null when none. */
  updateUrl: string | null
  installedAt: number
  updatedAt: number
  enabled: boolean
  /** Pinned extensions are skipped by update checks. */
  pinned: boolean
  /**
   * Shown as a toolbar button; the rest live in the puzzle-piece panel. Off by default like
   * Chrome's `pinned_extensions` (the install toast offers to pin).
   */
  toolbarPinned: boolean
  /** Chrome's "Allow access to file URLs" toggle; off by default like Chrome. */
  allowFileAccess: boolean
  manifestVersion: number
  name: string
  description: string
  /** API permissions (MV2 host patterns listed under `permissions` land in `hostPermissions`). */
  permissions: string[]
  hostPermissions: string[]
  /** `options_ui.page` or `options_page`, relative to the extension root. */
  optionsPage: string | null
  /** `action.default_popup` (or the MV2 `browser_action` equivalent). */
  popup: string | null
  /**
   * Warning lines an update added over the version the user approved. Chrome keeps such an
   * extension disabled until the user accepts them again; the host clears this on approval.
   */
  pendingWarnings: string[] | null
}

export interface ExtensionRegistry {
  version: 2
  extensions: ExtensionRecord[]
  /** When the last update check finished (any outcome), or null when none ran yet. */
  lastUpdateCheck: number | null
}

/** The fields of a record that come straight from a manifest. */
export type ManifestFields = Pick<
  ExtensionRecord,
  | 'version'
  | 'manifestVersion'
  | 'name'
  | 'description'
  | 'permissions'
  | 'hostPermissions'
  | 'optionsPage'
  | 'popup'
> & { updateUrl: string | null }

interface LooseManifest {
  manifest_version?: unknown
  name?: unknown
  version?: unknown
  description?: unknown
  permissions?: unknown
  host_permissions?: unknown
  options_ui?: { page?: unknown } | null
  options_page?: unknown
  action?: { default_popup?: unknown } | null
  browser_action?: { default_popup?: unknown } | null
  update_url?: unknown
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Reads the registry fields out of any manifest object (validated or raw; missing keys are fine). */
export function manifestFields(input: unknown): ManifestFields {
  const manifest = (input && typeof input === 'object' ? input : {}) as LooseManifest
  const manifestVersion =
    typeof manifest.manifest_version === 'number' ? manifest.manifest_version : 2
  const permissions: string[] = []
  const hostPermissions: string[] = []
  for (const permission of strings(manifest.permissions)) {
    // MV2 mixes host patterns into `permissions`; MV3 keeps them in `host_permissions`.
    if (manifestVersion < 3 && isMatchPattern(permission)) hostPermissions.push(permission)
    else permissions.push(permission)
  }
  hostPermissions.push(...strings(manifest.host_permissions))
  const action = manifest.action ?? manifest.browser_action
  const optionsPage = str(manifest.options_ui?.page) || str(manifest.options_page) || null
  return {
    version: str(manifest.version),
    manifestVersion,
    name: str(manifest.name),
    description: str(manifest.description),
    permissions,
    hostPermissions,
    optionsPage: optionsPage ? optionsPage.replace(/^\/+/, '') : null,
    popup: str(action?.default_popup) || null,
    updateUrl: str(manifest.update_url) || null
  }
}

export interface NewRecordOptions {
  id: string
  source: ExtensionSource
  path: string
  manifest: unknown
  now: number
  publisher?: CrxPublisher | null
  /** Overrides `manifest.update_url` (store installs always update through their store). */
  updateUrl?: string | null
  enabled?: boolean
  allowFileAccess?: boolean
}

export function newRecord(options: NewRecordOptions): ExtensionRecord {
  const fields = manifestFields(options.manifest)
  return {
    id: options.id,
    source: options.source,
    path: options.path,
    version: fields.version,
    publisher: options.publisher ?? null,
    updateUrl: options.updateUrl !== undefined ? options.updateUrl : fields.updateUrl,
    installedAt: options.now,
    updatedAt: options.now,
    enabled: options.enabled ?? true,
    pinned: false,
    toolbarPinned: false,
    allowFileAccess: options.allowFileAccess ?? false,
    manifestVersion: fields.manifestVersion,
    name: fields.name,
    description: fields.description,
    permissions: fields.permissions,
    hostPermissions: fields.hostPermissions,
    optionsPage: fields.optionsPage,
    popup: fields.popup,
    pendingWarnings: null
  }
}

/** Refreshes the manifest-derived fields of a record (an unpacked folder changed on disk, an update landed). */
export function withManifest(
  record: ExtensionRecord,
  manifest: unknown,
  overrides: Partial<ExtensionRecord> = {}
): ExtensionRecord {
  const fields = manifestFields(manifest)
  return {
    ...record,
    ...fields,
    // Store installs keep updating through their store even if the manifest says otherwise.
    updateUrl:
      record.source === 'chrome-web-store' || record.source === 'edge-add-ons'
        ? record.updateUrl
        : fields.updateUrl,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Persistence and migration
// ---------------------------------------------------------------------------

export interface MigrationHelpers {
  /** Chrome's id for an unpacked folder: a hash of its path (what `loadExtension` will report). */
  idForPath(path: string): string
  /** The folder's `manifest.json`, parsed, or null when unreadable. */
  readManifest(path: string): unknown | null
}

const SOURCES: ReadonlySet<string> = new Set([
  'chrome-web-store',
  'edge-add-ons',
  'crx',
  'zip',
  'unpacked'
])

export function emptyRegistry(): ExtensionRegistry {
  return { version: 2, extensions: [], lastUpdateCheck: null }
}

/**
 * Turns whatever `extensions.json` holds into the current schema. Version 1 records
 * (`{ path, enabled }`) become `unpacked` records with their fields read from the folder's
 * manifest; version 2 records are sanitised so a hand-edited or truncated document cannot crash
 * the host, and fields a future record type may add are dropped.
 */
export function migrateRegistry(
  raw: unknown,
  helpers: MigrationHelpers,
  now: number
): ExtensionRegistry {
  if (!raw || typeof raw !== 'object') return emptyRegistry()
  const doc = raw as { version?: unknown; extensions?: unknown; lastUpdateCheck?: unknown }
  if (!Array.isArray(doc.extensions)) return emptyRegistry()
  const registry = emptyRegistry()
  if (doc.version === 1) {
    for (const entry of doc.extensions as unknown[]) {
      const legacy = entry as { path?: unknown; enabled?: unknown } | null
      if (!legacy || typeof legacy.path !== 'string' || legacy.path.length === 0) continue
      const path = legacy.path
      const id = helpers.idForPath(path)
      if (registry.extensions.some((r) => r.id === id)) continue
      registry.extensions.push(
        newRecord({
          id,
          source: 'unpacked',
          path,
          manifest: helpers.readManifest(path),
          now,
          enabled: legacy.enabled !== false,
          // The first schema loaded every folder with file access; keep what those users had.
          allowFileAccess: true
        })
      )
    }
    return registry
  }
  if (doc.version !== 2) return emptyRegistry()
  if (typeof doc.lastUpdateCheck === 'number') registry.lastUpdateCheck = doc.lastUpdateCheck
  for (const entry of doc.extensions as unknown[]) {
    const record = sanitizeRecord(entry, now)
    if (record && !registry.extensions.some((r) => r.id === record.id))
      registry.extensions.push(record)
  }
  return registry
}

function sanitizeRecord(entry: unknown, now: number): ExtensionRecord | null {
  if (!entry || typeof entry !== 'object') return null
  const r = entry as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (typeof r.path !== 'string' || r.path.length === 0) return null
  const source =
    typeof r.source === 'string' && SOURCES.has(r.source)
      ? (r.source as ExtensionSource)
      : 'unpacked'
  const publisher =
    r.publisher === 'chrome-web-store' ||
    r.publisher === 'edge-add-ons' ||
    r.publisher === 'unknown'
      ? r.publisher
      : null
  const installedAt = typeof r.installedAt === 'number' ? r.installedAt : now
  return {
    id: r.id,
    source,
    path: r.path,
    version: str(r.version),
    publisher,
    updateUrl: str(r.updateUrl) || null,
    installedAt,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : installedAt,
    enabled: r.enabled !== false,
    pinned: r.pinned === true,
    toolbarPinned: r.toolbarPinned === true,
    allowFileAccess: r.allowFileAccess === true,
    manifestVersion: typeof r.manifestVersion === 'number' ? r.manifestVersion : 2,
    name: str(r.name),
    description: str(r.description),
    permissions: strings(r.permissions),
    hostPermissions: strings(r.hostPermissions),
    optionsPage: str(r.optionsPage) || null,
    popup: str(r.popup) || null,
    pendingWarnings: Array.isArray(r.pendingWarnings) ? strings(r.pendingWarnings) : null
  }
}
