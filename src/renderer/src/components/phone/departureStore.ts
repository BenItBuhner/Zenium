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
 * at once: closed (its last card's X or swipe, Close Group, a close that takes every member) or
 * dropped by the query (`filtered`). Its cell leaves the grid on the commit its cards are gone,
 * the exit fading where the card stood while the cells below glide up, as a card's leave (v2
 * §11.4: a container with nothing to hold departs as a card does, never a cut); a closed
 * group's folder stays, saved, so that exit too is the grid's to release. A `flown` group's last
 * card was swiped off the grid and is out of sight already: the frame leaves as it stands, its
 * slot empty, the count as it read.
 */
export type Departure =
  | { key: string; kind: 'tab'; tab: Tab; rect: Rect; filtered?: true }
  | GroupDeparture
  | { key: string; kind: 'new-tab'; isPrivate: boolean; rect: Rect }

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
}

export const departStore = createStore<DepartState>(
  { items: [], hidden: new Set(), released: new Set() },
  'card-departures'
)

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
  const released = new Set([...s.released].filter((k) => !keys.has(k)))
  departStore.set({ items: next, hidden: hiddenBy(next), released })
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
  const next = s.items.filter((i) => i.key !== key)
  const released = new Set(s.released)
  released.delete(key)
  departStore.set({ items: next, hidden: hiddenBy(next), released })
}

export function clearDepartures(): void {
  if (departStore.get().items.length > 0)
    departStore.set({ items: [], hidden: new Set(), released: new Set() })
}

/** A window-coordinates rect of an element, as the departure needs it. */
export function rectOf(el: Element | undefined | null): Rect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}
