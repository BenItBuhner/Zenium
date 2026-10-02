/**
 * The string table's nouns (spec §9 item 10; the D7 proposal's `nouns.ts`): the one per-host
 * axis the spec allows (TABLET-22) – the desktop says Folder, the touch hosts say Group – and
 * the default names a group wears until the user names it. This module imports nothing:
 * `groupNames.ts` and `formFactor.ts` re-export its words, `strings/index.ts` reads them, never
 * the other way round.
 *
 * §6: a group a touch host makes is named "Group", never "New Folder"; the desktop's stays "New
 * Folder" (`newFolderName` in `formFactor.ts` picks by host). Both words are default names: a
 * group still wearing either was never named by the user.
 */

/** The side of the noun axis a host draws: the desktop's `folder`, the phone's and tablet's `group`. */
export type Noun = 'folder' | 'group'

/** One word per side of the axis; an entry's `noun` field, and `S.menu(id, { noun })` picks. */
export interface NounWords {
  folder: string
  group: string
}

/** The noun as a menu face writes it ("Add Tab to New Folder" / "Add Tab to New Group"). */
export const GROUP_NOUN: NounWords = { folder: 'Folder', group: 'Group' }

/** The live group's noun – a coined sense (§9.1), so `sentence()` keeps its capitals. */
export const LIVE_GROUP_NOUN: NounWords = { folder: 'Live Folder', group: 'Live Group' }

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

/** The default name by side of the axis: what `newFolderName` picks from a form factor. */
export const DEFAULT_GROUP_NAME: NounWords = {
  folder: NEW_FOLDER_NAME,
  group: TOUCH_GROUP_DEFAULT_NAME
}

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
