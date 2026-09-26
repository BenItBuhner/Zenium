import type { BookmarkNode, ReadingListEntry, UIState } from '@shared/types'
import { activeTab } from '@renderer/lib/selectors'

/**
 * The star sheet's Reading list switch (HB-20, `BookmarkEditSheet`): the page's entry in the
 * list when it holds one, and – for the switch to turn on with – the tab showing the page, the
 * active tab first (the star's own flow: the sheet opens over the page it just saved). The
 * list's add is by tab (`readingList.add { tabId }`, the desktop's model, read-only here): a
 * bookmark no tab shows cannot be added from the sheet, and its switch stands disabled (§9.30)
 * saying why. Null for a folder or a bookmark not yet here.
 */
export function readingListToggle(
  state: UIState,
  node: BookmarkNode | null
): { entry: ReadingListEntry | null; tabId: string | null } | null {
  if (!node || node.type !== 'url' || !node.url) return null
  const url = node.url
  const entry = state.readingList.find((e) => e.url === url) ?? null
  const active = activeTab(state)
  const showing =
    active?.url === url ? active : Object.values(state.tabs).find((tab) => tab.url === url)
  return { entry, tabId: showing?.id ?? null }
}
