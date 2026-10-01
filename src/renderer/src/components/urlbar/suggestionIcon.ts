import {
  Calculator,
  Clipboard,
  Clock,
  Folder,
  Globe,
  Info,
  Layers,
  PanelTop,
  Puzzle,
  Search,
  Star,
  Terminal,
  type LucideIcon
} from 'lucide-react'
import type { Suggestion, SuggestionKind } from '@shared/types'
import { internalPageOf } from '@shared/internalPages'
import { RECENT_SEARCHES_GROUP } from '@shared/zeroSuggest'
import { PAGE_GLYPHS } from '@renderer/lib/pageGlyphs'

/**
 * The glyph a suggestion row of each kind falls back to when it has no favicon to show (v2
 * draft, shell pass 7(b): the globe for an address, the magnifier for a search or an engine
 * without a site icon, the clock for a page from history, the star for a bookmark – the same
 * star as the bookmarks page's registry glyph and the pill's – and a tab for an open tab). A tab
 * group's row (OMN-15) draws the one group glyph (`GroupGlyph`, §9.37) in the slot instead; the
 * folder here stands in only while the row outlives its group.
 */
const ROW_ICONS: Record<SuggestionKind, LucideIcon> = {
  url: Globe,
  search: Search,
  history: Clock,
  bookmark: Star,
  tab: PanelTop,
  space: Layers,
  command: Terminal,
  engine: Search,
  answer: Calculator,
  entity: Info,
  omnibox: Puzzle,
  clipboard: Clipboard,
  folder: Folder
}

/**
 * The glyph in a suggestion row's favicon slot. A row that lands on an internal page (typed
 * `zenium://settings`, its open tab, a history entry) draws the page's registry glyph where a
 * site's row draws its favicon (v2 §10.1: the gear, never the globe, in every slot that shows
 * the page) – `page` says so, and such a row shows no favicon even when one is set; every other
 * row keeps its kind's glyph (Chrome's globe for a site without one).
 *
 * With `recentSearchClock` – the touch layouts' rows (OMN-04) – a remembered search of the
 * zero-suggest list ("Recent searches") wears the clock, the draft's glyph for what comes from
 * the user's history, as Chrome for Android's search-history rows do; the desktop's rows keep
 * the magnifier they have.
 */
export function suggestionIcon(
  item: Pick<Suggestion, 'kind' | 'url' | 'group'>,
  opts: { recentSearchClock?: boolean } = {}
): {
  Icon: LucideIcon
  page: boolean
} {
  const glyph = item.url ? internalPageOf(item.url)?.glyph : undefined
  if (glyph) return { Icon: PAGE_GLYPHS[glyph], page: true }
  if (opts.recentSearchClock && item.kind === 'search' && item.group === RECENT_SEARCHES_GROUP)
    return { Icon: Clock, page: false }
  return { Icon: ROW_ICONS[item.kind], page: false }
}
