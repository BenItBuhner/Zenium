/**
 * The phone's address pill becoming the omnibox's field and back (MOT-07, Chrome's omnibox focus
 * animation): the impure half of `lib/motion/omniboxFocus.ts`. It keeps the machine's state,
 * measures the pill's slot in the bar band once at the tap, runs the one spring, writes the
 * value to the root once per frame (`--zen-omnibox-focus`, read by the bar's buttons and pill,
 * the omnibox's field and its suggestion card – transform and opacity only, `main.css`), and
 * hooks the omnibox's open and close: the pill's tap opens the bar as the field sets out, a
 * dismissal is held until the field has run back into the pill. The bar stays mounted under the
 * omnibox while the field is on its way either way (`focusHoldsChrome`), so its buttons are seen
 * pushed off by the widening field and coming back as it narrows.
 *
 * Nothing here runs unless the pill was tapped over a page (`focusOmnibox`); the new tab page's
 * field has its own morph (`lib/fakeboxMorph.ts`, v2 §11.8) and the desktop never comes here.
 * Under reduced motion (§11.3) the spring's part is a cut: the machine still runs, so the phase
 * is held for the stylesheet's 120 ms fade in place, and nothing is pushed.
 */
import type { Rect } from '@shared/types'
import {
  atBar,
  backPulled,
  dismissed,
  focusTarget,
  focusTravel,
  focusValue,
  landed,
  OMNIBOX_FOCUS_REST,
  omniboxUp,
  progressed,
  slotGrowth,
  slotOf,
  tapped,
  type FocusSlot,
  type OmniboxFocusPhase,
  type OmniboxFocusState
} from './motion/omniboxFocus'
import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from './motion/spring'
import { createStore } from './store'
import {
  closeUrlbar,
  interceptUrlbarClose,
  openUrlbar,
  returnFocusToPage,
  uiStore,
  type UrlbarCloseOptions
} from './ui'

/**
 * What the root's `data-omnibox-focus` says while the motion owns the bar: the field on its way
 * to the omnibox (`opening`), arrived (`open`), pulled back by the predictive back gesture
 * (`pulled`), on its way back (`closing`). Absent at rest, and whenever the bar was opened by
 * anything but the pill.
 */
export type OmniboxFocusLook = 'opening' | 'open' | 'pulled' | 'closing'

/** What the React tree needs of the machine: it changes at the ends of a run, never per frame. */
export interface OmniboxFocusStoreState {
  phase: OmniboxFocusPhase
  look: OmniboxFocusLook | null
}

const IDLE: OmniboxFocusStoreState = { phase: 'rest', look: null }

export const omniboxFocusStore = createStore<OmniboxFocusStoreState>(IDLE, 'omnibox-focus')

/**
 * Whether the motion holds the chrome's layout: the bar stays mounted under the omnibox while
 * the field is on its way, and while a back gesture holds it part way, so the buttons leave
 * and come back rather than cut.
 */
export function focusHoldsChrome(s: OmniboxFocusStoreState): boolean {
  return s.phase === 'opening' || s.phase === 'closing' || s.look === 'pulled'
}

/** The spring: SNAPPY's, the swipes' and the field morph's (v2 §11), over the field's growth. */
export const SPRING_FOCUS = SPRING_SNAPPY

/** Under reduced motion the omnibox arrives and leaves on a 120 ms fade in place (v2 §11.3). */
export const FOCUS_REDUCED_FADE_MS = 120

/** The value on the root: 0 the pill's pose, 1 the omnibox's. */
export const FOCUS_VAR = '--zen-omnibox-focus'
/** The slot on the root, written once at the tap: the two gaps the buttons leave, the pill's share. */
export const FOCUS_SLOT_LEFT_VAR = '--zen-omnibox-slot-left'
export const FOCUS_SLOT_RIGHT_VAR = '--zen-omnibox-slot-right'
export const FOCUS_SLOT_SCALE_VAR = '--zen-omnibox-slot-scale'

let machine: OmniboxFocusState = OMNIBOX_FOCUS_REST
let slot: FocusSlot | null = null
let travel = 120
/** The close a dismissal handed over, to be finished when the field has landed in the pill. */
let heldClose: UrlbarCloseOptions | null = null
let finishing = false
let reducedTimer: ReturnType<typeof setTimeout> | null = null
let openSeq = 0
/** The bar is up under the motion (its open has gone through): a bar found closed is a reset. */
let owning = false

const spring = new SpringAnimation(
  SPRING_FOCUS,
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
      }, FOCUS_REDUCED_FADE_MS)
    } else land()
  }
)

/**
 * The pill was tapped over a page: the omnibox opens for `activeTabId` (in edit mode; the
 * new-tab bar without a tab) as the field sets out from the pill's slot on the spring. While a
 * closing run is still up (its close held) the field turns round with the velocity it had, and
 * the tap only has to give the bar the keyboard back. Without a bar to measure – the pill is
 * not on screen – the bar opens as it always did, on its own entrance.
 */
export function focusOmnibox(activeTabId: string | null): void {
  const mode = activeTabId ? 'edit' : 'new-tab'
  if (machine.phase === 'closing') {
    const caught = spring.stop()
    heldClose = null
    setMachine(tapped(machine))
    startSegment(-caught.v)
    document.querySelector<HTMLInputElement>('[data-testid="urlbar-input"]')?.focus()
    return
  }
  if (machine.phase !== 'rest' || uiStore.get().urlbar.open) return
  const measured = measure()
  if (!measured) {
    void openUrlbar(mode, activeTabId, { attached: true })
    return
  }
  slot = measured
  writeSlot(measured)
  setMachine(tapped(machine))
  // The omnibox opens under the field; the field sets out once the bar is up (the same turn on
  // a host with nothing to capture, a frame later otherwise), so the sheet is there to fade in
  // with it from the first frame rather than appearing part-way.
  const seq = ++openSeq
  void openUrlbar(mode, activeTabId, { attached: true }).then(() => {
    if (seq !== openSeq || machine.phase !== 'opening' || spring.running) return
    if (!uiStore.get().urlbar.open) {
      reset()
      return
    }
    owning = true
    startSegment(0)
  })
}

/**
 * The predictive back gesture on the open omnibox: the field follows the finger back toward the
 * pill, the buttons coming back with it. Only while the motion owns the bar; returns whether it
 * did (the omnibox paints its own pull otherwise – under reduced motion too, where nothing
 * follows a finger and the gesture's commit runs the cut's fade like any dismissal). A field
 * still on its spring keeps flying: the pull paints nothing, and the commit is a dismissal.
 */
export function focusBackPulled(value: number): boolean {
  if (!omniboxUp(machine) || reducedMotion()) return false
  setMachine(backPulled(machine, value))
  return true
}

/**
 * Whether a back's commit on the bar the pill grew into – the gesture let go at `value`, 0 for
 * a back key – is the motion's to run rather than the bar's spring's. It is whenever the field
 * has not followed the pull: still on its spring toward the omnibox (a commit mid-flight), or
 * landed with nothing pulled (a back key; a flick that ended as it landed). The close hook then
 * runs the closing segment from where the field is, with the velocity carried. A field the
 * finger has pulled part way is the bar's spring's: it follows it home (`focusBackPulled`), and
 * the close comes at once when it lands. Under reduced motion nothing follows a pull, so only
 * the back key is the motion's: the cut's fade runs at once.
 */
export function focusTakesCommit(value: number): boolean {
  if (!focusOwnsUrlbar()) return false
  if (reducedMotion()) return value <= 0
  return machine.phase === 'opening' || machine.back <= 0
}

/** Whether the omnibox on screen is the one the pill grew into. */
export function focusOwnsUrlbar(): boolean {
  return omniboxUp(machine) && uiStore.get().urlbar.open
}

// ---------------------------------------------------------------------------
// The close hook
// ---------------------------------------------------------------------------

/**
 * `closeUrlbar` asks before closing. A dismissal while the field is up or on its way is held:
 * the field runs back into the pill on the same spring, the bar mounted again beneath it, and
 * the bar closes as it lands. A submit, a navigation or another surface's close goes through at
 * once, the motion reset with it (the bar comes back whole, as Chrome's does on a submit).
 */
interceptUrlbarClose((opts) => {
  if (finishing || !omniboxUp(machine)) return false
  if (opts.reason !== 'dismiss') {
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
  const back = dismissed(machine)
  if (atBar(back)) {
    // Nothing to run back: the field is in the pill already – the back gesture's commit after
    // its pull, or a dismissal before the bar came up – so the bar closes now rather than
    // holding its scrim over the page for the spring's settling time.
    reset()
    return false
  }
  setMachine(back)
  heldClose = opts
  startSegment(wasFlying ? -caught.v : 0)
  // The keyboard goes as the field sets off, not when it has landed (Chrome's unfocus).
  if (!opts.keepKeyboard) returnFocusToPage()
  return true
})

// The bar closed under the motion by a path that never asked – nothing does today, but a
// machine left `open` with no omnibox would refuse the next tap. Only once the open has gone
// through: the capture the open waits for writes the store while the bar is still on its way.
uiStore.subscribe(() => {
  if (owning && !finishing && !uiStore.get().urlbar.open) reset()
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
  const growth = slot ? slotGrowth(slot) : 0
  travel = focusTravel(focusValue(machine), focusTarget(machine), growth)
  if (reducedTimer) {
    clearTimeout(reducedTimer)
    reducedTimer = null
  }
  if (travel <= 0) {
    setMachine(progressed(machine, 1))
    land()
    return
  }
  spring.start(0, velocity, travel)
}

function land(): void {
  const next = landed(machine)
  if (machine.phase === 'closing') {
    // The bar's close and the field's landing are one commit: the bar goes first, so no frame
    // has the omnibox up without the motion fading it.
    machine = next
    slot = null
    owning = false
    finishHeldClose()
    publish()
    paint()
    return
  }
  setMachine(next)
}

function setMachine(next: OmniboxFocusState): void {
  if (next === machine) return
  machine = next
  publish()
  paint()
}

function lookOf(s: OmniboxFocusState): OmniboxFocusLook | null {
  switch (s.phase) {
    case 'rest':
      return null
    case 'opening':
      return 'opening'
    case 'open':
      return s.back > 0 ? 'pulled' : 'open'
    case 'closing':
      return 'closing'
  }
}

function publish(): void {
  const next: OmniboxFocusStoreState = { phase: machine.phase, look: lookOf(machine) }
  const prev = omniboxFocusStore.get()
  if (prev.phase !== next.phase || prev.look !== next.look) {
    omniboxFocusStore.set(next)
    const root = document.documentElement
    if (next.look) root.dataset.omniboxFocus = next.look
    else delete root.dataset.omniboxFocus
  }
}

function paint(): void {
  const root = document.documentElement.style
  if (!omniboxUp(machine)) {
    root.removeProperty(FOCUS_VAR)
    root.removeProperty(FOCUS_SLOT_LEFT_VAR)
    root.removeProperty(FOCUS_SLOT_RIGHT_VAR)
    root.removeProperty(FOCUS_SLOT_SCALE_VAR)
    return
  }
  root.setProperty(FOCUS_VAR, focusValue(machine).toFixed(4))
}

function writeSlot(s: FocusSlot): void {
  const root = document.documentElement.style
  root.setProperty(FOCUS_SLOT_LEFT_VAR, `${s.left.toFixed(2)}px`)
  root.setProperty(FOCUS_SLOT_RIGHT_VAR, `${s.right.toFixed(2)}px`)
  root.setProperty(FOCUS_SLOT_SCALE_VAR, s.scale.toFixed(4))
}

/** Everything back to rest: the spring stopped, the value gone, a held close let through. */
function reset(): void {
  spring.stop()
  openSeq++
  if (reducedTimer) {
    clearTimeout(reducedTimer)
    reducedTimer = null
  }
  machine = OMNIBOX_FOCUS_REST
  slot = null
  owning = false
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

/**
 * The pill's slot in the bar that is up: the bar row (the band the field will fill – the
 * omnibox's field band has the row's box exactly) and the pill inside it, read once at the tap,
 * never per frame. Null without a bar on screen.
 */
function measure(): FocusSlot | null {
  const bar = document.querySelector('.zen-phone-bar:not([aria-hidden])')
  const band = rectOf(bar?.querySelector('.zen-phone-bar-row') ?? null)
  const pill = rectOf(bar?.querySelector('.zen-phone-pill') ?? null)
  if (!band || !pill) return null
  return slotOf(band, pill)
}
