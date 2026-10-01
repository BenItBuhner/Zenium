/**
 * The page-edge band's model (motion spec §3.2) – which prompt the band shows, and for how long.
 * Host-free: the desktop and Android hosts tell it what the frame shows (`setBandFrame`: which
 * tab is in front, whether a band may stand on it at all – not on the new tab page, not on a
 * chrome page, not in a fullscreen – whether offers may, and whether something stands over the
 * page – a sheet or dialog, the keyboard up over the page's field), the tenants `showBand` their
 * prompts, and `chooseBand` says what stands at the frame's edge. The motion is
 * `lib/motion/band.ts`'s, the drawing `components/band/`'s.
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
 * - Under a cover (§3.2: "the band waits, it does not stack") a prompt arriving waits for the
 *   cover to go; the one standing already stays while it is still the frame's (`shown`).
 * - The scene (`BandFrame.scene`, the tab in front unless the host says more) rides with the
 *   choice: the band's drawing reads both from one snapshot, so a standing that changes with the
 *   scene is a cut and never a travel of the next page for the last page's prompt.
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

/**
 * Why a band went, as its tenant hears it (`onDismiss`). `'action'` is the action picked;
 * `'close'` the ×. The rest put the band away: `'swipe'` (up, past half its height), `'escape'`
 * (with focus in the band), `'back'` (Android's Back button; the desktop never emits it),
 * `'timeout'` (an offer's clock), `'navigation'` (the tab's document changed), `'replaced'` (a
 * newer prompt took its place), `'program'` (the tab closed, the tenant withdrew).
 *
 * The host contract, the Design Lead's ruling on the prompt band (§3.2 / §9.6, both hosts): on
 * a prompt band ONLY the × is a refusal to remember – the one that starts a cooldown or an
 * answer kept for the release. Every put-away – `'close'` excepted – means "not now": the band
 * goes for now and nothing is remembered, so it may stand again at the next eligible moment.
 */
export type BandDismissReason =
  | 'action'
  | 'close'
  | 'swipe'
  | 'escape'
  | 'back'
  | 'timeout'
  | 'navigation'
  | 'replaced'
  | 'program'

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
  /** One action at most; the × beside it is every band's "Dismiss" (the Design Lead's ruling on item 8). */
  action?: BandAction
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
  /** The clock; an offer's is `BAND_CLOCK_MS` unless given, a state's none. */
  duration?: number | null
  onDismiss?: (reason: BandDismissReason) => void
}

/** The host's word on the frame (`setBandFrame`). */
export interface BandFrame {
  /** The tab in front, or null for the empty frame. */
  front: string | null
  /**
   * What page the frame shows, for the band's motion: a standing that changes with the scene is
   * a cut, not a travel (the tab leaving the front, a page's fullscreen). The tab in front unless
   * the host says more.
   */
  scene?: string | null
  /** A band may stand on what is in front at all: false on the new tab page, a chrome page, a fullscreen. */
  ok: boolean
  /** Offers may stand on it: false on a private tab, whose offers Chrome withholds too (§3.2). */
  offers?: boolean
  /**
   * Something stands over the page – a sheet, a dialog, the keyboard over the page's field: a
   * prompt arriving waits for it to go; the one standing already stays (§3.2).
   */
  covered?: boolean
}

export interface BandState {
  /** Every prompt standing (shown or waiting), newest first. */
  entries: BandEntry[]
  /** The tab in front, as the host reports it. */
  front: string | null
  /** The frame's scene, as the host reports it (`BandFrame.scene`). */
  scene: string | null
  /** The host says a band may stand on what is in front. */
  ok: boolean
  /** The host says offers may stand on what is in front: false on a private tab (§3.2). */
  offers: boolean
  /** The host says something stands over the page: a prompt arriving waits, the standing stays. */
  covered: boolean
  /** The prompt shown, by the model's own bookkeeping: under a cover, the one that stays. */
  shown: number | null
  /** A finger has the shown band: its clock waits. */
  held: boolean
}

const INITIAL: BandState = {
  entries: [],
  front: null,
  scene: null,
  ok: false,
  offers: true,
  covered: false,
  shown: null,
  held: false
}

export const bandStore = createStore<BandState>(INITIAL, 'band')

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
 * of each. Under a cover only the prompt shown before it came stays, and only while it is still
 * the frame's: anything else waits.
 */
export function chooseBand(state: BandState): BandEntry | null {
  if (!state.ok) return null
  const candidates = state.entries.filter(
    (e) => inFront(e, state.front) && (e.form === 'state' || state.offers)
  )
  if (state.covered) return candidates.find((e) => e.id === state.shown) ?? null
  return candidates.find((e) => e.form === 'state') ?? candidates[0] ?? null
}

/** Write `patch` and, with it, the model's own word on what the band shows now. */
function commit(patch: Partial<BandState>): void {
  bandStore.set((s) => {
    const next = { ...s, ...patch }
    return { ...patch, shown: chooseBand(next)?.id ?? null }
  })
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
  commit({ entries: [entry, ...bandStore.get().entries] })
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
  commit({ entries: bandStore.get().entries.filter((e) => e.id !== id) })
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
 * The host's word on the frame: which tab is in front (and what scene that is), whether a band
 * may stand on it at all, whether offers may (a private tab's states show, its offers wait), and
 * whether something stands over the page (a prompt arriving waits; the standing one stays). A
 * band for another tab waits with its clock paused; a band withheld waits.
 */
export function setBandFrame(frame: BandFrame): void {
  const next = {
    front: frame.front,
    scene: frame.scene === undefined ? frame.front : frame.scene,
    ok: frame.ok,
    offers: frame.offers ?? true,
    covered: frame.covered ?? false
  }
  const s = bandStore.get()
  if (
    s.front === next.front &&
    s.scene === next.scene &&
    s.ok === next.ok &&
    s.offers === next.offers &&
    s.covered === next.covered
  )
    return
  commit({ ...next, held: false })
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
  bandStore.set(INITIAL)
}
