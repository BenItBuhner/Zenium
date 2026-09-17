import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionInfo as ZeniumExtensionInfo, ExtensionSource } from '../../../shared/types'
import { stripJsonComments, type ExtensionManifest } from '../../../core/extensions/manifest'
import { permissionWarningLines } from '../../../core/extensions/permissionMessages'
import { warningPlatform } from '../extensions'
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
 * `chrome.management` over the browser's extension registry. `getSelf` stays native (it works);
 * enabling, disabling and removal go through `ExtensionService`, the warning texts come from the
 * store core's `permissionMessages`, and the install / enable / disable / uninstall events are
 * broadcast to every other extension.
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
    getPermissionWarningsById: (_ctx, id) => this.entry(id).info.warnings,
    getPermissionWarningsByManifest: (_ctx, manifestStr) => {
      let manifest: unknown
      try {
        manifest = JSON.parse(stripJsonComments(String(manifestStr)))
      } catch {
        throw new ApiError('Invalid manifest.')
      }
      if (!isRecord(manifest)) throw new ApiError('Invalid manifest.')
      return permissionWarningLines(manifest, warningPlatform())
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

  /** The registry keeps Chromium's id for every extension, loaded or not. */
  private entries(): Array<{
    info: ZeniumExtensionInfo
    manifest: ExtensionManifest | null
    id: string
  }> {
    return this.host.browser.extensions.list().map((info) => {
      const loaded = this.host.loaded(info.id)
      const manifest = loaded?.manifest ?? readManifest(info.path)
      return { info, manifest, id: info.id }
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
      disabledReason: info.enabled
        ? undefined
        : info.pendingWarnings && info.pendingWarnings.length > 0
          ? 'permissions_increase'
          : 'unknown',
      isApp: false,
      type: 'extension',
      homepageUrl: manifest?.homepage_url,
      updateUrl: info.updateUrl ?? manifest?.update_url,
      offlineEnabled: manifest?.offline_enabled ?? false,
      optionsUrl: info.optionsPage ? extensionUrl(id, info.optionsPage) : '',
      icons,
      permissions: [...info.permissions],
      hostPermissions: [...info.hostPermissions],
      installType: installTypeOf(info.source)
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
    await this.host.browser.extensions.setEnabled(entry.id, enabled, ctx.window)
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
    await this.host.browser.extensions.remove(entry.id)
  }
}

function readManifest(path: string): ExtensionManifest | null {
  try {
    return JSON.parse(
      stripJsonComments(readFileSync(join(path, 'manifest.json'), 'utf8'))
    ) as ExtensionManifest
  } catch {
    return null
  }
}

/** Chrome's `installType` for where the extension came from. */
function installTypeOf(source: ExtensionSource): ManagementInfo['installType'] {
  switch (source) {
    case 'chrome-web-store':
    case 'edge-add-ons':
      return 'normal'
    case 'crx':
    case 'zip':
      return 'sideload'
    case 'unpacked':
      return 'development'
    default:
      return 'other'
  }
}
