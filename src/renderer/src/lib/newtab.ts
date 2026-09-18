import type { NewTabPinnedSite, NewTabShortcutStyle, Rect } from '@shared/types'
import { BLANK_URL, getHost } from '@shared/url'
import { cmd } from './api'
import { closeOverview, overviewIsOpen, setStageLayerShown } from './gestures/stage'
import type { TopSite } from './historyAdapter'
import { reducedMotion, type SpringConfig } from './motion/spring'
import { activeTab } from './selectors'
import { createStore } from './store'
import { captureThumbnail } from './thumbnails'
import { browserStore, closeUrlbar, uiStore } from './ui'

// ---------------------------------------------------------------------------
// The new tab page growing out of the plus button (MOT-03)
// ---------------------------------------------------------------------------

/**
 * `growing` while the surface is opaque; `revealing` once its progress has passed
 * `GROW_FADE_FROM` and the page shows through it (the page's tiles start their entrance then).
 */
export type NewTabGrowPhase = 'idle' | 'growing' | 'revealing'

export interface NewTabGrowState {
  phase: NewTabGrowPhase
  /** Bounds of the control the surface grows from, in window coordinates. */
  origin: Rect | null
  /** The page the surface grows over: its last capture is drawn behind the surface. */
  fromTabId: string | null
  /** The blank tab the page belongs to, once the browser has created it. */
  tabId: string | null
  /** The surface has reached the frame. */
  arrived: boolean
  /** The blank tab is the active tab: the page is mounted under the surface. */
  ready: boolean
}

const GROW_IDLE: NewTabGrowState = {
  phase: 'idle',
  origin: null,
  fromTabId: null,
  tabId: null,
  arrived: false,
  ready: false
}

/** Name of the stage layer the grow registers, so the live page is hidden under it. */
const GROW_LAYER = 'newtab-grow'

/** The browser has this long to make the new tab active before the surface reveals regardless. */
const READY_TIMEOUT_MS = 800

export const newTabGrowStore = createStore<NewTabGrowState>(GROW_IDLE, 'newtab-grow')

/** The corner radius the surface starts with: the plus button is a 44 pill. */
export const GROW_ORIGIN_RADIUS = 22

/**
 * The surface's spring: SNAPPY's family, a touch stiffer, so a full-height run from the bar to
 * the frame settles in about 300 ms without visible overshoot.
 */
export const SPRING_GROW: SpringConfig = {
  stiffness: 520,
  damping: 45,
  mass: 1,
  restDelta: 0.5,
  restSpeed: 10
}

export interface GrowFrame {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

/**
 * Where the surface is at `progress` (0 = the origin control, 1 = the content frame): each edge
 * moves on its own straight line, so the rectangle stays a rectangle and the corner radius shrinks
 * from the pill's to the frame's along the way.
 */
export function growFrame(
  progress: number,
  origin: Rect,
  frame: Rect,
  frameRadius: number
): GrowFrame {
  const t = Math.max(0, Math.min(1, progress))
  const lerp = (a: number, b: number): number => a + (b - a) * t
  return {
    x: lerp(origin.x, frame.x),
    y: lerp(origin.y, frame.y),
    width: lerp(origin.width, frame.width),
    height: lerp(origin.height, frame.height),
    radius: lerp(GROW_ORIGIN_RADIUS, frameRadius)
  }
}

/** `clip-path` for a `GrowFrame` on a layer whose box is `layer`. */
export function growClipPath(g: GrowFrame, layer: Rect): string {
  const top = g.y - layer.y
  const left = g.x - layer.x
  const right = layer.width - (left + g.width)
  const bottom = layer.height - (top + g.height)
  const px = (v: number): string => `${Math.round(v * 100) / 100}px`
  return `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round ${px(g.radius)})`
}

/** How far the surface travels (px): the spring runs on this distance so its pace is the frame's. */
export function growTravel(origin: Rect, frame: Rect): number {
  const dx = frame.x + frame.width / 2 - (origin.x + origin.width / 2)
  const dy = frame.y + frame.height / 2 - (origin.y + origin.height / 2)
  return Math.max(120, Math.hypot(dx, dy) + (frame.height - origin.height) / 2)
}

/** The progress at which the page starts to show through the surface (v2 §11, rule 4's exception). */
export const GROW_FADE_FROM = 0.7

/**
 * The surface's opacity at `progress`: opaque until `GROW_FADE_FROM`, then straight down to 0 at
 * arrival. The page beneath comes up on the value that grows the window – one spring, no second
 * clock – so a grow that is caught or run back fades back along the same line.
 */
export function growSurfaceOpacity(progress: number): number {
  const t = (Math.max(0, Math.min(1, progress)) - GROW_FADE_FROM) / (1 - GROW_FADE_FROM)
  return Math.round((1 - Math.max(0, Math.min(1, t))) * 1000) / 1000
}

/**
 * `clip-path` for the page's last capture, which lies under the surface at the frame's rectangle:
 * the card with the surface's rounded rectangle cut out of it (an even-odd path in the card's own
 * coordinates), so that what shows through the fading surface is the new page beneath the layer
 * and not the page being left. The cut-out grows with the surface, on the same progress.
 */
export function growHolePath(g: GrowFrame, card: Rect): string {
  const n = (v: number): string => `${Math.round(v * 100) / 100}`
  const x = g.x - card.x
  const y = g.y - card.y
  const r = Math.max(0, Math.min(g.radius, g.width / 2, g.height / 2))
  const right = x + g.width
  const bottom = y + g.height
  const arc = `A${n(r)} ${n(r)} 0 0 1`
  const outer = `M0 0H${n(card.width)}V${n(card.height)}H0Z`
  const inner =
    `M${n(x + r)} ${n(y)}H${n(right - r)}${arc} ${n(right)} ${n(y + r)}` +
    `V${n(bottom - r)}${arc} ${n(right - r)} ${n(bottom)}` +
    `H${n(x + r)}${arc} ${n(x)} ${n(bottom - r)}` +
    `V${n(y + r)}${arc} ${n(x + r)} ${n(y)}Z`
  return `path(evenodd, "${outer}${inner}")`
}

let pendingCapture: Promise<unknown> | null = null

/**
 * A finger touched the new tab control: capture the page now, while it is still on screen, so
 * the surface can start growing the moment the touch turns into a tap. Harmless otherwise.
 */
export function prepareNewTabGrow(): void {
  const state = browserStore.get().state
  const from = state ? activeTab(state) : null
  if (from && from.url !== BLANK_URL) pendingCapture = captureThumbnail(from.id)
}

/**
 * Open a new tab page on the phone: a blank tab becomes active and, when the request came from
 * a control on screen, a surface grows out of that control over the page before the new tab
 * page fades in. Without an origin (a shortcut, the empty state), or when the overview is up,
 * motion is reduced or the current tab is itself a new tab page, the page simply appears – out
 * of its card when the overview was open.
 */
export async function openNewTabPage(origin: Rect | null): Promise<void> {
  closeUrlbar()
  const state = browserStore.get().state
  const from = state ? activeTab(state) : null
  const overview = overviewIsOpen()
  const ui = uiStore.get()
  const animate =
    origin !== null &&
    !overview &&
    !reducedMotion() &&
    from !== null &&
    from.url !== BLANK_URL &&
    ui.overlay === 'none' &&
    !ui.drawerOpen &&
    !ui.menu &&
    !ui.siteInfoOpen &&
    !ui.stageActive &&
    newTabGrowStore.get().phase === 'idle'
  const capture = pendingCapture
  pendingCapture = null
  if (animate) {
    // The page is about to lose its live view; its last look is what the surface grows over.
    await (capture ?? captureThumbnail(from.id))
    newTabGrowStore.set({ ...GROW_IDLE, phase: 'growing', origin, fromTabId: from.id })
    setStageLayerShown(GROW_LAYER, true)
  }
  const tabId = await cmd('tab.create', { url: BLANK_URL, active: true }).catch(() => null)
  // From the overview the page morphs out of the new tab's card, as any picked tab does.
  if (overview) closeOverview(tabId ?? undefined)
  if (!animate) return
  if (!tabId || newTabGrowStore.get().phase === 'idle') {
    finishNewTabGrow()
    return
  }
  newTabGrowStore.set({ tabId })
  // The page is under the surface once the browser reports the blank tab active.
  stopWaiting?.()
  stopWaiting = whenTabActive(tabId, () => {
    stopWaiting = null
    if (newTabGrowStore.get().tabId === tabId) {
      newTabGrowStore.set({ ready: true })
      maybeFinish()
    }
  })
}

let stopWaiting: (() => void) | null = null

/** Runs `then` once `tabId` is the active tab, or after a while regardless; returns a canceller. */
function whenTabActive(tabId: string, then: () => void): () => void {
  const isActive = (): boolean => {
    const state = browserStore.get().state
    return state !== null && activeTab(state)?.id === tabId
  }
  let done = false
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    done = true
    unsubscribe?.()
    if (timer) clearTimeout(timer)
  }
  const fire = (): void => {
    if (done) return
    cancel()
    then()
  }
  if (isActive()) {
    fire()
    return cancel
  }
  unsubscribe = browserStore.subscribe(() => {
    if (isActive()) fire()
  })
  timer = setTimeout(fire, READY_TIMEOUT_MS)
  return cancel
}

/**
 * The surface's spring reports where it is: past `GROW_FADE_FROM` the page shows through the
 * surface, and the page is told so (its tiles come up from then, not under an opaque surface).
 */
export function growProgress(progress: number): void {
  const grow = newTabGrowStore.get()
  if (grow.phase === 'growing' && progress >= GROW_FADE_FROM) {
    newTabGrowStore.set({ phase: 'revealing' })
  }
}

/** The surface has reached the frame and its fade is complete: nothing of the layer is visible. */
export function arriveNewTabGrow(): void {
  if (newTabGrowStore.get().phase === 'idle') return
  newTabGrowStore.set({ arrived: true })
  maybeFinish()
}

/**
 * Both halves are in – the surface has arrived (and faded on the way) and the blank tab is the
 * active tab under it – so the layer goes. The frame draws again beneath it; the blank page's own
 * view stays away, since the layout reporter never places a new tab page's view on the phone.
 * Until the tab is active the (invisible) layer stays, keeping the page being left off screen.
 */
function maybeFinish(): void {
  const grow = newTabGrowStore.get()
  if (grow.phase === 'idle' || !grow.arrived || !grow.ready) return
  finishNewTabGrow()
}

export function finishNewTabGrow(): void {
  stopWaiting?.()
  stopWaiting = null
  setStageLayerShown(GROW_LAYER, false)
  if (newTabGrowStore.get().phase !== 'idle') newTabGrowStore.set(GROW_IDLE)
}

// ---------------------------------------------------------------------------
// The customise sheet and the picked wallpaper
// ---------------------------------------------------------------------------

export const customizeStore = createStore<{ open: boolean }>({ open: false }, 'newtab-customize')

export function openCustomize(): void {
  customizeStore.set({ open: true })
}

export function closeCustomize(): void {
  customizeStore.set({ open: false })
}

interface WallpaperImageState {
  /** The browser has been asked; `dataUrl` is the answer (null: nothing picked). */
  loaded: boolean
  dataUrl: string | null
}

export const wallpaperImageStore = createStore<WallpaperImageState>(
  { loaded: false, dataUrl: null },
  'newtab-wallpaper'
)

let wallpaperRequest: Promise<void> | null = null

/** Fetch the picked wallpaper once; later callers share the answer. */
export function loadWallpaperImage(): Promise<void> {
  if (wallpaperImageStore.get().loaded) return Promise.resolve()
  wallpaperRequest ??= cmd('newtab.wallpaper', undefined)
    .then((dataUrl) => wallpaperImageStore.set({ loaded: true, dataUrl }))
    .catch(() => wallpaperImageStore.set({ loaded: true, dataUrl: null }))
    .finally(() => {
      wallpaperRequest = null
    })
  return wallpaperRequest
}

/** Store a picked image (or, with null, let it go); the page shows it as soon as it is stored. */
export async function setWallpaperImage(dataUrl: string | null): Promise<void> {
  await cmd('newtab.setWallpaper', { dataUrl })
  wallpaperImageStore.set({ loaded: true, dataUrl })
}

/** Longest edge (px) a picked wallpaper is kept at; phones never show more. */
const WALLPAPER_MAX_EDGE = 1600

/**
 * Read a picked image file into a JPEG data URL sized for a phone screen, so a 12-megapixel
 * photo does not end up as a 20 MB string in the browser's store.
 */
export async function readWallpaperFile(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('The image could not be read'))
      img.src = url
    })
    const scale = Math.min(
      1,
      WALLPAPER_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight)
    )
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The image could not be read')
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.86)
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

export interface TopSiteTile {
  url: string
  title: string
  favicon: string | null
  pinned: boolean
}

/** Host without `www.`, lower-cased: the identity a tile stands for. */
function tileHost(url: string): string {
  return getHost(url)
    .toLowerCase()
    .replace(/^www\./, '')
}

/**
 * The tiles the page shows, `n` at most: the pinned sites first, in their order, then the most
 * visited sites of other hosts – or only the pinned ones when the shortcuts are "my shortcuts".
 * A pin borrows the icon (and a missing title) from the history of its host, since a pin only
 * knows its URL and title.
 */
export function composeTiles(opts: {
  pinned: readonly NewTabPinnedSite[]
  ranked: readonly TopSite[]
  style: NewTabShortcutStyle
  n: number
  /** Icons known from elsewhere (open tabs), by host. */
  favicons?: ReadonlyMap<string, string>
}): TopSiteTile[] {
  const byHost = new Map<string, TopSite>()
  for (const site of opts.ranked) {
    const host = tileHost(site.url)
    if (host && !byHost.has(host)) byHost.set(host, site)
  }
  const pinnedHosts = new Set<string>()
  const tiles: TopSiteTile[] = []
  for (const pin of opts.pinned) {
    const host = tileHost(pin.url)
    if (!host || pinnedHosts.has(host)) continue
    pinnedHosts.add(host)
    const known = byHost.get(host)
    tiles.push({
      url: pin.url,
      title: pin.title || known?.title || '',
      favicon: known?.favicon ?? opts.favicons?.get(host) ?? null,
      pinned: true
    })
  }
  if (opts.style === 'most-visited') {
    for (const site of opts.ranked) {
      const host = tileHost(site.url)
      if (!host || pinnedHosts.has(host)) continue
      pinnedHosts.add(host)
      tiles.push({ url: site.url, title: site.title, favicon: site.favicon, pinned: false })
    }
  }
  return tiles.slice(0, Math.max(0, opts.n))
}

/** Longest caption a tile carries before the host stands in for the title. */
const TILE_LABEL_MAX = 18

/** Separators titles put between a page's name and the site's ("Coffee - Wikipedia"). */
const SITE_SEPARATOR = /\s+[-|·—–]\s+/

/** Whether the URL is a site's front page rather than a page inside it. */
function isFrontPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.pathname === '/' || parsed.pathname === '') && !parsed.search
  } catch {
    return false
  }
}

/**
 * The caption under a tile: the site's name. A front page's title starts with it ("YouTube",
 * "Hacker News - Top", "GitHub: Let's build from here"); a page inside a site ends with it
 * ("Coffee - Wikipedia", "corner-shape - CSS | MDN"), and when such a title has no site suffix
 * the host stands for the site. The host also stands in when the name would not fit on one line
 * under a 56 tile.
 */
export function tileLabel(title: string, url: string): string {
  const host = tileHost(url)
  let name = ''
  if (isFrontPage(url) || !host) {
    name = title.split(/\s+[-|·—–]\s+|:\s+/)[0]?.trim() ?? ''
  } else {
    const parts = title.split(SITE_SEPARATOR)
    name = parts.length > 1 ? (parts[parts.length - 1]?.trim() ?? '') : ''
  }
  if (name && name.length <= TILE_LABEL_MAX) return name
  return host || title.trim() || url
}
