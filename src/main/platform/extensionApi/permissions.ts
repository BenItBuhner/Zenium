import {
  type ManifestPermissionSets,
  type PermissionSet,
  addPermissionSets,
  availablePermissions,
  manifestPermissionSets,
  missingPermissions,
  normalizePermissionSet,
  permissionSetContains,
  removePermissionSet,
  requestablePermissions
} from '../../../core/extensions/api/permissions'
import { matchesAnyPattern } from '../../../core/extensions/api/matchPattern'
import {
  newWarnings,
  permissionWarnings,
  type PermissionWarningSource
} from '../../../core/extensions/permissionMessages'
import { warningPlatform } from '../extensions'
import {
  ApiError,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/** API permissions that reveal tab URLs, titles and favicons to an extension. */
const TAB_REVEALING = ['tabs', 'webNavigation']

/**
 * `chrome.permissions`: the granted set of each extension, seeded from the manifest's required
 * permissions and persisted. `request` asks the user through the browser's own prompt, and only
 * when the new permissions add a warning, as Chrome does (a request that is no privilege
 * increase is granted without a question).
 */
export class PermissionsApi {
  private readonly granted = new Map<string, PermissionSet>()
  private readonly manifests = new Map<string, ManifestPermissionSets>()

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    getAll: (ctx) => this.getAll(ctx),
    contains: (ctx, permissions) => this.contains(ctx, permissions),
    request: (ctx, permissions) => this.request(ctx, permissions),
    remove: (ctx, permissions) => this.remove(ctx, permissions)
  }

  /**
   * An extension loaded: its granted set is what was stored plus whatever the manifest requires,
   * less what Chrome refuses to its manifest version (a grant stored before that rule, or before
   * an update changed the version, goes too).
   */
  load(ext: LoadedExtension): void {
    const sets = manifestPermissionSets(ext.manifest)
    this.manifests.set(ext.id, sets)
    const stored = this.host.store.grants(ext.id)
    const merged = stored ? addPermissionSets(stored, sets.required) : { ...sets.required }
    const manifestVersion: 2 | 3 = ext.manifest.manifest_version === 2 ? 2 : 3
    const grants: PermissionSet = {
      permissions: availablePermissions(merged.permissions, manifestVersion),
      origins: merged.origins
    }
    this.granted.set(ext.id, grants)
    if (!stored || grants.permissions.length !== merged.permissions.length)
      this.host.store.setGrants(ext.id, grants)
  }

  unload(extensionId: string): void {
    this.granted.delete(extensionId)
    this.manifests.delete(extensionId)
  }

  grants(extensionId: string): PermissionSet {
    return this.granted.get(extensionId) ?? { permissions: [], origins: [] }
  }

  /** Whether the extension may see a tab's URL, title and favicon. */
  canSeeTab(extensionId: string, url: string): boolean {
    const grants = this.grants(extensionId)
    if (grants.permissions.some((p) => TAB_REVEALING.includes(p))) return true
    return this.hasHostAccess(extensionId, url)
  }

  /** Whether a granted host permission covers `url`. */
  hasHostAccess(extensionId: string, url: string): boolean {
    if (!url) return false
    return matchesAnyPattern(url, this.grants(extensionId).origins)
  }

  private getAll(ctx: ApiContext): PermissionSet {
    const grants = this.grants(ctx.extensionId)
    return { permissions: [...grants.permissions], origins: [...grants.origins] }
  }

  private wanted(permissions: unknown): PermissionSet {
    const set = normalizePermissionSet(permissions)
    if (!set) throw new ApiError('Invalid permissions')
    return set
  }

  private contains(ctx: ApiContext, permissions: unknown): boolean {
    return permissionSetContains(this.grants(ctx.extensionId), this.wanted(permissions))
  }

  private async request(ctx: ApiContext, permissions: unknown): Promise<boolean> {
    const wanted = this.wanted(permissions)
    const sets = this.manifests.get(ctx.extensionId)
    if (!sets) throw new ApiError('Extension is not loaded')
    const check = requestablePermissions(sets, wanted)
    if (!check.ok) throw new ApiError(check.error)
    const grants = this.grants(ctx.extensionId)
    const missing = missingPermissions(grants, wanted)
    if (missing.permissions.length === 0 && missing.origins.length === 0) return true
    const next = addPermissionSets(grants, missing)
    const warnings = addedWarnings(ctx.extension, grants, next)
    if (warnings.length > 0) {
      const accepted = await this.host.confirmPermissions(ctx.extensionId, warnings, ctx.window)
      if (!accepted) return false
    }
    this.granted.set(ctx.extensionId, next)
    this.host.store.setGrants(ctx.extensionId, next)
    this.host.dispatch(ctx.extensionId, 'permissions', 'onAdded', [missing])
    return true
  }

  private remove(ctx: ApiContext, permissions: unknown): boolean {
    const wanted = this.wanted(permissions)
    const sets = this.manifests.get(ctx.extensionId)
    if (!sets) throw new ApiError('Extension is not loaded')
    const required = sets.required
    if (
      wanted.permissions.some((p) => required.permissions.includes(p)) ||
      wanted.origins.some((o) => required.origins.includes(o))
    ) {
      throw new ApiError('You cannot remove required permissions.')
    }
    const grants = this.grants(ctx.extensionId)
    const next = removePermissionSet(grants, wanted)
    const removed: PermissionSet = {
      permissions: grants.permissions.filter((p) => !next.permissions.includes(p)),
      origins: grants.origins.filter((o) => !next.origins.includes(o))
    }
    if (removed.permissions.length === 0 && removed.origins.length === 0) return true
    this.granted.set(ctx.extensionId, next)
    this.host.store.setGrants(ctx.extensionId, next)
    this.host.dispatch(ctx.extensionId, 'permissions', 'onRemoved', [removed])
    return true
  }
}

/**
 * Chrome's prompt lines for what a request adds: the install-style warnings of the manifest with
 * the grants after the request, less those the grants of today already produce (Chrome's
 * privilege-increase check). Empty when nothing new would be shown, so no prompt is due.
 */
export function addedWarnings(
  ext: LoadedExtension,
  before: PermissionSet,
  after: PermissionSet
): string[] {
  const mv3 = ext.manifest.manifest_version !== 2
  // The manifest's other keys (content scripts, devtools_page, overrides) count in both sets and
  // cancel out; MV2 lists its host patterns among `permissions`, MV3 under `host_permissions`.
  const source = (grants: PermissionSet): PermissionWarningSource => ({
    ...ext.manifest,
    permissions: mv3 ? grants.permissions : [...grants.permissions, ...grants.origins],
    host_permissions: mv3 ? grants.origins : undefined,
    optional_permissions: undefined,
    optional_host_permissions: undefined
  })
  const platform = warningPlatform()
  return newWarnings(
    permissionWarnings(source(before), platform),
    permissionWarnings(source(after), platform)
  ).flatMap((w) => [w.message, ...w.details.map((d) => `  ${d}`)])
}
