import { BookmarkTree, recentBookmarks } from '@shared/bookmarks'
import { MAGIC_STACK_MODULE_IDS } from '@shared/newTab'
import type {
  BookmarkNode,
  ClosedEntrySummary,
  DefaultBrowserStatus,
  DownloadItem,
  MagicStackModuleId
} from '@shared/types'

/**
 * The Magic Stack's module plan (NTP-16, design language v2 §9.29): which cards the stack under
 * the new tab page's tiles draws, from what the UI state already publishes, in the stack's
 * order – the user's own content first, the promo last – less the modules hidden on this device
 * and the ones with nothing to show. Pure: the component renders what `planMagicStack` returns,
 * the Customise sheet lists `availableModules`, and the tests read both directly.
 *
 * Chrome 152's stack has more modules than Zenium has sources for. Tab resumption from other
 * devices, Price tracking and Safety check wait on the services' tab sync, a price service and
 * a phone Safety check; the History sync promo and Auxiliary search are Google-account features.
 * Those are not drawn, not listed and not pretended.
 */

/** What the plan reads: the slices of `UIState` the modules are built from. */
export interface MagicStackSources {
  /** `UIState.recentlyClosed`, newest first. */
  recentlyClosed: ClosedEntrySummary[]
  /** `UIState.downloads`, newest first. */
  downloads: DownloadItem[]
  /** `UIState.bookmarks`, every node. */
  bookmarks: BookmarkNode[]
  /** `UIState.defaultBrowser`. */
  defaultBrowser: DefaultBrowserStatus
  /** `UIState.capabilities.defaultBrowser`: the host can tell and can ask. */
  canRequestDefault: boolean
}

/** One card of the stack, with the content its module found. */
export type MagicStackCard =
  | { id: 'continue'; entry: ClosedEntrySummary }
  | { id: 'downloads'; item: DownloadItem }
  | { id: 'bookmarks'; items: BookmarkNode[] }
  | { id: 'default-browser' }

/** How a module names itself: on its card's title row and on its row of the Customise sheet. */
export interface MagicStackModule {
  id: MagicStackModuleId
  /** Sentence case (§9.1). */
  title: string
  /** The Customise sheet's description line, 13 at the deemphasised ink. */
  description: string
}

/** The bookmarks card lists this many, newest first. */
export const BOOKMARKS_CARD_LIMIT = 3

export const MAGIC_STACK_MODULES: readonly MagicStackModule[] = [
  {
    id: 'continue',
    title: 'Continue where you left off',
    description: 'The tab you closed last, ready to reopen'
  },
  { id: 'downloads', title: 'Downloads', description: 'The file you downloaded last' },
  { id: 'bookmarks', title: 'Bookmarks', description: 'The bookmarks you added most recently' },
  {
    id: 'default-browser',
    title: 'Default browser',
    description: 'A reminder to make Zenium your default browser'
  }
]

export function magicStackModule(id: MagicStackModuleId): MagicStackModule {
  const found = MAGIC_STACK_MODULES.find((m) => m.id === id)
  if (!found) throw new Error(`Unknown Magic Stack module: ${id}`)
  return found
}

/**
 * The modules this host has at all, in stack order: the Customise sheet's rows. A host that
 * cannot ask to be the default browser (a desktop, a phone whose host never answered) has no
 * such module to switch on or off.
 */
export function availableModules(
  sources: Pick<MagicStackSources, 'canRequestDefault'>
): MagicStackModule[] {
  return MAGIC_STACK_MODULES.filter((m) => m.id !== 'default-browser' || sources.canRequestDefault)
}

/**
 * A module's card from the sources, or null when it has nothing to show. Each module is one
 * rule: the newest closed entry; the newest completed download still on disk and not held in
 * quarantine; the newest bookmarks; the default-browser reminder while Zenium is known not to
 * be the default and no dedicated prompt (the first-run sheet, the banner) is asking already.
 */
export function buildCard(
  id: MagicStackModuleId,
  sources: MagicStackSources
): MagicStackCard | null {
  switch (id) {
    case 'continue': {
      const entry = sources.recentlyClosed[0]
      return entry ? { id, entry } : null
    }
    case 'downloads': {
      const item = sources.downloads.find(
        (d) =>
          d.state === 'completed' &&
          !d.fileMissing &&
          !d.removed &&
          (d.danger.level === 'safe' || d.dangerAccepted)
      )
      return item ? { id, item } : null
    }
    case 'bookmarks': {
      if (sources.bookmarks.length === 0) return null
      const items = recentBookmarks(new BookmarkTree(sources.bookmarks), BOOKMARKS_CARD_LIMIT)
      return items.length > 0 ? { id, items } : null
    }
    case 'default-browser': {
      if (!sources.canRequestDefault) return null
      const { isDefault, prompt } = sources.defaultBrowser
      return isDefault === false && prompt === null ? { id } : null
    }
  }
}

/**
 * The stack's cards in order, less the hidden modules and the empty ones. An empty result is
 * the stack not drawn at all: Chrome shows no stack rather than an empty one, and so do we.
 */
export function planMagicStack(
  sources: MagicStackSources,
  hidden: readonly MagicStackModuleId[]
): MagicStackCard[] {
  const cards: MagicStackCard[] = []
  for (const id of MAGIC_STACK_MODULE_IDS) {
    if (hidden.includes(id)) continue
    const card = buildCard(id, sources)
    if (card) cards.push(card)
  }
  return cards
}

/**
 * The page the carousel rests on after a scroll: the nearest card start to the scroll offset,
 * clamped to the cards there are. `pitch` is one card's width plus the gap between cards.
 */
export function pageAt(scrollLeft: number, pitch: number, count: number): number {
  if (count <= 0 || pitch <= 0) return 0
  return Math.max(0, Math.min(count - 1, Math.round(scrollLeft / pitch)))
}
