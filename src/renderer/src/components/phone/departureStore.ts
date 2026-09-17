import type { Folder, Rect, Tab } from '@shared/types'
import { createStore } from '@renderer/lib/store'

/**
 * A card on its way out of the grid, drawn where it was when its tab (or group) was told to
 * close, collapsing and fading while the browser removes the tab and the neighbours glide into
 * the gap. The record of the tab travels with it: by the time it is drawn, the tab is gone.
 */
export type Departure =
  | { key: string; kind: 'tab'; tab: Tab; rect: Rect }
  | { key: string; kind: 'group'; folder: Folder; tabs: Tab[]; rect: Rect; columns: number }

interface DepartState {
  items: Departure[]
  /** Ids of the tabs whose cards are hidden behind a departure (the group's members too). */
  hidden: ReadonlySet<string>
}

export const departStore = createStore<DepartState>(
  { items: [], hidden: new Set() },
  'card-departures'
)

function hiddenBy(items: Departure[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.kind === 'tab') ids.add(item.tab.id)
    else for (const t of item.tabs) ids.add(t.id)
  }
  return ids
}

/** Cards are about to leave: draw their exits in place of them. */
export function depart(items: Departure[]): void {
  if (items.length === 0) return
  const s = departStore.get()
  const keys = new Set(items.map((i) => i.key))
  const next = [...s.items.filter((i) => !keys.has(i.key)), ...items]
  departStore.set({ items: next, hidden: hiddenBy(next) })
}

/** An exit has finished (or the overview went away). */
export function departed(key: string): void {
  const s = departStore.get()
  if (!s.items.some((i) => i.key === key)) return
  const next = s.items.filter((i) => i.key !== key)
  departStore.set({ items: next, hidden: hiddenBy(next) })
}

export function clearDepartures(): void {
  if (departStore.get().items.length > 0) departStore.set({ items: [], hidden: new Set() })
}

/** A window-coordinates rect of an element, as the departure needs it. */
export function rectOf(el: Element | undefined | null): Rect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}
