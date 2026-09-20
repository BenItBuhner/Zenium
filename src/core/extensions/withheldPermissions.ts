/**
 * API permissions Zenium withholds from the manifest the engine loads. Electron never creates the
 * browser-side objects a few of Chromium's extension APIs stand on, and where Chromium's API code
 * assumes the object exists the result is a main-process crash rather than an error to the
 * extension: `system.storage`'s functions run `StorageMonitor::EnsureInitialized` on a monitor
 * Electron never instantiates, so an extension declaring the permission took the whole browser
 * down the moment its worker called `chrome.system.storage.getInfo`. A user reaches that by
 * installing such an extension from a store, so it has to be impossible.
 *
 * The install pipeline removes these entries from `permissions` and `optional_permissions` of the
 * manifest the engine loads (the way it adds the content-script prelude: for store packages,
 * sideloaded zips and unpacked folders alike), the host keeps what the extension declared, reports
 * a line on the extension's error console, and the browser layer answers the API in Chrome's shape
 * (`api/systemStorage.ts`). Pure functions, so the rewrite is one rule everywhere and testable.
 */
import type { WithheldPermissions } from '../../shared/types'

export type { WithheldPermissions } from '../../shared/types'

/** The API permissions the engine must not see. Only confirmed crashes belong here. */
export const WITHHELD_PERMISSIONS: readonly string[] = ['system.storage']

/**
 * The install directory's copy of the manifest as the extension declared it, written beside the
 * `manifest.json` the engine loads before that one is rewritten. The host reads permissions and
 * install warnings from this copy when it exists, so the management UI, the update check and the
 * API layer see what the extension asked for. Unpacked folders need none: the developer's own
 * folder keeps the declaration and the engine loads a shadow.
 */
export const DECLARED_MANIFEST_FILE = 'zenium-declared-manifest.json'

export interface WithheldRewrite {
  manifest: Record<string, unknown>
  withheld: WithheldPermissions
  /** Whether the rewrite produced a different manifest. */
  changed: boolean
}

export function isWithheldPermission(permission: unknown): permission is string {
  return typeof permission === 'string' && WITHHELD_PERMISSIONS.includes(permission)
}

export function noWithheldPermissions(): WithheldPermissions {
  return { required: [], optional: [] }
}

export function hasWithheldPermissions(withheld: WithheldPermissions): boolean {
  return withheld.required.length > 0 || withheld.optional.length > 0
}

/** Every withheld permission the extension declared, required ones first, each once. */
export function withheldPermissionNames(withheld: WithheldPermissions): string[] {
  return [...new Set([...withheld.required, ...withheld.optional])]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function withheldIn(list: unknown): string[] {
  return Array.isArray(list) ? [...new Set(list.filter(isWithheldPermission))] : []
}

/** The withheld entries a manifest declares, by the list they sit in. */
export function withheldPermissionsOf(manifest: unknown): WithheldPermissions {
  if (!isRecord(manifest)) return noWithheldPermissions()
  return {
    required: withheldIn(manifest.permissions),
    optional: withheldIn(manifest.optional_permissions)
  }
}

/**
 * The manifest without its withheld entries: `permissions` and `optional_permissions` keep their
 * other entries and their order (an emptied list stays as an empty list); every other key is
 * untouched. Idempotent: a manifest already free of them comes back as is, `changed` false.
 */
export function withoutWithheldPermissions(manifest: Record<string, unknown>): WithheldRewrite {
  const withheld = withheldPermissionsOf(manifest)
  if (!hasWithheldPermissions(withheld)) return { manifest, withheld, changed: false }
  const next: Record<string, unknown> = { ...manifest }
  if (withheld.required.length > 0 && Array.isArray(manifest.permissions))
    next.permissions = manifest.permissions.filter((entry) => !isWithheldPermission(entry))
  if (withheld.optional.length > 0 && Array.isArray(manifest.optional_permissions))
    next.optional_permissions = manifest.optional_permissions.filter(
      (entry) => !isWithheldPermission(entry)
    )
  return { manifest: next, withheld, changed: true }
}

/**
 * The engine's manifest with the withheld entries back in the lists they came from: the manifest
 * as declared, for permission sets and install warnings. Unchanged (same object) when nothing was
 * withheld or the lists already carry the entries.
 */
export function restoreWithheldPermissions<
  T extends { permissions?: unknown; optional_permissions?: unknown }
>(manifest: T, withheld: WithheldPermissions): T {
  const restore = (list: unknown, entries: string[]): unknown[] | null => {
    const current = Array.isArray(list) ? list : []
    const missing = entries.filter((entry) => !current.includes(entry))
    return missing.length > 0 ? [...current, ...missing] : null
  }
  const permissions = restore(manifest.permissions, withheld.required)
  const optional = restore(manifest.optional_permissions, withheld.optional)
  if (!permissions && !optional) return manifest
  return {
    ...manifest,
    ...(permissions ? { permissions } : {}),
    ...(optional ? { optional_permissions: optional } : {})
  }
}

/**
 * The error console line reported at load for one withheld permission (a warning with `source:
 * 'load'`, in the tone of Chrome's manifest warnings): what is missing, and what the extension
 * gets instead.
 */
export function withheldPermissionLine(permission: string): string {
  if (permission === 'system.storage') {
    return (
      "'system.storage' is not available in Zenium; the permission was withheld and " +
      'chrome.system.storage answers with no devices.'
    )
  }
  return `'${permission}' is not available in Zenium; the permission was withheld.`
}
