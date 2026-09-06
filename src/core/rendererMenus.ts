import type { MenuDescriptor, MenuItemDescriptor } from '../shared/types'
import type { ChromeHost, MenuHost, MenuItemTemplate, MenuPopupOptions } from './platform'

/**
 * A `MenuHost` for platforms without native popup menus: the template is serialised and shown
 * by the renderer (`menu.show`), which reports the picked item back through `menu.click`.
 */
export class RendererMenuHost implements MenuHost {
  private seq = 0
  private open: { id: string; handlers: Map<string, () => void> } | null = null

  constructor(private readonly chrome: ChromeHost) {}

  popup(items: MenuItemTemplate[], options: MenuPopupOptions): void {
    if (this.open) this.chrome.send('menu.hide', { menuId: this.open.id })
    const id = `menu_${++this.seq}`
    const handlers = new Map<string, () => void>()
    let n = 0
    const serialise = (list: MenuItemTemplate[]): MenuItemDescriptor[] =>
      list.map((item) => {
        const itemId = `${id}_${++n}`
        if (item.click) handlers.set(itemId, item.click)
        return {
          id: itemId,
          type: item.type ?? 'normal',
          label: item.label ?? '',
          enabled: item.enabled ?? true,
          checked: Boolean(item.checked),
          submenu: item.submenu ? serialise(item.submenu) : null
        }
      })
    const descriptor: MenuDescriptor = {
      id,
      items: serialise(items),
      source: options.source,
      x: options.x ?? null,
      y: options.y ?? null
    }
    this.open = { id, handlers }
    this.chrome.send('menu.show', descriptor)
  }

  activate(menuId: string, itemId: string): void {
    if (!this.open || this.open.id !== menuId) return
    const handler = this.open.handlers.get(itemId)
    this.open = null
    handler?.()
  }

  dismiss(menuId: string): void {
    if (this.open?.id === menuId) this.open = null
  }
}
