import type {
  NewTabBackgroundKind,
  NewTabPageAction,
  NewTabPageShortcut,
  NewTabPageState,
  NewTabShortcutsMode,
  TopSite
} from './types'
import { NEW_TAB_ICONS, newTabIconSvg, type NewTabIcon } from './newTabPage'
import { SPRING_SNAPPY, stepSpring, type SpringState } from './spring'
import { getHost, inputToUrl } from './url'

/**
 * Runs inside `zen://newtab` (the host's preload supplies the transport). The page is filled
 * from `NewTabPageState`: theme, search box hand-off, the shortcuts grid (most visited or
 * custom, with add/edit dialogs, remove with Undo and drag-reorder on the design-language spring),
 * the Customize panel and the keyboard. Nothing here touches browser state directly: every wish
 * is a `NewTabPageAction`, and the answer arrives as the next state.
 */
export interface NewTabTransport {
  /** The state to paint first, fetched synchronously before the document renders (null when unknown). */
  initialState(): NewTabPageState | null
  onState(listener: (state: NewTabPageState) => void): void
  send(action: NewTabPageAction): void
}

/** Distance (px) a press travels before it is a drag rather than a click. */
const DRAG_THRESHOLD = 4
/** Half the grid gap: the caret sits in the middle of the gap before the drop slot. */
const HALF_GAP = 6
const UNDO_MS = 8000
const PRIVATE_ACCENT = '#a98bff'
const PRIVATE_ACCENT_RGB = '169 139 255'
const SOLID_LIGHT = '#fbfbfe'
const SOLID_DARK = '#1c1b22'

export function installNewTabPage(transport: NewTabTransport): void {
  const boot = (): void => {
    new NewTabPage(transport)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else boot()
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function icon(name: NewTabIcon): SVGSVGElement {
  const wrap = el('span')
  wrap.innerHTML = newTabIconSvg(name)
  return wrap.firstElementChild as SVGSVGElement
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`zen://newtab: missing #${id}`)
  return node as T
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}

interface Tile {
  id: string
  url: string
  title: string
  favicon: string | null
}

interface Removed {
  tile: Tile
  index: number
  custom: boolean
}

interface Drag {
  pointerId: number
  tile: HTMLElement
  link: HTMLElement
  id: string
  startX: number
  startY: number
  dx: number
  dy: number
  /** Last pointer position and time, for the release velocity. */
  lastX: number
  lastY: number
  lastT: number
  vx: number
  vy: number
  active: boolean
  ids: string[]
  slots: DOMRect[]
  from: number
  to: number
  /** Per neighbour: its current translate, springing towards its slot in the new order. */
  offsets: Map<string, { x: SpringState; y: SpringState; tx: number; ty: number }>
  caret: { x: SpringState; y: SpringState; tx: number; ty: number; el: HTMLElement }
  /** After release: the lifted tile springs into its slot, then the order is committed. */
  settling: { x: SpringState; y: SpringState; tx: number; ty: number } | null
  frame: number | null
  lastFrame: number
}

class NewTabPage {
  private state: NewTabPageState | null = null
  private readonly root = document.documentElement
  private readonly body = document.body
  private readonly bgCurrent = byId<HTMLDivElement>('zen-bg-current')
  private readonly bgNext = byId<HTMLDivElement>('zen-bg-next')
  private readonly privateLabel = byId<HTMLDivElement>('zen-private')
  private readonly greeting = byId<HTMLHeadingElement>('zen-greeting')
  private readonly search = byId<HTMLFormElement>('zen-search')
  private readonly input = byId<HTMLInputElement>('zen-search-input')
  private readonly empty = byId<HTMLParagraphElement>('zen-empty')
  private readonly grid = byId<HTMLDivElement>('zen-grid')
  private readonly customize = byId<HTMLButtonElement>('zen-customize')
  private readonly panel = byId<HTMLDivElement>('zen-panel')
  private readonly menu = byId<HTMLDivElement>('zen-menu')
  private readonly dialog = byId<HTMLDialogElement>('zen-dialog')
  private readonly toast = byId<HTMLDivElement>('zen-toast')
  private readonly systemDark = window.matchMedia('(prefers-color-scheme: dark)')

  private currentBackground: string | null = null
  private fadeTimer: ReturnType<typeof setTimeout> | null = null
  private tiles: Tile[] = []
  private custom = false
  private focusIndex = 0
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private pendingUndo: Removed | null = null
  private drag: Drag | null = null
  private suppressClick = false
  private greetingTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly transport: NewTabTransport) {
    this.wireSearch()
    this.wireGrid()
    this.wireCustomize()
    this.wireGlobalKeys()
    this.systemDark.addEventListener('change', () => this.applyTheme())
    transport.onState((state) => this.apply(state))
    const initial = transport.initialState()
    if (initial) this.apply(initial)
    transport.send({ type: 'ready' })
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  private apply(state: NewTabPageState): void {
    this.state = state
    this.applyTheme()
    this.privateLabel.hidden = !state.isPrivate
    this.applyGreeting()
    this.custom = state.shortcutsMode === 'custom'
    this.tiles =
      state.shortcutsMode === 'custom'
        ? state.shortcuts.map(fromShortcut)
        : state.shortcutsMode === 'most-visited'
          ? state.topSites.map(fromTopSite)
          : []
    if (!this.drag) this.renderGrid()
    if (!this.panel.hidden) this.renderPanel()
  }

  private isDark(): boolean {
    const state = this.state
    if (!state) return this.systemDark.matches
    return state.colorScheme === 'system' ? this.systemDark.matches : state.colorScheme === 'dark'
  }

  private applyTheme(): void {
    const state = this.state
    if (!state) return
    const variant = this.isDark() ? state.dark : state.light
    for (const [key, value] of Object.entries(variant.vars)) this.root.style.setProperty(key, value)
    if (state.isPrivate) {
      this.root.style.setProperty('--zen-accent', PRIVATE_ACCENT)
      this.root.style.setProperty('--zen-accent-rgb', PRIVATE_ACCENT_RGB)
    }
    this.root.dataset.theme = variant.isDark ? 'dark' : 'light'
    this.body.dataset.bg = state.background
    this.setBackground(this.backgroundValue(state, variant.vars, variant.isDark))
  }

  private backgroundValue(
    state: NewTabPageState,
    vars: Record<string, string>,
    dark: boolean
  ): string {
    if (state.background === 'image' && state.backgroundImage)
      return `url("${state.backgroundImage.replace(/"/g, '%22')}") center / cover no-repeat`
    if (state.background === 'solid') return dark ? SOLID_DARK : SOLID_LIGHT
    return vars['--zen-bg'] ?? (dark ? SOLID_DARK : SOLID_LIGHT)
  }

  /** The next background fades in over the current one (600 ms, like the chrome recolouring). */
  private setBackground(value: string): void {
    if (value === this.currentBackground) return
    const previous = this.currentBackground
    this.currentBackground = value
    if (previous === null || reducedMotion()) {
      this.bgCurrent.style.background = value
      return
    }
    // A fade still running is finished on the spot before the new one starts.
    if (this.fadeTimer !== null) this.finishFade()
    this.bgNext.style.background = value
    // Two frames: the layer must paint its new background at opacity 0 before fading in.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.currentBackground !== value) return
        this.bgNext.dataset.fading = ''
        this.fadeTimer = setTimeout(() => this.finishFade(), 650)
      })
    })
  }

  private finishFade(): void {
    if (this.fadeTimer !== null) clearTimeout(this.fadeTimer)
    this.fadeTimer = null
    this.bgCurrent.style.background = this.bgNext.style.background
    this.bgNext.style.transition = 'none'
    delete this.bgNext.dataset.fading
    // Reflow so the opacity drops without animating, then restore the transition.
    void this.bgNext.offsetWidth
    this.bgNext.style.transition = ''
  }

  private applyGreeting(): void {
    const on = Boolean(this.state?.greeting)
    this.greeting.hidden = !on
    if (on) {
      this.greeting.textContent = greetingFor(new Date().getHours())
      if (this.greetingTimer === null)
        this.greetingTimer = setInterval(() => this.applyGreeting(), 60_000)
    } else if (this.greetingTimer !== null) {
      clearInterval(this.greetingTimer)
      this.greetingTimer = null
    }
  }

  // ---------------------------------------------------------------------------
  // Search box: focus and the first character go to the real omnibox
  // ---------------------------------------------------------------------------

  private wireSearch(): void {
    this.search.addEventListener('submit', (e) => {
      e.preventDefault()
      this.handOff(this.input.value)
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.handOff(this.input.value)
        return
      }
      if (isTypedCharacter(e)) {
        e.preventDefault()
        this.handOff(e.key)
      }
    })
    this.input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      e.preventDefault()
      this.handOff(text)
    })
    // A click (not a focus: focus comes back to the field when the omnibox closes).
    this.search.addEventListener('click', () => this.handOff(''))
  }

  private handOff(text: string): void {
    this.input.value = ''
    this.transport.send({ type: 'search', text: text.slice(0, 199) })
  }

  /** Typing anywhere on the page (not in a control) also goes to the omnibox. */
  private wireGlobalKeys(): void {
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.dialog.open || !this.menu.hidden || !this.panel.hidden || this.drag) return
        const target = e.target as HTMLElement | null
        if (target === this.input) return
        const tag = target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return
        if (!isTypedCharacter(e)) return
        e.preventDefault()
        this.handOff(e.key)
      },
      true
    )
  }

  // ---------------------------------------------------------------------------
  // Grid
  // ---------------------------------------------------------------------------

  private wireGrid(): void {
    this.grid.addEventListener('keydown', (e) => this.onGridKey(e))
    this.grid.addEventListener('focusin', (e) => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>('.zen-tile')
      if (!tile) return
      const index = this.tileElements().indexOf(tile)
      if (index >= 0) this.setFocusIndex(index, false)
    })
    this.grid.addEventListener('contextmenu', (e) => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>('.zen-tile')
      const id = tile?.dataset.id
      if (!tile || !id) return
      e.preventDefault()
      const item = this.tiles.find((t) => t.id === id)
      if (!item) return
      // Keyboard (Shift+F10, the Menu key): anchor to the tile rather than the pointer.
      const fromKeyboard = e.button === 0 && e.clientX === 0 && e.clientY === 0
      const rect = tile.getBoundingClientRect()
      this.openMenu(
        item,
        tile,
        fromKeyboard ? rect.left + 12 : e.clientX,
        fromKeyboard ? rect.top + 12 : e.clientY
      )
    })
    this.grid.addEventListener('click', (e) => {
      if (!this.suppressClick) return
      e.preventDefault()
      e.stopPropagation()
      this.suppressClick = false
    })
    this.grid.addEventListener('pointerdown', (e) => this.onPointerDown(e))
    this.grid.addEventListener('pointermove', (e) => this.onPointerMove(e))
    this.grid.addEventListener('pointerup', (e) => this.onPointerUp(e, false))
    this.grid.addEventListener('pointercancel', (e) => this.onPointerUp(e, true))
  }

  private tileElements(): HTMLElement[] {
    return [...this.grid.querySelectorAll<HTMLElement>('.zen-tile')]
  }

  private renderGrid(): void {
    const state = this.state
    const mode: NewTabShortcutsMode = state?.shortcutsMode ?? 'hidden'
    const showGrid = mode === 'custom' || (mode === 'most-visited' && this.tiles.length > 0)
    this.empty.hidden = !(mode === 'most-visited' && this.tiles.length === 0)
    this.grid.hidden = !showGrid
    this.grid.textContent = ''
    if (!showGrid) return
    for (const tile of this.tiles) this.grid.appendChild(this.renderTile(tile))
    if (this.custom && this.tiles.length < 10) this.grid.appendChild(this.renderAddTile())
    const count = this.tileElements().length
    if (this.focusIndex >= count) this.focusIndex = Math.max(0, count - 1)
    this.applyTabStops()
  }

  private renderTile(tile: Tile): HTMLElement {
    const wrap = el('div', 'zen-tile')
    wrap.dataset.id = tile.id
    wrap.setAttribute('role', 'listitem')
    const link = el('a', 'zen-tile-link')
    link.href = tile.url
    link.title = tile.url
    link.draggable = false
    const iconBox = el('span', 'zen-tile-icon')
    if (tile.favicon) {
      const img = el('img')
      img.src = tile.favicon
      img.alt = ''
      img.draggable = false
      img.referrerPolicy = 'no-referrer'
      img.addEventListener('error', () => {
        img.replaceWith(letterFor(tile))
      })
      iconBox.appendChild(img)
    } else iconBox.appendChild(letterFor(tile))
    link.appendChild(iconBox)
    link.appendChild(el('span', 'zen-tile-label', tile.title))
    wrap.appendChild(link)
    const more = el('button', 'zen-tile-menu')
    more.type = 'button'
    more.tabIndex = -1
    more.setAttribute('aria-label', `More options for ${tile.title}`)
    more.setAttribute('aria-haspopup', 'menu')
    more.appendChild(icon('more'))
    more.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const rect = more.getBoundingClientRect()
      this.openMenu(tile, wrap, rect.left, rect.bottom + 4)
    })
    more.addEventListener('pointerdown', (e) => e.stopPropagation())
    wrap.appendChild(more)
    return wrap
  }

  private renderAddTile(): HTMLElement {
    const wrap = el('div', 'zen-tile')
    wrap.setAttribute('role', 'listitem')
    const button = el('button', 'zen-tile-link zen-tile-add')
    button.type = 'button'
    const iconBox = el('span', 'zen-tile-icon')
    iconBox.appendChild(icon('plus'))
    button.appendChild(iconBox)
    button.appendChild(el('span', 'zen-tile-label', 'Add shortcut'))
    button.addEventListener('click', () => this.openDialog(null))
    wrap.appendChild(button)
    return wrap
  }

  private applyTabStops(): void {
    this.tileElements().forEach((tile, i) => {
      const control = tile.querySelector<HTMLElement>('.zen-tile-link')
      if (control) control.tabIndex = i === this.focusIndex ? 0 : -1
    })
  }

  private setFocusIndex(index: number, focus: boolean): void {
    const tiles = this.tileElements()
    if (tiles.length === 0) return
    this.focusIndex = Math.max(0, Math.min(tiles.length - 1, index))
    this.applyTabStops()
    if (focus) tiles[this.focusIndex].querySelector<HTMLElement>('.zen-tile-link')?.focus()
  }

  private columns(): number {
    const tiles = this.tileElements()
    if (tiles.length === 0) return 1
    const top = tiles[0].offsetTop
    let n = 0
    for (const t of tiles) {
      if (t.offsetTop !== top) break
      n += 1
    }
    return Math.max(1, n)
  }

  private onGridKey(e: KeyboardEvent): void {
    const tiles = this.tileElements()
    if (tiles.length === 0 || e.ctrlKey || e.altKey || e.metaKey) return
    const cols = this.columns()
    let next: number | null = null
    switch (e.key) {
      case 'ArrowRight':
        next = this.focusIndex + 1
        break
      case 'ArrowLeft':
        next = this.focusIndex - 1
        break
      case 'ArrowDown':
        next = this.focusIndex + cols
        break
      case 'ArrowUp':
        next = this.focusIndex - cols
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = tiles.length - 1
        break
      case 'Delete':
      case 'Backspace': {
        const id = tiles[this.focusIndex]?.dataset.id
        const tile = id ? this.tiles.find((t) => t.id === id) : undefined
        if (!tile) return
        e.preventDefault()
        this.remove(tile)
        return
      }
      default:
        return
    }
    if (next === null || next < 0 || next >= tiles.length) return
    e.preventDefault()
    this.setFocusIndex(next, true)
  }

  // ---------------------------------------------------------------------------
  // Tile menu, removal and Undo
  // ---------------------------------------------------------------------------

  private openMenu(tile: Tile, anchor: HTMLElement, x: number, y: number): void {
    this.closeMenu()
    this.menu.textContent = ''
    const items: Array<{ label: string; glyph: NewTabIcon; run: () => void }> = []
    if (this.custom)
      items.push({ label: 'Edit shortcut', glyph: 'pencil', run: () => this.openDialog(tile) })
    items.push({ label: 'Remove', glyph: 'trash', run: () => this.remove(tile) })
    for (const item of items) {
      const button = el('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.appendChild(icon(item.glyph))
      button.appendChild(el('span', undefined, item.label))
      button.addEventListener('click', () => {
        this.closeMenu()
        item.run()
      })
      this.menu.appendChild(button)
    }
    anchor.querySelector('.zen-tile-menu')?.setAttribute('aria-expanded', 'true')
    this.menu.hidden = false
    const width = this.menu.offsetWidth
    const height = this.menu.offsetHeight
    this.menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, x))}px`
    this.menu.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, y))}px`
    this.menu.querySelector<HTMLElement>('button')?.focus()
    const onDown = (e: PointerEvent): void => {
      if (!this.menu.contains(e.target as Node)) this.closeMenu()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closeMenu()
        anchor.querySelector<HTMLElement>('.zen-tile-link')?.focus()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const buttons = [...this.menu.querySelectorAll<HTMLElement>('button')]
        const index = buttons.indexOf(document.activeElement as HTMLElement)
        const next = (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    this.menuCleanup = () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }

  private menuCleanup: (() => void) | null = null

  private closeMenu(): void {
    if (this.menu.hidden) return
    this.menu.hidden = true
    this.menuCleanup?.()
    this.menuCleanup = null
    for (const b of this.grid.querySelectorAll('.zen-tile-menu[aria-expanded]'))
      b.removeAttribute('aria-expanded')
  }

  private remove(tile: Tile): void {
    const index = this.tiles.findIndex((t) => t.id === tile.id)
    if (index < 0) return
    this.tiles.splice(index, 1)
    this.renderGrid()
    this.setFocusIndex(Math.min(index, this.tileElements().length - 1), true)
    if (this.custom) this.transport.send({ type: 'remove-shortcut', id: tile.id })
    else this.transport.send({ type: 'hide-site', url: tile.url })
    this.showUndo({ tile, index, custom: this.custom })
  }

  private showUndo(removed: Removed): void {
    this.pendingUndo = removed
    this.toast.textContent = ''
    this.toast.appendChild(
      el('span', undefined, removed.custom ? 'Shortcut removed' : 'Site removed')
    )
    const undo = el('button', 'zen-btn', 'Undo')
    undo.type = 'button'
    undo.addEventListener('click', () => this.undo())
    this.toast.appendChild(undo)
    this.toast.hidden = false
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => this.hideToast(), UNDO_MS)
  }

  private undo(): void {
    const removed = this.pendingUndo
    this.hideToast()
    if (!removed) return
    if (removed.custom) {
      this.transport.send({
        type: 'restore-shortcut',
        id: removed.tile.id,
        title: removed.tile.title,
        url: removed.tile.url,
        index: removed.index
      })
    } else this.transport.send({ type: 'unhide-site', url: removed.tile.url })
  }

  private hideToast(): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer)
    this.toastTimer = null
    this.pendingUndo = null
    this.toast.hidden = true
  }

  // ---------------------------------------------------------------------------
  // Add / edit dialog
  // ---------------------------------------------------------------------------

  private openDialog(existing: Tile | null): void {
    const dialog = this.dialog
    dialog.textContent = ''
    const title = el('h2', undefined, existing ? 'Edit Shortcut' : 'Add Shortcut')
    title.id = 'zen-dialog-title'
    dialog.appendChild(title)
    const form = el('form')
    form.method = 'dialog'
    form.autocomplete = 'off'
    const nameLabel = el('label', undefined, 'Name')
    nameLabel.htmlFor = 'zen-shortcut-name'
    const name = el('input', 'zen-field')
    name.id = 'zen-shortcut-name'
    name.type = 'text'
    name.value = existing?.title ?? ''
    name.maxLength = 120
    const urlLabel = el('label', undefined, 'URL')
    urlLabel.htmlFor = 'zen-shortcut-url'
    const url = el('input', 'zen-field')
    url.id = 'zen-shortcut-url'
    url.type = 'text'
    url.placeholder = 'example.com'
    url.spellcheck = false
    url.value = existing?.url ?? ''
    const error = el('p', 'zen-dialog-error')
    error.setAttribute('aria-live', 'polite')
    const actions = el('div', 'zen-dialog-actions')
    const cancel = el('button', 'zen-btn', 'Cancel')
    cancel.type = 'button'
    cancel.addEventListener('click', () => dialog.close())
    const ok = el('button', 'zen-btn zen-btn-primary', existing ? 'Save' : 'Add')
    ok.type = 'submit'
    actions.append(cancel, ok)
    form.append(nameLabel, name, urlLabel, url, error, actions)
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const address = inputToUrl(url.value.trim())
      if (!address || !/^https?:\/\//i.test(address)) {
        error.textContent = 'Enter a web address, like example.com.'
        url.focus()
        return
      }
      const label = name.value.trim() || getHost(address).replace(/^www\./, '') || address
      if (existing) {
        this.transport.send({
          type: 'update-shortcut',
          id: existing.id,
          title: label,
          url: address
        })
      } else {
        this.transport.send({ type: 'add-shortcut', title: label, url: address })
      }
      dialog.close()
    })
    dialog.appendChild(form)
    dialog.addEventListener(
      'close',
      () => {
        // Focus returns to the grid: the edited tile, or the "Add shortcut" tile.
        this.setFocusIndex(this.focusIndex, true)
      },
      { once: true }
    )
    dialog.showModal()
    if (existing) name.select()
    else name.focus()
  }

  // ---------------------------------------------------------------------------
  // Customize panel
  // ---------------------------------------------------------------------------

  private wireCustomize(): void {
    this.customize.addEventListener('click', () => {
      if (this.panel.hidden) this.openPanel()
      else this.closePanel()
    })
  }

  private panelCleanup: (() => void) | null = null

  private openPanel(): void {
    this.closeMenu()
    this.renderPanel()
    this.panel.hidden = false
    this.customize.setAttribute('aria-expanded', 'true')
    this.panel.querySelector<HTMLElement>('input:checked, input')?.focus()
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (!this.panel.contains(target) && !this.customize.contains(target)) this.closePanel()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || this.dialog.open) return
      e.preventDefault()
      this.closePanel()
      this.customize.focus()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    this.panelCleanup = () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }

  private closePanel(): void {
    if (this.panel.hidden) return
    this.panel.hidden = true
    this.customize.setAttribute('aria-expanded', 'false')
    this.panelCleanup?.()
    this.panelCleanup = null
  }

  private renderPanel(): void {
    const state = this.state
    if (!state) return
    const panel = this.panel
    panel.textContent = ''
    const title = el('h2', undefined, 'Customize New Tab')
    title.id = 'zen-panel-title'
    panel.appendChild(title)

    panel.appendChild(el('h3', undefined, 'Shortcuts'))
    const modes: Array<{ value: NewTabShortcutsMode; label: string }> = [
      { value: 'most-visited', label: 'Most visited' },
      { value: 'custom', label: 'My shortcuts' },
      { value: 'hidden', label: 'Hide shortcuts' }
    ]
    for (const mode of modes) {
      panel.appendChild(
        option('zen-shortcuts', mode.label, state.shortcutsMode === mode.value, false, () =>
          this.transport.send({ type: 'set-shortcuts-mode', mode: mode.value })
        )
      )
    }

    panel.appendChild(el('h3', undefined, 'Background'))
    const backgrounds: Array<{ value: NewTabBackgroundKind; label: string; disabled: boolean }> = [
      { value: 'space', label: 'Space gradient', disabled: false },
      { value: 'solid', label: 'Solid', disabled: false },
      { value: 'image', label: 'Image from file', disabled: !state.canPickImage }
    ]
    for (const bg of backgrounds) {
      panel.appendChild(
        option('zen-background', bg.label, state.background === bg.value, bg.disabled, () =>
          this.transport.send({ type: 'set-background', background: bg.value })
        )
      )
    }
    if (state.canPickImage && (state.background === 'image' || state.backgroundImage)) {
      const actions = el('div', 'zen-image-actions')
      const choose = el(
        'button',
        'zen-btn',
        state.backgroundImage ? 'Change image' : 'Choose image'
      )
      choose.type = 'button'
      choose.addEventListener('click', () => this.transport.send({ type: 'pick-background-image' }))
      actions.appendChild(choose)
      if (state.backgroundImage) {
        const clear = el('button', 'zen-btn', 'Remove image')
        clear.type = 'button'
        clear.addEventListener('click', () =>
          this.transport.send({ type: 'clear-background-image' })
        )
        actions.appendChild(clear)
      }
      panel.appendChild(actions)
    }

    panel.appendChild(el('h3', undefined, 'Greeting'))
    panel.appendChild(
      option(null, 'Show a greeting', state.greeting, false, (checked) =>
        this.transport.send({ type: 'set-greeting', greeting: checked })
      )
    )

    const actions = el('div', 'zen-panel-actions')
    const done = el('button', 'zen-btn', 'Done')
    done.type = 'button'
    done.addEventListener('click', () => {
      this.closePanel()
      this.customize.focus()
    })
    actions.appendChild(done)
    panel.appendChild(actions)
  }

  // ---------------------------------------------------------------------------
  // Drag to reorder (custom shortcuts)
  // ---------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (!this.custom || e.button !== 0 || this.drag) return
    const link = (e.target as HTMLElement).closest<HTMLElement>('a.zen-tile-link')
    const tile = link?.closest<HTMLElement>('.zen-tile')
    const id = tile?.dataset.id
    if (!link || !tile || !id) return
    this.drag = {
      pointerId: e.pointerId,
      tile,
      link,
      id,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      dy: 0,
      lastX: e.clientX,
      lastY: e.clientY,
      lastT: e.timeStamp,
      vx: 0,
      vy: 0,
      active: false,
      ids: [],
      slots: [],
      from: 0,
      to: 0,
      offsets: new Map(),
      caret: { x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, tx: 0, ty: 0, el: el('div', 'zen-caret') },
      settling: null,
      frame: null,
      lastFrame: 0
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag
    if (!drag || drag.pointerId !== e.pointerId || drag.settling) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      this.startDrag(drag)
    }
    const dt = Math.max(1, e.timeStamp - drag.lastT) / 1000
    drag.vx = (e.clientX - drag.lastX) / dt
    drag.vy = (e.clientY - drag.lastY) / dt
    drag.lastX = e.clientX
    drag.lastY = e.clientY
    drag.lastT = e.timeStamp
    drag.dx = dx
    drag.dy = dy
    drag.tile.style.transform = `translate(${dx}px, ${dy}px) scale(1.02)`
    const origin = drag.slots[drag.from]
    const cx = origin.left + origin.width / 2 + dx
    const cy = origin.top + origin.height / 2 + dy
    let nearest = drag.to
    let best = Infinity
    drag.slots.forEach((slot, i) => {
      const d = Math.hypot(slot.left + slot.width / 2 - cx, slot.top + slot.height / 2 - cy)
      if (d < best) {
        best = d
        nearest = i
      }
    })
    if (nearest !== drag.to) {
      drag.to = nearest
      this.retargetNeighbours(drag)
    }
  }

  private startDrag(drag: Drag): void {
    drag.active = true
    this.closeMenu()
    this.hideToast()
    const tiles = this.tileElements().filter((t) => t.dataset.id)
    drag.ids = tiles.map((t) => t.dataset.id as string)
    drag.slots = tiles.map((t) => t.getBoundingClientRect())
    drag.from = drag.ids.indexOf(drag.id)
    drag.to = drag.from
    for (const id of drag.ids) {
      if (id === drag.id) continue
      drag.offsets.set(id, { x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, tx: 0, ty: 0 })
    }
    drag.tile.dataset.dragging = ''
    try {
      drag.link.setPointerCapture(drag.pointerId)
    } catch {
      /* pointer already gone */
    }
    const slot = drag.slots[drag.from]
    drag.caret.el.style.height = `${slot.height - 16}px`
    this.body.appendChild(drag.caret.el)
    this.retargetNeighbours(drag)
    drag.caret.x.x = drag.caret.tx
    drag.caret.y.x = drag.caret.ty
    this.paintDrag(drag)
  }

  /** The neighbours slide into the order the drop would produce; the caret marks the slot. */
  private retargetNeighbours(drag: Drag): void {
    const order = drag.ids.filter((id) => id !== drag.id)
    order.splice(drag.to, 0, drag.id)
    order.forEach((id, newIndex) => {
      if (id === drag.id) return
      const oldIndex = drag.ids.indexOf(id)
      const spring = drag.offsets.get(id)
      if (!spring) return
      spring.tx = drag.slots[newIndex].left - drag.slots[oldIndex].left
      spring.ty = drag.slots[newIndex].top - drag.slots[oldIndex].top
    })
    const slot = drag.slots[drag.to]
    drag.caret.tx = slot.left - HALF_GAP - 1
    drag.caret.ty = slot.top + 8
    this.ensureFrame(drag)
  }

  private ensureFrame(drag: Drag): void {
    if (drag.frame !== null) return
    drag.lastFrame = performance.now()
    drag.frame = requestAnimationFrame((now) => this.tick(drag, now))
  }

  private tick(drag: Drag, now: number): void {
    drag.frame = null
    if (this.drag !== drag) return
    const dt = Math.min(0.064, Math.max(0.001, (now - drag.lastFrame) / 1000))
    drag.lastFrame = now
    const reduced = reducedMotion()
    let moving = false
    const advance = (state: SpringState, target: number): SpringState => {
      if (reduced) return { x: target, v: 0 }
      const next = stepSpring(state, target, dt, SPRING_SNAPPY)
      if (next.x !== target || next.v !== 0) moving = true
      return next
    }
    for (const spring of drag.offsets.values()) {
      spring.x = advance(spring.x, spring.tx)
      spring.y = advance(spring.y, spring.ty)
    }
    drag.caret.x = advance(drag.caret.x, drag.caret.tx)
    drag.caret.y = advance(drag.caret.y, drag.caret.ty)
    if (drag.settling) {
      drag.settling.x = advance(drag.settling.x, drag.settling.tx)
      drag.settling.y = advance(drag.settling.y, drag.settling.ty)
    }
    this.paintDrag(drag)
    if (drag.settling && !moving) {
      this.commitDrag(drag)
      return
    }
    if (moving) this.ensureFrame(drag)
  }

  private paintDrag(drag: Drag): void {
    for (const tile of this.tileElements()) {
      const id = tile.dataset.id
      if (!id || id === drag.id) continue
      const spring = drag.offsets.get(id)
      if (spring) tile.style.transform = `translate(${spring.x.x}px, ${spring.y.x}px)`
    }
    drag.caret.el.style.left = `${drag.caret.x.x}px`
    drag.caret.el.style.top = `${drag.caret.y.x}px`
    if (drag.settling)
      drag.tile.style.transform = `translate(${drag.settling.x.x}px, ${drag.settling.y.x}px) scale(1.02)`
  }

  private onPointerUp(e: PointerEvent, cancelled: boolean): void {
    const drag = this.drag
    if (!drag || drag.pointerId !== e.pointerId || drag.settling) return
    if (!drag.active) {
      // A plain click: the link does its work.
      this.drag = null
      return
    }
    this.suppressClick = true
    if (cancelled) drag.to = drag.from
    const target = drag.slots[drag.to]
    const origin = drag.slots[drag.from]
    drag.settling = {
      x: { x: drag.dx, v: drag.vx },
      y: { x: drag.dy, v: drag.vy },
      tx: target.left - origin.left,
      ty: target.top - origin.top
    }
    this.retargetNeighbours(drag)
    this.ensureFrame(drag)
  }

  private commitDrag(drag: Drag): void {
    if (drag.frame !== null) cancelAnimationFrame(drag.frame)
    drag.caret.el.remove()
    delete drag.tile.dataset.dragging
    for (const tile of this.tileElements()) tile.style.transform = ''
    this.drag = null
    if (drag.to !== drag.from) {
      const order = drag.ids.filter((id) => id !== drag.id)
      order.splice(drag.to, 0, drag.id)
      const byId = new Map(this.tiles.map((t) => [t.id, t]))
      this.tiles = order.map((id) => byId.get(id)).filter((t): t is Tile => Boolean(t))
      this.focusIndex = drag.to
      this.transport.send({ type: 'reorder-shortcuts', ids: order })
    }
    this.renderGrid()
    this.setFocusIndex(this.focusIndex, false)
    if (this.state) this.apply(this.state)
  }
}

function fromShortcut(s: NewTabPageShortcut): Tile {
  return { id: s.id, url: s.url, title: s.title, favicon: s.favicon }
}

function fromTopSite(s: TopSite): Tile {
  return { id: `site:${s.url}`, url: s.url, title: s.title, favicon: s.favicon }
}

function letterFor(tile: Tile): HTMLElement {
  const host = getHost(tile.url).replace(/^www\./, '')
  const letter = (host || tile.title).trim().charAt(0).toUpperCase() || '·'
  return el('span', 'zen-tile-letter', letter)
}

/** A key that would insert a character into a text field. */
function isTypedCharacter(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing
}

function option(
  group: string | null,
  label: string,
  checked: boolean,
  disabled: boolean,
  onChange: (checked: boolean) => void
): HTMLLabelElement {
  const wrap = el('label', 'zen-option')
  const input = el('input')
  input.type = group ? 'radio' : 'checkbox'
  if (group) input.name = group
  input.checked = checked
  input.disabled = disabled
  input.addEventListener('change', () => onChange(input.checked))
  wrap.appendChild(input)
  wrap.appendChild(el('span', undefined, label))
  return wrap
}

/** Exposed for tests: the glyph names the page uses. */
export const NEW_TAB_PAGE_ICONS = Object.keys(NEW_TAB_ICONS) as NewTabIcon[]
