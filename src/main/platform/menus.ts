import { Menu, nativeImage, net, type MenuItemConstructorOptions } from 'electron'
import type { MenuHost, MenuItemTemplate, MenuPopupOptions } from '../../core/platform'
import type { ElectronWindow } from './window'

/** Longest a menu waits for uncached remote favicons before it opens without them. */
const ICON_FETCH_MS = 400
const ICON_CACHE_MAX = 200

/**
 * Native popup menus. Zen (Firefox) uses native-styled menus everywhere, and native popups are
 * also the only thing that can draw above the tab views in Electron.
 */
export class ElectronMenus implements MenuHost {
  /** Decoded favicons by URL (`null` = could not be fetched or decoded; not retried). */
  private readonly icons = new Map<string, Electron.NativeImage | null>()

  /** Native menus always open at the cursor, so the anchor in the options is not needed. */
  popup(items: MenuItemTemplate[], options: MenuPopupOptions): void {
    const host = options.win.host as ElectronWindow | undefined
    if (!host?.alive) return
    const show = (): void => {
      if (!host.alive) return
      Menu.buildFromTemplate(items.map((item) => this.toElectron(item))).popup({
        window: host.win
      })
    }
    const pending = [...remoteIcons(items)].filter((url) => !this.icons.has(url))
    if (pending.length === 0) {
      show()
      return
    }
    // Recently closed entries carry remote favicons: fetch what is missing (bounded), then open.
    void Promise.all(pending.map((url) => this.fetchIcon(url))).then(show)
  }

  private toElectron(item: MenuItemTemplate): MenuItemConstructorOptions {
    if (item.type === 'separator') return { type: 'separator' }
    const out: MenuItemConstructorOptions = {
      label: item.label,
      enabled: item.enabled,
      type: item.type === 'checkbox' || item.type === 'radio' ? item.type : 'normal'
    }
    if (item.type === 'checkbox' || item.type === 'radio') out.checked = item.checked
    if (item.role) out.role = item.role
    if (item.click) out.click = item.click
    if (item.submenu) out.submenu = item.submenu.map((sub) => this.toElectron(sub))
    const icon = item.icon ? this.icon(item.icon) : null
    if (icon) out.icon = icon
    return out
  }

  private icon(src: string): Electron.NativeImage | null {
    if (src.startsWith('data:image/')) return dataUrlIcon(src)
    return this.icons.get(src) ?? null
  }

  private async fetchIcon(url: string): Promise<void> {
    let image: Electron.NativeImage | null = null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ICON_FETCH_MS)
    try {
      const response = await net.fetch(url, { signal: controller.signal })
      if (response.ok) {
        const decoded = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()))
        image = decoded.isEmpty() ? null : decoded.resize({ width: 16, height: 16 })
      }
    } catch {
      image = null
    } finally {
      clearTimeout(timer)
    }
    if (this.icons.size >= ICON_CACHE_MAX) {
      const oldest = this.icons.keys().next().value
      if (oldest !== undefined) this.icons.delete(oldest)
    }
    this.icons.set(url, image)
  }
}

/** Every http(s) favicon referenced by a template, submenus included. */
function remoteIcons(items: MenuItemTemplate[], out = new Set<string>()): Set<string> {
  for (const item of items) {
    if (item.icon && /^https?:\/\//i.test(item.icon)) out.add(item.icon)
    if (item.submenu) remoteIcons(item.submenu, out)
  }
  return out
}

function dataUrlIcon(src: string): Electron.NativeImage | null {
  try {
    const image = nativeImage.createFromDataURL(src)
    return image.isEmpty() ? null : image.resize({ width: 16, height: 16 })
  } catch {
    return null
  }
}
