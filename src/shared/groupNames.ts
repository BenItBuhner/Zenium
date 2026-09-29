/**
 * The touch hosts' default group name – ONE constant for the core (`menus.ts`, `browser.ts`)
 * and the renderer, so a group the phone or the tablet makes with no name of its own, and every
 * test of "the default name", read the same word.
 *
 * §6: the desktop says Folder, the touch hosts say Group – a group a touch host makes is named
 * "Group", never "New Folder". The desktop's "New Folder" is not this module's: it stays where
 * the desktop's paths always had it (`newFolderName` in `formFactor.ts` picks by host).
 */

/**
 * The name a group made on the phone or the tablet gets when no name is given: the overview's
 * drag-to-group, the link menu's "Open Link in New Tab in Group", the tab menu's "Add Tab to New
 * Folder" and "Move to Folder ▸ New Folder…", the tab strip's and the selection menu's New Folder.
 */
export const TOUCH_GROUP_DEFAULT_NAME = 'Group'

/**
 * Whether a group still wears a default name – no name at all, or the touch hosts' default – so
 * a message about it can leave the name out ("Tab group closed and saved") where a group the
 * user named is called by that name. The desktop's "New Folder" is a name of the desktop's,
 * not a default of this module's, and is not one.
 */
export function isDefaultGroupName(name: string | undefined | null): boolean {
  return name == null || name.trim() === '' || name === TOUCH_GROUP_DEFAULT_NAME
}
