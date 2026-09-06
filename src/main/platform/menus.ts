import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { MenuHost, MenuItemTemplate } from '../../core/platform'

/**
 * Native popup menus. Zen (Firefox) uses native-styled menus everywhere, and native popups are
 * also the only thing that can draw above the tab views in Electron.
 */
export class ElectronMenus implements MenuHost {
  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /** Native menus always open at the cursor, so the anchor in the options is not needed. */
  popup(items: MenuItemTemplate[]): void {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    Menu.buildFromTemplate(items.map(toElectron)).popup({ window: win })
  }
}

function toElectron(item: MenuItemTemplate): MenuItemConstructorOptions {
  if (item.type === 'separator') return { type: 'separator' }
  const out: MenuItemConstructorOptions = {
    label: item.label,
    enabled: item.enabled,
    type: item.type === 'checkbox' ? 'checkbox' : 'normal'
  }
  if (item.type === 'checkbox') out.checked = item.checked
  if (item.role) out.role = item.role
  if (item.click) out.click = item.click
  if (item.submenu) out.submenu = item.submenu.map(toElectron)
  return out
}
