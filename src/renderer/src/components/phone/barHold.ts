import type { PhoneBarItemId, Rect, Tab } from '@shared/types'
import { openSettings } from '@renderer/lib/pages'
import { openBarEditor, openHistoryMenu, openTabsMenu } from '@renderer/lib/ui'

/**
 * What a hold on the phone bar opens (`useBarHold`, the shell's). On the Tabs button: its quick
 * menu, anchored to the button; on Home, the homepage setting (TB-15: Chrome's long-press on
 * its Home button) – Settings › Look and Feel landed on its Home group, the Homepage row's
 * (`?row=`, the row `homepageGroup` names in sections.tsx), not the section's top; on Back or
 * Forward with history that way, the tab's history popup (GN-08: Chrome's long-press on its
 * toolbar's Back); any other hold – a Back with nothing behind it included, the bar's own
 * background – the editor.
 */
export function barHold(
  item: PhoneBarItemId | null,
  rect: Rect,
  tab: Tab | null,
  activeTabId: string | null
): void {
  if (item === 'tabs') void openTabsMenu(rect, activeTabId)
  else if (item === 'home') openSettings('look', { row: 'homepage' })
  else if (item === 'back' && tab?.canGoBack) void openHistoryMenu(rect, 'back', activeTabId)
  else if (item === 'forward' && tab?.canGoForward)
    void openHistoryMenu(rect, 'forward', activeTabId)
  else void openBarEditor(activeTabId)
}
