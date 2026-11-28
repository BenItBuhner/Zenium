import { describe, expect, it } from 'vitest'
import { NEW_FOLDER_NAME, isDefaultGroupName } from '../groupNames'

/**
 * The one place the default folder name is pinned as a word: every other test of "the default
 * name" compares against the constant, so a change of the word is one line here.
 */
describe('the default folder name: one shared module', () => {
  it('is "New Folder" on every host', () => {
    expect(NEW_FOLDER_NAME).toBe('New Folder')
  })

  it('isDefaultGroupName: no name, a blank name, "New Folder" and the touch hosts’ old "Group"', () => {
    expect(isDefaultGroupName('')).toBe(true)
    expect(isDefaultGroupName('   ')).toBe(true)
    expect(isDefaultGroupName('Group')).toBe(true)
    expect(isDefaultGroupName(NEW_FOLDER_NAME)).toBe(true)
    expect(isDefaultGroupName(undefined)).toBe(true)
    expect(isDefaultGroupName(null)).toBe(true)
  })

  it('isDefaultGroupName: false for a name the user gave', () => {
    expect(isDefaultGroupName('Research')).toBe(false)
    expect(isDefaultGroupName('Group 2')).toBe(false)
    expect(isDefaultGroupName('group')).toBe(false)
    expect(isDefaultGroupName(`${NEW_FOLDER_NAME} (2)`)).toBe(false)
  })
})
