import type { BrowsingDataRange, BrowsingDataType, Rect } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { browserStore } from '@renderer/lib/browserStore'
import { openOverview, stageStore } from '@renderer/lib/gestures/stage'
import { reducedMotion } from '@renderer/lib/motion/spring'
import { overviewPane, pickOverviewPane } from '@renderer/lib/privateTabs'
import {
  awaitRested,
  depart,
  departStore,
  isHeld,
  releaseDepartures,
  restoreDepartures,
  type Departure
} from './departureStore'
import { exitProgressAt } from './exitSpring'
import type { ClearArgs, ClearOutcome } from '../siteControls/useClearForm'

/**
 * Quick Delete's tab motion on the phone (matrix MOT-24 / HB-07; Chrome 152.0.7977.89's
 * `QuickDeleteController.java:167–259`). The Delete browsing data form confirmed with the Tabs
 * row on sends `privacy.clearBrowsingData { range, types }` with `'tabs'` among the types – the
 * one signal the motion reads (the coordinator's 15:22 ruling: no dedicated form signal) – and
 * the phone runs Chrome's sequence around the core's clear, in Chrome's order:
 *
 *  1. The DATA goes first (`types` less `'tabs'`; `performQuickDelete` → the
 *     `onBrowsingDataDeletionFinished` callback): its re-authentication round – the vault's
 *     passphrase before saved passwords – happens here, on the form, before any motion; an
 *     outcome short of `ok` is the form's to show, nothing moves.
 *  2. The form goes, and the overview opens if it is not up (`navigateToTabSwitcher`, :175 –
 *     Chrome shows the switcher whether or not a tab will close), on the Tabs pane – the range
 *     never holds a private tab – with the standing morph (gate question (c)).
 *  3. The range's tabs are read IMMEDIATELY before the wipe (`privacy.tabsInRange`, the same
 *     set the core will close, give or take a tab that crosses the period's edge meanwhile),
 *     and their cards depart IN PLACE, held (`departureStore.ts`): the house exit (v2 §11.4,
 *     `scale(1 − .1·t)`, opacity `1 − t` on the exit spring, as any close), bottom-up by card
 *     bottom on a sweep that stands for Chrome's gradient wipe (`wipeSchedule`; gate (a)/(b)),
 *     a group card as one exit only when every tab of it is in range (Chrome's
 *     `TabListMediator.java:3226–3274`), the rest as cards of their own.
 *  4. Once every exit has rested the core closes the tabs (`privacy.clearBrowsingData` with
 *     `['tabs']`: `closeUnrecorded`, no undo, no Recently closed entry) – Chrome closes at the
 *     animation's end (`closeTabsAndShowPostDeleteFeedback`) – and the commit that shows the
 *     closes takes the slots, the neighbours gliding into the gaps as for any close. A tab the
 *     core kept (it left the period between the read and the close) gets its card back: its
 *     exit runs backwards (Chrome's `TAB_RESTORE`).
 *  5. The haptic (Chrome's 50 ms one-shot, `triggerHapticFeedback`; the host's `dock` kind) and
 *     the toast in the period's words – `clearedToast(range, cleared)` on the caller's side,
 *     the same words the form's plain clear gets; never "Deleted browsing data".
 *
 * Without `'tabs'` in `types` the submit is the plain clear: no switcher, no motion. Under
 * reduced motion the range's cards are not departed at all – the close is a cut, the cards gone
 * at once on the commit (the brief's ruling; §11.3's 120 ms fade is a one-line fold here). The
 * tablet's form has no Tabs row (#624), so this never runs there; the seam is layout-agnostic.
 */

/**
 * How long the wipe takes from the grid's bottom edge to its top: the one constant of the
 * stagger (gate question (a); 0 = every card at once). Chrome's gradient crosses the visible
 * grid in about 380 ms of its 1200 ms curve (`QuickDeleteAnimationGradientDrawable.java:52–72`:
 * the sweep runs 1.35 × the grid's height on (0.25, 0, 0.15, 1), the trigger line 0.175 × the
 * height ahead of the gradient's top); the house form takes it as a straight sweep, a card's
 * exit spring standing for Chrome's 230 ms linear fade (`TabGridView.java:159–193`).
 */
export const QUICK_DELETE_SWEEP_MS = 250

/**
 * How long the chrome waits for the browser to show the closes (the core's state broadcast is
 * the next macrotask on Android) before it takes the cards still there as kept.
 */
export const CLOSE_SHOWN_WAIT_MS = 400

/** How long the runner waits for the overview to land before it wipes regardless. */
export const OVERVIEW_OPEN_WAIT_MS = 1500

/** What the mounted overview hands the runner for the range's tabs: their exits and its grid. */
export interface QuickDeleteWipe {
  /** The held exits over the range's cards (a group's as one when whole), plus the New Tab card's if the pane empties. */
  exits: Departure[]
  /** The grid's visible rect in window coordinates: the sweep runs its height. */
  grid: Rect | null
}

type WipeBuilder = (tabIds: readonly string[]) => QuickDeleteWipe | null

let wipeBuilder: WipeBuilder | null = null

/** The mounted `TabOverview` registers how the range's cards are departed (null on unmount). */
export function setQuickDeleteWipe(builder: WipeBuilder | null): void {
  wipeBuilder = builder
}

/**
 * When each held exit sets off, in ms from the wipe's start: bottom-up by card bottom, a card at
 * the grid's bottom edge first and one at its top edge last, in proportion to the distance
 * between (a row's cards set off together; a card below the visible grid at once, one above it
 * at the sweep's end). Without a grid to measure, or with the sweep at 0, everything at once.
 */
export function wipeSchedule(
  exits: readonly Departure[],
  grid: Rect | null,
  sweepMs: number
): Array<{ key: string; delay: number }> {
  return exits.filter(isHeld).map((exit) => {
    if (!grid || grid.height <= 0 || sweepMs <= 0) return { key: exit.key, delay: 0 }
    const bottom = exit.rect.y + exit.rect.height
    const share = Math.min(1, Math.max(0, (grid.y + grid.height - bottom) / grid.height))
    return { key: exit.key, delay: Math.round(share * sweepMs) }
  })
}

/** Whether the form's confirm runs the motion: only with `'tabs'` among what it clears. */
export function closesTabs(types: readonly BrowsingDataType[]): boolean {
  return types.includes('tabs')
}

/**
 * The wipe held `atMs` into its release, for a still (the preview host's `overview&wipe=<ms>`,
 * `previewStates.ts`): the range's tabs read as the runner reads them, their exits departed
 * held and frozen at the frame the schedule would have each on – a card at the grid's bottom
 * `atMs` into its run, one higher up `atMs` less its delay, one the sweep has not reached yet
 * standing whole (`exitProgressAt`). Nothing runs and nothing closes: the frame holds until the
 * next state clears the store. Whether the overview had cards to hold.
 */
export async function holdQuickDeleteWipe(
  range: BrowsingDataRange,
  atMs: number
): Promise<boolean> {
  const inRange = await cmd('privacy.tabsInRange', { range })
  const built = wipeBuilder?.(Array.isArray(inRange) ? inRange : []) ?? null
  if (!built || built.exits.length === 0) return false
  const delays = new Map(
    wipeSchedule(built.exits, built.grid, QUICK_DELETE_SWEEP_MS).map((s) => [s.key, s.delay])
  )
  depart(
    built.exits.map((exit) =>
      isHeld(exit) && exit.kind !== 'new-tab'
        ? { ...exit, frozen: exitProgressAt(atMs - (delays.get(exit.key) ?? 0)) }
        : exit
    )
  )
  return true
}

/**
 * The phone form's clear: the plain command without `'tabs'`; with it, Chrome's sequence around
 * two commands – the data first, the tabs once the wipe is through. `dismiss` is the form's
 * close, called before the overview opens (once; the form calls it again on `ok` and that call
 * is the caller's to make a no-op).
 */
export async function quickDeleteClear(
  args: ClearArgs,
  dismiss: () => void
): Promise<ClearOutcome> {
  if (!closesTabs(args.types)) return cmd('privacy.clearBrowsingData', args)
  const dataTypes = args.types.filter((t) => t !== 'tabs')
  let cleared: BrowsingDataType[] = []
  if (dataTypes.length > 0) {
    const data = await cmd('privacy.clearBrowsingData', { ...args, types: dataTypes })
    if (data.status !== 'ok') return data
    cleared = data.value.cleared
  }
  dismiss()
  await showOverview()
  const inRange = await cmd('privacy.tabsInRange', { range: args.range })
  const ids = Array.isArray(inRange) ? inRange : []
  const held = await wipe(ids)
  const tabs = await cmd('privacy.clearBrowsingData', { range: args.range, types: ['tabs'] })
  if (held.length > 0) {
    await closesShown(ids)
    restoreDepartures(kept(held))
  }
  if (tabs.status !== 'ok') return tabs
  run('haptic', { kind: 'dock' })
  return { status: 'ok', value: { cleared: [...cleared, ...tabs.value.cleared] } }
}

/** The overview up, on the Tabs pane, at rest – Chrome's switcher first, whatever will close. */
async function showOverview(): Promise<void> {
  const state = browserStore.get().state
  if (!state) return
  if (overviewPane(state) !== 'tabs') pickOverviewPane('tabs')
  if (stageStore.get().overview.phase !== 'open') openOverview(state)
  await new Promise<void>((resolve) => {
    const landed = (): boolean => {
      const { phase } = stageStore.get().overview
      return phase === 'open' || phase === 'closed'
    }
    if (landed()) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      off()
      resolve()
    }, OVERVIEW_OPEN_WAIT_MS)
    const off = stageStore.subscribe(() => {
      if (!landed()) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}

/**
 * The range's cards depart, held, on the sweep's schedule; resolves with the held exits' keys
 * once every one has rested. Nothing departs under reduced motion (the close is a cut), with no
 * overview mounted, or for a range with no card on the grid.
 */
async function wipe(ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0 || reducedMotion() || !wipeBuilder) return []
  const built = wipeBuilder(ids)
  if (!built || built.exits.length === 0) return []
  depart(built.exits)
  const schedule = wipeSchedule(built.exits, built.grid, QUICK_DELETE_SWEEP_MS)
  const byDelay = new Map<number, string[]>()
  for (const { key, delay } of schedule) byDelay.set(delay, [...(byDelay.get(delay) ?? []), key])
  for (const [delay, keys] of byDelay) setTimeout(() => releaseDepartures(keys), delay)
  const keys = schedule.map((s) => s.key)
  await awaitRested(keys)
  return keys
}

/** Resolves once the browser shows none of `ids` open, or once the wait for it runs out. */
function closesShown(ids: readonly string[]): Promise<void> {
  const shown = (): boolean => {
    const state = browserStore.get().state
    return state !== null && ids.every((id) => !state.tabs[id])
  }
  if (shown()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve()
    }, CLOSE_SHOWN_WAIT_MS)
    const off = browserStore.subscribe(() => {
      if (!shown()) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}

/** The held exits among `keys` whose tab (any of a group's) the browser still shows open. */
function kept(keys: readonly string[]): string[] {
  const state = browserStore.get().state
  if (!state) return [...keys]
  const items = departStore.get().items
  return keys.filter((key) => {
    const item = items.find((i) => i.key === key)
    if (!item || !isHeld(item)) return false
    if (item.kind === 'tab') return state.tabs[item.tab.id] !== undefined
    if (item.kind === 'group') return item.tabs.some((t) => state.tabs[t.id] !== undefined)
    return false
  })
}
