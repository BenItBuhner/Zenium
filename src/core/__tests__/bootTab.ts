import { isEmptyTabUrl } from '../../shared/url'
import type { Browser } from '../browser'

/**
 * A started browser opens every window on a tab – a fresh profile boots to the new tab page
 * (`Browser.ensureFirstTab`: a window always has a tab from its creation, as Chrome's do). The
 * suites that build their scenes tab by tab begin from the bare space instead – the one the user
 * makes by closing that tab (Zen's "This space is empty" state, which stays) – and, given the
 * host's record of the pages made so far, from a record without the boot tab's page (`tabIdOf`
 * reads a record's tab id; the `tabId` field by default). A window that came up on a restored
 * page (a second start over a saved profile) is left alone. Returns the ids of the tabs closed.
 */
export function closeBootTabs<V>(
  browser: Browser,
  views?: V[],
  tabIdOf: (view: V) => string = (view) => (view as { tabId: string }).tabId
): string[] {
  const closed: string[] = []
  for (const win of browser.allWindows()) {
    const tab = browser.tabs.activeTabFor(win)
    if (!tab || !isEmptyTabUrl(tab.url)) continue
    browser.tabs.closeTab(tab.id, true, win)
    closed.push(tab.id)
  }
  if (views) {
    for (let i = views.length - 1; i >= 0; i--) {
      if (closed.includes(tabIdOf(views[i]))) views.splice(i, 1)
    }
  }
  return closed
}
