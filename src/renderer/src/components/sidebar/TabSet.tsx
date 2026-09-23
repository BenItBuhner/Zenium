/* eslint-disable react-refresh/only-export-components -- the list's provider ships with the row's hook */
import type { JSX, ReactNode } from 'react'
import { createContext, useContext, useMemo } from 'react'
import type { Tab } from '@shared/types'
import { tabRowPosition } from '@renderer/lib/tabRowAria'

/**
 * The tabs one tablist holds, in the order it draws them (a11y-31): each run of rows – the
 * pinned rows, a folder's, the loose rows, the private session's – wraps its rows in one so a
 * row can say its place in the list (`aria-posinset` / `aria-setsize`, `TabItem`). A split
 * group's panes are the list's tabs too, in the group's order, as `stripRows` lays them.
 */
const TabSetContext = createContext<readonly string[] | null>(null)

export function TabSet({
  tabs,
  children
}: {
  tabs: readonly Tab[]
  children: ReactNode
}): JSX.Element {
  const ids = useMemo(() => tabs.map((t) => t.id), [tabs])
  return <TabSetContext.Provider value={ids}>{children}</TabSetContext.Provider>
}

/** The row's one-based place in its list and the list's size, or null outside a list. */
export function useTabPosition(tabId: string): { pos: number; size: number } | null {
  return tabRowPosition(useContext(TabSetContext), tabId)
}
