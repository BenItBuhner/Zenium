import type { MenuItemTemplate, PageContextParams } from '@core/platform'
import type { Tab } from '@shared/types'
import {
  MenuError,
  MenuRegistry,
  actionMenuEntriesFor,
  menuEntriesFor,
  normalizeCreateProperties,
  normalizeUpdateProperties,
  onClickData,
  type MenuClickContext,
  type MenuEntry,
  type MenuItemId
} from '@core/extensions/api/contextMenus'
import type { AttachedExtension } from './extensionApi'

/**
 * What the menus need from the runtime: the attached extensions, event delivery and the tab
 * objects Chrome hands to `onClicked`.
 */
export interface ContextMenusHost {
  attached(id: string): AttachedExtension | undefined
  allAttached(): AttachedExtension[]
  /** Raise `chrome.contextMenus.onClicked` in every listening endpoint (waking the background). */
  emit(extensionId: string, ns: string, name: string, args: unknown[]): void
  /**
   * Deliver an event to one endpoint whether or not it registered a listener: the context that
   * created an item with `onclick` runs that handler off the event (the shim keeps the function).
   */
  emitTo(endpointId: string, ns: string, name: string, args: unknown[]): void
  hasEndpoint(endpointId: string): boolean
  chromeTab(tab: Tab): Record<string, unknown>
  visibleTo(ext: AttachedExtension, tab: Tab): boolean
  /** The extension's toolbar icon as a `data:` URL, for the menu rows. */
  icon(extensionId: string): string | null
  /** The user picked an item of the extension on `tab`: an `activeTab` grant. */
  grantActiveTab(extensionId: string, tab: Tab): void
}

/**
 * `chrome.contextMenus` on Android: one shared `MenuRegistry` per extension, fed by the routed
 * `create` / `update` / `remove` / `removeAll` calls, surfacing in the long-press page menu of a
 * tab (a link or an image under the finger; the chrome renders the menu as a sheet) in Chrome's
 * grouping – an extension with one matching top-level item shows it directly, one with several
 * gets a submenu titled with its name, both with the extension's icon – and in the toolbar
 * button's own menu. A pick becomes `onClicked(info, tab)`, grants `activeTab` like a toolbar
 * click, and toggles checkbox and radio state as Chrome's `MenuManager` does.
 */
export class AndroidContextMenus {
  private readonly registries = new Map<string, MenuRegistry>()
  /** Items created with an `onclick` handler: item key → the endpoint holding the function. */
  private readonly clickHandlers = new Map<string, Map<string, string>>()

  constructor(private readonly host: ContextMenusHost) {}

  forget(extensionId: string): void {
    this.registries.delete(extensionId)
    this.clickHandlers.delete(extensionId)
  }

  /** The context that created `onclick` items went away: its handlers with it. */
  endpointGone(endpointId: string): void {
    for (const handlers of this.clickHandlers.values()) {
      for (const [key, ep] of handlers) if (ep === endpointId) handlers.delete(key)
    }
  }

  private registry(extensionId: string): MenuRegistry {
    let registry = this.registries.get(extensionId)
    if (!registry) {
      registry = new MenuRegistry(extensionId)
      this.registries.set(extensionId, registry)
    }
    return registry
  }

  /** How many items the extension holds (instrumentation). */
  size(extensionId: string): number {
    return this.registries.get(extensionId)?.size ?? 0
  }

  // ---------------------------------------------------------------------------
  // Routed calls
  // ---------------------------------------------------------------------------

  /**
   * `chrome.contextMenus.<method>` from `endpointId`. The shim answers `create`'s id itself and
   * sends `[properties, id]`, with `onclick: true` standing for a handler it kept.
   */
  call(ext: AttachedExtension, endpointId: string, method: string, args: unknown[]): unknown {
    const id = ext.record.id
    try {
      switch (method) {
        case 'create': {
          const props = args[0]
          const generated = args[1]
          const background = ext.manifest.background
          // Chrome rejects `onclick` where the handler could not outlive the page: MV3 workers
          // and MV2 event pages.
          const requiresId =
            background?.kind === 'service_worker' ||
            (ext.manifest.manifestVersion === 2 && background !== null && !background.persistent)
          const normalized = normalizeCreateProperties(props, { requiresId })
          if (normalized.id === undefined && isMenuItemId(generated)) normalized.id = generated
          const item = this.registry(id).create(normalized)
          if (isRecord(props) && props.onclick === true) {
            let handlers = this.clickHandlers.get(id)
            if (!handlers) {
              handlers = new Map()
              this.clickHandlers.set(id, handlers)
            }
            handlers.set(keyOf(item.id), endpointId)
          }
          return item.id
        }
        case 'update': {
          const menuId = args[0]
          if (!isMenuItemId(menuId)) throw new Error('Invalid menu item id')
          this.registry(id).update(menuId, normalizeUpdateProperties(args[1]))
          return undefined
        }
        case 'remove': {
          const menuId = args[0]
          if (!isMenuItemId(menuId)) throw new Error('Invalid menu item id')
          for (const removed of this.registry(id).remove(menuId))
            this.clickHandlers.get(id)?.delete(keyOf(removed))
          return undefined
        }
        case 'removeAll':
          this.registry(id).removeAll()
          this.clickHandlers.delete(id)
          return undefined
      }
    } catch (error) {
      if (error instanceof MenuError) throw new Error(error.message)
      throw error
    }
    throw new Error(`chrome.contextMenus.${method} is not implemented on Zenium for Android`)
  }

  // ---------------------------------------------------------------------------
  // Menus
  // ---------------------------------------------------------------------------

  /** The extension section of a tab's long-press menu, in Chrome's grouping, by extension name. */
  pageMenuItems(tab: Tab, params: PageContextParams): MenuItemTemplate[] {
    const click = clickContext(tab, params)
    const out: MenuItemTemplate[] = []
    for (const ext of this.sortedExtensions()) {
      if (!this.host.visibleTo(ext, tab)) continue
      const registry = this.registries.get(ext.record.id)
      if (!registry || registry.size === 0) continue
      const entries = menuEntriesFor(registry.all(), registry.topLevelIds(), click)
      if (entries.length === 0) continue
      const icon = this.host.icon(ext.record.id)
      const toTemplate = (entry: MenuEntry): MenuItemTemplate =>
        this.template(ext, entry, click, tab)
      if (entries.length === 1) {
        out.push({ ...toTemplate(entries[0]), icon })
        continue
      }
      out.push({
        label: ext.manifest.name || ext.record.id,
        icon,
        submenu: entries.map(toTemplate)
      })
    }
    return out
  }

  /** The items an extension adds to its own toolbar button's menu (`action` contexts). */
  actionMenuItems(extensionId: string, active: Tab | undefined): MenuItemTemplate[] {
    const ext = this.host.attached(extensionId)
    const registry = this.registries.get(extensionId)
    if (!ext || !registry || registry.size === 0) return []
    const tab = active && this.host.visibleTo(ext, active) ? active : undefined
    const click: MenuClickContext = {
      pageUrl: tab?.url ?? '',
      frameUrl: '',
      frameId: 0,
      linkUrl: '',
      srcUrl: '',
      mediaType: 'none',
      selectionText: '',
      editable: false
    }
    const version = ext.manifest.manifestVersion === 2 ? 2 : 3
    return actionMenuEntriesFor(registry.all(), registry.topLevelIds(), version).map((entry) =>
      this.template(ext, entry, click, tab)
    )
  }

  private template(
    ext: AttachedExtension,
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
      template.click = () => this.clicked(ext.record.id, item.id, click, tab)
    }
    return template
  }

  /** The user picked `id`: the check state moves, `onClicked` fires, the tab is granted. */
  clicked(
    extensionId: string,
    id: MenuItemId,
    click: MenuClickContext,
    tab: Tab | undefined
  ): void {
    const registry = this.registries.get(extensionId)
    const item = registry?.get(id)
    if (!registry || !item) return
    const checkState = registry.clicked(id)
    const info = onClickData(item, click, checkState)
    if (tab) this.host.grantActiveTab(extensionId, tab)
    const args: unknown[] = tab ? [info, this.host.chromeTab(tab)] : [info]
    this.host.emit(extensionId, 'contextMenus', 'onClicked', args)
    const holder = this.clickHandlers.get(extensionId)?.get(keyOf(id))
    if (holder && this.host.hasEndpoint(holder))
      this.host.emitTo(holder, 'contextMenus', 'onClicked', args)
  }

  private sortedExtensions(): AttachedExtension[] {
    return [...this.host.allAttached()].sort((a, b) =>
      (a.manifest.name || a.record.id).localeCompare(b.manifest.name || b.record.id)
    )
  }
}

/** Chrome's view of the long-press from the chrome's context-menu parameters. */
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

function keyOf(id: MenuItemId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`
}

function isMenuItemId(value: unknown): value is MenuItemId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
