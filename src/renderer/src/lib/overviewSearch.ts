import type { Tab } from '@shared/types'
import { displayUrl } from '@shared/url'

/*
 * The tab overview's search (matrix TAB-21; Chrome's magnifier in the tab switcher): the field
 * pinned under the overview's header narrows the open tabs of the pane in view to the ones
 * whose title or address holds what was typed, as it is typed. Pure, so the filter can be tested
 * without the grid: what matches, what the pane's count is, what a screen reader is told.
 *
 * The match is a plain one: every word of the query (space-separated) must appear somewhere in
 * the tab's title or address, case and diacritics folded (`café` finds "Cafe", `cafe` finds
 * "Café"), the words in any order. Nothing fuzzy – a card that leaves the grid as a letter is
 * typed must be one the reader can see does not hold the letters, and the omnibox's scattered
 * matching (`shared/tabSearch.ts`) is for a ranked list, not a filter. The matched text is not
 * highlighted on the card (Chrome does not).
 */

/** Decompose, drop the combining marks (the accents), lower-case: the text as the match reads it. */
export function foldSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/** The query as the filter takes it: trimmed; a query of blanks is no query at all. */
export function normalizeQuery(query: string): string {
  return query.trim()
}

/** The query's words, folded; none for an empty query. */
function queryWords(query: string): string[] {
  return foldSearchText(normalizeQuery(query)).split(/\s+/).filter(Boolean)
}

/**
 * What a tab is searched by: its title as the card shows it, and its address. An open tab may
 * carry a custom title; a recently closed one or another device's (the search's reach) has none.
 */
export type SearchableTab = Pick<Tab, 'title' | 'url'> & { customTitle?: Tab['customTitle'] }

/**
 * The text of `tab` the query is looked for in: the title the card reads (a custom title over
 * the page's), the address as typed and as shown (`example.com/path`, the scheme and `www.` off
 * – so `example` finds the tab whether the user thinks in addresses or in sites).
 */
function haystack(tab: SearchableTab): string {
  const title = tab.customTitle ?? tab.title
  return foldSearchText([title, tab.url, displayUrl(tab.url)].filter(Boolean).join('\n'))
}

/** Whether `tab` holds every word of `query` in its title or address; every tab matches no query. */
export function tabMatchesQuery(tab: SearchableTab, query: string): boolean {
  const words = queryWords(query)
  if (words.length === 0) return true
  const text = haystack(tab)
  return words.every((word) => text.includes(word))
}

/** `tabs` narrowed to the ones matching `query`, in the order given; all of them for no query. */
export function filterTabs<T extends SearchableTab>(tabs: readonly T[], query: string): T[] {
  if (queryWords(query).length === 0) return [...tabs]
  return tabs.filter((tab) => tabMatchesQuery(tab, query))
}

/**
 * What a screen reader is told as the query narrows the grid (TalkBack, through the chrome's
 * status region): the count of cards left – "3 tabs found", "1 tab found", "No tabs found" – and
 * nothing for an empty query, whose grid is the pane as it was.
 */
export function searchResultAnnouncement(query: string, count: number): string | null {
  if (queryWords(query).length === 0) return null
  if (count === 0) return 'No tabs found'
  return `${count} ${count === 1 ? 'tab' : 'tabs'} found`
}

/**
 * The field's placeholder: example text, never the label (§9.12) – the desktop tab search's
 * words (#213, the lead's ruling), so the two fields read the same.
 */
export const SEARCH_TABS_PLACEHOLDER = 'Title or address'
