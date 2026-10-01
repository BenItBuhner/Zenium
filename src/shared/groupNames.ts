/**
 * The default group names – ONE module for the core (`menus.ts`, `browser.ts`) and the renderer,
 * so a group made with no name of its own, and every test of "the default name", read the same
 * words. This module imports nothing: `formFactor.ts` reads it (and re-exports the desktop's
 * word), never the other way round.
 *
 * §6: the desktop says Folder, the touch hosts say Group – a group a touch host makes is named
 * "Group", never "New Folder"; the desktop's stays "New Folder" (`newFolderName` in
 * `formFactor.ts` picks by host). Both words are default names: a group still wearing either
 * was never named by the user.
 */

/**
 * The name a group made on the phone or the tablet gets when no name is given: the overview's
 * drag-to-group, the link menu's "Open Link in New Tab in Group", the tab menu's "Add Tab to New
 * Folder" and "Move to Folder ▸ New Folder…", the tab strip's and the selection menu's New Folder.
 */
export const TOUCH_GROUP_DEFAULT_NAME = 'Group'

/**
 * The name a group made on the desktop gets when no name is given – and the name every touch
 * group made before the touch hosts had a word of their own still wears (records are not
 * migrated).
 */
export const NEW_FOLDER_NAME = 'New Folder'

/**
 * Whether a group still wears a default name – no name at all, the touch hosts' "Group" or the
 * desktop's "New Folder", on every host – so a message about it can leave the name out ("Tab
 * group closed and saved") where a group the user named is called by that name. "New Folder"
 * counts on the touch hosts too: a touch group from before this word had a home carries it, and
 * no migration renames records.
 */
export function isDefaultGroupName(name: string | undefined | null): boolean {
  return (
    name == null ||
    name.trim() === '' ||
    name === TOUCH_GROUP_DEFAULT_NAME ||
    name === NEW_FOLDER_NAME
  )
}
