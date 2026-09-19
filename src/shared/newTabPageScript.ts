import type {
  NewTabPageAction,
  NewTabPageCommand,
  NewTabPageShortcut,
  NewTabPageState,
  NewTabShortcutsMode,
  TopSite
} from './types'
import { NEW_TAB_ICONS, PRIVATE_COOKIES, newTabIconSvg, type NewTabIcon } from './newTabPage'
import { MAX_NEW_TAB_SHORTCUTS } from './newTab'
import { SPRING_SNAPPY, stepSpring, type SpringState } from './spring'
import { getHost } from './url'

/**
 * Runs inside `zen://newtab` (the host's preload supplies the transport). The page is filled
 * from `NewTabPageState`: theme, search box hand-off, the grid – the user's shortcuts, leading
 * the most visited sites or on their own; remove with Undo, and drag-reorder on the
 * design-language spring when the grid is theirs alone – and the keyboard.
 * In a private window the grid gives way to the explainer and its "Block third-party cookies"
 * switch. Nothing here touches browser state
 * directly: every wish is a `NewTabPageAction`, and the answer arrives as the next state. The page draws no popover or dialog of its own (design
 * language v2 §9.20–9.23): a tile's menu is the host's context menu, the add / edit dialog and
 * Customize (Settings → New Tab) are the chrome's, asked for through actions; the one surface it
 * keeps is the Undo toast, and the chrome tells it through a `NewTabPageCommand` when the menu
 * picked Remove so that toast follows.
 */
export interface NewTabTransport {
  /** The state to paint first, fetched synchronously before the document renders (null when unknown). */
  initialState(): NewTabPageState | null
  onState(listener: (state: NewTabPageState) => void): void
  onCommand(listener: (command: NewTabPageCommand) => void): void
  send(action: NewTabPageAction): void
}

/** Distance (px) a press travels before it is a drag rather than a click. */
const DRAG_THRESHOLD = 4
/** Half the grid gap: the caret sits in the middle of the gap before the drop slot. */
const HALF_GAP = 6
const UNDO_MS = 8000
/**
 * The private window's accent, as the chrome sets it on `.zen-window[data-window-kind='private']`
 * in main.css (`newTabPage.test.ts` pins the two in step): a private page's controls take the
 * frame's accent like every other v2 surface in that window.
 */
export const PRIVATE_ACCENT = '#a98bff'
export const PRIVATE_ACCENT_RGB = '169 139 255'

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
  /** One of the user's shortcuts (removed as such, with Undo) rather than a most visited site. */
  custom: boolean
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
  private readonly privateExplainer = byId<HTMLElement>('zen-private')
  private readonly cookiesRow = byId<HTMLElement>('zen-cookies')
  private readonly cookiesSwitch = byId<HTMLButtonElement>('zen-cookies-switch')
  private readonly cookiesDescription = byId<HTMLElement>('zen-cookies-desc')
  private readonly greeting = byId<HTMLHeadingElement>('zen-greeting')
  private readonly search = byId<HTMLFormElement>('zen-search')
  private readonly input = byId<HTMLInputElement>('zen-search-input')
  private readonly empty = byId<HTMLParagraphElement>('zen-empty')
  private readonly grid = byId<HTMLDivElement>('zen-grid')
  private readonly customize = byId<HTMLButtonElement>('zen-customize')
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
    this.wirePrivateCookies()
    this.wireGlobalKeys()
    this.systemDark.addEventListener('change', () => this.applyTheme())
    transport.onState((state) => this.apply(state))
    transport.onCommand((command) => this.onCommand(command))
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
    this.applyGreeting()
    this.applyPrivateCookies()
    // The grid is the user's own under "My shortcuts" (add tile, drag to reorder); under "Most
    // visited" their shortcuts lead it and history's sites fill the rest.
    this.custom = state.shortcutsMode === 'my-shortcuts'
    this.tiles =
      state.shortcutsMode === 'hidden'
        ? []
        : [...state.shortcuts.map(fromShortcut), ...state.topSites.map(fromTopSite)]
    if (!this.drag) this.renderGrid()
  }

  /** The chrome's tile menu picked Remove: the page removes the tile itself, with Undo. */
  private onCommand(command: NewTabPageCommand): void {
    if (command.type !== 'remove-tile') return
    const tile = this.tiles.find((t) => t.id === command.id)
    if (tile) this.remove(tile)
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
    this.setBackground(this.backgroundValue(state, variant.vars))
  }

  private backgroundValue(state: NewTabPageState, vars: Record<string, string>): string {
    if (state.background === 'image' && state.backgroundImage)
      return `url("${state.backgroundImage.replace(/"/g, '%22')}") center / cover no-repeat`
    if (state.background === 'solid') return this.pageColour()
    return vars['--zen-bg'] ?? this.pageColour()
  }

  /**
   * The v2 page surface for the theme just applied, read from the stylesheet (main.css's token
   * block) rather than kept here, as a literal so that a scheme change still crossfades.
   */
  private pageColour(): string {
    return getComputedStyle(this.root).getPropertyValue('--v2-page').trim()
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
        if (this.drag) return
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
      // The tile's own menu replaces the page's context menu (Chrome's tiles do the same).
      e.preventDefault()
      const item = this.tiles.find((t) => t.id === id)
      if (!item) return
      // Keyboard (Shift+F10, the Menu key): flush under the tile's square rather than at the pointer.
      const fromKeyboard = e.button === 0 && e.clientX === 0 && e.clientY === 0
      const rect = (tile.querySelector('.zen-ntp-tile') ?? tile).getBoundingClientRect()
      this.openMenu(
        item,
        fromKeyboard ? rect.left : e.clientX,
        fromKeyboard ? rect.bottom : e.clientY,
        fromKeyboard
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

  /**
   * The grid (four by two, most visited or the user's own), the empty sentence when the history
   * has nothing to show, or – in a private window – the explainer where the tiles would be.
   */
  private renderGrid(): void {
    const state = this.state
    const isPrivate = Boolean(state?.isPrivate)
    const mode: NewTabShortcutsMode = isPrivate ? 'hidden' : (state?.shortcutsMode ?? 'hidden')
    const showGrid = mode === 'my-shortcuts' || (mode === 'most-visited' && this.tiles.length > 0)
    this.privateExplainer.hidden = !isPrivate
    this.empty.hidden = !(mode === 'most-visited' && this.tiles.length === 0)
    this.grid.hidden = !showGrid
    this.grid.textContent = ''
    if (!showGrid) return
    for (const tile of this.tiles) this.grid.appendChild(this.renderTile(tile))
    if (this.custom && this.tiles.length < MAX_NEW_TAB_SHORTCUTS)
      this.grid.appendChild(this.renderAddTile())
    const count = this.tileElements().length
    if (this.focusIndex >= count) this.focusIndex = Math.max(0, count - 1)
    this.applyTabStops()
  }

  /**
   * A shortcut is the tile – a 64 square holding the site's 32 icon, or its letter, or the globe
   * – and its caption 8 below, one target (the phone page's `zen-v2-shortcut`). Its menu is the
   * host's context menu: right-click, Shift+F10 or the Menu key open it, Delete removes.
   */
  private renderTile(tile: Tile): HTMLElement {
    const wrap = el('div', 'zen-tile')
    wrap.dataset.id = tile.id
    wrap.setAttribute('role', 'listitem')
    const link = el('a', 'zen-v2-shortcut')
    link.href = tile.url
    link.title = tile.url
    link.draggable = false
    const square = el('span', 'zen-ntp-tile')
    if (tile.favicon) {
      const img = el('img', 'zen-ntp-icon')
      img.src = tile.favicon
      img.alt = ''
      img.width = 32
      img.height = 32
      img.draggable = false
      img.referrerPolicy = 'no-referrer'
      img.addEventListener('error', () => {
        img.replaceWith(fallbackFor(tile))
      })
      square.appendChild(img)
    } else square.appendChild(fallbackFor(tile))
    link.appendChild(square)
    link.appendChild(el('span', 'zen-ntp-caption', tile.title))
    wrap.appendChild(link)
    return wrap
  }

  private renderAddTile(): HTMLElement {
    const wrap = el('div', 'zen-tile zen-tile-add')
    wrap.setAttribute('role', 'listitem')
    const button = el('button', 'zen-v2-shortcut')
    button.type = 'button'
    const square = el('span', 'zen-ntp-tile')
    square.appendChild(icon('plus'))
    button.appendChild(square)
    button.appendChild(el('span', 'zen-ntp-caption', 'Add shortcut'))
    button.addEventListener('click', () => this.transport.send({ type: 'edit-shortcut', id: null }))
    wrap.appendChild(button)
    return wrap
  }

  private applyTabStops(): void {
    this.tileElements().forEach((tile, i) => {
      const control = tile.querySelector<HTMLElement>('.zen-v2-shortcut')
      if (control) control.tabIndex = i === this.focusIndex ? 0 : -1
    })
  }

  private setFocusIndex(index: number, focus: boolean): void {
    const tiles = this.tileElements()
    if (tiles.length === 0) return
    this.focusIndex = Math.max(0, Math.min(tiles.length - 1, index))
    this.applyTabStops()
    if (focus) tiles[this.focusIndex].querySelector<HTMLElement>('.zen-v2-shortcut')?.focus()
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

  /**
   * The tile's menu is the host's (native on desktop, the chrome's sheet elsewhere), opened at
   * `x`, `y` in the page's CSS pixels: Open in New Tab / Window / Private Window, then Edit
   * Shortcut (custom tiles) and Remove. Remove comes back as a `remove-tile` command so Undo is
   * the page's.
   */
  private openMenu(tile: Tile, x: number, y: number, keyboard: boolean): void {
    this.transport.send({
      type: 'tile-menu',
      id: tile.id,
      url: tile.url,
      title: tile.title,
      x: Math.round(x),
      y: Math.round(y),
      keyboard
    })
  }

  private remove(tile: Tile): void {
    const index = this.tiles.findIndex((t) => t.id === tile.id)
    if (index < 0) return
    this.tiles.splice(index, 1)
    this.renderGrid()
    this.setFocusIndex(Math.min(index, this.tileElements().length - 1), true)
    if (tile.custom) this.transport.send({ type: 'remove-shortcut', id: tile.id })
    else this.transport.send({ type: 'hide-site', url: tile.url })
    this.showUndo({ tile, index, custom: tile.custom })
  }

  private showUndo(removed: Removed): void {
    this.pendingUndo = removed
    this.toast.textContent = ''
    this.toast.appendChild(
      el('span', undefined, removed.custom ? 'Shortcut removed' : 'Site removed')
    )
    const undo = el('button', 'zen-v2-button', 'Undo')
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
  // Customize: Settings opens on its New Tab section
  // ---------------------------------------------------------------------------

  private wireCustomize(): void {
    this.customize.addEventListener('click', () => this.transport.send({ type: 'customize' }))
  }

  // ---------------------------------------------------------------------------
  // The private page's "Block third-party cookies" switch
  // ---------------------------------------------------------------------------

  /**
   * A private window's page carries the one control Chrome's Incognito page has: the switch for
   * `privacy.thirdPartyCookiesPrivate`, its position `blocked`, `locked` while Settings blocks
   * third-party cookies in every window – then it is on and disabled (§9.30) and the description
   * says where the lock is. A regular page has no row, and neither has a page whose state does
   * not carry the field.
   */
  private applyPrivateCookies(): void {
    const cookies = this.privateCookies()
    this.cookiesRow.hidden = !cookies
    if (!cookies) return
    this.cookiesSwitch.setAttribute('aria-checked', String(cookies.blocked))
    this.cookiesSwitch.disabled = cookies.locked
    if (cookies.locked) this.cookiesSwitch.setAttribute('aria-disabled', 'true')
    else this.cookiesSwitch.removeAttribute('aria-disabled')
    this.cookiesDescription.textContent = cookies.locked
      ? PRIVATE_COOKIES.lockedDescription
      : PRIVATE_COOKIES.description
  }

  private privateCookies(): NewTabPageState['privateThirdPartyCookies'] | undefined {
    const state = this.state
    return state?.isPrivate ? state.privateThirdPartyCookies : undefined
  }

  /**
   * A press (pointer, or Space / Enter on the focused button) flips the switch: on asks for
   * `block`, off for `allow`. The switch moves at once and the browser's next state confirms
   * it. Locked, the button is disabled and nothing is sent even if a press reaches it.
   */
  private wirePrivateCookies(): void {
    this.cookiesSwitch.addEventListener('click', () => {
      const state = this.state
      const cookies = this.privateCookies()
      if (!state || !cookies || cookies.locked) return
      const blocked = !cookies.blocked
      this.state = { ...state, privateThirdPartyCookies: { ...cookies, blocked } }
      this.applyPrivateCookies()
      this.transport.send({ type: 'set-private-third-party-cookies', blocked })
    })
  }

  // ---------------------------------------------------------------------------
  // Drag to reorder (custom shortcuts)
  // ---------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (!this.custom || e.button !== 0 || this.drag) return
    const link = (e.target as HTMLElement).closest<HTMLElement>('a.zen-v2-shortcut')
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
  return { id: s.id, url: s.url, title: s.title, favicon: s.favicon, custom: true }
}

function fromTopSite(s: TopSite): Tile {
  return { id: `site:${s.url}`, url: s.url, title: s.title, favicon: s.favicon, custom: false }
}

/** No icon: the site's first letter in the deemphasised ink, or the globe when there is none. */
function fallbackFor(tile: Tile): Element {
  const host = getHost(tile.url).replace(/^www\./, '')
  const letter = (host || tile.title).trim().charAt(0).toUpperCase()
  if (!letter) return icon('globe')
  return el('span', 'zen-ntp-letter', letter)
}

/** A key that would insert a character into a text field. */
function isTypedCharacter(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing
}

/** Exposed for tests: the glyph names the page uses. */
export const NEW_TAB_PAGE_ICONS = Object.keys(NEW_TAB_ICONS) as NewTabIcon[]
