import type { MenuItemTemplate, PageContextParams } from '../../../core/platform'
import type { ZenWindow } from '../../../core/window'
import type { Tab } from '../../../shared/types'
import {
  MenuError,
  MenuRegistry,
  actionMenuEntriesFor,
  hasLazyBackground,
  menuEntriesFor,
  normalizeCreateProperties,
  normalizeUpdateProperties,
  onClickData,
  type MenuClickContext,
  type MenuEntry,
  type MenuItemId
} from '../../../core/extensions/api/contextMenus'
import type { ActiveTabGrants } from './activeTab'
import {
  ApiError,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/**
 * `chrome.contextMenus`: one `MenuRegistry` per loaded extension, fed by the routed
 * `create` / `update` / `remove` / `removeAll` calls, and the two places the items surface:
 * the page context menu of a tab (Chrome's grouping: an extension with one matching top-level
 * item shows it directly, one with several gets a submenu titled with its name, both carrying
 * the extension icon) and the toolbar button's own menu. Clicks become `onClicked(info, tab)`
 * and grant `activeTab` like a toolbar click does.
 *
 * The items of an extension with a lazy background (MV3 worker, MV2 event page) are persisted
 * as Chrome's `MenuManager` persists them: written after every `create` / `update` / `remove` /
 * `removeAll` and after a checkbox or radio click, restored when the extension loads (before its
 * worker runs, so an `update` of an `onInstalled` item at a later start finds it, and a `create`
 * of the same id fails with the duplicate-id error, as in Chrome), kept while the extension is
 * unloaded or disabled, dropped with the rest of its records when it is uninstalled.
 */
export class ContextMenusApi {
  private readonly registries = new Map<string, MenuRegistry>()

  constructor(
    private readonly host: ApiHost,
    private readonly activeTab: ActiveTabGrants
  ) {}

  readonly handlers: NamespaceHandlers = {
    create: (ctx, props, generatedId) => this.create(ctx, props, generatedId),
    update: (ctx, id, props) => this.update(ctx, id, props),
    remove: (ctx, id) => this.remove(ctx, id),
    removeAll: (ctx) => this.removeAll(ctx)
  }

  private registry(extensionId: string): MenuRegistry {
    let registry = this.registries.get(extensionId)
    if (!registry) {
      registry = new MenuRegistry(extensionId)
      this.registries.set(extensionId, registry)
    }
    return registry
  }

  /** The extension loaded: its persisted items are back before its background runs. */
  load(ext: LoadedExtension): void {
    if (!hasLazyBackground(ext.manifest)) return
    const persisted = this.host.store.contextMenuItems(ext.id)
    if (!Array.isArray(persisted) || persisted.length === 0) return
    this.registry(ext.id).restore(persisted)
  }

  /** The extension unloaded: the in-memory items go, the persisted ones stay for the next load. */
  forget(extensionId: string): void {
    this.registries.delete(extensionId)
  }

  /** `MenuManager::WriteToStorage`: the whole tree, for lazy-background extensions only. */
  private persist(ext: LoadedExtension): void {
    if (!hasLazyBackground(ext.manifest)) return
    const registry = this.registries.get(ext.id)
    this.host.store.setContextMenuItems(ext.id, registry ? registry.toPersisted() : [])
  }

  // ---------------------------------------------------------------------------
  // Routed calls
  // ---------------------------------------------------------------------------

  /**
   * `generatedId` is the id the shim already returned to the caller when `createProperties.id`
   * was absent (Chrome numbers those per extension; the shim per context, which is the same
   * thing for the one background context that may omit ids).
   */
  private create(ctx: ApiContext, props: unknown, generatedId: unknown): MenuItemId {
    const background = ctx.extension.manifest.background
    const requiresId =
      ctx.sender.kind === 'worker' ||
      (ctx.extension.manifest.manifest_version === 2 &&
        background !== undefined &&
        background.persistent === false)
    try {
      const normalized = normalizeCreateProperties(props, { requiresId })
      if (normalized.id === undefined && isMenuItemId(generatedId)) normalized.id = generatedId
      const item = this.registry(ctx.extensionId).create(normalized)
      this.persist(ctx.extension)
      return item.id
    } catch (error) {
      throw toApiError(error)
    }
  }

  private update(ctx: ApiContext, id: unknown, props: unknown): void {
    if (!isMenuItemId(id)) throw new ApiError('Invalid menu item id')
    try {
      this.registry(ctx.extensionId).update(id, normalizeUpdateProperties(props))
      this.persist(ctx.extension)
    } catch (error) {
      throw toApiError(error)
    }
  }

  private remove(ctx: ApiContext, id: unknown): void {
    if (!isMenuItemId(id)) throw new ApiError('Invalid menu item id')
    try {
      this.registry(ctx.extensionId).remove(id)
      this.persist(ctx.extension)
    } catch (error) {
      throw toApiError(error)
    }
  }

  private removeAll(ctx: ApiContext): void {
    this.registry(ctx.extensionId).removeAll()
    this.persist(ctx.extension)
  }

  // ---------------------------------------------------------------------------
  // Menus
  // ---------------------------------------------------------------------------

  /** The extension section of a tab's page context menu, in Chrome's grouping, by extension name. */
  pageMenuItems(tab: Tab, params: PageContextParams): MenuItemTemplate[] {
    const click = clickContext(tab, params)
    const out: MenuItemTemplate[] = []
    for (const ext of this.sortedExtensions()) {
      const registry = this.registries.get(ext.id)
      if (!registry || registry.size === 0) continue
      const entries = menuEntriesFor(registry.all(), registry.topLevelIds(), click)
      if (entries.length === 0) continue
      const icon = this.iconOf(ext.id)
      const toTemplate = (entry: MenuEntry): MenuItemTemplate =>
        this.template(ext, entry, click, tab)
      if (entries.length === 1) {
        out.push({ ...toTemplate(entries[0]), icon })
        continue
      }
      out.push({
        label: ext.manifest.name ?? ext.id,
        icon,
        submenu: entries.map(toTemplate)
      })
    }
    return out
  }

  /** The items an extension adds to its own toolbar button's menu. */
  actionMenuItems(extensionId: string, win: ZenWindow): MenuItemTemplate[] {
    const ext = this.host.loaded(extensionId)
    const registry = this.registries.get(extensionId)
    if (!ext || !registry || registry.size === 0) return []
    const active = this.host.browser.tabs.activeTabFor(win)
    const click: MenuClickContext = {
      pageUrl: active?.url ?? '',
      frameUrl: '',
      frameId: 0,
      linkUrl: '',
      srcUrl: '',
      mediaType: 'none',
      selectionText: '',
      editable: false
    }
    const version = ext.manifest.manifest_version === 2 ? 2 : 3
    return actionMenuEntriesFor(registry.all(), registry.topLevelIds(), version).map((entry) =>
      this.template(ext, entry, click, active)
    )
  }

  private template(
    ext: LoadedExtension,
    entry: MenuEntry,
    click: MenuClickContext,
    tab: Tab | undefined
  ): MenuItemTemplate {
    const { item } = entry
    if (item.type === 'separator') return { type: 'separator' }
    const template: MenuItemTemplate = {
      type: item.type,
      label: entry.title,
      enabled: item.enabled
    }
    if (item.type === 'checkbox' || item.type === 'radio') template.checked = item.checked
    if (entry.children.length > 0) {
      template.submenu = entry.children.map((child) => this.template(ext, child, click, tab))
    } else {
      template.click = () => this.clicked(ext, item.id, click, tab)
    }
    return template
  }

  private clicked(
    ext: LoadedExtension,
    id: MenuItemId,
    click: MenuClickContext,
    tab: Tab | undefined
  ): void {
    const registry = this.registries.get(ext.id)
    const item = registry?.get(id)
    if (!registry || !item) return
    const checkState = registry.clicked(id)
    // A checkbox toggled or a radio picked is state Chrome writes (`MenuManager::ExecuteCommand`).
    if (item.type === 'checkbox' || item.type === 'radio') this.persist(ext)
    const info = onClickData(item, click, checkState)
    if (tab) this.activeTab.grant(ext.id, tab)
    const chromeTab = tab
      ? this.host.model.chromeTab(tab, this.host.canSeeTab(ext, tab.url))
      : undefined
    const args: unknown[] = chromeTab ? [info, chromeTab] : [info]
    this.host.dispatch(ext.id, 'contextMenus', 'onClicked', args, { wake: true })
  }

  private sortedExtensions(): LoadedExtension[] {
    return [...this.host.allLoaded()].sort((a, b) =>
      (a.manifest.name ?? a.id).localeCompare(b.manifest.name ?? b.id)
    )
  }

  private iconOf(extensionId: string): string | undefined {
    const info = this.host.browser.extensions.list().find((entry) => entry.id === extensionId)
    return info?.icon ?? undefined
  }
}

/** Chrome's view of a right-click from the engine's context menu parameters. */
export function clickContext(tab: Tab, params: PageContextParams): MenuClickContext {
  const mediaType =
    params.mediaType === 'image' || params.mediaType === 'video' || params.mediaType === 'audio'
      ? params.mediaType
      : 'none'
  const frameId = params.frameId ?? 0
  return {
    pageUrl: params.pageURL || tab.url,
    frameUrl: frameId !== 0 ? (params.frameURL ?? '') : '',
    frameId,
    linkUrl: params.linkURL,
    srcUrl: params.srcURL,
    mediaType,
    selectionText: params.selectionText,
    editable: params.isEditable
  }
}

function isMenuItemId(value: unknown): value is MenuItemId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
}

function toApiError(error: unknown): ApiError {
  if (error instanceof MenuError || error instanceof ApiError) return new ApiError(error.message)
  return new ApiError(error instanceof Error ? error.message : String(error))
}
