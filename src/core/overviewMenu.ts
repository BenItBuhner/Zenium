import {
  isOverviewChromeCommand,
  isOverviewMenuSeparator,
  overviewMenu,
  type OverviewChromeCommand,
  type OverviewMenuContext
} from '../shared/overviewMenu'
import type { MenuItemTemplate } from './platform'

/**
 * The tab overview's ⋯ menu as the core's menu template (tab overview cleanup spec §4, §5):
 * `Menus.showAppMenu` pops it through the bar's own surface while the overview stands – the
 * phone's sheet, the tablet's popover at the button – in place of the app menu. The rows and
 * their visibility are `overviewMenu`'s (`shared/overviewMenu.ts`); this is the mapping to the
 * host's items: a destructive row in the danger ink, a disabled row greyed and kept (§9.17), the
 * hairline a separator, "Switch Space ▸" a submenu of radio rows with the current space checked.
 */

export interface OverviewMenuActs {
  /** New Tab: the core opens the new tab page in the window (`Browser.openNewTab`). */
  newTab(): void
  /** New Private Tab: the core opens a private tab (`Tabs.newPrivateTab`). */
  newPrivateTab(): void
  /** A row of Switch Space ▸: the core switches the window to the space (`Tabs.switchSpace`). */
  switchSpace(spaceId: string): void
  /** Every other row: the chrome's to act on (the `overview.command` event). */
  chrome(command: OverviewChromeCommand): void
}

export function overviewMenuTemplate(
  ctx: OverviewMenuContext,
  acts: OverviewMenuActs
): MenuItemTemplate[] {
  return overviewMenu(ctx).map((entry): MenuItemTemplate => {
    if (isOverviewMenuSeparator(entry)) return { type: 'separator' }
    const item: MenuItemTemplate = { label: entry.label, enabled: !entry.disabled }
    if (entry.destructive) item.danger = true
    const { command } = entry
    if (command === 'switch-space') {
      item.submenu = (entry.spaces ?? []).map((space) => ({
        type: 'radio',
        label: space.label,
        checked: space.checked,
        click: () => acts.switchSpace(space.spaceId)
      }))
      return item
    }
    if (command === 'new-tab') item.click = () => acts.newTab()
    else if (command === 'new-private-tab') item.click = () => acts.newPrivateTab()
    else if (isOverviewChromeCommand(command)) item.click = () => acts.chrome(command)
    return item
  })
}
