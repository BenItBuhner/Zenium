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
import {
  isWithheldPermission,
  restoreWithheldPermissions
} from '../../../core/extensions/withheldPermissions'
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
  private readonly originListeners = new Set<HostOriginsListener>()
  private readonly manifestHostGrants = new Map<string, readonly string[]>()

  constructor(private readonly host: ApiHost) {}

  /**
   * The host patterns the platform folded into the engine's manifest to carry a runtime grant
   * (`extensionStore.grantedHostPermissions`): host permissions the manifest declared as optional,
   * not required. The engine reports them among `host_permissions` all the same, so `load` would
   * take them for required (unremovable) unless it is told; the service notes them before the
   * load. Set before an extension loads, cleared on unload.
   */
  noteManifestHostGrants(extensionId: string, folded: readonly string[]): void {
    if (folded.length === 0) this.manifestHostGrants.delete(extensionId)
    else this.manifestHostGrants.set(extensionId, [...folded])
  }

  /**
   * Called after a `request` or a `remove` moved an extension's host patterns, with the granted
   * origins as they stand (never for a move of API permissions alone). The service folds them
   * into the manifest the engine loads, which is where Chromium's own permission set –
   * the native `scripting.executeScript`, the content-script matcher – reads host access from.
   * Returns the unsubscribe.
   */
  onOriginsChanged(listener: HostOriginsListener): () => void {
    this.originListeners.add(listener)
    return () => {
      this.originListeners.delete(listener)
    }
  }

  readonly handlers: NamespaceHandlers = {
    getAll: (ctx) => this.getAll(ctx),
    contains: (ctx, permissions) => this.contains(ctx, permissions),
    request: (ctx, permissions) => this.request(ctx, permissions),
    remove: (ctx, permissions) => this.remove(ctx, permissions)
  }

  /**
   * An extension loaded: its granted set is what was stored plus whatever the manifest requires,
   * less what Chrome refuses to its manifest version (a grant stored before that rule, or before
   * an update changed the version, goes too). The manifest counts as declared: a permission the
   * host withheld from the engine's copy is required or optional here as the extension wrote it.
   */
  load(ext: LoadedExtension): void {
    const sets = reclassifyHostGrants(
      manifestPermissionSets(restoreWithheldPermissions(ext.manifest, ext.withheld)),
      this.manifestHostGrants.get(ext.id) ?? []
    )
    this.manifests.set(ext.id, sets)
    const stored = this.host.store.grants(ext.id)
    const merged = stored ? addPermissionSets(stored, sets.required) : { ...sets.required }
    const manifestVersion: 2 | 3 = ext.manifest.manifest_version === 2 ? 2 : 3
    const grants: PermissionSet = {
      // A withheld optional permission granted before it was withheld goes too: `request`
      // refuses it now, and the stored set should say the same.
      permissions: availablePermissions(merged.permissions, manifestVersion).filter(
        (p) => !isWithheldPermission(p) || sets.required.permissions.includes(p)
      ),
      origins: merged.origins
    }
    this.granted.set(ext.id, grants)
    if (!stored || grants.permissions.length !== merged.permissions.length)
      this.host.store.setGrants(ext.id, grants)
  }

  unload(extensionId: string): void {
    this.granted.delete(extensionId)
    this.manifests.delete(extensionId)
    this.manifestHostGrants.delete(extensionId)
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
    // A permission withheld from the engine cannot be granted: the answer is the user's "no",
    // without a prompt (Chrome grants or refuses a request whole, so the rest waits too).
    if (missing.permissions.some(isWithheldPermission)) return false
    const next = addPermissionSets(grants, missing)
    const warnings = addedWarnings(ctx.extension, grants, next)
    if (warnings.length > 0) {
      const accepted = await this.host.confirmPermissions(ctx.extensionId, warnings, ctx.window)
      if (!accepted) return false
    }
    this.granted.set(ctx.extensionId, next)
    this.host.store.setGrants(ctx.extensionId, next)
    this.pushGrants(ctx.extensionId, next)
    this.host.dispatch(ctx.extensionId, 'permissions', 'onAdded', [missing])
    if (missing.origins.length > 0) this.originsChanged(ctx.extensionId, next)
    return true
  }

  private originsChanged(extensionId: string, grants: PermissionSet): void {
    for (const listener of this.originListeners) listener(extensionId, [...grants.origins])
  }

  /**
   * The granted set moved: every context of the extension learns the new set at once
   * (`__zen.grants`), so the shim defines the namespaces a grant opens and deletes the ones a
   * removal closes, as Chrome's bindings do, listeners on `permissions.onAdded` or not.
   */
  private pushGrants(extensionId: string, grants: PermissionSet): void {
    const registry = this.host.registry
    const payload = { permissions: [...grants.permissions] }
    for (const context of [...registry.framesOf(extensionId), ...registry.workersOf(extensionId)]) {
      registry.sendTo(context, '__zen', 'grants', [payload])
    }
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
    this.pushGrants(ctx.extensionId, next)
    this.host.dispatch(ctx.extensionId, 'permissions', 'onRemoved', [removed])
    if (removed.origins.length > 0) this.originsChanged(ctx.extensionId, next)
    return true
  }
}

export type HostOriginsListener = (extensionId: string, origins: readonly string[]) => void

/**
 * The manifest sets with the platform's runtime host grants (`folded`) counted as optional, not
 * required: the origins the platform folded into the engine's `host_permissions` to carry a
 * `chrome.permissions` grant Chromium has no runtime API for. The engine reports them among the
 * required host permissions; here they are what they were declared as — optional and granted —
 * so `remove` lets the user take them back (a required permission cannot be removed) and
 * `request` still accepts them. Untouched when nothing was folded, or for an origin that was not
 * among the required set (a declared optional pattern needs no move).
 */
export function reclassifyHostGrants(
  sets: ManifestPermissionSets,
  folded: readonly string[]
): ManifestPermissionSets {
  if (folded.length === 0) return sets
  const move = sets.required.origins.filter((origin) => folded.includes(origin))
  if (move.length === 0) return sets
  return {
    required: {
      permissions: sets.required.permissions,
      origins: sets.required.origins.filter((origin) => !move.includes(origin))
    },
    optional: {
      permissions: sets.optional.permissions,
      origins: [...sets.optional.origins, ...move.filter((o) => !sets.optional.origins.includes(o))]
    }
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
