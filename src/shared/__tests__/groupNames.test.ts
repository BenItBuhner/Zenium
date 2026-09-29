import { describe, expect, it } from 'vitest'
import { NEW_FOLDER_NAME } from '../formFactor'
import { TOUCH_GROUP_DEFAULT_NAME, isDefaultGroupName } from '../groupNames'

/**
 * The one place the touch hosts' default group name is pinned as a word: every other test of
 * "the default name" – the core's, the renderer's, another PR's – compares against the constant,
 * so a change of the word is one line here and the rest keeps passing.
 */
describe('the touch hosts’ default group name (§6): one shared constant', () => {
  it('is "Group" – the touch hosts say Group, never "New Folder"', () => {
    expect(TOUCH_GROUP_DEFAULT_NAME).toBe('Group')
    expect(TOUCH_GROUP_DEFAULT_NAME).not.toBe(NEW_FOLDER_NAME)
  })

  it('isDefaultGroupName: true for no name at all and for the touch default', () => {
    expect(isDefaultGroupName(TOUCH_GROUP_DEFAULT_NAME)).toBe(true)
    expect(isDefaultGroupName('')).toBe(true)
    expect(isDefaultGroupName('   ')).toBe(true)
    expect(isDefaultGroupName(undefined)).toBe(true)
    expect(isDefaultGroupName(null)).toBe(true)
  })

  it('isDefaultGroupName: false for a name the user gave – and for the desktop’s "New Folder", which is not this module’s default', () => {
    expect(isDefaultGroupName('Research')).toBe(false)
    expect(isDefaultGroupName(`${TOUCH_GROUP_DEFAULT_NAME} 2`)).toBe(false)
    expect(isDefaultGroupName(TOUCH_GROUP_DEFAULT_NAME.toLowerCase())).toBe(false)
    expect(isDefaultGroupName(NEW_FOLDER_NAME)).toBe(false)
  })
})
