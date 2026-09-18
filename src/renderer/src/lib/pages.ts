import type { InternalPageId } from '@shared/internalPages'
import { isChromePageUrl } from '@shared/internalPages'
import type { Tab } from '@shared/types'
import { run } from './api'

/**
 * Internal pages from the chrome's side (`shared/internalPages.ts`, `core/pages.ts`). Every
 * entry point that used to open the Settings overlay goes through {@link openPage}: the core
 * opens (or reuses) the page's tab on hosts with `capabilities.pageTabs` and the overlay on the
 * others, so the chrome has one call whichever host it runs on.
 *
 * A chrome page tab's back is the tab's back: the core mirrors its section history into
 * `Tab.canGoBack`, so `tab.back` steps through it and, at the landing, the one root-back rule in
 * `back.ts` (`rootBackAction`) applies – back to the opener, to the previous tab, or to the app
 * that sent the deep link.
 */

/** Open a page, or move its tab to `section` (`null` = the landing; left out = where it is). */
export function openPage(id: InternalPageId, section?: string | null): void {
  run('page.open', { id, section })
}

export function openSettings(section?: string | null): void {
  openPage('settings', section)
}

/**
 * Whether `tab` is a page the chrome draws inside the content area (`render: 'chrome'`): no
 * page view, so there is nothing to snapshot, dim or find in. A document page (the new tab page
 * once it registers) answers false and is treated as any document. A plain boolean, not a
 * predicate: a tab that is not a page is still a `Tab`.
 */
export function isPageTab(tab: Tab | null | undefined): boolean {
  return tab !== null && tab !== undefined && isChromePageUrl(tab.url)
}
