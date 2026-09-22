import type { Tab } from '@shared/types'
import { isEmptyTabUrl } from '@shared/url'
import { tabTitle } from './selectors'

/**
 * The tab overview's select-tabs mode (matrix TAB-08, TAB-35, SH-12; Chrome's "Select tabs" /
 * Edit mode): the cards become checkable, the header counts the picks, and a bottom action row
 * acts on them all at once – Close, Group, Bookmark, Share. This is the mode's model, pure and
 * apart from the grid: what is on, what is picked, and what each action's target is.
 *
 * Unlike the panels' `multiSelect`, the mode does not end when the last pick is undone: Chrome's
 * Edit mode stays up at "Select tabs" until Done or back, so a user who unticks the only card is
 * not thrown out of the mode they just entered. What is picked is kept by id in the order it was
 * picked; the grid gives the tabs back in its own order (`selectedTabs`) when an action runs.
 */
export interface OverviewSelection {
  /** The mode is on. */
  on: boolean
  /** The tabs picked, by id, in the order they were picked. */
  picked: readonly string[]
}

export const NO_SELECTION: OverviewSelection = { on: false, picked: [] }

/** Enter the mode, with `tabId` picked when the entry was a card's hold sheet. */
export function startSelection(tabId?: string): OverviewSelection {
  return { on: true, picked: tabId ? [tabId] : [] }
}

export function endSelection(): OverviewSelection {
  return NO_SELECTION
}

export function isSelected(selection: OverviewSelection, tabId: string): boolean {
  return selection.picked.includes(tabId)
}

/** A card was tapped: picked if it was not, unpicked if it was. */
export function toggleSelected(selection: OverviewSelection, tabId: string): OverviewSelection {
  if (!selection.on) return selection
  return {
    on: true,
    picked: isSelected(selection, tabId)
      ? selection.picked.filter((id) => id !== tabId)
      : [...selection.picked, tabId]
  }
}

/** Every card the grid offers is picked; the ones picked already keep their place in the order. */
export function selectAll(
  selection: OverviewSelection,
  tabIds: readonly string[]
): OverviewSelection {
  if (!selection.on) return selection
  const kept = selection.picked.filter((id) => tabIds.includes(id))
  const rest = tabIds.filter((id) => !kept.includes(id))
  return { on: true, picked: [...kept, ...rest] }
}

/** Nothing is picked; the mode stays on. */
export function deselectAll(selection: OverviewSelection): OverviewSelection {
  if (!selection.on) return selection
  return selection.picked.length === 0 ? selection : { on: true, picked: [] }
}

/** Whether every one of `tabIds` is picked (the header's Select all reads Deselect all then). */
export function allSelected(selection: OverviewSelection, tabIds: readonly string[]): boolean {
  return tabIds.length > 0 && tabIds.every((id) => isSelected(selection, id))
}

/**
 * The grid changed under the mode (a tab closed elsewhere, the pane switched, a group folded):
 * picks that no longer name a card of the grid go; the mode stays on, at zero if need be. The
 * same object comes back when nothing changed, so a render that reads it sees no change.
 */
export function pruneSelection(
  selection: OverviewSelection,
  present: ReadonlySet<string>
): OverviewSelection {
  if (!selection.on) return selection
  if (selection.picked.every((id) => present.has(id))) return selection
  return { on: true, picked: selection.picked.filter((id) => present.has(id)) }
}

/** The picked tabs in the grid's own order, which is what every action works through. */
export function selectedTabs(selection: OverviewSelection, ordered: readonly Tab[]): Tab[] {
  return ordered.filter((tab) => isSelected(selection, tab.id))
}

/** What the header says: the mode's name until something is picked, then the count. */
export function selectionTitle(count: number): string {
  return count === 0 ? 'Select tabs' : `${count} selected`
}

// --- the actions' targets ----------------------------------------------------------------------

/**
 * The picked tabs a group can take: a pinned or essential tab is never grouped (the core's
 * `moveToFolder` leaves them where they are), so Group works on the others and is off when
 * there are none.
 */
export function groupableTabs(tabs: readonly Tab[]): Tab[] {
  return tabs.filter((tab) => !tab.pinned && !tab.essential)
}

/**
 * The picked tabs that are pages – a bookmark or a share has nothing to say of a blank tab, the
 * new tab page or one of the browser's own `zen://` pages, as the core's "Bookmark all tabs"
 * leaves them out.
 */
export function pageTabs(tabs: readonly Tab[]): Tab[] {
  return tabs.filter(
    (tab) => Boolean(tab.url) && !isEmptyTabUrl(tab.url) && !tab.url.startsWith('zen://')
  )
}

/**
 * The bookmarks folder Bookmark all files the picks in (TAB-35): "Tabs from <date>", the date
 * as the locale writes it in full (day, month and year), so two folders a year apart never read
 * the same.
 */
export function bookmarkFolderTitle(now: Date): string {
  return `Tabs from ${now.toLocaleDateString(undefined, { dateStyle: 'medium' })}`
}

/** The toast after Bookmark all (§9.33): the count and where it went, the core's own phrasing. */
export function bookmarkedMessage(count: number, folderTitle: string): string {
  return `Bookmarked ${count} ${count === 1 ? 'tab' : 'tabs'} in “${folderTitle}”`
}

/**
 * What Share hands to the system sheet for several tabs (SH-12): a text list, each tab its
 * title on one line and its address on the next, a blank line between tabs – the plain form
 * every messaging app shows as it is, and a single link stays a link. The payload's title names
 * the count for the sheet's preview.
 */
export function shareTabsPayload(tabs: readonly Tab[]): { title: string; text: string } {
  const lines = tabs.map((tab) => {
    const title = tabTitle(tab).trim()
    return title && title !== tab.url ? `${title}\n${tab.url}` : tab.url
  })
  return {
    title: tabs.length === 1 ? tabTitle(tabs[0]) : `${tabs.length} tabs`,
    text: lines.join('\n\n')
  }
}
