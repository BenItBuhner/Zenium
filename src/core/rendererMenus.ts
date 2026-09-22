import type { MenuDescriptor, MenuItemDescriptor } from '../shared/types'
import type { MenuHost, MenuItemTemplate, MenuPopupOptions } from './platform'
import type { ZenWindow } from './window'

/**
 * A menu template as the renderer can draw it: the items serialised to descriptors – each with
 * an id that stands for its `click` in `handlers` – so a pick reported back by id runs the
 * template's handler on this side. Shared by the renderer-drawn menus (`menu.show`) and the
 * extension action menu the phone's sheet asks for as data (`extension.actionMenuItems`).
 */
export function serialiseMenu(
  items: MenuItemTemplate[],
  prefix: string
): { items: MenuItemDescriptor[]; handlers: Map<string, () => void> } {
  const handlers = new Map<string, () => void>()
  let n = 0
  const serialise = (list: MenuItemTemplate[]): MenuItemDescriptor[] =>
    list.map((item) => {
      const itemId = `${prefix}_${++n}`
      if (item.click) handlers.set(itemId, item.click)
      return {
        id: itemId,
        type: item.type ?? 'normal',
        label: item.label ?? '',
        enabled: item.enabled ?? true,
        checked: Boolean(item.checked),
        icon: item.icon ?? null,
        submenu: item.submenu ? serialise(item.submenu) : null,
        // Only an icon-row item carries a glyph, only a bound action a chord, only an empty
        // state's sentence the note; every other descriptor keeps its shape.
        ...(item.glyph ? { glyph: item.glyph } : {}),
        ...(item.hint ? { hint: item.hint } : {}),
        ...(item.note ? { note: true } : {})
      }
    })
  return { items: serialise(items), handlers }
}

/**
 * A `MenuHost` for platforms without native popup menus: the template is serialised and shown
 * by the renderer (`menu.show`), which reports the picked item back through `menu.click`.
 */
export class RendererMenuHost implements MenuHost {
  private seq = 0
  private open: { id: string; win: ZenWindow; handlers: Map<string, () => void> } | null = null

  popup(items: MenuItemTemplate[], options: MenuPopupOptions): void {
    if (this.open) this.open.win.send('menu.hide', { menuId: this.open.id })
    const id = `menu_${++this.seq}`
    const { items: serialised, handlers } = serialiseMenu(items, id)
    const descriptor: MenuDescriptor = {
      id,
      items: serialised,
      source: options.source,
      x: options.x ?? null,
      y: options.y ?? null,
      ...(options.keyboard !== undefined ? { keyboard: options.keyboard } : {})
    }
    this.open = { id, win: options.win, handlers }
    options.win.send('menu.show', descriptor)
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
