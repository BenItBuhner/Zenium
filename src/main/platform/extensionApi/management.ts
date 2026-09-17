import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionInfo as ZeniumExtensionInfo } from '../../../shared/types'
import type { ExtensionManifest } from '../../../core/extensions/manifest'
import { idFromDigestPrefix } from '../../../core/extensions/bytes'
import { manifestPermissionSets } from '../../../core/extensions/api/permissions'
import {
  ApiError,
  extensionUrl,
  isRecord,
  type ApiContext,
  type ApiHost,
  type NamespaceHandlers
} from './types'

/** Chrome's `management.ExtensionInfo`. */
export interface ManagementInfo {
  id: string
  name: string
  shortName: string
  description: string
  version: string
  versionName?: string
  mayDisable: boolean
  mayEnable?: boolean
  enabled: boolean
  disabledReason?: 'unknown' | 'permissions_increase'
  isApp: boolean
  type: 'extension' | 'hosted_app' | 'packaged_app' | 'legacy_packaged_app' | 'theme'
  appLaunchUrl?: string
  homepageUrl?: string
  updateUrl?: string
  offlineEnabled: boolean
  optionsUrl: string
  icons?: Array<{ size: number; url: string }>
  permissions: string[]
  hostPermissions: string[]
  installType: 'admin' | 'development' | 'normal' | 'sideload' | 'other'
}

/**
 * `chrome.management` over the browser's extension list. `getSelf` stays native (it works);
 * enabling, disabling and removal go through `ExtensionService`, and the install / enable /
 * disable / uninstall events are broadcast to every other extension.
 */
export class ManagementApi {
  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    getAll: () => this.getAll(),
    get: (_ctx, id) => this.get(id),
    getSelf: (ctx) => this.get(ctx.extensionId),
    setEnabled: (ctx, id, enabled) => this.setEnabled(ctx, id, enabled),
    uninstall: (ctx, id, options) => this.uninstall(ctx, id, options, false),
    uninstallSelf: (ctx, options) => this.uninstall(ctx, ctx.extensionId, options, true),
    // Permission warning texts arrive with the store's `permissionMessages` module.
    getPermissionWarningsById: (_ctx, id) => {
      this.entry(id)
      return []
    },
    getPermissionWarningsByManifest: (_ctx, manifestStr) => {
      try {
        JSON.parse(String(manifestStr))
      } catch {
        throw new ApiError('Invalid manifest.')
      }
      return []
    },
    launchApp: (_ctx, id) => {
      throw new ApiError(`Extension ${String(id)} is not an app.`)
    },
    createAppShortcut: (_ctx, id) => {
      throw new ApiError(`Extension ${String(id)} is not an app.`)
    },
    setLaunchType: (_ctx, id) => {
      throw new ApiError(`Extension ${String(id)} is not an app.`)
    },
    generateAppForLink: () => {
      throw new ApiError('Not supported in Zenium.')
    }
  }

  // ---------------------------------------------------------------------------
  // Listing
  // ---------------------------------------------------------------------------

  private entries(): Array<{
    info: ZeniumExtensionInfo
    manifest: ExtensionManifest | null
    id: string
  }> {
    return this.host.browser.extensions.list().map((info) => {
      const loaded = this.host.allLoaded().find((e) => e.path === info.path)
      const manifest = loaded?.manifest ?? readManifest(info.path)
      const id = loaded?.id ?? (manifest ? extensionIdFor(info.path, manifest) : info.id)
      return { info, manifest, id }
    })
  }

  private entry(id: unknown): {
    info: ZeniumExtensionInfo
    manifest: ExtensionManifest | null
    id: string
  } {
    if (typeof id !== 'string') throw new ApiError('Invalid extension id')
    const entry = this.entries().find((e) => e.id === id || e.info.path === id)
    if (!entry) throw new ApiError(`Failed to find extension with id ${id}.`)
    return entry
  }

  private describe(entry: {
    info: ZeniumExtensionInfo
    manifest: ExtensionManifest | null
    id: string
  }): ManagementInfo {
    const { info, manifest, id } = entry
    const sets = manifest
      ? manifestPermissionSets(manifest)
      : { required: { permissions: [], origins: [] } }
    const optionsPage = manifest?.options_ui?.page ?? manifest?.options_page
    const icons = manifest?.icons
      ? Object.entries(manifest.icons)
          .map(([size, path]) => ({ size: Number(size), url: extensionUrl(id, path) }))
          .filter((icon) => Number.isFinite(icon.size))
          .sort((a, b) => a.size - b.size)
      : undefined
    return {
      id,
      name: info.name,
      shortName: manifest?.short_name ?? info.name,
      description: info.description,
      version: info.version,
      versionName: manifest?.version_name,
      mayDisable: true,
      mayEnable: info.error === null,
      enabled: info.enabled && info.error === null,
      isApp: false,
      type: 'extension',
      homepageUrl: manifest?.homepage_url,
      updateUrl: manifest?.update_url,
      offlineEnabled: manifest?.offline_enabled ?? false,
      optionsUrl: optionsPage ? extensionUrl(id, optionsPage) : '',
      icons,
      permissions: [...sets.required.permissions],
      hostPermissions: [...sets.required.origins],
      installType: manifest?.update_url ? 'normal' : 'development'
    }
  }

  private getAll(): ManagementInfo[] {
    return this.entries().map((entry) => this.describe(entry))
  }

  private get(id: unknown): ManagementInfo {
    return this.describe(this.entry(id))
  }

  /** Chrome's `ExtensionInfo` for an extension that is loaded right now. */
  infoFor(extensionId: string): ManagementInfo | null {
    const entry = this.entries().find((e) => e.id === extensionId)
    return entry ? this.describe(entry) : null
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  private async setEnabled(ctx: ApiContext, id: unknown, enabled: unknown): Promise<void> {
    const entry = this.entry(id)
    if (typeof enabled !== 'boolean') throw new ApiError('Invalid value for enabled')
    if (entry.id === ctx.extensionId && !enabled) {
      throw new ApiError('An extension cannot disable itself through the management API.')
    }
    await this.host.browser.extensions.setEnabled(entry.info.path, enabled)
  }

  private async uninstall(
    ctx: ApiContext,
    id: unknown,
    options: unknown,
    self: boolean
  ): Promise<void> {
    const entry = this.entry(id)
    const showDialog = !self || (isRecord(options) && options.showConfirmDialog === true)
    if (showDialog) {
      const accepted = await this.host.confirm(
        {
          message: `Remove "${entry.info.name}" from Zenium?`,
          detail: self
            ? 'The extension asked to remove itself.'
            : `"${ctx.extension.manifest.name}" asked to remove this extension.`,
          okLabel: 'Remove',
          danger: true
        },
        ctx.window
      )
      if (!accepted) throw new ApiError('The user did not accept the uninstall.')
    }
    this.host.browser.extensions.remove(entry.info.path)
  }
}

function readManifest(path: string): ExtensionManifest | null {
  try {
    return JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as ExtensionManifest
  } catch {
    return null
  }
}

/**
 * The id Chromium assigns: from the manifest's `key` when present, otherwise from the install
 * path (`crx_file::id_util::GenerateIdForPath`, which hashes the path's bytes).
 */
export function extensionIdFor(path: string, manifest: { key?: string }): string {
  const hash = createHash('sha256')
  if (typeof manifest.key === 'string' && manifest.key.length > 0) {
    hash.update(Buffer.from(manifest.key, 'base64'))
  } else {
    hash.update(Buffer.from(path, process.platform === 'win32' ? 'utf16le' : 'utf8'))
  }
  return idFromDigestPrefix(new Uint8Array(hash.digest()))
}
