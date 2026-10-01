/**
 * The page-edge band's model (motion spec §3.2) – which prompt the band shows, and for how long.
 * Host-free: the desktop and Android hosts tell it which tab is in front and whether a band may
 * show on it at all (not on the new tab page, not on a chrome page, not while a sheet or dialog
 * stands, not with the keyboard up over the page's field), the tenants `showBand` their prompts,
 * and `chooseBand` says what stands at the frame's edge. The motion is `lib/motion/band.ts`'s,
 * the drawing `components/band/`'s.
 *
 * - One band at a time. A newer offer replaces the standing offer in its scope (the same tab, or
 *   window-wide); the same `key` again replaces its earlier self. States are not replaced: they
 *   stand while the state holds, and the newest shows. Priority: state > offer; among offers the
 *   newer.
 * - The clock: an offer stands `BAND_CLOCK_MS` by default (`duration`), a state has none. The
 *   clock runs only while the offer is the one shown, the page is in front and no finger has it;
 *   paused, it keeps what was left and resumes with at least a moment (the house's rule for a
 *   message let go).
 * - Per tab: a tab-scoped band goes when its tab leaves the front (its clock pauses) and returns
 *   with it; a navigation to another document dismisses it (`dismissTabBands`). A window-wide
 *   band (`tabId: null`) stands on every page tab.
 */
import type { LucideIcon } from 'lucide-react'
import { BAND_HEIGHT_ONE_LINE, BAND_HEIGHT_TWO_LINE, type BandHeight } from './motion/band'
import { BAND_CLOCK_MS } from './motion/tokens'
import { createStore } from './store'

export type BandForm = 'state' | 'offer'

/**
 * A state's status ink for its glyph (§3.1): the chrome's ok / warn / danger inks; a state with
 * none (the default-browser prompt is no alarm) draws it in the deemphasised ink. An offer's
 * glyph is the accent whatever this says.
 */
export type BandTone = 'ok' | 'warn' | 'danger'

export type BandDismissReason =
  'action' | 'close' | 'swipe' | 'escape' | 'timeout' | 'navigation' | 'replaced' | 'program'

export interface BandAction {
  label: string
  onPick(): void
  /**
   * The band stands through the act: a state whose act ends it elsewhere (the default-browser
   * prompt's flow ends the state through the settings), not the band's own dismissal.
   */
  holds?: boolean
}

export interface BandEntry {
  id: number
  /** One per tenant; showing the same key again replaces its earlier self. */
  key: string
  form: BandForm
  /** The tab the prompt is about, or null for a prompt about the window (connectivity, default browser). */
  tabId: string | null
  /** The glyph before the title: the status ink for a state, the accent for an offer (§3.1). */
  icon: LucideIcon
  tone?: BandTone
  title: string
  detail?: string
  action?: BandAction
  /** The ×'s accessible name; the message close's "Dismiss" when absent. */
  closeLabel?: string
  /** The clock (ms); null stands while the state holds. */
  duration: number | null
  onDismiss?: (reason: BandDismissReason) => void
}

export interface BandOptions {
  key: string
  form: BandForm
  tabId?: string | null
  icon: LucideIcon
  tone?: BandTone
  title: string
  detail?: string
  action?: BandAction
  closeLabel?: string
  /** The clock; an offer's is `BAND_CLOCK_MS` unless given, a state's none. */
  duration?: number | null
  onDismiss?: (reason: BandDismissReason) => void
}

export interface BandState {
  /** Every prompt standing (shown or waiting), newest first. */
  entries: BandEntry[]
  /** The tab in front, as the host reports it. */
  front: string | null
  /** The host says a band may show on what is in front now. */
  eligible: boolean
  /** The host says offers may show on what is in front: false on a private tab (§3.2). */
  offers: boolean
  /** A finger has the shown band: its clock waits. */
  held: boolean
}

export const bandStore = createStore<BandState>(
  { entries: [], front: null, eligible: false, offers: true, held: false },
  'band'
)

/** The band's height for a prompt: two lines with a detail, one without (§3.1). */
export function bandHeightOf(entry: BandEntry): BandHeight {
  return entry.detail ? BAND_HEIGHT_TWO_LINE : BAND_HEIGHT_ONE_LINE
}

/** Whether `entry` is about the tab in front (or about the window). */
function inFront(entry: BandEntry, front: string | null): boolean {
  return entry.tabId === null || entry.tabId === front
}

/**
 * The prompt the band shows for `state`: null when none may (nothing stands for the front tab,
 * or the host withholds the band, or withholds offers there). States before offers; the newest
 * of each.
 */
export function chooseBand(state: BandState): BandEntry | null {
  if (!state.eligible) return null
  const candidates = state.entries.filter(
    (e) => inFront(e, state.front) && (e.form === 'state' || state.offers)
  )
  return candidates.find((e) => e.form === 'state') ?? candidates[0] ?? null
}

/** The shown prompt right now. */
export function shownBand(): BandEntry | null {
  return chooseBand(bandStore.get())
}

let seq = 0

/** The clocks: the one running (for the shown offer) and what each paused offer has left. */
let running: { id: number; timer: ReturnType<typeof setTimeout>; due: number } | null = null
const left = new Map<number, number>()
/** A clock resumed gets at least this long: a message let go has a moment before it leaves. */
const RESUME_FLOOR_MS = 1000

function pauseClock(): void {
  if (!running) return
  clearTimeout(running.timer)
  left.set(running.id, Math.max(0, running.due - Date.now()))
  running = null
}

/** Run the clock of the shown offer (if it is an offer, unheld, in front) and no other. */
function syncClock(): void {
  const s = bandStore.get()
  const shown = chooseBand(s)
  const wants = shown !== null && shown.duration !== null && !s.held
  if (running && (!wants || running.id !== shown.id)) pauseClock()
  if (!wants || running) return
  const ms = left.has(shown.id) ? Math.max(left.get(shown.id)!, RESUME_FLOOR_MS) : shown.duration!
  left.delete(shown.id)
  const id = shown.id
  running = {
    id,
    due: Date.now() + ms,
    timer: setTimeout(() => {
      running = null
      dismissBand(id, 'timeout')
    }, ms)
  }
}

/**
 * Stand a prompt at the band. An offer replaces the standing offer of its scope and its own
 * earlier self; a state joins the states standing. Returns the entry's id.
 */
export function showBand(opts: BandOptions): number {
  const id = ++seq
  const tabId = opts.tabId ?? null
  const entry: BandEntry = {
    id,
    key: opts.key,
    form: opts.form,
    tabId,
    icon: opts.icon,
    tone: opts.tone,
    title: opts.title,
    detail: opts.detail,
    action: opts.action,
    closeLabel: opts.closeLabel,
    duration:
      opts.duration === undefined ? (opts.form === 'offer' ? BAND_CLOCK_MS : null) : opts.duration,
    onDismiss: opts.onDismiss
  }
  const sameScope = (e: BandEntry): boolean =>
    e.tabId === null || tabId === null || e.tabId === tabId
  for (const e of bandStore.get().entries) {
    if (e.key === opts.key) dismissBand(e.id, 'replaced')
    else if (opts.form === 'offer' && e.form === 'offer' && sameScope(e))
      dismissBand(e.id, 'replaced')
  }
  bandStore.set((s) => ({ entries: [entry, ...s.entries] }))
  syncClock()
  return id
}

/** Take a prompt down; its `onDismiss` hears why, once. */
export function dismissBand(id: number, reason: BandDismissReason = 'program'): void {
  const entry = bandStore.get().entries.find((e) => e.id === id)
  if (!entry) return
  if (running?.id === id) {
    clearTimeout(running.timer)
    running = null
  }
  left.delete(id)
  bandStore.set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }))
  entry.onDismiss?.(reason)
  syncClock()
}

/** Take down the prompt standing under `key`, if any. */
export function dismissBandByKey(key: string, reason: BandDismissReason = 'program'): void {
  for (const e of bandStore.get().entries) if (e.key === key) dismissBand(e.id, reason)
}

/** The tab navigated to another document (or closed): its prompts go. */
export function dismissTabBands(tabId: string, reason: BandDismissReason = 'navigation'): void {
  for (const e of bandStore.get().entries) if (e.tabId === tabId) dismissBand(e.id, reason)
}

/** The shown prompt's action was picked: it performs, and the band leaves unless the act holds it. */
export function pickBandAction(id: number): void {
  const entry = bandStore.get().entries.find((e) => e.id === id)
  if (!entry?.action) return
  if (!entry.action.holds) dismissBand(id, 'action')
  entry.action.onPick()
}

/** A finger is on the shown band (its clock waits) or has left it. */
export function holdBand(held: boolean): void {
  if (bandStore.get().held === held) return
  bandStore.set({ held })
  syncClock()
}

/**
 * The host's word on the frame: which tab is in front, whether a band may show on it now (false
 * on the new tab page, a chrome page, under a sheet or dialog, with the keyboard up over the
 * page's field), and whether offers may (false on a private tab, whose offers Chrome withholds
 * too; its states show). A band for another tab waits with its clock paused; a band withheld
 * waits.
 */
export function setBandFront(front: string | null, eligible: boolean, offers = true): void {
  const s = bandStore.get()
  if (s.front === front && s.eligible === eligible && s.offers === offers) return
  bandStore.set({ front, eligible, offers, held: false })
  syncClock()
}

/** What a paused offer has left on its clock (ms), or null when it is not paused (for tests and the host). */
export function bandClockLeft(id: number): number | null {
  if (running?.id === id) return Math.max(0, running.due - Date.now())
  return left.get(id) ?? null
}

/** Forget every prompt and clock (tests). */
export function resetBands(): void {
  if (running) clearTimeout(running.timer)
  running = null
  left.clear()
  bandStore.set({ entries: [], front: null, eligible: false, offers: true, held: false })
}
