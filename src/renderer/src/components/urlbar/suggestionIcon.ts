import {
  Bookmark,
  Calculator,
  Clipboard,
  Clock,
  Globe,
  Info,
  Layers,
  Puzzle,
  Search,
  Terminal,
  type LucideIcon
} from 'lucide-react'
import type { Suggestion, SuggestionKind } from '@shared/types'
import { internalPageOf } from '@shared/internalPages'
import { PAGE_GLYPHS } from '@renderer/lib/pageGlyphs'

/** The glyph a suggestion row of each kind falls back to when it has no favicon to show. */
const ROW_ICONS: Record<SuggestionKind, LucideIcon> = {
  url: Globe,
  search: Search,
  history: Clock,
  bookmark: Bookmark,
  tab: Globe,
  space: Layers,
  command: Terminal,
  engine: Search,
  answer: Calculator,
  entity: Info,
  omnibox: Puzzle,
  clipboard: Clipboard
}

/**
 * The glyph in a suggestion row's favicon slot. A row that lands on an internal page (typed
 * `zenium://settings`, its open tab, a history entry) draws the page's registry glyph where a
 * site's row draws its favicon (v2 §10.1: the gear, never the globe, in every slot that shows
 * the page) – `page` says so, and such a row shows no favicon even when one is set; every other
 * row keeps its kind's glyph (Chrome's globe for a site without one).
 */
export function suggestionIcon(item: Pick<Suggestion, 'kind' | 'url'>): {
  Icon: LucideIcon
  page: boolean
} {
  const glyph = item.url ? internalPageOf(item.url)?.glyph : undefined
  return glyph
    ? { Icon: PAGE_GLYPHS[glyph], page: true }
    : { Icon: ROW_ICONS[item.kind], page: false }
}
