import { describe, expect, it } from 'vitest'
import { NEW_FOLDER_NAME, TOUCH_GROUP_DEFAULT_NAME, isDefaultGroupName } from '../groupNames'

/**
 * The one place the default group names are pinned as words: every other test of "the default
 * name" – the core's, the renderer's, another PR's – compares against the constants, so a change
 * of a word is one line here and the rest keeps passing.
 */
describe('the default group names (§6): one shared module', () => {
  it('the touch hosts’ default is "Group" – the touch hosts say Group, never "New Folder"', () => {
    expect(TOUCH_GROUP_DEFAULT_NAME).toBe('Group')
  })

  it('the desktop’s default is "New Folder" – and the two words differ', () => {
    expect(NEW_FOLDER_NAME).toBe('New Folder')
    expect(TOUCH_GROUP_DEFAULT_NAME).not.toBe(NEW_FOLDER_NAME)
  })

  it('isDefaultGroupName: the set is exactly no name, a blank name, "Group" and "New Folder" – on every host', () => {
    // The four members, each spelled out: a group wearing any of these was never named by the
    // user – "New Folder" on a touch host too, the name of every touch group made before the
    // touch hosts had a word of their own (records are not migrated).
    expect(isDefaultGroupName('')).toBe(true)
    expect(isDefaultGroupName('   ')).toBe(true)
    expect(isDefaultGroupName('Group')).toBe(true)
    expect(isDefaultGroupName('New Folder')).toBe(true)
    // The same members through the constants, and the no-value cases.
    expect(isDefaultGroupName(TOUCH_GROUP_DEFAULT_NAME)).toBe(true)
    expect(isDefaultGroupName(NEW_FOLDER_NAME)).toBe(true)
    expect(isDefaultGroupName(undefined)).toBe(true)
    expect(isDefaultGroupName(null)).toBe(true)
  })

  it('isDefaultGroupName: false for a name the user gave', () => {
    expect(isDefaultGroupName('Research')).toBe(false)
    expect(isDefaultGroupName(`${TOUCH_GROUP_DEFAULT_NAME} 2`)).toBe(false)
    expect(isDefaultGroupName(TOUCH_GROUP_DEFAULT_NAME.toLowerCase())).toBe(false)
    expect(isDefaultGroupName(`${NEW_FOLDER_NAME} (2)`)).toBe(false)
  })
})
