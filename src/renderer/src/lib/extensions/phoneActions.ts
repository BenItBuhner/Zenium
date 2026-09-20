import type {
  CommandArgs,
  CommandName,
  ExtensionInfo,
  MenuItemDescriptor,
  Rect
} from '@shared/types'
import { badgeLabel, badgeStyle, type BadgeStyle } from './badge'
import { actionEnabled, actionIcon, actionTitle } from './toolbar'

/**
 * The model of the phone's Extensions sheet (the app menu's Extensions row): what the desktop
 * toolbar and its puzzle panel show as buttons, as 44 px rows – one per enabled extension with
 * an action – and Chrome's action context menu as the rows' long-press menu. Pure: the sheet
 * component (`components/phone/ExtensionsSheet.tsx`) draws these and runs the commands.
 */

/** One row of the sheet: an enabled, loaded extension with a `chrome.action` state. */
export interface ActionSheetRow {
  id: string
  name: string
  /** The action's own icon, then the manifest icon; null for the puzzle glyph. */
  icon: string | null
  /** The action title (the desktop button's tooltip), then the name. */
  title: string
  /** Chrome's badge text, at most four characters; empty for no badge. */
  badge: string
  /** The extension's badge colours when it set them; null for the surface's accent (§9.29). */
  badgeColours: BadgeStyle | null
  /**
   * `chrome.action.enable` / `disable` for the current tab: off, the row stays and dims (§9.30)
   * and a tap does nothing, as the desktop button does.
   */
  enabled: boolean
  /** The tap opens a popup document; otherwise it fires `action.onClicked`. */
  hasPopup: boolean
}

/**
 * The rows, in the list's order: enabled extensions that loaded and have an action. A disabled
 * extension, one that failed to load and one without an action state are not listed (the empty
 * state says "No extensions with a toolbar action").
 */
export function actionSheetRows(extensions: readonly ExtensionInfo[]): ActionSheetRow[] {
  return extensions
    .filter((ext) => ext.enabled && !ext.error && ext.action !== undefined)
    .map((ext) => {
      const action = ext.action!
      return {
        id: ext.id,
        name: ext.name || ext.id,
        icon: actionIcon(ext),
        title: actionTitle(ext),
        badge: badgeLabel(action.badgeText),
        badgeColours: badgeStyle(action),
        enabled: actionEnabled(ext),
        hasPopup: Boolean(action.popup ?? ext.popup)
      }
    })
}

/** A command with its arguments, as the sheet runs it. */
export type SheetCommand<K extends CommandName = CommandName> = {
  [N in K]: { name: N; args: CommandArgs<N> }
}[K]

/**
 * What a tap on a row runs: the one command path the desktop button takes (`extension.openPopup`
 * with the row's box as the anchor), which the host resolves to the popup when the action names
 * one and to `action.onClicked` when it does not. Null for an action that is off for this tab.
 */
export function actionTapCommand(
  row: Pick<ActionSheetRow, 'id' | 'enabled'>,
  anchor: Rect
): SheetCommand<'extension.openPopup'> | null {
  if (!row.enabled) return null
  return { name: 'extension.openPopup', args: { id: row.id, anchor } }
}

/** The browser's entries of the long-press menu: Chrome's action context menu, less what a phone has no place for. */
export type ActionMenuItemId = 'options' | 'manage' | 'remove'

export interface ActionMenuItem {
  id: ActionMenuItemId
  /** Title Case: a context menu's items (§9.1). */
  label: string
  /** The destructive entry, in the danger ink; it asks first (`removeConfirm`). */
  danger?: true
}

/**
 * The long-press menu in Chrome's order, as groups a hairline tells apart: the extension's own
 * `contextMenus` items for its action first (`extension.actionMenuItems`, in the layout the
 * host answered: check states, submenus, its own separators as group breaks), then the
 * browser's – Options when the manifest names an options page, Manage Extension – and last,
 * under a hairline of its own, Remove from Zenium, the destructive row (§10.4). No Pin / Unpin:
 * the phone has no toolbar to pin to.
 */
export interface ActionMenuGroup {
  /** The extension's items are `own` (a pick is `extension.actionMenuClick`); the rest the browser's. */
  kind: 'own' | 'browser'
  items: (MenuItemDescriptor | ActionMenuItem)[]
}

export function actionMenuGroups(
  ext: Pick<ExtensionInfo, 'optionsPage'>,
  own: readonly MenuItemDescriptor[] = []
): ActionMenuGroup[] {
  const groups: ActionMenuGroup[] = []
  // The host's separators break the extension's items into groups, as the native menu draws them.
  let group: MenuItemDescriptor[] = []
  for (const item of own) {
    if (item.type === 'separator') {
      if (group.length) groups.push({ kind: 'own', items: group })
      group = []
    } else {
      group.push(item)
    }
  }
  if (group.length) groups.push({ kind: 'own', items: group })
  const browser: ActionMenuItem[] = []
  if (ext.optionsPage) browser.push({ id: 'options', label: 'Options' })
  browser.push({ id: 'manage', label: 'Manage Extension' })
  groups.push({ kind: 'browser', items: browser })
  groups.push({
    kind: 'browser',
    items: [{ id: 'remove', label: 'Remove from Zenium', danger: true }]
  })
  return groups
}

/** The browser's entries alone, flat, in the menu's order (the groups above without the extension's). */
export function actionMenuItems(ext: Pick<ExtensionInfo, 'optionsPage'>): ActionMenuItem[] {
  return actionMenuGroups(ext).flatMap((group) => group.items as ActionMenuItem[])
}

/** Whether a row of the menu is one of the extension's own items (a descriptor) or the browser's. */
export function isOwnMenuItem(
  item: MenuItemDescriptor | ActionMenuItem
): item is MenuItemDescriptor {
  return 'type' in item
}

/**
 * What a pick among the extension's own items runs: the item's handle back to the core
 * (`extension.actionMenuClick`), which fires the extension's `contextMenus.onClicked` with
 * Chrome's `OnClickData` for the `action` context and the active tab. Null for an item that
 * only opens a submenu (the sheet drills in) or one the extension turned off.
 */
export function ownMenuCommand(
  extensionId: string,
  item: MenuItemDescriptor
): SheetCommand<'extension.actionMenuClick'> | null {
  if (item.submenu || !item.enabled) return null
  return { name: 'extension.actionMenuClick', args: { id: extensionId, itemId: item.id } }
}

/** The confirmation the Remove entry opens (the wording of Settings › Extensions' Remove row). */
export function removeConfirm(ext: Pick<ExtensionInfo, 'id' | 'name'>): {
  title: string
  description: string
  action: string
} {
  return {
    title: `Remove ${ext.name || ext.id}?`,
    description: 'Its settings and data on this device go with it.',
    action: 'Remove'
  }
}

/**
 * The command a menu entry runs once the menu has left: Options opens the options page as a tab
 * (`extension.openOptions`), a confirmed Remove runs `extension.remove`. Manage Extension is not
 * a command: the sheet opens Settings › Extensions on the extension's details (`manageExtension`).
 */
export function actionMenuCommand(
  id: Exclude<ActionMenuItemId, 'manage'>,
  extensionId: string
): SheetCommand<'extension.openOptions' | 'extension.remove'> {
  return id === 'options'
    ? { name: 'extension.openOptions', args: { id: extensionId } }
    : { name: 'extension.remove', args: { id: extensionId } }
}
