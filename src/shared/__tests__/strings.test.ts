import { describe, expect, it } from 'vitest'
import { NEW_FOLDER_NAME, TOUCH_GROUP_DEFAULT_NAME, isDefaultGroupName } from '../groupNames'
import { newFolderName } from '../formFactor'
import {
  PROTECTED,
  S,
  face,
  fill,
  nounFor,
  plural,
  sentence,
  tableEntries,
  tableValues,
  type Entry
} from '../strings'
import { ACTIONS } from '../strings/actions'
import { APP_MENU } from '../strings/appMenu'
import {
  DEFAULT_GROUP_NAME,
  GROUP_NOUN,
  LIVE_GROUP_NOUN,
  NEW_FOLDER_NAME as NOUNS_NEW_FOLDER_NAME,
  TOUCH_GROUP_DEFAULT_NAME as NOUNS_TOUCH_GROUP_DEFAULT_NAME,
  isDefaultGroupName as nounsIsDefaultGroupName
} from '../strings/nouns'

/**
 * The string table's engine (spec §9 item 10; the D7 proposal §C): `fill()`, `plural()`,
 * `sentence()` with the PROTECTED list, and the faces an entry is read in – by the entry alone,
 * then through `S` for the action tables, the first family to land (§D; the rest one PR each).
 */
describe('fill(): {name} holes', () => {
  it('fills each hole from the values, as many times as it appears', () => {
    expect(fill('Add {n} Tabs to {noun}', { n: 3, noun: 'Folder' })).toBe('Add 3 Tabs to Folder')
    expect(fill('Open in {app}', { app: 'Figma' })).toBe('Open in Figma')
    expect(fill('{site} wants to open {object}', { site: 'example.com', object: 'Zoom' })).toBe(
      'example.com wants to open Zoom'
    )
    expect(fill('{n} of {n}', { n: 2 })).toBe('2 of 2')
  })

  it('leaves a hole with no value as typed – visible, never thrown over', () => {
    const template: string = 'Installed {app}'
    expect(fill(template, {})).toBe('Installed {app}')
  })

  it('is a plain string, never a template literal: a number is written as it is', () => {
    expect(fill('{n} tabs', { n: 1000 })).toBe('1000 tabs')
  })
})

describe('plural(): the counted face', () => {
  const count = { one: 'Put 1 Tab to Sleep', other: 'Put {n} Tabs to Sleep' }

  it('picks `one` for a count of 1 and `other` else, filling {n}', () => {
    expect(plural(count, 1)).toBe('Put 1 Tab to Sleep')
    expect(plural(count, 3)).toBe('Put 3 Tabs to Sleep')
    expect(plural(count, 0)).toBe('Put 0 Tabs to Sleep')
  })
})

describe('sentence(): the derived sentence face (§9.1)', () => {
  it('lower-cases every word after the first', () => {
    expect(sentence('Duplicate Tab')).toBe('Duplicate tab')
    expect(sentence('Move Tab to Start')).toBe('Move tab to start')
    expect(sentence('Bookmark All Tabs')).toBe('Bookmark all tabs')
    expect(sentence('Open a New Blank Window')).toBe('Open a new blank window')
  })

  it('keeps the coined senses, proper nouns, acronyms and key names (PROTECTED)', () => {
    expect(sentence('Copy Current URL as Markdown')).toBe('Copy current URL as Markdown')
    expect(sentence('Jump to the Next Space')).toBe('Jump to the next Space')
    expect(sentence('Create New Space')).toBe('Create new Space')
    expect(sentence('Expand Glance')).toBe('Expand Glance')
    expect(sentence('New Boost')).toBe('New Boost')
    expect(sentence('Remove Mod')).toBe('Remove Mod')
    expect(sentence('Open in Chrome')).toBe('Open in Chrome')
    expect(sentence('Save as PDF')).toBe('Save as PDF')
    expect(sentence('JavaScript Console')).toBe('JavaScript console')
    expect(sentence('Press Enter to Search')).toBe('Press Enter to search')
    expect(sentence('Picture-in-Picture')).toBe('Picture-in-Picture')
    expect(sentence('Toggle Picture-in-Picture')).toBe('Toggle Picture-in-Picture')
    expect(sentence('About Zenium')).toBe('About Zenium')
  })

  it('lower-cases the common nouns the spec names (§9.1 v2; P-45)', () => {
    expect(sentence('Toggle Split View Grid')).toBe('Toggle split view grid')
    expect(sentence('Toggle Compact Mode')).toBe('Toggle compact mode')
    expect(sentence('Focus Bookmarks Bar')).toBe('Focus bookmarks bar')
    expect(sentence('Toggle Reader View')).toBe('Toggle reader view')
    expect(sentence('Close Tab Group')).toBe('Close tab group')
  })

  it('keeps the phrases with part of their capitals', () => {
    expect(sentence('Customise New Tab Page')).toBe('Customise New Tab page')
    expect(sentence('New Tab Page')).toBe('New Tab page')
    expect(sentence('Add to Home Screen')).toBe('Add to Home screen')
    expect(sentence('New Live Folder')).toBe('New Live Folder')
    expect(sentence('Open Live Group')).toBe('Open Live Group')
    // The plain noun is a common one.
    expect(sentence('Add Tab to New Folder')).toBe('Add tab to new folder')
  })

  it('reads a word through the punctuation around it, and leaves a {placeholder} alone', () => {
    expect(sentence('Open in {app}?')).toBe('Open in {app}?')
    expect(sentence('Switch to Space {n}')).toBe('Switch to Space {n}')
    expect(sentence('Close Tab (Esc)')).toBe('Close tab (Esc)')
    expect(sentence("Zenium's Settings")).toBe("Zenium's settings")
    expect(sentence('Pin / Unpin Tab')).toBe('Pin / unpin tab')
    expect(sentence('Add-ons and Themes')).toBe('Add-ons and themes')
  })

  it('PROTECTED is the list the proposal names, and no common noun', () => {
    for (const word of [
      'Space',
      'Spaces',
      'Essentials',
      'Glance',
      'Boost',
      'Boosts',
      'Mod',
      'Mods'
    ])
      expect(PROTECTED.has(word), word).toBe(true)
    for (const word of ['Chrome', 'Google', 'Android', 'Windows', 'Markdown', 'Zenium'])
      expect(PROTECTED.has(word), word).toBe(true)
    for (const word of ['URL', 'URLs', 'PDF', 'HTML', 'CPU', 'QR', 'PIN', 'MCP'])
      expect(PROTECTED.has(word), word).toBe(true)
    for (const word of ['Ctrl', 'Alt', 'Esc', 'Enter', 'Shift', 'Picture-in-Picture'])
      expect(PROTECTED.has(word), word).toBe(true)
    for (const word of ['Tab', 'Folder', 'Group', 'Sidebar', 'Window', 'View', 'Mode', 'Bookmarks'])
      expect(PROTECTED.has(word), word).toBe(false)
  })
})

describe('face(): the four faces of an entry', () => {
  it('menu is the Title Case words; row, button and title the sentence face', () => {
    const entry: Entry = { menu: 'Copy Current URL as Markdown' }
    expect(face(entry, 'menu')).toBe('Copy Current URL as Markdown')
    expect(face(entry, 'row')).toBe('Copy current URL as Markdown')
    expect(face(entry, 'button')).toBe('Copy current URL as Markdown')
    expect(face(entry, 'title')).toBe('Copy current URL as Markdown')
  })

  it('the ask flag supplies the ellipsis on the menu and row faces, never on a button or a title (P-5, P-39)', () => {
    const entry: Entry = { menu: 'Share', ask: true }
    expect(face(entry, 'menu')).toBe('Share…')
    expect(face(entry, 'row')).toBe('Share…')
    expect(face(entry, 'button')).toBe('Share')
    expect(face(entry, 'title')).toBe('Share')
    const data: Entry = { menu: 'Delete Browsing Data', ask: true }
    expect(face(data, 'row')).toBe('Delete browsing data…')
    expect(face(data, 'title')).toBe('Delete browsing data')
  })

  it('an explicit sentence replaces the derived one for the plain menu words alone', () => {
    const entry: Entry = {
      menu: 'Pin / Unpin Tab',
      sentence: 'Pin or unpin tab',
      state: { on: 'Unpin Tab', off: 'Pin Tab' }
    }
    expect(face(entry, 'row')).toBe('Pin or unpin tab')
    expect(face(entry, 'menu')).toBe('Pin / Unpin Tab')
    expect(face(entry, 'row', { state: true })).toBe('Unpin tab')
    expect(face(entry, 'row', { state: false })).toBe('Pin tab')
    const overlay: Entry = {
      menu: 'Screenshot',
      sentence: 'Open the screenshot overlay',
      ask: true
    }
    expect(face(overlay, 'menu')).toBe('Screenshot…')
    expect(face(overlay, 'row')).toBe('Open the screenshot overlay…')
    expect(face(overlay, 'title')).toBe('Open the screenshot overlay')
  })

  it('the state axis: `on` while the state is on (the row turns it off), `off` while it is off', () => {
    const entry: Entry = {
      menu: 'Full Screen',
      state: { on: 'Exit Full Screen', off: 'Enter Full Screen' }
    }
    expect(face(entry, 'menu')).toBe('Full Screen')
    expect(face(entry, 'menu', { state: true })).toBe('Exit Full Screen')
    expect(face(entry, 'menu', { state: false })).toBe('Enter Full Screen')
    expect(face(entry, 'row', { state: false })).toBe('Enter full screen')
    // An entry without the axis ignores the context.
    expect(face({ menu: 'Reload' }, 'menu', { state: true })).toBe('Reload')
  })

  it('the count axis: plural by the count, {n} filled', () => {
    const entry: Entry = {
      menu: 'Put Tabs to Sleep',
      count: { one: 'Put 1 Tab to Sleep', other: 'Put {n} Tabs to Sleep' }
    }
    expect(face(entry, 'menu', { n: 1 })).toBe('Put 1 Tab to Sleep')
    expect(face(entry, 'menu', { n: 4 })).toBe('Put 4 Tabs to Sleep')
    expect(face(entry, 'row', { n: 4 })).toBe('Put 4 tabs to sleep')
    expect(face(entry, 'menu')).toBe('Put Tabs to Sleep')
  })

  it('the noun axis: {noun} filled with the side’s word, the desktop’s when no side is given', () => {
    const entry: Entry = { menu: 'Add Tab to New {noun}', noun: GROUP_NOUN }
    expect(face(entry, 'menu', { noun: 'folder' })).toBe('Add Tab to New Folder')
    expect(face(entry, 'menu', { noun: 'group' })).toBe('Add Tab to New Group')
    expect(face(entry, 'menu')).toBe('Add Tab to New Folder')
    expect(face(entry, 'row', { noun: 'group' })).toBe('Add tab to new group')
    // The live noun is a coined sense and keeps its capitals in the sentence face.
    const live: Entry = { menu: 'New {noun}', noun: LIVE_GROUP_NOUN, ask: true }
    expect(face(live, 'menu', { noun: 'group' })).toBe('New Live Group…')
    expect(face(live, 'row', { noun: 'folder' })).toBe('New Live Folder…')
    // Sides that share no words: the whole face is the side's.
    const unpack: Entry = { menu: '{noun}', noun: { folder: 'Unpack Folder', group: 'Ungroup' } }
    expect(face(unpack, 'menu', { noun: 'folder' })).toBe('Unpack Folder')
    expect(face(unpack, 'menu', { noun: 'group' })).toBe('Ungroup')
    expect(face(unpack, 'button', { noun: 'folder' })).toBe('Unpack folder')
    // Count and noun together.
    const counted: Entry = {
      menu: 'Add Tabs to {noun}',
      count: { one: 'Add Tab to {noun}', other: 'Add {n} Tabs to {noun}' },
      noun: GROUP_NOUN
    }
    expect(face(counted, 'menu', { n: 1, noun: 'group' })).toBe('Add Tab to Group')
    expect(face(counted, 'menu', { n: 5, noun: 'folder' })).toBe('Add 5 Tabs to Folder')
  })

  it('the os axis (Q4): the platform’s own words; a string keeps the entry’s ask, an OsFace states its own', () => {
    const minimise: Entry = { menu: 'Minimise Window', os: { darwin: 'Minimize' } }
    expect(face(minimise, 'menu')).toBe('Minimise Window')
    expect(face(minimise, 'menu', { os: 'linux' })).toBe('Minimise Window')
    expect(face(minimise, 'menu', { os: 'darwin' })).toBe('Minimize')
    const find: Entry = { menu: 'Find in Page', ask: true, os: { darwin: 'Find' } }
    expect(face(find, 'menu')).toBe('Find in Page…')
    expect(face(find, 'menu', { os: 'darwin' })).toBe('Find…')
    const settings: Entry = { menu: 'Settings', os: { darwin: { menu: 'Settings', ask: true } } }
    expect(face(settings, 'menu')).toBe('Settings')
    expect(face(settings, 'menu', { os: 'win32' })).toBe('Settings')
    expect(face(settings, 'menu', { os: 'darwin' })).toBe('Settings…')
    expect(face(settings, 'title', { os: 'darwin' })).toBe('Settings')
  })

  it('the orientation axis (P-34): the strip’s words by direction', () => {
    const entry: Entry = {
      menu: 'New Tab to the Right',
      orientation: { horizontal: 'New Tab to the Right', vertical: 'New Tab Below' }
    }
    expect(face(entry, 'menu', { orientation: 'horizontal' })).toBe('New Tab to the Right')
    expect(face(entry, 'menu', { orientation: 'vertical' })).toBe('New Tab Below')
    expect(face(entry, 'row', { orientation: 'vertical' })).toBe('New tab below')
  })
})

describe('nounFor(): the side of the noun axis by host', () => {
  it('the touch hosts say Group, the desktop and a caller with no form factor say Folder', () => {
    expect(nounFor('phone')).toBe('group')
    expect(nounFor('tablet')).toBe('group')
    expect(nounFor('desktop')).toBe('folder')
    expect(nounFor(undefined)).toBe('folder')
  })

  it('agrees with newFolderName and the default names', () => {
    for (const formFactor of ['phone', 'tablet', 'desktop'] as const)
      expect(newFolderName(formFactor)).toBe(DEFAULT_GROUP_NAME[nounFor(formFactor)])
    expect(newFolderName(undefined)).toBe(DEFAULT_GROUP_NAME.folder)
  })
})

describe('nouns.ts: the words, re-exported where they were', () => {
  it('groupNames.ts and formFactor.ts read the table’s nouns', () => {
    expect(TOUCH_GROUP_DEFAULT_NAME).toBe(NOUNS_TOUCH_GROUP_DEFAULT_NAME)
    expect(NEW_FOLDER_NAME).toBe(NOUNS_NEW_FOLDER_NAME)
    expect(isDefaultGroupName).toBe(nounsIsDefaultGroupName)
    expect(GROUP_NOUN).toEqual({ folder: 'Folder', group: 'Group' })
    expect(LIVE_GROUP_NOUN).toEqual({ folder: 'Live Folder', group: 'Live Group' })
    expect(DEFAULT_GROUP_NAME).toEqual({ folder: 'New Folder', group: 'Group' })
  })
})

describe('the merged table', () => {
  it('holds the action tables (PR-2) and the app menu (PR-2b) and nothing else yet: the families land one PR each (§D)', () => {
    const ids = tableEntries().map(([id]) => id)
    expect(ids).toEqual([...Object.keys(ACTIONS), ...Object.keys(APP_MENU)])
    expect(ids.length).toBeGreaterThan(130)
    expect(new Set(ids).size).toBe(ids.length)
    // One entry per act: a family cannot name an act another family holds.
    for (const id of Object.keys(APP_MENU)) expect(ACTIONS).not.toHaveProperty(id)
    expect(tableValues().get('Copy Link')).toBe('tab.copyUrl')
    expect(tableValues().get('Copy link')).toBe('tab.copyUrl')
    expect(tableValues().get('Find in Page…')).toBe('find.open')
    expect(tableValues().get('Find')).toBe('find.open')
    expect(tableValues().get('New Tab Below')).toBe('tab.newAfter')
    expect(tableValues().get('Exit Full Screen')).toBe('page.fullscreen')
  })

  it('reads the action tables’ faces the Lead ruled', () => {
    // Q4: the mac bar's standard items take the platform's words; the house label elsewhere.
    expect(S.menu('settings.open')).toBe('Settings')
    expect(S.menu('settings.open', { os: 'darwin' })).toBe('Settings…')
    expect(S.menu('settings.open', { os: 'linux' })).toBe('Settings')
    expect(S.menu('window.minimize')).toBe('Minimise Window')
    expect(S.menu('window.minimize', { os: 'darwin' })).toBe('Minimize')
    expect(S.menu('find.open')).toBe('Find in Page…')
    expect(S.menu('find.open', { os: 'darwin' })).toBe('Find…')
    expect(S.title('find.open')).toBe('Find in page')
    expect(S.menu('nav.reloadSkipCache', { os: 'darwin' })).toBe('Hard Reload')
    expect(S.menu('urlbar.focus', { os: 'darwin' })).toBe('Open Location…')
    expect(S.menu('urlbar.focus')).toBe('Focus Address Bar')
    // Q5: the palette carries the ellipsis; Q9: Bookmark This Tab…; P-10: Search Tabs bare.
    expect(S.menu('capture.start')).toBe('Screenshot…')
    expect(S.title('capture.start')).toBe('Open the screenshot overlay')
    expect(S.menu('bookmark.add')).toBe('Bookmark This Tab…')
    expect(S.menu('bookmark.add', { state: true })).toBe('Edit Bookmark…')
    expect(S.row('bookmark.add', { state: false })).toBe('Bookmark this tab…')
    expect(S.menu('tab.search')).toBe('Search Tabs')
    // P-22 and P-23: the noun, the state pair where the row knows it.
    expect(S.menu('page.fullscreen')).toBe('Full Screen')
    expect(S.menu('page.fullscreen', { state: true })).toBe('Exit Full Screen')
    expect(S.menu('page.readerMode', { state: false })).toBe('Enter Reader View')
    expect(S.menu('compact.toggle')).toBe('Compact Mode')
    expect(S.title('compact.toggle')).toBe('Compact mode')
    // The Lead's re-word of P-23's "Sidebar": the state pair, the act's side; the stateless
    // face is the key table's, and an entry without a pair ignores the state asked.
    expect(S.menu('sidebar.toggle')).toBe('Expand Sidebar')
    expect(S.menu('sidebar.toggle', { state: false })).toBe('Expand Sidebar')
    expect(S.menu('sidebar.toggle', { state: true })).toBe('Collapse Sidebar')
    expect(S.title('sidebar.toggle')).toBe('Expand sidebar')
    expect(S.title('sidebar.toggle', { state: true })).toBe('Collapse sidebar')
    expect(S.menu('nav.reload', { state: true })).toBe('Reload')
    // P-34: the orientation axis.
    expect(S.menu('tab.closeBefore', { orientation: 'horizontal' })).toBe('Close Tabs to the Left')
    expect(S.menu('tab.closeBefore', { orientation: 'vertical' })).toBe('Close Tabs Above')
    expect(S.menu('tab.closeBefore')).toBe('Close Tabs to the Left')
    // The helper's derived faces (P-45 and §B) and the explicit sentences.
    expect(S.title('focus.bookmarksBar')).toBe('Focus bookmarks bar')
    expect(S.title('space.new')).toBe('New Space')
    expect(S.title('space.next')).toBe('Jump to the next Space')
    expect(S.title('tab.togglePin')).toBe('Pin or unpin tab')
    expect(S.title('tab.togglePin', { state: true })).toBe('Unpin tab')
  })

  it('reads the app menu’s faces (PR-2b): the acts it shares with the tables, resolved; its own', () => {
    // P-6 and Q2: the page's name on the row, the page title and the extension's own menu.
    expect(S.menu('addons.open')).toBe('Extensions and Mods')
    expect(S.title('addons.open')).toBe('Extensions and Mods')
    // P-33: the translate bar asks; P-36: a settings page is a destination, not an ask.
    expect(S.menu('translate.open')).toBe('Translate Page…')
    expect(S.button('translate.open')).toBe('Translate page')
    expect(S.menu('resources.open')).toBe('Resource Settings')
    expect(S.menu('search.manageEngines')).toBe('Manage Search Engines')
    expect(S.menu('newTab.customise')).toBe('Customise New Tab Page')
    expect(S.row('newTab.customise')).toBe('Customise New Tab page')
    expect(S.menu('toolbar.customise')).toBe('Customise Toolbar…')
    expect(S.menu('languages.open')).toBe('Language Settings')
    // `space.new`: one label for the key table, the palette and the menus; the dialog asks.
    expect(S.menu('space.new')).toBe('New Space…')
    expect(S.button('space.new')).toBe('New Space')
    // The app menu's own acts.
    expect(S.menu('tab.newPrivate')).toBe('New Private Tab')
    expect(S.menu('tab.closePrivate')).toBe('Close Private Tabs')
    expect(S.menu('window.closePrivate', { n: 1 })).toBe('Close Private Window')
    expect(S.menu('window.closePrivate', { n: 2 })).toBe('Close 2 Private Windows')
    expect(S.menu('window.closePrivate')).toBe('Close Private Window')
    expect(S.menu('reader.textPreferences')).toBe('Text Preferences…')
    expect(S.title('reader.textPreferences')).toBe('Text preferences')
    expect(S.menu('readAloud.start')).toBe('Listen to This Page')
    expect(S.menu('help.reportUnsafeSite')).toBe('Report an Unsafe Site…')
    expect(tableValues().get('Close {n} Private Windows')).toBe('window.closePrivate')
    expect(tableValues().get('Extensions and Mods')).toBe('addons.open')
    expect(tableValues().get('Add-ons and Themes')).toBeUndefined()
  })
})
