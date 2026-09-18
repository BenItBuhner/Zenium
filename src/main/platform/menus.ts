import { Menu, nativeImage, net, type MenuItemConstructorOptions } from 'electron'
import type { MenuHost, MenuItemTemplate, MenuPopupOptions } from '../../core/platform'
import type { ElectronWindow } from './window'

/** Longest a menu waits for uncached remote favicons before it opens without them. */
const ICON_FETCH_MS = 400
const ICON_CACHE_MAX = 200

/**
 * Native popup menus. Zen (Firefox) uses native-styled menus everywhere, and native popups are
 * also the only thing that can draw above the tab views in Electron. On macOS the same
 * templates make the menu bar.
 */
export class ElectronMenus implements MenuHost {
  /** Decoded favicons by URL (`null` = could not be fetched or decoded; not retried). */
  private readonly icons = new Map<string, Electron.NativeImage | null>()

  /**
   * The menu bar. Only macOS has one worth the name (Windows and Linux windows are frameless
   * and the "⋯" menu stands in), so the method exists there alone and the core skips the work
   * elsewhere.
   */
  readonly setApplicationMenu?: (menus: MenuItemTemplate[]) => void

  constructor() {
    if (process.platform === 'darwin') {
      this.setApplicationMenu = (menus) =>
        Menu.setApplicationMenu(Menu.buildFromTemplate(menus.map((item) => this.toElectron(item))))
    }
  }

  /**
   * Opens at the pointer unless the core anchors the menu to a control (the "⋯" button). A menu
   * opened by the keyboard says so: Chromium then starts with its first item selected, and the
   * arrow keys and Escape work from there (Escape leaves the keyboard where it was, on the button).
   */
  popup(items: MenuItemTemplate[], options: MenuPopupOptions): void {
    const host = options.win.host as ElectronWindow | undefined
    if (!host?.alive) return
    const show = (): void => {
      if (!host.alive) return
      const popup: Electron.PopupOptions = { window: host.win }
      if (options.x !== undefined && options.y !== undefined) {
        popup.x = Math.round(options.x)
        popup.y = Math.round(options.y)
      }
      if (options.keyboard) popup.sourceType = 'keyboard'
      Menu.buildFromTemplate(items.map((item) => this.toElectron(item))).popup(popup)
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
    // An explicit `type: 'normal'` makes Electron ignore `submenu`: submenu items must say so.
    const out: MenuItemConstructorOptions = {
      label: item.label,
      enabled: item.enabled,
      type:
        item.type === 'checkbox' || item.type === 'radio'
          ? item.type
          : item.submenu
            ? 'submenu'
            : 'normal'
    }
    if (item.type === 'checkbox' || item.type === 'radio') out.checked = item.checked
    if (item.role) out.role = item.role
    if (item.click) out.click = item.click
    if (item.accelerator) {
      // The chord is a hint: Zenium's own key table runs the shortcut (and the user can rebind
      // it), so the system must not also fire the item. Roles keep their registered chords –
      // Cmd+C and friends only work through them on macOS.
      out.accelerator = item.accelerator
      out.registerAccelerator = false
    }
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
