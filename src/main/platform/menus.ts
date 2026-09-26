import { Menu, nativeImage, net, type MenuItemConstructorOptions } from 'electron'
import type { MenuHost, MenuItemTemplate, MenuPopupOptions } from '../../core/platform'
import { RendererMenuHost } from '../../core/rendererMenus'
import { withMnemonics } from './menuMnemonics'
import { popupPoint } from './menuPlacement'
import type { ElectronWindow } from './window'

/** Longest a menu waits for uncached remote favicons before it opens without them. */
const ICON_FETCH_MS = 400
const ICON_CACHE_MAX = 200

/**
 * The desktop's menus. The context menus (page, link, selection, tab, the sidebar's rows) are
 * native popups, as Zen (Firefox) draws them, and the only thing that can draw above the tab
 * views in Electron. The "⋯" app menu is not: it is Zenium's in-chrome panel on every desktop –
 * Firefox's, not the OS's menu (design language v2 §6 "Menus") – drawn by the renderer from the
 * same template through `RendererMenuHost` (`menu.show`, picks back through `menu.click`), over a
 * picture of the page as the chrome's other popovers stand. On macOS the same templates make
 * the menu bar.
 */
export class ElectronMenus implements MenuHost {
  /** Decoded favicons by URL (`null` = could not be fetched or decoded; not retried). */
  private readonly icons = new Map<string, Electron.NativeImage | null>()

  /** The renderer-drawn menus: the app menu (`source: 'app'`), the browser window's and a web app window's alike. */
  private readonly inChrome = new RendererMenuHost()

  /** Which `setApplicationMenu` is the latest: an older one's favicons, landing late, set nothing. */
  private applicationMenuGeneration = 0

  /**
   * The menu bar. Only macOS has one worth the name (Windows and Linux windows are frameless
   * and the "⋯" menu stands in), so the method exists there alone and the core skips the work
   * elsewhere.
   */
  readonly setApplicationMenu?: (menus: MenuItemTemplate[]) => void

  constructor() {
    if (process.platform === 'darwin') {
      this.setApplicationMenu = (menus) => this.applyApplicationMenu(menus)
    }
  }

  /**
   * The bar is set at once, so a state change never shows late in it; the favicons its rows
   * carry that the cache lacks – History › Recently Visited's, which history keeps as http(s)
   * addresses (shortcuts-menus-157) – are fetched behind it, bounded as `popup()`'s are, and
   * the bar set again once they are in: Chrome's picture, every row with its favicon, rather
   * than the scatter a cache filled only by the context menus' popups would give. A bar set
   * meanwhile supersedes this one, and a fetch that brought nothing sets nothing again.
   */
  private applyApplicationMenu(menus: MenuItemTemplate[]): void {
    const generation = ++this.applicationMenuGeneration
    const set = (): void => Menu.setApplicationMenu(Menu.buildFromTemplate(this.template(menus)))
    set()
    const pending = [...remoteIcons(menus)].filter((url) => !this.icons.has(url))
    if (pending.length === 0) return
    void Promise.all(pending.map((url) => this.fetchIcon(url))).then(() => {
      if (generation !== this.applicationMenuGeneration) return
      if (pending.some((url) => this.icons.get(url))) set()
    })
  }

  /**
   * The app menu goes to the renderer, which hangs it from the "⋯" button it finds on screen
   * (end-aligned under its bar, §9.20) and starts on its first row when the keyboard asked. A
   * native menu opens at the pointer unless the core anchors it – to a point, or to the element
   * it belongs to, whose bottom-left corner it hangs from (`popupPoint`, §9.23); opened by the
   * keyboard it says so: Chromium then starts with its first item selected, and the arrow keys
   * and Escape work from there. The menu never takes the chrome document's focus – a views menu
   * runs in its own popup widget over the still-active window – so the element that opened it
   * has the keyboard back the moment it closes.
   */
  popup(items: MenuItemTemplate[], options: MenuPopupOptions): void {
    if (options.source === 'app') {
      this.inChrome.popup(items, options)
      return
    }
    const host = options.win.host as ElectronWindow | undefined
    if (!host?.alive) return
    const show = (): void => {
      if (!host.alive) return
      const popup: Electron.PopupOptions = { window: host.win }
      const point = popupPoint(options, host.contentSize())
      if (point) {
        popup.x = point.x
        popup.y = point.y
      }
      if (options.keyboard) popup.sourceType = 'keyboard'
      Menu.buildFromTemplate(this.template(items)).popup(popup)
    }
    const pending = [...remoteIcons(items)].filter((url) => !this.icons.has(url))
    if (pending.length === 0) {
      show()
      return
    }
    // Recently closed entries carry remote favicons: fetch what is missing (bounded), then open.
    void Promise.all(pending.map((url) => this.fetchIcon(url))).then(show)
  }

  /** A pick in the renderer-drawn menu runs the template's handler on this side. */
  activate(menuId: string, itemId: string): void {
    this.inChrome.activate(menuId, itemId)
  }

  /** The renderer closed its menu without a pick. */
  dismiss(menuId: string): void {
    this.inChrome.dismiss(menuId)
  }

  /**
   * Electron's template for the core's: the labels marked with their Alt mnemonics on Windows
   * and Linux (`&` escaped everywhere, see `menuMnemonics.ts`), then each item converted.
   */
  private template(items: MenuItemTemplate[]): MenuItemConstructorOptions[] {
    return withMnemonics(items, process.platform).map((item) => this.toElectron(item))
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
    if (item.click) {
      const click = item.click
      // The modifiers held on the pick go with it (a stack row's Ctrl+click / ⌘+click opens
      // the entry in a new tab).
      out.click = (_item, _window, event) =>
        click({
          control: Boolean(event?.ctrlKey),
          meta: Boolean(event?.metaKey),
          shift: Boolean(event?.shiftKey),
          alt: Boolean(event?.altKey)
        })
    }
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
        image = menuIcon(nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer())))
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
    return menuIcon(nativeImage.createFromDataURL(src))
  } catch {
    return null
  }
}

/**
 * A picture as a menu item's 16 × 16 icon. A favicon is square already; the app menu's "Now
 * playing…" row leads with a media session's artwork, which is often 16:9 or 1200 × 630 – that
 * is cropped to its centre square first, as the media hub's tile covers it (`object-fit: cover`),
 * rather than squashed to fit.
 */
function menuIcon(image: Electron.NativeImage): Electron.NativeImage | null {
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const side = Math.min(width, height)
  const square =
    width === height
      ? image
      : image.crop({
          x: Math.floor((width - side) / 2),
          y: Math.floor((height - side) / 2),
          width: side,
          height: side
        })
  return square.resize({ width: 16, height: 16 })
}
