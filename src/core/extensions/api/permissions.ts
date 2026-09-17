/**
 * `chrome.permissions` grant logic: which API permissions and host patterns an extension holds,
 * split from the manifest into required and optional sets the way Chrome does (MV2 mixes hosts
 * into `permissions`; MV3 separates `host_permissions`), plus `contains` / `request` / `remove`
 * set arithmetic. Pure functions; the host persists the grants.
 */
import type { ExtensionManifest } from '../manifest'
import { compileMatchPattern, patternContains } from './matchPattern'

export interface PermissionSet {
  permissions: string[]
  origins: string[]
}

export interface ManifestPermissionSets {
  required: PermissionSet
  optional: PermissionSet
}

/** Whether a manifest `permissions` entry names a host pattern rather than an API permission. */
export function isHostPattern(entry: string): boolean {
  return entry === '<all_urls>' || entry.includes('://') || entry.startsWith('file:')
}

export function emptyPermissionSet(): PermissionSet {
  return { permissions: [], origins: [] }
}

/** Required and optional sets of a manifest, host patterns separated from API permissions. */
export function manifestPermissionSets(manifest: ExtensionManifest): ManifestPermissionSets {
  const required = emptyPermissionSet()
  const optional = emptyPermissionSet()
  const sort = (entries: string[] | undefined, into: PermissionSet): void => {
    for (const entry of entries ?? []) {
      if (typeof entry !== 'string') continue
      if (isHostPattern(entry)) into.origins.push(entry)
      else into.permissions.push(entry)
    }
  }
  sort(manifest.permissions, required)
  sort(manifest.host_permissions, required)
  sort(manifest.optional_permissions, optional)
  sort(manifest.optional_host_permissions, optional)
  return { required: dedupe(required), optional: dedupe(optional) }
}

/** Coerce a `Permissions` argument into a normalised set; `null` when it is malformed. */
export function normalizePermissionSet(input: unknown): PermissionSet | null {
  if (input === null || typeof input !== 'object') return null
  const obj = input as { permissions?: unknown; origins?: unknown }
  const set = emptyPermissionSet()
  for (const [key, target] of [
    ['permissions', set.permissions],
    ['origins', set.origins]
  ] as const) {
    const value = obj[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return null
    target.push(...(value as string[]))
  }
  return dedupe(set)
}

/** Whether `granted` covers every permission and origin in `wanted`. */
export function permissionSetContains(granted: PermissionSet, wanted: PermissionSet): boolean {
  for (const permission of wanted.permissions) {
    if (!granted.permissions.includes(permission)) return false
  }
  for (const origin of wanted.origins) {
    if (!granted.origins.some((g) => patternContains(g, origin))) return false
  }
  return true
}

export function addPermissionSets(a: PermissionSet, b: PermissionSet): PermissionSet {
  return dedupe({
    permissions: [...a.permissions, ...b.permissions],
    origins: [...a.origins, ...b.origins]
  })
}

/** Remove `removed` from `granted`; origins only go when the exact pattern was granted. */
export function removePermissionSet(granted: PermissionSet, removed: PermissionSet): PermissionSet {
  return {
    permissions: granted.permissions.filter((p) => !removed.permissions.includes(p)),
    origins: granted.origins.filter((o) => !removed.origins.includes(o))
  }
}

/** The part of `wanted` that is not granted yet. */
export function missingPermissions(granted: PermissionSet, wanted: PermissionSet): PermissionSet {
  return {
    permissions: wanted.permissions.filter((p) => !granted.permissions.includes(p)),
    origins: wanted.origins.filter((o) => !granted.origins.some((g) => patternContains(g, o)))
  }
}

/** Validation Chrome performs on `permissions.request`: only optional/required entries qualify. */
export function requestablePermissions(
  manifest: ManifestPermissionSets,
  wanted: PermissionSet
): { ok: true } | { ok: false; error: string } {
  for (const permission of wanted.permissions) {
    if (
      !manifest.optional.permissions.includes(permission) &&
      !manifest.required.permissions.includes(permission)
    ) {
      return {
        ok: false,
        error: `Only permissions specified in the manifest may be requested.`
      }
    }
  }
  for (const origin of wanted.origins) {
    if (compileMatchPattern(origin) === null) {
      return {
        ok: false,
        error: `Invalid value for origin pattern ${origin}: Missing scheme separator.`
      }
    }
    const allowed = [...manifest.optional.origins, ...manifest.required.origins].some((g) =>
      patternContains(g, origin)
    )
    if (!allowed) {
      return {
        ok: false,
        error: `Only permissions specified in the manifest may be requested.`
      }
    }
  }
  return { ok: true }
}

function dedupe(set: PermissionSet): PermissionSet {
  return { permissions: [...new Set(set.permissions)], origins: [...new Set(set.origins)] }
}
