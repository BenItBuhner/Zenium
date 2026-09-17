import {
  type ManifestPermissionSets,
  type PermissionSet,
  addPermissionSets,
  manifestPermissionSets,
  missingPermissions,
  normalizePermissionSet,
  permissionSetContains,
  removePermissionSet,
  requestablePermissions
} from '../../../core/extensions/api/permissions'
import { matchesAnyPattern } from '../../../core/extensions/api/matchPattern'
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
 * permissions and persisted, with `request` going through the platform's native confirmation
 * until the toolbar has its own prompt.
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

  /** An extension loaded: its granted set is what was stored plus whatever the manifest requires. */
  load(ext: LoadedExtension): void {
    const sets = manifestPermissionSets(ext.manifest)
    this.manifests.set(ext.id, sets)
    const stored = this.host.store.grants(ext.id)
    const grants = stored ? addPermissionSets(stored, sets.required) : { ...sets.required }
    this.granted.set(ext.id, grants)
    if (!stored) this.host.store.setGrants(ext.id, grants)
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
    const lines = [
      ...missing.permissions.map((p) => `Use the "${p}" browser feature`),
      ...missing.origins.map((o) => `Read and change data on ${describeOrigin(o)}`)
    ]
    const accepted = await this.host.confirm(
      {
        message: `"${ctx.extension.manifest.name}" wants additional permissions`,
        detail: lines.join('\n'),
        okLabel: 'Allow'
      },
      ctx.window
    )
    if (!accepted) return false
    const next = addPermissionSets(grants, missing)
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

function describeOrigin(pattern: string): string {
  if (pattern === '<all_urls>' || pattern === '*://*/*') return 'all websites'
  const match = /^[^:]+:\/\/([^/]+)/.exec(pattern)
  if (!match) return pattern
  const host = match[1]
  return host.startsWith('*.') ? `${host.slice(2)} and its subdomains` : host
}
