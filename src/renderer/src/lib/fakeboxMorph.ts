/**
 * The phone new tab page's field becoming the omnibox and back (NTP-02 / MOT-08): the impure half
 * of `lib/motion/fakebox.ts`. It keeps the machine's state, measures the field, the pill's slot and
 * the omnibox's field, runs the one spring, writes the morph's values to the root once per frame
 * (`--zen-ntp-morph`, read by the sheet, the bar and the page; `--zen-ntp-pill`, read by the
 * pill's slot), and hooks the omnibox's open and close: a tap opens the bar as the field sets
 * out, a dismissal is held until the field has run back. `FakeboxMorphLayer` paints the field's
 * double from the pose handed to it here.
 *
 * Nothing here runs unless a new tab page has registered its field, and the desktop never does.
 * Under reduced motion (v2 §11.3) the spring's part is a cut: the machine still runs, so the
 * omnibox is held for the stylesheet's 120 ms fade in place, but the double is not drawn for a
 * tap or a dismissal and the page's own field fades with the page. The scroll scrub is the
 * finger's own motion, like the bar's hide (#200, §11.5), and follows it one to one either way.
 */
import type { Rect } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import {
  backPulled,
  dismissed,
  drawsSurface,
  FAKEBOX_REST,
  landed,
  omniboxUp,
  poseOf,
  progressed,
  scrolled,
  scrubTravel,
  segmentTravel,
  showsOmniboxField,
  showsPageField,
  tapped,
  targetPose,
  type FakeboxGeometry,
  type FakeboxPhase,
  type FakeboxPose,
  type FakeboxState
} from './motion/fakebox'
import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from './motion/spring'
import { viewportStore } from './formFactor'
import { activeTab } from './selectors'
import { createStore } from './store'
import {
  browserStore,
  closeUrlbar,
  contentAreaStore,
  interceptUrlbarClose,
  openUrlbar,
  returnFocusToPage,
  uiStore,
  type UrlbarCloseOptions
} from './ui'

/**
 * What the root's `data-fakebox` says while the morph shows anything: the field carried part of
 * the way by the scroll (`scrub`), landed in the pill's slot (`docked`), on its way to the
 * omnibox (`opening`), arrived (`open`), pulled back by the predictive back gesture (`pulled`),
 * on its way back (`closing`). Absent at rest with the page unscrolled, and without a page.
 */
export type FakeboxLook = 'scrub' | 'docked' | 'opening' | 'open' | 'pulled' | 'closing'

/** What the React tree needs of the machine: it changes at the ends of a run, never per frame. */
export interface FakeboxMorphState {
  phase: FakeboxPhase
  /** The new tab page whose field is morphing (or scrubbed); null while no page has registered. */
  tabId: string | null
  look: FakeboxLook | null
  /** The field's double is painted (the page's field, the pill or the omnibox's field is not). */
  surface: boolean
  /** The page's own field is painted. */
  pageField: boolean
  /** The omnibox's own field is painted. */
  omniField: boolean
  /** The open omnibox is being pulled back by the predictive back gesture. */
  pulled: boolean
  /**
   * The pill's slot is the well (#27's, the slot a carried pill leaves): the field is the
   * address control, on the page or in flight, as Chrome's toolbar has no omnibox while the
   * fakebox is on the page. False once the scroll has docked the field in the slot.
   */
  away: boolean
}

const IDLE: FakeboxMorphState = {
  phase: 'rest',
  tabId: null,
  look: null,
  surface: false,
  pageField: true,
  omniField: false,
  pulled: false,
  away: false
}

export const fakeboxMorphStore = createStore<FakeboxMorphState>(IDLE, 'fakebox-morph')

/**
 * Whether the morph holds the chrome's layout: the bar stays mounted (fading on the value) and
 * the page stays painted while the field is on its way, and while a back gesture pulls it.
 */
export function fakeboxHoldsChrome(s: FakeboxMorphState): boolean {
  return s.phase === 'opening' || s.phase === 'closing' || s.pulled
}

/** The spring: SNAPPY's, the swipes' and the FLIP glides' (v2 §11), on the poses' distance. */
export const SPRING_FAKEBOX = SPRING_SNAPPY

/** Under reduced motion the omnibox arrives and leaves on a 120 ms fade in place (v2 §11.3). */
export const FAKEBOX_REDUCED_FADE_MS = 120

/** The morph's value on the root: 0 the page's, 1 the omnibox's. */
export const FAKEBOX_VAR = '--zen-ntp-morph'
/** The handover to the pill on the root: 0 the field's, 1 the pill's slot filled in. */
export const FAKEBOX_PILL_VAR = '--zen-ntp-pill'

interface Registration {
  tabId: string
  field: HTMLElement
  scroller: HTMLElement | null
}

let registration: Registration | null = null
let machine: FakeboxState = FAKEBOX_REST
let geometry: FakeboxGeometry | null = null
let travel = 120
/** The close a dismissal handed over, to be finished when the field has landed. */
let heldClose: UrlbarCloseOptions | null = null
let finishing = false
let reducedTimer: ReturnType<typeof setTimeout> | null = null
let openSeq = 0
let painter: ((pose: FakeboxPose, state: FakeboxState) => void) | null = null
let stopWatching: (() => void) | null = null

const spring = new SpringAnimation(
  SPRING_FAKEBOX,
  (x) => {
    setMachine(progressed(machine, x / travel))
  },
  () => {
    setMachine(progressed(machine, 1))
    // The 120 ms fade the stylesheet runs under reduced motion needs the phase held that long.
    if (reducedMotion()) {
      reducedTimer = setTimeout(() => {
        reducedTimer = null
        land()
      }, FAKEBOX_REDUCED_FADE_MS)
    } else land()
  }
)

/** The layer's paint callback: called with the pose once per frame while it is registered. */
export function setFakeboxPainter(
  fn: ((pose: FakeboxPose, state: FakeboxState) => void) | null
): void {
  painter = fn
  if (fn && geometry) fn(poseOf(machine, geometry), machine)
}

/** The pose the field is in now (for a layer mounting mid-flight); null before any measure. */
export function currentFakeboxPose(): FakeboxPose | null {
  return geometry ? poseOf(machine, geometry) : null
}

/**
 * A new tab page mounted its field: from now on the field's taps and the page's scroll drive
 * the morph for `tabId`. Returns the release; the page unmounting (the tab navigated, closed or
 * left) puts everything back and lets a held close through.
 */
export function registerFakebox(
  tabId: string,
  field: HTMLElement,
  scroller: HTMLElement | null
): () => void {
  const mine: Registration = { tabId, field, scroller }
  registration = mine
  measure()
  if (scroller) machine = scrolled(machine, scroller.scrollTop, geometry ?? measure())
  publish()
  paint()
  watch()
  return () => {
    if (registration !== mine) return
    registration = null
    reset()
  }
}

/** The page scrolled: the field is carried toward the pill's slot with it. */
export function fakeboxScrolled(offset: number): void {
  if (!registration) return
  const g = geometry ?? measure()
  setMachine(scrolled(machine, offset, g))
}

/** Whether the pill's slot is the well: the field is the address control elsewhere. */
export function fakeboxAway(): boolean {
  return fakeboxMorphStore.get().away
}

/**
 * The scroll offset at which the field has docked in the pill's slot (the page's field having
 * left the frame), for a driver scrolling the page to a pose; null without a page.
 */
export function fakeboxScrubTravel(): number | null {
  if (!registration) return null
  return scrubTravel(geometry ?? measure())
}

/**
 * The field was tapped (or its double, mid-flight, or the well the field left in the bar): the
 * field sets out for the omnibox on the spring from wherever it is and the omnibox opens under
 * it. From the pill's slot (scrubbed all the way) there is nothing left to morph: the bar opens
 * as a tap on the pill opens it.
 */
export function tapFakebox(): void {
  const reg = registration
  if (!reg) return
  const g = measure()
  if (machine.phase === 'rest' && (machine.scrub >= 1 || uiStore.get().urlbar.open)) {
    if (!uiStore.get().urlbar.open) void openUrlbar('edit', reg.tabId, { attached: true })
    return
  }
  if (machine.phase === 'opening' || machine.phase === 'open') return
  const wasClosing = machine.phase === 'closing'
  const caught = spring.stop()
  setMachine(tapped(machine, g))
  if (wasClosing) {
    // The bar is still up (its close is held): the field turns round with the velocity it had,
    // and the tap only has to give the bar the keyboard back.
    heldClose = null
    startSegment(-caught.v)
    document.querySelector<HTMLInputElement>('[data-testid="urlbar-input"]')?.focus()
    return
  }
  // The omnibox opens under the field; the field sets out once the bar is up (the same turn on
  // a host with nothing to capture, a frame later otherwise), so the sheet is there to fade in
  // with it from the first frame rather than appearing part-way.
  const seq = ++openSeq
  void openUrlbar('edit', reg.tabId, { attached: true }).then(() => {
    if (seq !== openSeq || machine.phase !== 'opening' || spring.running) return
    measure()
    startSegment(0)
  })
}

/**
 * A preview's hold (src/android/previewStates.ts, `ntp=morph:<t>`): the field stopped at `t` of
 * the way from the page to the omnibox, the bar open under it. For stills; never on a device.
 */
export function holdFakeboxMorph(t: number): void {
  const reg = registration
  if (!reg) return
  if (machine.phase === 'rest') {
    tapFakebox()
    // The spring has not started (the bar opens first): hold it before it does.
    openSeq++
  }
  spring.stop()
  if (reducedTimer) {
    clearTimeout(reducedTimer)
    reducedTimer = null
  }
  measure()
  setMachine(progressed(machine, t))
}

/**
 * The predictive back gesture on the open omnibox: the field follows the finger back toward the
 * page. Only while the morph owns the bar; returns whether it did (the omnibox paints its own
 * pull otherwise).
 */
export function fakeboxBackPulled(value: number): boolean {
  if (!registration || !geometry || !omniboxUp(machine)) return false
  setMachine(backPulled(machine, value))
  return true
}

/** Whether the omnibox on screen is the one the field morphed into. */
export function fakeboxOwnsUrlbar(): boolean {
  const ui = uiStore.get().urlbar
  return (
    registration !== null &&
    omniboxUp(machine) &&
    ui.open &&
    ui.tabId === registration.tabId &&
    ui.attached
  )
}

// ---------------------------------------------------------------------------
// The close hook
// ---------------------------------------------------------------------------

/**
 * `closeUrlbar` asks before closing. A dismissal while the field is up or on its way is held:
 * the field runs back on the same spring and the bar closes as it lands, its sheet fading on the
 * value meanwhile. A submit, a navigation or another surface's close goes through at once, the
 * morph reset with it.
 */
interceptUrlbarClose((opts) => {
  if (finishing || !registration || !geometry || !omniboxUp(machine)) return false
  if (opts.reason !== 'dismiss' || !pageStillHere()) {
    // The close under way is the one that counts: nothing held is finished on top of it.
    heldClose = null
    reset()
    return false
  }
  if (machine.phase === 'closing') {
    heldClose = { ...heldClose, ...opts }
    return true
  }
  const caught = spring.stop()
  const wasFlying = machine.phase === 'opening'
  setMachine(dismissed(machine, geometry))
  heldClose = opts
  startSegment(wasFlying ? -caught.v : 0)
  // The keyboard goes as the field sets off, not when it has landed (Chrome's unfocus).
  if (!opts.keepKeyboard) returnFocusToPage()
  return true
})

function finishHeldClose(): void {
  const opts = heldClose
  heldClose = null
  if (!opts) return
  finishing = true
  try {
    closeUrlbar(opts)
  } finally {
    finishing = false
  }
}

// ---------------------------------------------------------------------------
// The machine's plumbing
// ---------------------------------------------------------------------------

function startSegment(velocity: number): void {
  if (!geometry) return
  const from = poseOf(machine, geometry)
  const to = targetPose(machine, geometry)
  travel = segmentTravel(from, to)
  if (reducedTimer) {
    clearTimeout(reducedTimer)
    reducedTimer = null
  }
  spring.start(0, velocity, travel)
}

function land(): void {
  const next = landed(machine)
  if (machine.phase === 'closing') {
    // The bar's close and the field's landing are one commit: the bar goes first, so no frame
    // has the omnibox up without the morph fading it.
    machine = next
    finishHeldClose()
    publish()
    paint()
    return
  }
  setMachine(next)
}

function setMachine(next: FakeboxState): void {
  if (next === machine) return
  machine = next
  publish()
  paint()
}

function lookOf(s: FakeboxState): FakeboxLook | null {
  switch (s.phase) {
    case 'rest':
      return s.scrub <= 0 ? null : s.scrub >= 1 ? 'docked' : 'scrub'
    case 'opening':
      return 'opening'
    case 'open':
      return s.back > 0 ? 'pulled' : 'open'
    case 'closing':
      return 'closing'
  }
}

function publish(): void {
  const registered = registration !== null
  // Under reduced motion the spring's part is a fade in place: no double for a tap, a pull or a
  // dismissal (the scrub's is the finger's and stays), and the page's own field, when the page
  // had it, fades out with the page rather than yielding to a double.
  const cut = reducedMotion() && machine.phase !== 'rest'
  const next: FakeboxMorphState = {
    phase: machine.phase,
    tabId: registration?.tabId ?? null,
    look: registered ? lookOf(machine) : null,
    surface: registered && !cut && drawsSurface(machine),
    pageField: !registered || showsPageField(machine) || (cut && machine.scrub === 0),
    omniField: registered && showsOmniboxField(machine),
    pulled: registered && machine.phase === 'open' && machine.back > 0,
    away: registered && !(machine.phase === 'rest' && machine.scrub >= 1)
  }
  const prev = fakeboxMorphStore.get()
  if (
    prev.phase !== next.phase ||
    prev.tabId !== next.tabId ||
    prev.look !== next.look ||
    prev.surface !== next.surface ||
    prev.pageField !== next.pageField ||
    prev.omniField !== next.omniField ||
    prev.pulled !== next.pulled ||
    prev.away !== next.away
  ) {
    fakeboxMorphStore.set(next)
    const root = document.documentElement
    if (next.look) root.dataset.fakebox = next.look
    else delete root.dataset.fakebox
  }
}

function paint(): void {
  const root = document.documentElement.style
  if (!geometry || !registration) {
    root.removeProperty(FAKEBOX_VAR)
    root.removeProperty(FAKEBOX_PILL_VAR)
    return
  }
  const pose = poseOf(machine, geometry)
  root.setProperty(FAKEBOX_VAR, pose.open.toFixed(4))
  root.setProperty(FAKEBOX_PILL_VAR, pose.pill.toFixed(4))
  painter?.(pose, machine)
}

/** Whether the page the field belongs to is still the active tab's, and still blank. */
function pageStillHere(): boolean {
  const reg = registration
  const state = browserStore.get().state
  if (!reg || !state) return false
  const tab = activeTab(state)
  return tab !== null && tab.id === reg.tabId && tab.url === BLANK_URL
}

/**
 * Everything back to rest: the spring stopped, the values at 0, a held close let through. The
 * page's scrub is re-read from its scroller if it is still there.
 */
function reset(): void {
  spring.stop()
  openSeq++
  if (reducedTimer) {
    clearTimeout(reducedTimer)
    reducedTimer = null
  }
  machine = FAKEBOX_REST
  const scroller = registration?.scroller
  if (scroller && geometry) machine = scrolled(machine, scroller.scrollTop, geometry)
  if (!registration) {
    geometry = null
    unwatch()
  }
  publish()
  paint()
  finishHeldClose()
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

const rectOf = (el: Element | null): Rect | null => {
  if (!el) return null
  const b = el.getBoundingClientRect()
  return { x: b.left, y: b.top, width: b.width, height: b.height }
}

const EMPTY: Rect = { x: 0, y: 0, width: 0, height: 0 }

/**
 * The field's natural rectangle (with the page unscrolled), the pill's slot and the omnibox's
 * field – the omnibox's own once it is up, the bar's row until then – and the frame's top edge,
 * all in window coordinates. Read again whenever the layout may have moved (the insets, the
 * viewport, the bar coming and going), never per frame.
 */
function measure(): FakeboxGeometry {
  const reg = registration
  const last = geometry ?? { rest: EMPTY, slot: EMPTY, omnibox: EMPTY, frameTop: 0 }
  if (!reg) return last
  const fieldRect = rectOf(reg.field)
  const rest =
    fieldRect && fieldRect.width > 0
      ? { ...fieldRect, y: fieldRect.y + (reg.scroller?.scrollTop ?? 0) }
      : last.rest
  const bar = '.zen-phone-bar:not([aria-hidden])'
  const omnibox =
    rectOf(document.querySelector('.zen-omnibox-field')) ??
    rectOf(document.querySelector(`${bar} .zen-phone-bar-row`)) ??
    last.omnibox
  const slot =
    rectOf(document.querySelector(`${bar} .zen-phone-pill`)) ??
    (last.slot.width > 0 ? last.slot : omnibox)
  const frameTop = contentAreaStore.get().area?.y ?? last.frameTop
  geometry = { rest, slot, omnibox, frameTop }
  return geometry
}

/**
 * The layout may have moved under the morph – the keyboard's inset, a rotation, the frame – so
 * the geometry is read again and the pose repainted toward the new target; the tab leaving or
 * navigating puts the morph back.
 */
function watch(): void {
  if (stopWatching) return
  const remeasure = (): void => {
    if (!registration) return
    measure()
    paint()
  }
  const unsubs = [
    // The insets: the bottom band rides the keyboard's; the bar comes and goes with the omnibox.
    uiStore.subscribe(remeasure),
    viewportStore.subscribe(remeasure),
    contentAreaStore.subscribe(remeasure),
    browserStore.subscribe(() => {
      if (!registration) return
      if (!pageStillHere() && omniboxUp(machine)) reset()
    })
  ]
  window.addEventListener('resize', remeasure)
  stopWatching = () => {
    for (const u of unsubs) u()
    window.removeEventListener('resize', remeasure)
  }
}

function unwatch(): void {
  stopWatching?.()
  stopWatching = null
}
