import type { Folder, Rect, Tab } from '@shared/types'
import { createStore } from '@renderer/lib/store'

/**
 * A card on its way out of the grid, drawn where it was when its tab (or group) was told to
 * close, collapsing and fading while the browser removes the tab and the neighbours glide into
 * the gap. The record of the tab travels with it: by the time it is drawn, the tab is gone.
 *
 * A `filtered` card is one the overview's search dropped (TAB-21): its tab stays open, so the
 * grid, not the browser, is what shows its gap – `TabOverview` releases the exit in the commit
 * that unmounts the card, and drops it if the card is back before it has run. The New Tab card
 * leaves the same way when a query stands (§9.34: it is not a match), as the pane's `new-tab`
 * departure, which hides no tab.
 *
 * A group leaves whole – one `group` exit, its cards drawn inside it – when its every card goes
 * at once: closed (its last card's X or swipe, Close Group, a close that takes every member),
 * dropped by the query (`filtered`), or the last card the query left it closed (the group stays
 * open with the cards the query hides; its card has nothing left to show). Its cell leaves the
 * grid on the commit its cards are gone, the exit fading where the card stood while the cells
 * below glide up, as a card's leave (v2 §11.4: a container with nothing to hold departs as a
 * card does, never a cut); the group's folder stays – saved on a close, open under a query – so
 * that exit too is the grid's to release. A `flown` group's last card was swiped off the grid
 * and is out of sight already: the frame leaves as it stands, its slot empty, the count as it
 * read.
 *
 * The New Tab card also leaves `with` the cards of a close that empties the Tabs pane (TAB-34):
 * §9.17's sentence takes the grid's place in the commit those tabs are gone, and the card leaves
 * on that commit as they do – released by the browser's close, like a card's exit, and standing
 * while a page among them is asked "Leave site?"; not the grid's to drop while the card is drawn.
 *
 * A `held` card is Quick Delete's (MOT-24, `quickDelete.ts`): its exit runs BEFORE the browser
 * closes the tab, not on the commit that shows the close – Chrome wipes the period's cards in
 * the switcher and closes the tabs once the wipe is through – so nothing releases it but the
 * wipe's own schedule, and at rest it stays drawn, gone from view, over the slot the card still
 * holds (`restDeparture`) until the browser's close takes the slot (`departureGone`: the exit
 * goes on that commit, the neighbours gliding into the gap as for any close) or keeps the tab
 * (`restoreDepartures`: the exit runs back to the card, which is then shown again). A held exit
 * `frozen` at a progress is drawn at that frame of its run and runs no further – the preview
 * host's mid-wipe still (`holdQuickDeleteWipe`); nothing in the product freezes one.
 */
export type Departure =
  | {
      key: string
      kind: 'tab'
      tab: Tab
      rect: Rect
      filtered?: true
      held?: true
      frozen?: number
    }
  | GroupDeparture
  | { key: string; kind: 'new-tab'; isPrivate: boolean; rect: Rect; with?: readonly string[] }

/** A group's exit, its cards drawn inside it. */
export interface GroupDeparture {
  key: string
  kind: 'group'
  folder: Folder
  tabs: Tab[]
  rect: Rect
  columns: number
  filtered?: true
  flown?: true
  held?: true
  frozen?: number
}

interface DepartState {
  items: Departure[]
  /** Ids of the tabs whose cards are hidden behind a departure (the group's members too). */
  hidden: ReadonlySet<string>
  /**
   * Keys of the exits that run: an exit stands still over its card until the grid shows the
   * gap – the commit in which the tab has left the state, whose glide closes the gap – so the
   * collapse and the neighbours' glide start on the same frame (v2 §11.4).
   */
  released: ReadonlySet<string>
  /** Keys of the held exits that have run to rest and stand, out of view, over their slots. */
  settled: ReadonlySet<string>
  /** Keys of the held exits whose card has left the grid while the exit still ran: they go at rest. */
  gone: ReadonlySet<string>
  /** Keys of the held exits running back to their cards: the browser kept the tab. */
  restoring: ReadonlySet<string>
}

const EMPTY: DepartState = {
  items: [],
  hidden: new Set(),
  released: new Set(),
  settled: new Set(),
  gone: new Set(),
  restoring: new Set()
}

export const departStore = createStore<DepartState>(EMPTY, 'card-departures')

/** Whether `item` is one of Quick Delete's, run ahead of the browser's close. */
export function isHeld(item: Departure): boolean {
  return item.kind !== 'new-tab' && item.held === true
}

function without(set: ReadonlySet<string>, keys: ReadonlySet<string>): Set<string> {
  return new Set([...set].filter((k) => !keys.has(k)))
}

function hiddenBy(items: Departure[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.kind === 'tab') ids.add(item.tab.id)
    else if (item.kind === 'group') for (const t of item.tabs) ids.add(t.id)
  }
  return ids
}

/** Cards are about to leave: draw their exits in place of them. */
export function depart(items: Departure[]): void {
  if (items.length === 0) return
  const s = departStore.get()
  const keys = new Set(items.map((i) => i.key))
  const next = [...s.items.filter((i) => !keys.has(i.key)), ...items]
  departStore.set({
    items: next,
    hidden: hiddenBy(next),
    released: without(s.released, keys),
    settled: without(s.settled, keys),
    gone: without(s.gone, keys),
    restoring: without(s.restoring, keys)
  })
}

/** The grid shows the gap these cards left (or has waited long enough): their exits run. */
export function releaseDepartures(keys: Iterable<string>): void {
  const s = departStore.get()
  const released = new Set(s.released)
  for (const key of keys) if (s.items.some((i) => i.key === key)) released.add(key)
  if (released.size !== s.released.size) departStore.set({ released })
}

/** An exit has finished (or the overview went away). */
export function departed(key: string): void {
  const s = departStore.get()
  if (!s.items.some((i) => i.key === key)) return
  const keys = new Set([key])
  const next = s.items.filter((i) => i.key !== key)
  departStore.set({
    items: next,
    hidden: hiddenBy(next),
    released: without(s.released, keys),
    settled: without(s.settled, keys),
    gone: without(s.gone, keys),
    restoring: without(s.restoring, keys)
  })
}

/**
 * A held exit has run to rest. It stays drawn where it is, out of view, over the slot its card
 * still holds – unless the card is gone already (the browser's close came first): then it goes.
 */
export function restDeparture(key: string): void {
  const s = departStore.get()
  if (!s.items.some((i) => i.key === key)) return
  if (s.gone.has(key)) {
    departed(key)
    return
  }
  departStore.set({ settled: new Set([...s.settled, key]) })
}

/**
 * The cards these exits stood for have left the grid: a tab gone from the state, a group's cell
 * gone from the grid. A card's exit runs now, on the commit whose glide closes the gap (v2
 * §11.4). A held exit has run already: at rest it goes with the slot; still running, it is
 * marked to go at rest (and released, should the close have come before the wipe reached it).
 */
export function departureGone(keys: Iterable<string>): void {
  const s = departStore.get()
  const released = new Set(s.released)
  const gone = new Set(s.gone)
  const done = new Set<string>()
  for (const key of keys) {
    const item = s.items.find((i) => i.key === key)
    if (!item) continue
    if (!isHeld(item)) {
      released.add(key)
      continue
    }
    if (s.settled.has(key) || s.restoring.has(key)) done.add(key)
    else {
      gone.add(key)
      released.add(key)
    }
  }
  if (done.size === 0 && released.size === s.released.size && gone.size === s.gone.size) return
  const items = done.size > 0 ? s.items.filter((i) => !done.has(i.key)) : s.items
  departStore.set({
    items,
    hidden: done.size > 0 ? hiddenBy(items) : s.hidden,
    released: without(released, done),
    settled: without(s.settled, done),
    gone: without(gone, done),
    restoring: without(s.restoring, done)
  })
}

/** The browser kept these tabs: their held exits run back to the cards, which then show again. */
export function restoreDepartures(keys: Iterable<string>): void {
  const s = departStore.get()
  const restoring = new Set(s.restoring)
  for (const key of keys) {
    const item = s.items.find((i) => i.key === key)
    if (item && isHeld(item)) restoring.add(key)
  }
  if (restoring.size !== s.restoring.size) departStore.set({ restoring })
}

/**
 * Resolves once every one of `keys` has run to rest – or is no longer a departure at all (gone
 * with its card, or cleared with the overview).
 */
export function awaitRested(keys: readonly string[]): Promise<void> {
  const rested = (s: DepartState): boolean =>
    keys.every((key) => s.settled.has(key) || !s.items.some((i) => i.key === key))
  if (rested(departStore.get())) return Promise.resolve()
  return new Promise((resolve) => {
    const off = departStore.subscribe(() => {
      if (!rested(departStore.get())) return
      off()
      resolve()
    })
  })
}

export function clearDepartures(): void {
  if (departStore.get().items.length > 0) departStore.set(EMPTY)
}

/** A window-coordinates rect of an element, as the departure needs it. */
export function rectOf(el: Element | undefined | null): Rect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}
