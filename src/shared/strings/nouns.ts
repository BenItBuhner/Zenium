/**
 * The string table's word for a group of tabs: Zen's Folder, on every host. This module imports
 * nothing: `groupNames.ts` and `formFactor.ts` re-export its words, `strings/index.ts` reads
 * them, never the other way round.
 */

/** The name a folder made with no name of its own gets, on every host. */
export const NEW_FOLDER_NAME = 'New Folder'

/**
 * The default name touch hosts gave a group before every host said Folder. Records are not
 * migrated, so a group still wearing it reads as unnamed.
 */
const LEGACY_GROUP_NAME = 'Group'

/**
 * Whether a folder still wears a default name – no name at all, "New Folder", or the touch hosts'
 * old "Group" – so a message about it can leave the name out ("Folder closed") where a
 * folder the user named is called by that name.
 */
export function isDefaultGroupName(name: string | undefined | null): boolean {
  return (
    name == null || name.trim() === '' || name === NEW_FOLDER_NAME || name === LEGACY_GROUP_NAME
  )
}
