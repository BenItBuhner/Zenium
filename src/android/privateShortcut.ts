import { PRIVATE_CONTAINER_ID, type Tab } from '@shared/types'
import type { Browser } from '@core/browser'
import type { ZenWindow } from '@core/window'

/** What the shortcut says on a WebView without profiles, where nothing could be kept private. */
export const PRIVATE_TABS_UNAVAILABLE = 'Private tabs need a newer Android System WebView'

/**
 * The launcher shortcut's "New private tab" (INC-01): the intent the launcher fires reaches the
 * core here, through `LauncherIconActivity` -> `MainActivity.handleIntent` -> `window.__zenHost`.
 * The tab is a tab another app sent, so it is created `fromIntent` like a link an app handed
 * over: back at its root returns to the launcher and the tab closes on the way out (#117's
 * `rootBackAction` -> `caller`), instead of closing into the app's other tabs.
 *
 * The shortcut is static, so it is offered on a WebView without profiles too, where the core
 * declines (`capabilities.privateTabs` off): the user hears why instead of getting a tab that
 * only looks private.
 */
export function openShortcutPrivateTab(browser: Browser, win: ZenWindow): Tab | null {
  if (!browser.state.capabilities.privateTabs) {
    browser.toast(PRIVATE_TABS_UNAVAILABLE, 'error', win)
    return null
  }
  return browser.tabs.createTab(
    { active: true, containerId: PRIVATE_CONTAINER_ID, fromIntent: true },
    win
  )
}
