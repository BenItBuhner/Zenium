import { describe, expect, it } from 'vitest'
import {
  NEW_FOLDER_NAME,
  NEW_GROUP_NAME,
  PHONE_MAX_WIDTH,
  classifyViewport,
  newFolderName,
  touchLayout
} from '../formFactor'
import type { FormFactor } from '../types'

const finger = { coarse: true, hover: false }
const mouse = { coarse: false, hover: true }
/** A touch screen with a mouse or trackpad attached: DeX, a tablet with a keyboard cover. */
const touchAndMouse = { coarse: true, hover: true }

describe('classifyViewport', () => {
  it('keeps a phone a phone in both orientations', () => {
    expect(classifyViewport({ width: 412, height: 915, ...finger })).toBe('phone')
    expect(classifyViewport({ width: 915, height: 412, ...finger })).toBe('phone')
    // A large phone: still under the tablet line on its short side.
    expect(classifyViewport({ width: 480, height: 1040, ...finger })).toBe('phone')
    expect(classifyViewport({ width: 1040, height: 480, ...finger })).toBe('phone')
  })

  it('keeps a tablet a tablet in both orientations', () => {
    expect(classifyViewport({ width: 800, height: 1280, ...finger })).toBe('tablet')
    expect(classifyViewport({ width: 1280, height: 800, ...finger })).toBe('tablet')
    // A small tablet exactly on Android's sw600dp line.
    expect(classifyViewport({ width: PHONE_MAX_WIDTH, height: 960, ...finger })).toBe('tablet')
    expect(classifyViewport({ width: 960, height: PHONE_MAX_WIDTH, ...finger })).toBe('tablet')
  })

  it('gives a mouse the desktop layout, and the phone one only in a narrow window', () => {
    expect(classifyViewport({ width: 1280, height: 800, ...mouse })).toBe('desktop')
    // DeX and a tablet with a trackpad: the window's width decides, as on a laptop.
    expect(classifyViewport({ width: 1920, height: 1080, ...touchAndMouse })).toBe('tablet')
    expect(classifyViewport({ width: 500, height: 900, ...mouse })).toBe('phone')
    expect(classifyViewport({ width: 500, height: 900, ...touchAndMouse })).toBe('phone')
    // A short, wide desktop window is not a sideways phone.
    expect(classifyViewport({ width: 1000, height: 400, ...mouse })).toBe('desktop')
    expect(classifyViewport({ width: 1000, height: 400, ...touchAndMouse })).toBe('tablet')
  })

  it('tells a phone with the keyboard up from a phone on its side', () => {
    // Portrait with the soft keyboard taking half the height: the width still decides.
    expect(classifyViewport({ width: 412, height: 420, ...finger })).toBe('phone')
    // Foldable unfolded: both sides are tablet-sized.
    expect(classifyViewport({ width: 673, height: 841, ...finger })).toBe('tablet')
  })
})

describe('newFolderName – what a group made with no name of its own is called (§6)', () => {
  it('is the desktop’s "New Folder" on the desktop and the touch hosts’ "Group" on the phone and the tablet', () => {
    expect(NEW_FOLDER_NAME).toBe('New Folder')
    expect(NEW_GROUP_NAME).toBe('Group')
    expect(newFolderName('desktop')).toBe('New Folder')
    expect(newFolderName('phone')).toBe('Group')
    expect(newFolderName('tablet')).toBe('Group')
    // The touch name follows `touchLayout`, so a layout a finger drives is never named "New
    // Folder" – §6's "never".
    for (const layout of ['phone', 'tablet', 'desktop'] as const satisfies readonly FormFactor[])
      expect(newFolderName(layout) === NEW_GROUP_NAME).toBe(touchLayout(layout))
  })

  it('names as the desktop does when there is no form factor to read – a caller with no window', () => {
    expect(newFolderName(undefined)).toBe('New Folder')
  })
})
