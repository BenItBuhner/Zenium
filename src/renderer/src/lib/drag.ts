import type { Tab, TabDragOver } from '@shared/types'
import { run } from './api'
import { InsertionCaret, autoscrollStep, type CaretPlacement } from './insertionCaret'
import type { SlideMotion } from './motion/slide'
import { SPRING_GENTLE, SpringAnimation } from './motion/spring'
import { VelocityTracker } from './motion/velocity'
import { gapCentre, slideOffsets, slotAt, slotKey, type Span } from './reorder'
import { activeTab, tabTitle } from './selectors'
import { createStore } from './store'
import { STRIP_TEAR_PAST } from './tabStripLayout'
import {
  browserStore,
  captureActiveTab,
  invalidateSnapshot,
  returnFocusToPage,
  uiStore
} from './ui'

/**
 * Pointer-based drag & drop for sidebar tabs. The row's slot stays where it is (a hole) while a
 * ghost follows the pointer; within its own list the neighbours slide on springs to open the gap
 * where the row would land, marked by the insertion caret; anywhere else the drop targets are
 * DOM elements carrying a `data-drop` attribute:
 *   tab:<tabId>:before|after     insert relative to another tab (its section)
 *   section:<section>:<spaceId>  append to a section (pinned | regular | essential)
 *   folder:<folderId>            move into a folder
 *   space:<spaceId>              move to another space
 *   split:<left|right|top|bottom> split with the active tab, or join its split on that side
 *                                (the content area's edges)
 *   pane:<tabId>                 take over that pane of the split shown (the content area)
 *   bookmark:<folderId>:<index>  file the page on the bookmarks bar
 * The core resolves the key against the model (`tab.drop`). Past the sidebar – over the page
 * (`data-tear-zone`) or outside the window – the tab tears off: the core moves it into the
 * Zenium window under the pointer or into a new one there. The core follows the drag across
 * windows; a window hovered by a drag from another window gets `tab.dragOver` and shows the
 * same ghost, caret and sliding rows for it (`remoteDragOver`).
 *
 * With the tabs along the caption band (design language v2 §9.37) the same session runs with
 * its axis turned: slots are read left to right off the strip's rows, the caret stands upright
 * in the gap, the region autoscrolls at its left and right edges, and a tab pulled 16 past the
 * band tears off.
 */
export type GhostKind = 'row' | 'into' | 'tearoff'

/**
 * The drop target under the pointer (`key`), the ghost's shape, and whether the sidebar should
 * offer the drop zones that need room of their own (an empty Essentials grid's "Drop here").
 * Nothing in the sidebar moves while the pointer is over the tab rows: those zones mount once
 * the pointer has gone above the tab panel, and stay for the rest of the drag. `page`: the
 * pointer is over the page (the content viewport) right now – the split targets over it (the
 * edge zones, the panes) show then and only then (split-12, Edge's behaviour): a drag that
 * stays in the strip, a plain reorder, never sees them.
 */
export const dropStore = createStore<{
  key: string | null
  ghost: GhostKind
  zones: boolean
  page: boolean
}>({ key: null, ghost: 'row', zones: false, page: false }, 'drop')

/** The tab lists' motion, by the scrolling container that holds the list (the panels register). */
export const listMotions = new WeakMap<HTMLElement, SlideMotion>()

const DRAG_THRESHOLD = 5
/** Where a remote ghost hangs from the pointer (the other window knows the grab offset, not us). */
const REMOTE_GRAB = { dx: 24, dy: 18 }

type Caret = CaretPlacement

/** The axis a list's rows are laid along: the sidebar's column, or the strip along the band (§9.37). */
type Axis = 'x' | 'y'

type DropTarget =
  /**
   * A slot of a tab list, read off the rows' geometry: the lifted row's own list (its hole is
   * `liftedAt` among the others) or another list here (pinned from regular, a remote drag, a
   * tile from Essentials; `liftedAt` is then the count, a hole past the end). The rows slide on
   * that list's motion to open the gap; `land` is where the ghost's top-left glides to on a drop.
   */
  | {
      kind: 'slot'
      key: string | null
      stay: boolean
      index: number
      liftedAt: number
      caret: Caret
      land: { x: number; y: number }
      motion: SlideMotion
      rows: HTMLElement[]
      shift: number
    }
  /** A `data-drop` target: a grid tile's edge, a folder, a section, a space, a split, the bar. */
  | { kind: 'key'; key: string; caret: Caret | null; into: boolean }
  /** The page, or past the window's edge: the tab leaves this window. */
  | { kind: 'tearoff' }
  | { kind: 'none' }

interface Session {
  tabId: string
  /** The drag started in another window; the core relays the pointer. */
  remote: boolean
  /**
   * A finger's drag from a long-press ([liftTabByTouch], TABLET-02): the row moves within the
   * window only. The page and the window's edge never tear it off (a release there puts it
   * back), and the core is not asked to follow it across windows.
   */
  touch: boolean
  /** The lifted row's own list (direct `[data-tab-id]` children of one parent), when rendered here. */
  list: HTMLElement | null
  scroller: HTMLElement | null
  motion: SlideMotion | null
  /** The list whose rows are slid open right now, own or not. */
  slid: SlideMotion | null
  /**
   * The chrome the tab rows live in, where a drag is this window's own (`inSidebar`): the
   * sidebar; with the tabs along the caption band (§9.37) the band and the rail beside the frame.
   */
  chrome: HTMLElement[]
  /** The strip's band when the rows run along it: past it by `STRIP_TEAR_PAST` the tab tears off. */
  band: HTMLElement | null
  /** The content viewport (`data-tear-zone`): the page the split targets show over. */
  page: HTMLElement | null
  /** Pointer offset inside the picked-up row and the row's size: the ghost keeps both. */
  dx: number
  dy: number
  width: number
  height: number
  pointer: { x: number; y: number }
  target: DropTarget
  /** Last drop key told to the core (remote drags only). */
  reportedKey: string | null | undefined
  settling: boolean
  frame: number | null
}

let session: Session | null = null
let ghostEl: HTMLElement | null = null
let settleSpring: SpringAnimation | null = null
const live = { x: 0, y: 0 }
const velocity = new VelocityTracker()
const caret = new InsertionCaret()

/** The drag layer mounted its ghost: it is placed under the pointer right away. */
export function registerGhost(el: HTMLElement | null): void {
  ghostEl = el
  if (el && session && !session.settling) showGhost()
}

/** A fresh session's ghost: whatever a previous settle left on the element is undone. */
function showGhost(): void {
  const el = ghostEl
  if (!el) return
  el.style.transition = ''
  el.style.opacity = ''
  placeGhostAt(live.x, live.y)
}

export function registerCaret(el: HTMLElement | null): void {
  caret.register(el)
}

export function startTabDrag(tab: Tab, e: React.PointerEvent): void {
  if (e.button !== 0) return
  // A finger dragging a tab row is a scroll (and a long-press is the context menu); only a mouse
  // drags tabs from here. On the tablet a long-press lifts the row into the finger's own session
  // (`liftTabByTouch`); elsewhere touch users move tabs through the tab menu (pin, essentials,
  // space, split).
  if (e.pointerType !== 'mouse') return
  // Grabbing while a previous ghost is still settling takes over from it.
  if (session && !session.settling) return
  const rowEl = e.currentTarget as HTMLElement
  const startX = e.clientX
  const startY = e.clientY
  const pointerId = e.pointerId
  let dragging = false
  velocity.reset()
  velocity.add(e.timeStamp, startX, startY)

  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return
    velocity.add(ev.timeStamp, ev.clientX, ev.clientY)
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
      dragging = true
      begin(tab, rowEl, startX, startY)
    }
    const s = session
    if (!s || s.remote) return
    s.pointer = { x: ev.clientX, y: ev.clientY }
    placeGhost(ev.clientX, ev.clientY)
    offerZones(s, ev.clientX, ev.clientY)
    trackPage(s, ev.clientX, ev.clientY)
    apply(resolve(ev.clientX, ev.clientY, s), s)
    run('tab.dragMove', {
      tabId: s.tabId,
      x: ev.clientX,
      y: ev.clientY,
      inSidebar: inSidebar(s, ev.clientX, ev.clientY)
    })
  }

  const cleanup = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
  }

  const onUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return
    cleanup()
    if (!dragging || !session || session.remote) return
    velocity.add(ev.timeStamp, ev.clientX, ev.clientY)
    drop(session, ev.clientX, ev.clientY)
  }

  const onCancel = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return
    cleanup()
    if (session && !session.remote) cancel(session)
  }

  const onKey = (ev: KeyboardEvent): void => {
    // Escape lets go without dropping: the row returns to its slot.
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopPropagation()
    cleanup()
    if (session && !session.remote) cancel(session)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
}

/**
 * A tab dragged in another window hovers this one (`tab.dragOver`, pointer in this window's
 * chrome coordinates), or left it / was dropped (null). The drop target under the pointer is
 * told to the core, which moves the tab here on release.
 */
export function remoteDragOver(over: TabDragOver | null): void {
  if (!over) {
    if (session?.remote) end(session, false)
    return
  }
  if (session && !session.remote) return
  if (!session || session.tabId !== over.tabId) {
    if (session) end(session, false)
    beginRemote(over)
  }
  const s = session
  if (!s) return
  s.pointer = { x: over.x, y: over.y }
  placeGhost(over.x, over.y)
  offerZones(s, over.x, over.y)
  trackPage(s, over.x, over.y)
  const target = resolve(over.x, over.y, s)
  apply(target, s)
  const key = target.kind === 'slot' || target.kind === 'key' ? target.key : null
  if (key !== s.reportedKey) {
    s.reportedKey = key
    run('tab.dragTarget', { tabId: s.tabId, key })
  }
}

/**
 * A tab row a finger holds, once its long-press has lifted it (TABLET-02; the hold itself is
 * `components/tablet/useTabTouch.ts`). The drag is the mouse's session – the ghost under the
 * finger, the neighbours sliding open on their springs, the caret, the autoscroll at the
 * list's edges, the `data-drop` targets (a folder, a space, the Essentials, a split edge) – for
 * the one window: the page and the window's edge are no target (the row goes home from them,
 * where the mouse's tears the tab off into a new window) and the core is not asked to follow
 * the drag across windows. Returns the drag's handle, or null when another drag has the rows.
 */
export function liftTabByTouch(
  tab: Tab,
  rowEl: HTMLElement,
  x: number,
  y: number,
  timeStamp: number
): TouchTabDrag | null {
  if (session && !session.settling) return null
  velocity.reset()
  velocity.add(timeStamp, x, y)
  begin(tab, rowEl, x, y)
  const s = session
  if (!s) return null
  s.touch = true
  let done = false
  return {
    move: (mx, my, at) => {
      if (done || session !== s || s.settling) return
      velocity.add(at, mx, my)
      s.pointer = { x: mx, y: my }
      placeGhost(mx, my)
      offerZones(s, mx, my)
      trackPage(s, mx, my)
      apply(resolve(mx, my, s), s)
    },
    release: (rx, ry, at) => {
      if (done) return
      done = true
      if (session !== s || s.settling) return
      velocity.add(at, rx, ry)
      drop(s, rx, ry)
    },
    cancel: () => {
      if (done) return
      done = true
      if (session === s) cancel(s)
    }
  }
}

/** A finger's drag in progress ([liftTabByTouch]); each call after `release` or `cancel` is nothing. */
export interface TouchTabDrag {
  /** The finger moved to `x`, `y` (`timeStamp` the event's): the ghost and the rows follow. */
  move: (x: number, y: number, timeStamp: number) => void
  /** The finger lifted at `x`, `y`: the row lands there, or goes home. */
  release: (x: number, y: number, timeStamp: number) => void
  /** The touch was taken away (a `pointercancel`): the row goes home. */
  cancel: () => void
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * The list a row is a slot of: the rows' parent, or – for a segment of a split group's row
 * (design language v2 §9.35) – the parent of that row, which is the list's slot in the
 * segment's stead.
 */
function listOf(rowEl: HTMLElement): HTMLElement | null {
  return rowEl.closest<HTMLElement>('[data-split-row]')?.parentElement ?? rowEl.parentElement
}

/**
 * The chrome a drag counts as this window's own: the sidebar the row sits in – or, with the
 * tabs along the caption band (§9.37), the band and the rail beside the frame, whichever the
 * row (a strip tab, a rail tile) came from; a remote drag (no row) takes what the window shows.
 */
function rowsChrome(rowEl: HTMLElement | null): Pick<Session, 'chrome' | 'band'> {
  const band =
    rowEl?.closest<HTMLElement>('[data-tab-strip]') ??
    document.querySelector<HTMLElement>('[data-tab-strip]')
  const aside = rowEl?.closest<HTMLElement>('aside') ?? document.querySelector<HTMLElement>('aside')
  const chrome: HTMLElement[] = []
  if (aside) chrome.push(aside)
  if (band) chrome.push(band)
  return { chrome, band }
}

function begin(tab: Tab, rowEl: HTMLElement, startX: number, startY: number): void {
  if (session) end(session, false)
  const rect = rowEl.getBoundingClientRect()
  const scroller = rowEl.closest<HTMLElement>('[data-tab-scroller]')
  const motion = scroller ? (listMotions.get(scroller) ?? null) : null
  // Essentials tiles sit in a grid: they keep their own before / after zones, nothing slides.
  const list = motion && rowEl.matches('.zen-tab') ? listOf(rowEl) : null
  session = {
    tabId: tab.id,
    remote: false,
    touch: false,
    list,
    scroller,
    motion,
    slid: null,
    ...rowsChrome(rowEl),
    page: pageViewport(),
    dx: startX - rect.left,
    dy: startY - rect.top,
    width: rect.width,
    height: rect.height,
    pointer: { x: startX, y: startY },
    target: { kind: 'none' },
    reportedKey: undefined,
    settling: false,
    frame: null
  }
  live.x = rect.left
  live.y = rect.top
  const state = browserStore.get().state
  void captureActiveTab(state ? (activeTab(state)?.id ?? null) : null)
  uiStore.set({
    drag: {
      tabId: tab.id,
      remote: false,
      title: tabTitle(tab),
      favicon: tab.favicon,
      width: rect.width,
      height: rect.height,
      tile: rowEl.matches('.zen-essential'),
      settling: false
    }
  })
  showGhost()
  document.body.style.cursor = 'grabbing'
  run('tab.dragStart', { tabId: tab.id })
  scheduleAutoscroll(session)
}

function beginRemote(over: TabDragOver): void {
  if (session) end(session, false)
  const rowEl = document.querySelector<HTMLElement>(
    `.zen-tab[data-tab-id="${CSS.escape(over.tabId)}"]`
  )
  const scroller =
    rowEl?.closest<HTMLElement>('[data-tab-scroller]') ??
    document.querySelector<HTMLElement>('[data-tab-scroller][data-active="true"]') ??
    document.querySelector<HTMLElement>('[data-tab-scroller]')
  const motion = scroller ? (listMotions.get(scroller) ?? null) : null
  const sample = rowEl ?? document.querySelector<HTMLElement>('.zen-tab')
  const rect = sample?.getBoundingClientRect()
  const width = rect?.width ?? 200
  const height = rect?.height ?? 36
  session = {
    tabId: over.tabId,
    remote: true,
    touch: false,
    list: rowEl && motion ? listOf(rowEl) : null,
    scroller,
    motion,
    slid: null,
    ...rowsChrome(rowEl),
    page: pageViewport(),
    dx: REMOTE_GRAB.dx,
    dy: REMOTE_GRAB.dy,
    width,
    height,
    pointer: { x: over.x, y: over.y },
    target: { kind: 'none' },
    reportedKey: undefined,
    settling: false,
    frame: null
  }
  live.x = over.x - REMOTE_GRAB.dx
  live.y = over.y - REMOTE_GRAB.dy
  const state = browserStore.get().state
  void captureActiveTab(state ? (activeTab(state)?.id ?? null) : null)
  uiStore.set({
    drag: {
      tabId: over.tabId,
      remote: true,
      title: over.title,
      favicon: over.favicon,
      width,
      height,
      tile: false,
      settling: false
    }
  })
  showGhost()
  scheduleAutoscroll(session)
}

/** The pointer let go over `x`, `y`. */
function drop(s: Session, x: number, y: number): void {
  const target = resolve(x, y, s)
  s.target = target
  switch (target.kind) {
    case 'slot': {
      if (target.stay || !target.key) {
        cancel(s)
        return
      }
      run('tab.drop', { tabId: s.tabId, key: target.key })
      run('tab.dragEnd', { tabId: s.tabId, x, y, outcome: 'cancel' })
      hideCaret()
      // The ghost glides into the gap its neighbours opened; the row shows there once it landed.
      settle(s, target.land, true)
      return
    }
    case 'key':
      run('tab.drop', { tabId: s.tabId, key: target.key })
      run('tab.dragEnd', { tabId: s.tabId, x, y, outcome: 'cancel' })
      hideCaret()
      settle(s, null, true)
      return
    case 'tearoff':
      run('tab.dragEnd', { tabId: s.tabId, x, y, outcome: 'release' })
      settle(s, null, false)
      return
    case 'none':
      cancel(s)
  }
}

/** Escape, a lost pointer, or a release over nothing: the row goes back where it came from. */
function cancel(s: Session): void {
  if (s.settling) return
  const { x, y } = s.pointer
  run('tab.dragEnd', { tabId: s.tabId, x, y, outcome: 'cancel' })
  s.slid?.slide(new Map())
  s.slid = null
  hideCaret()
  dropStore.set({ key: null, ghost: 'row', page: false })
  const own = ownRect(s)
  settle(s, own ? { x: own.left, y: own.top } : null, true)
}

/**
 * The ghost glides to where it belongs – its slot, or the gap – on one spring along the straight
 * path, launched with the pointer's release velocity; with nowhere to go it dissolves in place.
 */
function settle(s: Session, to: { x: number; y: number } | null, focusPage: boolean): void {
  s.settling = true
  if (s.frame !== null) cancelAnimationFrame(s.frame)
  s.frame = null
  document.body.style.cursor = ''
  uiStore.set((ui) => ({ drag: ui.drag ? { ...ui.drag, settling: true } : null }))
  const ghost = ghostEl
  const done = (): void => {
    if (session === s) end(s, focusPage)
  }
  const from = { x: live.x, y: live.y }
  const dx = to ? to.x - from.x : 0
  const dy = to ? to.y - from.y : 0
  const distance = Math.hypot(dx, dy)
  if (!to || distance < 0.5) {
    if (ghost) {
      ghost.style.transition = 'opacity 120ms var(--zen-ease)'
      ghost.style.opacity = '0'
    }
    setTimeout(done, to ? 0 : 130)
    return
  }
  const ux = dx / distance
  const uy = dy / distance
  const { vx, vy } = velocity.velocity(performance.now())
  const spring = new SpringAnimation(
    SPRING_GENTLE,
    (d) => placeGhostAt(from.x + ux * d, from.y + uy * d),
    () => {
      if (ghost) {
        ghost.style.transition = 'opacity 100ms var(--zen-ease)'
        ghost.style.opacity = '0'
      }
      setTimeout(done, 100)
    }
  )
  settleSpring = spring
  spring.start(0, vx * ux + vy * uy, distance)
}

function end(s: Session, focusPage: boolean): void {
  if (session !== s) return
  session = null
  settleSpring?.stop()
  settleSpring = null
  if (s.frame !== null) cancelAnimationFrame(s.frame)
  document.body.style.cursor = ''
  hideCaret()
  dropStore.set({ key: null, ghost: 'row', zones: false, page: false })
  uiStore.set({ drag: null })
  invalidateSnapshot()
  // Rows that slid for a drop that never committed (a cancel from the other window, a failed
  // tear-off) glide home; a commit that does land puts them right first.
  s.slid?.releaseSoon()
  if (focusPage) returnFocusToPage()
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function listRows(list: HTMLElement): HTMLElement[] {
  return [...list.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.tabId !== undefined
  )
}

function ownRect(s: Session): DOMRect | null {
  // A segment of a split row: its own box, not the row's (the row is the slot in the motion,
  // under its anchor's id, which may be this tab's).
  const segment = document.querySelector<HTMLElement>(
    `[data-split-row] .zen-tab[data-tab-id="${CSS.escape(s.tabId)}"]`
  )
  if (segment) return segment.getBoundingClientRect()
  const fromMotion = s.motion?.restingRect(s.tabId) ?? null
  if (fromMotion) return fromMotion
  return (
    document
      .querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(s.tabId)}"]`)
      ?.getBoundingClientRect() ?? null
  )
}

function within(el: HTMLElement | null | undefined, x: number, y: number): boolean {
  const r = el?.getBoundingClientRect()
  return Boolean(r && x >= r.left && x < r.right && y >= r.top && y < r.bottom)
}

function inSidebar(s: Session, x: number, y: number): boolean {
  return s.chrome.some((el) => within(el, x, y))
}

/**
 * The zones that take room of their own (an empty Essentials grid's "Drop here") are offered
 * once the pointer is in the sidebar above the tab panel, where nothing under it can shift –
 * or anywhere in the rail beside the frame, which holds no tab panel (§9.37).
 */
function offerZones(s: Session, x: number, y: number): void {
  if (dropStore.get().zones) return
  const aside = s.chrome.find((el) => el.matches('aside'))
  if (!aside || !within(aside, x, y) || !s.scroller) return
  const above = aside.contains(s.scroller)
    ? y < s.scroller.getBoundingClientRect().top
    : Boolean(s.band?.contains(s.scroller))
  if (above) dropStore.set({ zones: true })
}

/** The content viewport the split targets show over; the page is what tears a tab off. */
function pageViewport(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-tear-zone]')
}

/**
 * Whether the pointer is over the page (split-12): the split targets – the four edge zones,
 * the panes of the split on screen – are drawn while it is and not before, so a drag that
 * stays in the strip shows none; back in the strip they go again, the page being a target
 * only under the pointer (Edge). Read off the viewport's box, not hit-tested: the zones are
 * what would be hit, and they are not there yet.
 */
function trackPage(s: Session, x: number, y: number): void {
  const r = s.page?.getBoundingClientRect()
  const over = Boolean(r && x >= r.left && x < r.right && y >= r.top && y < r.bottom)
  if (dropStore.get().page !== over) dropStore.set({ page: over })
}

/**
 * What lies under the pointer, in this order: a drop-into target drawn over the lists (a folder
 * row, the Essentials grid, a space, the separator's pin zone, a split edge, the bookmarks bar)
 * wins; then a slot of the lifted row's own list, read off the rows' geometry; then a slot of
 * the tab list under the pointer; then a grid tile's edge; then the section's empty space; then
 * the page, which tears the tab off.
 */
function resolve(x: number, y: number, s: Session): DropTarget {
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return tearOff(s)
  const under = document.elementFromPoint(x, y)
  const dropEl = under?.closest<HTMLElement>('[data-drop]')
  const key = dropEl?.dataset.drop ?? null
  const kind = key?.slice(0, key.indexOf(':')) ?? null
  const overList = kind === 'tab' || key?.startsWith('section:regular:')
  if (key && kind && !overList)
    return {
      kind: 'key',
      key,
      caret: null,
      into: kind === 'folder' || kind === 'section' || kind === 'space' || kind === 'bookmark'
    }
  const own = s.list && s.motion ? resolveSlot(x, y, s, s.list, s.motion) : null
  if (own) return own
  // The list under the pointer; in the empty space under a panel's rows, its regular list.
  const scroller = under?.closest<HTMLElement>('[data-tab-scroller]') ?? null
  const listEl =
    under?.closest<HTMLElement>('[data-tab-list]') ??
    scroller?.querySelector<HTMLElement>('[data-tab-list="regular"]') ??
    null
  const motion = scroller ? listMotions.get(scroller) : undefined
  if (listEl && listEl !== s.list && motion) {
    const slot = resolveSlot(x, y, s, listEl, motion)
    if (slot) return slot
  }
  if (key && kind && dropEl) {
    if (key.startsWith(`tab:${s.tabId}:`)) return { kind: 'none' }
    // A grid tile's edge (Essentials): the tile draws its own vertical caret.
    if (kind === 'tab') return { kind: 'key', key, caret: null, into: false }
    return { kind: 'key', key, caret: null, into: true }
  }
  if (under?.closest('[data-tear-zone]')) return tearOff(s)
  // A tab of the strip pulled down past the band (§9.37: 16 past it) leaves the window – over
  // the toolbar row, the bookmarks bar, whatever lies there that is no target of its own. Not
  // over the rail: that is the window's chrome still, its zones on offer, and a release there
  // sends the row home like the sidebar's empty space does.
  if (
    s.band &&
    s.band.contains(s.scroller) &&
    y > s.band.getBoundingClientRect().bottom + STRIP_TEAR_PAST &&
    !inSidebar(s, x, y)
  )
    return tearOff(s)
  return { kind: 'none' }
}

/** The page, or past the window: the tab leaves the window – except from a finger (TABLET-02). */
function tearOff(s: Session): DropTarget {
  return s.touch ? { kind: 'none' } : { kind: 'tearoff' }
}

/**
 * A box read along a list's axis: `start` / `end` along it (top / bottom of a row in a column,
 * left / right of a tab along the strip), `cross` / `size` across it.
 */
interface AxisBox {
  start: number
  end: number
  cross: number
  size: number
}

function along(r: DOMRect, axis: Axis): AxisBox {
  return axis === 'y'
    ? { start: r.top, end: r.bottom, cross: r.left, size: r.width }
    : { start: r.left, end: r.right, cross: r.top, size: r.height }
}

/**
 * The slot of `list` under the pointer, read off the rows as drawn, not hit-tested: the pointer
 * over the gap the neighbours opened must keep resolving to that gap. When the lifted row is one
 * of the rows its slot is the hole; otherwise the hole is past the end and the incoming row is
 * as tall as the list's rows. The band runs from the first row to the last; for the regular
 * list it reaches down to the end of the scroller, so the empty space under the rows means
 * "after the last one". Read along the list's axis (`motion.axis`): the sidebar's column, or
 * the strip along the caption band (§9.37) where the same rules run left to right and the
 * caret stands upright in the gap.
 */
function resolveSlot(
  x: number,
  y: number,
  s: Session,
  list: HTMLElement,
  motion: SlideMotion
): DropTarget | null {
  const axis = motion.axis
  const pointer = axis === 'y' ? y : x
  const across = axis === 'y' ? x : y
  const rows = listRows(list)
  // A split group's row stands under its anchor's id but is not the hole a lifted segment left:
  // the row stays, with the segment's slot open in it, and the segment lands like a row from
  // elsewhere (§9.35; the core takes it out of the split unless it lands beside a sibling).
  const ownEl =
    rows.find((r) => r.dataset.tabId === s.tabId && r.dataset.splitRow === undefined) ?? null
  const others = rows.filter((r) => r !== ownEl)
  if (!ownEl && others.length === 0) return null
  const liftedAt = ownEl ? rows.indexOf(ownEl) : others.length
  const spans: Span[] = others.map((r) => {
    const rr = along(motion.restingRect(r.dataset.tabId ?? '') ?? r.getBoundingClientRect(), axis)
    return { start: rr.start, end: rr.end }
  })
  const gap = rowGap(list, axis)
  const band = along(list.getBoundingClientRect(), axis)
  let own: AxisBox
  if (ownEl) {
    own = along(motion.restingRect(s.tabId) ?? ownEl.getBoundingClientRect(), axis)
  } else {
    // The virtual hole after the last row, one row long.
    const last = spans[spans.length - 1] ?? { start: band.start, end: band.start }
    const sample = others[others.length - 1]?.getBoundingClientRect()
    const length = sample ? along(sample, axis).end - along(sample, axis).start : s.height
    const start = last.end + gap
    own = { start, end: start + length, cross: band.cross, size: band.size }
  }
  const first = Math.min(own.start, spans[0]?.start ?? own.start)
  let last = Math.max(own.end, spans[spans.length - 1]?.end ?? own.end)
  const scroller = list.closest<HTMLElement>('[data-tab-scroller]')
  if (list.dataset.tabList === 'regular' && scroller)
    last = Math.max(last, along(scroller.getBoundingClientRect(), axis).end)
  if (across < band.cross || across > band.cross + band.size || pointer < first || pointer > last)
    return null
  const mids = others.map((r) => {
    const v = along(motion.visualRect(r.dataset.tabId ?? '') ?? r.getBoundingClientRect(), axis)
    return (v.start + v.end) / 2
  })
  const index = slotAt(pointer, mids)
  const ids = others.map((r) => r.dataset.tabId ?? '')
  const named = slotKey(ids, liftedAt, index)
  // A row from elsewhere never "stays": past the end it lands after the last row – unless the
  // slot is named by the lifted tab itself (the split row it anchors), which is its own.
  const key = named.key
  const stay = ownEl ? named.stay : Boolean(key?.startsWith(`tab:${s.tabId}:`))
  const centre = gapCentre(liftedAt, index, spans, own)
  // The caret in the gap, inset from the row's ends (8 along a column's row; 4 along the
  // strip's 32 row, the Essentials grid's upright caret), and where the ghost lands: its slot's
  // start edge, centred on the gap along the axis.
  const caret: Caret =
    axis === 'y'
      ? { x: own.cross + 8, y: centre, width: own.size - 16 }
      : { axis: 'x', x: centre, y: own.cross + 4, height: own.size - 8 }
  const land =
    axis === 'y'
      ? { x: own.cross, y: centre - s.height / 2 }
      : { x: centre - s.width / 2, y: own.cross }
  return {
    kind: 'slot',
    key,
    stay,
    index,
    liftedAt,
    caret,
    land,
    motion,
    rows: others,
    shift: own.end - own.start + gap
  }
}

function rowGap(list: HTMLElement | null, axis: Axis = 'y'): number {
  if (!list) return 0
  const style = getComputedStyle(list)
  return parseFloat(axis === 'y' ? style.rowGap : style.columnGap) || 0
}

// ---------------------------------------------------------------------------
// Feedback: the ghost, the caret, the sliding rows
// ---------------------------------------------------------------------------

/**
 * The feedback for a target: the drop key and ghost shape for the components, the rows of the
 * slot's list slid open (any other list slid for an earlier target glides home), the caret.
 */
function apply(target: DropTarget, s: Session): void {
  s.target = target
  const key = target.kind === 'slot' || target.kind === 'key' ? target.key : null
  const ghost: GhostKind =
    target.kind === 'tearoff' ? 'tearoff' : target.kind === 'key' && target.into ? 'into' : 'row'
  dropStore.set({ key, ghost })
  if (target.kind === 'slot') {
    const offsets = slideOffsets(target.liftedAt, target.index, target.rows.length, target.shift)
    const byId = new Map<string, number>()
    target.rows.forEach((r, j) => {
      if (offsets[j]) byId.set(r.dataset.tabId ?? '', offsets[j])
    })
    if (s.slid && s.slid !== target.motion) s.slid.slide(new Map())
    target.motion.slide(byId)
    s.slid = target.motion
  } else if (s.slid) {
    s.slid.slide(new Map())
    s.slid = null
  }
  const caret = target.kind === 'slot' ? target.caret : target.kind === 'key' ? target.caret : null
  if (caret) showCaret(caret)
  else hideCaret()
}

function placeGhost(pointerX: number, pointerY: number): void {
  const s = session
  if (!s) return
  placeGhostAt(pointerX - s.dx, pointerY - s.dy)
}

function placeGhostAt(x: number, y: number): void {
  live.x = x
  live.y = y
  if (ghostEl) ghostEl.style.transform = `translate3d(${x}px, ${y}px, 0)`
}

/** The caret sits in the gap and glides between slots on the spring; it never jumps. */
function showCaret(c: Caret): void {
  caret.show(c)
}

function hideCaret(): void {
  caret.hide()
}

/**
 * Near the list's top or bottom edge the list scrolls under the pointer, faster the closer to
 * the edge, and the target under the (still) pointer is re-read as it does.
 */
function scheduleAutoscroll(s: Session): void {
  const tick = (): void => {
    s.frame = null
    if (session !== s || s.settling) return
    const el = s.scroller
    if (el) {
      const { x, y } = s.pointer
      const axis: Axis = s.motion?.axis ?? 'y'
      const step = autoscrollStep(el.getBoundingClientRect(), x, y, axis)
      if (step !== 0) {
        const before = axis === 'y' ? el.scrollTop : el.scrollLeft
        if (axis === 'y') el.scrollTop += step
        else el.scrollLeft += step
        const after = axis === 'y' ? el.scrollTop : el.scrollLeft
        if (after !== before) apply(resolve(x, y, s), s)
      }
    }
    s.frame = requestAnimationFrame(tick)
  }
  s.frame = requestAnimationFrame(tick)
}
