import type { Space, UIState } from '@shared/types'
import type { OverviewView } from '@shared/overviewMenu'
import { resolveTheme, rgbToHex } from '@shared/theme'
import { privateTabsOf, tabsOnPane } from './privateTabs'
import { essentialsFor, pinnedOf, regularOf } from './selectors'

/**
 * The words of the tab overview's one header row (tab overview cleanup spec §1, §3): the
 * space's name with its count – "Default · 3 tabs" – or, in the private view, "Private · N
 * tabs"; the same count the Spaces sheet writes after each space.
 */

/** The private view's title (§3): the session has no space's name. */
export const PRIVATE_TITLE = 'Private'

/** "3 tabs", "1 tab". */
export function tabsWord(n: number): string {
  return `${n} tab${n === 1 ? '' : 's'}`
}

/**
 * The cards the overview's regular grid shows of `space`: its Essentials, pinned and regular
 * tabs, never a private one (TAB-02: a private tab is the private view's). What the header
 * counts, and what the Spaces sheet writes after the space's name.
 */
export function overviewTabCount(state: UIState, space: Space): number {
  return tabsOnPane(
    [...essentialsFor(state, space), ...pinnedOf(state, space), ...regularOf(state, space)],
    'tabs'
  ).length
}

/** The header's count on `view`: the space's regular cards, or the private session's across the spaces. */
export function overviewCount(state: UIState, space: Space, view: OverviewView): number {
  return view === 'private' ? privateTabsOf(state).length : overviewTabCount(state, space)
}

/** The header's title on `view`: the space's name, or "Private". */
export function overviewTitle(view: OverviewView, space: Pick<Space, 'name'>): string {
  return view === 'private' ? PRIVATE_TITLE : space.name
}

/**
 * The title control's accessible name: the words without the typographic dot between them
 * ("Default, 3 tabs"), which a screen reader would read out. A harness contract
 * (`OverviewCleanupDemo.kt` finds the title by it).
 */
export function overviewTitleLabel(title: string, count: number): string {
  return `${title}, ${tabsWord(count)}`
}

/**
 * The space's dot: its theme's accent in the current scheme, as the drawer's rows draw it – the
 * overview's title draws the same dot before the name (§1), the Spaces sheet's rows before theirs.
 */
export function spaceSwatch(space: Space, isDark: boolean): string | undefined {
  return space.theme ? rgbToHex(resolveTheme(space.theme, isDark).accent) : undefined
}
