import type { InternalPageId } from '@shared/internalPages'
import { isChromePageUrl } from '@shared/internalPages'
import type { Tab } from '@shared/types'
import { run } from './api'
import { isPhone } from './formFactor'
import { openImportDialog, openOverlay, overlayAvailable } from './ui'

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
 * Bookmarks › Import Bookmarks and Settings…, the `import.open` event and the first-run offer
 * (Chrome's `chrome://settings/importData`, ID-23): Settings on its Import category – the tab,
 * or the overlay on a host without page tabs – with the import dialog up over it on a mouse or
 * a tablet, where another browser's profile can be read. On a phone the category alone: its
 * rows import from files, there being no profile to read, so the dialog never opens there.
 * `section` lets the first run land on another category first (Sync, when both were asked
 * for) with the dialog over it; a phone lands on Import whatever was asked.
 */
export async function openImportSurface(
  activeTabId: string | null,
  source: string | null = null,
  section = 'import'
): Promise<void> {
  const phone = isPhone()
  if (overlayAvailable('settings')) await openOverlay('settings', activeTabId, null, null, section)
  else openSettings(phone ? 'import' : section)
  if (!phone) await openImportDialog(activeTabId, source)
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
