import { Menu, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { MenuHost, MenuItemTemplate, MenuPopupOptions } from '../../core/platform'
import type { ElectronWindow } from './window'

/**
 * Native popup menus. Zen (Firefox) uses native-styled menus everywhere, and native popups are
 * also the only thing that can draw above the tab views in Electron.
 */
export class ElectronMenus implements MenuHost {
  /** Native menus always open at the cursor, so the anchor in the options is not needed. */
  popup(items: MenuItemTemplate[], options: MenuPopupOptions): void {
    const host = options.win.host as ElectronWindow | undefined
    if (!host?.alive) return
    Menu.buildFromTemplate(items.map(toElectron)).popup({ window: host.win })
  }
}

function toElectron(item: MenuItemTemplate): MenuItemConstructorOptions {
  if (item.type === 'separator') return { type: 'separator' }
  const out: MenuItemConstructorOptions = {
    label: item.label,
    enabled: item.enabled,
    type: item.type === 'checkbox' || item.type === 'radio' ? item.type : 'normal'
  }
  if (item.type === 'checkbox' || item.type === 'radio') out.checked = item.checked
  if (item.role) out.role = item.role
  if (item.click) out.click = item.click
  if (item.submenu) out.submenu = item.submenu.map(toElectron)
  const icon = item.icon ? menuIcon(item.icon) : null
  if (icon) out.icon = icon
  return out
}

/** Only inline (`data:`) favicons can be shown; remote ones would need a fetch first. */
function menuIcon(src: string): Electron.NativeImage | null {
  if (!src.startsWith('data:image/')) return null
  try {
    const image = nativeImage.createFromDataURL(src)
    return image.isEmpty() ? null : image.resize({ width: 16, height: 16 })
  } catch {
    return null
  }
}
