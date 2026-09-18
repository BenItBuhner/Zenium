import type { InternalPageId } from '@shared/internalPages'
import { isInternalPageUrl } from '@shared/internalPages'
import type { Tab, UIState } from '@shared/types'
import { run } from './api'
import { activeSpace, activeTab, tabOrderOf } from './selectors'

/**
 * Internal pages from the chrome's side (`shared/internalPages.ts`, `core/pages.ts`). Every
 * entry point that used to open the Settings overlay goes through {@link openPage}: the core
 * opens (or reuses) the page's tab on hosts with `capabilities.pageTabs` and the overlay on the
 * others, so the chrome has one call whichever host it runs on.
 */

/** Open a page, or move its tab to `section` (`null` = the landing; left out = where it is). */
export function openPage(id: InternalPageId, section?: string | null): void {
  run('page.open', { id, section })
}

export function openSettings(section?: string | null): void {
  openPage('settings', section)
}

/**
 * Whether `tab` is an internal page tab (drawn by the chrome, no page view). A plain boolean,
 * not a predicate: a tab that is not a page is still a `Tab`.
 */
export function isPageTab(tab: Tab | null | undefined): boolean {
  return tab !== null && tab !== undefined && isInternalPageUrl(tab.url)
}

/**
 * The active page tab, when a system back inside it has somewhere to go: a section beneath the
 * one shown, or another tab of the space to return to (`core/pages.ts` `back`). Null when the
 * active tab is not a page, or Settings is the only tab and shows its landing – then the back
 * is the system's, and the host may leave the app.
 */
export function pageTabWithBack(state: UIState): Tab | null {
  const tab = activeTab(state)
  if (!tab || !isPageTab(tab)) return null
  if (tab.canGoBack) return tab
  const others = tabOrderOf(state, activeSpace(state)).some((t) => t.id !== tab.id)
  return others ? tab : null
}
