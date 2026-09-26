import { describe, expect, it } from 'vitest'
import {
  HELP_MENU_ROWS,
  MENU_ORDER,
  TAB_MENU_CHORDS,
  TAB_MENU_ROWS,
  aboutRowProblems,
  barProblems,
  expectedTabMenu,
  helpMenuProblems,
  noBarProblems,
  readMenuBarScript,
  pickMenuRowScript,
  rowLabels,
  tabMenuProblems,
  toggleProblems
} from './menu-bar-scenario.mjs'

/** A main-process reading of a menu's rows from labels: `-` a separator, `!label` greyed. */
const rows = (labels, chords = TAB_MENU_CHORDS) =>
  labels.map((l) => {
    if (l === '-') return { type: 'separator', label: '', enabled: true, accelerator: null }
    const greyed = l.startsWith('!')
    const label = greyed ? l.slice(1) : l
    return {
      type: 'normal',
      label,
      enabled: !greyed,
      accelerator: chords[label] ?? null,
      role: null
    }
  })

const bar = (labels = MENU_ORDER) => ({
  menus: labels.map((label) => ({
    label,
    role: label === 'Window' ? 'window' : label === 'Help' ? 'help' : null,
    items: []
  }))
})

describe('expectedTabMenu', () => {
  it('lists Chrome’s rows in Chrome’s order, a new tab page alone greying Mute Site and the closes', () => {
    const menu = expectedTabMenu('new-tab-page')
    expect(menu.map((r) => r.label)).toEqual(TAB_MENU_ROWS)
    expect(menu.filter((r) => !r.enabled).map((r) => r.label)).toEqual([
      'Mute Site',
      'Remove from Folder',
      'Close Other Tabs',
      'Close Tabs Below'
    ])
  })
  it('enables Mute Site and the closes for a site page with a tab below it', () => {
    const menu = expectedTabMenu('site-among-others')
    expect(menu.filter((r) => !r.enabled).map((r) => r.label)).toEqual(['Remove from Folder'])
  })
  it('gives the chord rows the Chrome preset’s chords and the others none', () => {
    const chords = Object.fromEntries(
      expectedTabMenu('new-tab-page').map((r) => [r.label, r.accelerator])
    )
    expect(chords).toMatchObject({
      'Select Next Tab': 'Ctrl+Tab',
      'Select Previous Tab': 'Ctrl+Shift+Tab',
      'Duplicate Tab': 'Cmd+Shift+K',
      'Pin Tab': 'Cmd+Ctrl+P',
      'Search Tabs…': 'Cmd+Shift+A',
      'New Tab Below': null,
      'Mute Site': null,
      'Move Tab to New Window': null
    })
  })
  it('refuses a state it does not know', () => {
    expect(() => expectedTabMenu('pinned')).toThrow(/no such Tab menu state/)
  })
})

describe('barProblems', () => {
  it('accepts Chrome’s menus in Chrome’s order with the window and help roles', () => {
    expect(barProblems(bar())).toEqual([])
  })
  it('names a missing menu, a wrong order and a lost role', () => {
    expect(barProblems(bar(MENU_ORDER.filter((l) => l !== 'Tab')))[0]).toMatch(/expected .*"Tab"/)
    const swapped = [...MENU_ORDER]
    ;[swapped[6], swapped[7]] = [swapped[7], swapped[6]]
    expect(barProblems(bar(swapped))[0]).toMatch(/menus \[/)
    const noRole = bar()
    noRole.menus.find((m) => m.label === 'Help').role = null
    expect(barProblems(noRole)).toEqual(["the Help menu's role is null"])
    expect(barProblems(null)).toEqual(['no application menu'])
  })
})

describe('tabMenuProblems', () => {
  it('accepts the rows as expected', () => {
    const items = rows([
      'New Tab Below',
      'Select Next Tab',
      'Select Previous Tab',
      'Duplicate Tab',
      '!Mute Site',
      'Pin Tab',
      'Add Tab to New Folder',
      '!Remove from Folder',
      '!Close Other Tabs',
      '!Close Tabs Below',
      'Move Tab to New Window',
      'Search Tabs…'
    ])
    expect(tabMenuProblems(items, expectedTabMenu('new-tab-page'))).toEqual([])
  })
  it('names a row out of order, a wrong state and a chord off the table', () => {
    const order = rows(TAB_MENU_ROWS.slice().reverse())
    expect(tabMenuProblems(order, expectedTabMenu('new-tab-page'))).toHaveLength(1)
    expect(tabMenuProblems(order, expectedTabMenu('new-tab-page'))[0]).toMatch(/^rows /)
    const items = rows(TAB_MENU_ROWS.map((l) => (l === 'Remove from Folder' ? `!${l}` : l)))
    const problems = tabMenuProblems(items, expectedTabMenu('new-tab-page'))
    expect(problems).toEqual([
      'Mute Site is enabled, expected greyed',
      'Close Other Tabs is enabled, expected greyed',
      'Close Tabs Below is enabled, expected greyed'
    ])
    const chords = rows(
      TAB_MENU_ROWS.map((l) => (l === 'Remove from Folder' ? `!${l}` : l)),
      { ...TAB_MENU_CHORDS, 'Duplicate Tab': 'Cmd+D', 'Mute Site': 'Cmd+M' }
    )
    expect(tabMenuProblems(chords, expectedTabMenu('site-among-others'))).toEqual([
      'Duplicate Tab shows Cmd+D, expected Cmd+Shift+K',
      'Mute Site shows Cmd+M, expected none'
    ])
  })
})

describe('helpMenuProblems', () => {
  it('accepts the Help rows, enabled and without chords', () => {
    expect(helpMenuProblems(rows(HELP_MENU_ROWS, {}))).toEqual([])
  })
  it('names a stray About or Report Unsafe Site row, a greyed row and a chord', () => {
    const withAbout = rows([...HELP_MENU_ROWS, 'About Zenium', 'Report Unsafe Site'], {})
    const problems = helpMenuProblems(withAbout)
    expect(problems[0]).toMatch(/^rows /)
    expect(problems).toContain('About Zenium is in the Help menu')
    expect(problems).toContain('Report Unsafe Site is in the Help menu')
    expect(
      helpMenuProblems(
        rows(
          HELP_MENU_ROWS.map((l) => (l === 'Zenium Help' ? '!Zenium Help' : l)),
          {}
        )
      )
    ).toEqual(['Zenium Help is greyed'])
    expect(helpMenuProblems(rows(HELP_MENU_ROWS, { 'Zenium Help': 'Cmd+Shift+/' }))).toEqual([
      'Zenium Help shows Cmd+Shift+/'
    ])
  })
})

describe('aboutRowProblems', () => {
  it('accepts an enabled plain About Zenium first row', () => {
    expect(aboutRowProblems(rows(['About Zenium', '-', 'Settings…'], {}))).toEqual([])
  })
  it('names the host’s role, a greyed row, another first row, and no rows', () => {
    const role = rows(['About Zenium'], {})
    role[0].role = 'about'
    expect(aboutRowProblems(role)).toEqual(['About Zenium has the about role'])
    expect(aboutRowProblems(rows(['!About Zenium'], {}))).toEqual(['About Zenium is greyed'])
    expect(aboutRowProblems(rows(['Settings…'], {}))).toEqual(['the first row is Settings…'])
    expect(aboutRowProblems([])).toEqual(['the application menu has no rows'])
  })
})

describe('noBarProblems and toggleProblems', () => {
  it('wants no application menu off macOS', () => {
    expect(noBarProblems(null)).toEqual([])
    expect(noBarProblems(bar())[0]).toMatch(/an application menu is set/)
  })
  it('wants the toggle’s other word after the pick, the first gone', () => {
    expect(
      toggleProblems(['Unpin Tab', 'Mute Site'], { word: 'Unpin Tab', gone: 'Pin Tab' })
    ).toEqual([])
    expect(toggleProblems(['Pin Tab'], { word: 'Unpin Tab', gone: 'Pin Tab' })).toEqual([
      'no Unpin Tab row after the pick',
      'Pin Tab still reads after the pick'
    ])
  })
})

describe('the main-process scripts', () => {
  /** Electron's `Menu` as far as the scripts read it. */
  const fakeMenu = (menus) => ({
    getApplicationMenu: () =>
      menus && {
        items: menus.map((m) => ({
          label: m.label,
          role: m.role,
          submenu: { items: m.items }
        }))
      }
  })
  it('readMenuBarScript reads the menus, their roles and rows two levels deep, or null', () => {
    expect(readMenuBarScript({ Menu: fakeMenu(null) })).toBeNull()
    const picked = []
    const reading = readMenuBarScript({
      Menu: fakeMenu([
        {
          label: 'Tab',
          role: undefined,
          items: [
            {
              label: 'Move to Folder',
              type: 'submenu',
              enabled: true,
              submenu: {
                items: [
                  { label: 'New Folder…', type: 'normal', enabled: true },
                  {
                    label: '📁 Work',
                    type: 'checkbox',
                    enabled: true,
                    checked: true,
                    submenu: { items: [{ label: 'deep' }] }
                  }
                ]
              }
            },
            {
              label: 'Pin Tab',
              type: 'normal',
              enabled: true,
              accelerator: 'Cmd+Ctrl+P',
              click: () => picked.push('pin')
            }
          ]
        },
        { label: 'Help', role: 'help', items: [] }
      ])
    })
    expect(reading.menus.map((m) => [m.label, m.role])).toEqual([
      ['Tab', null],
      ['Help', 'help']
    ])
    expect(rowLabels(reading.menus[0].items)).toEqual(['Move to Folder', 'Pin Tab'])
    expect(reading.menus[0].items[1]).toMatchObject({
      accelerator: 'Cmd+Ctrl+P',
      role: null,
      enabled: true
    })
    expect(reading.menus[0].items[0].submenu.map((i) => i.label)).toEqual([
      'New Folder…',
      '📁 Work'
    ])
    expect(reading.menus[0].items[0].submenu[1]).toMatchObject({
      checked: true,
      submenu: undefined
    })
  })
  it('pickMenuRowScript clicks the row it finds and says when there is none or it is greyed', () => {
    const picked = []
    const Menu = fakeMenu([
      {
        label: 'Tab',
        items: [
          { label: 'Pin Tab', enabled: true, click: () => picked.push('Pin Tab') },
          { label: 'Mute Site', enabled: false, click: () => picked.push('Mute Site') }
        ]
      }
    ])
    expect(pickMenuRowScript({ Menu }, { menu: 'Tab', label: 'Pin Tab' })).toEqual({ picked: true })
    expect(picked).toEqual(['Pin Tab'])
    expect(pickMenuRowScript({ Menu }, { menu: 'Tab', label: 'Mute Site' })).toEqual({
      picked: false,
      greyed: true
    })
    expect(pickMenuRowScript({ Menu }, { menu: 'Tab', label: 'Close Tab' })).toEqual({
      picked: false,
      rows: ['Pin Tab', 'Mute Site']
    })
    expect(pickMenuRowScript({ Menu }, { menu: 'Window', label: 'Zoom' })).toEqual({
      picked: false,
      rows: []
    })
    expect(picked).toEqual(['Pin Tab'])
  })
})
