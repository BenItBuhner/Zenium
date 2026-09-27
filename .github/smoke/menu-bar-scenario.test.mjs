import { describe, expect, it } from 'vitest'
import {
  HELP_MENU_CHORDS,
  HELP_MENU_ROWS,
  MENU_ORDER,
  TAB_DIRECTION_ROWS,
  TAB_MENU_CHORDS,
  TAB_MENU_ROWS,
  aboutPageProblems,
  aboutRowProblems,
  barProblems,
  expectedTabMenu,
  helpMenuProblems,
  noBarProblems,
  readMenuBarScript,
  pickMenuRowScript,
  rowLabels,
  tabMenuProblems,
  tabMenuRows,
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
  it('lists Chrome’s rows in Chrome’s order, a new tab page alone greying Mute Site, the closes and the move to a new window', () => {
    const menu = expectedTabMenu('new-tab-page')
    expect(menu.map((r) => r.label)).toEqual(TAB_MENU_ROWS)
    expect(menu.filter((r) => !r.enabled).map((r) => r.label)).toEqual([
      'Mute Site',
      'Remove from Folder',
      'Close Other Tabs',
      'Close Tabs Below',
      'Move Tab to New Window'
    ])
  })
  it('enables Mute Site, the closes and the move for a site page with a tab below it', () => {
    const menu = expectedTabMenu('site-among-others')
    expect(menu.filter((r) => !r.enabled).map((r) => r.label)).toEqual(['Remove from Folder'])
  })
  it('seats Add Tab to New Split View after Move Tab to New Window, before Search Tabs, as Chrome does', () => {
    expect(TAB_MENU_ROWS.slice(-3)).toEqual([
      'Move Tab to New Window',
      'Add Tab to New Split View',
      'Search Tabs…'
    ])
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
      'Add Tab to New Split View': 'Cmd+Shift+*',
      'Search Tabs…': 'Cmd+Shift+A',
      'New Tab Below': null,
      'Mute Site': null,
      'Move Tab to New Window': null
    })
  })
  it('words the two direction rows to the Right beside a horizontal strip, Below beside the sidebar’s, the rest the same', () => {
    const horizontal = expectedTabMenu('site-among-others', 'horizontal')
    const labels = horizontal.map((r) => r.label)
    expect(labels).toEqual(tabMenuRows('horizontal'))
    expect(labels[0]).toBe('New Tab to the Right')
    expect(labels[labels.indexOf('Close Other Tabs') + 1]).toBe('Close Tabs to the Right')
    expect(labels).not.toContain('New Tab Below')
    expect(labels).not.toContain('Close Tabs Below')
    const vertical = expectedTabMenu('site-among-others', 'vertical')
    expect(vertical.map((r) => r.label)).toEqual(TAB_MENU_ROWS)
    expect(expectedTabMenu('site-among-others')).toEqual(vertical)
    const swap = (rows) =>
      rows.map((r) => ({ ...r, label: r.label.replace(/ (to the Right|Below)$/, '') }))
    expect(swap(horizontal)).toEqual(swap(vertical))
    expect(TAB_DIRECTION_ROWS.horizontal).toEqual({
      newTab: 'New Tab to the Right',
      closeAfter: 'Close Tabs to the Right'
    })
    const newTabPage = expectedTabMenu('new-tab-page', 'horizontal')
    expect(newTabPage.filter((r) => !r.enabled).map((r) => r.label)).toEqual([
      'Mute Site',
      'Remove from Folder',
      'Close Other Tabs',
      'Close Tabs to the Right',
      'Move Tab to New Window'
    ])
  })
  it('refuses a state or an orientation it does not know', () => {
    expect(() => expectedTabMenu('pinned')).toThrow(/no such Tab menu state/)
    expect(() => expectedTabMenu('new-tab-page', 'diagonal')).toThrow(/no such strip orientation/)
    expect(() => tabMenuRows('diagonal')).toThrow(/no such strip orientation/)
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
      '!Move Tab to New Window',
      'Add Tab to New Split View',
      'Search Tabs…'
    ])
    expect(tabMenuProblems(items, expectedTabMenu('new-tab-page'))).toEqual([])
    const horizontal = rows([
      'New Tab to the Right',
      'Select Next Tab',
      'Select Previous Tab',
      'Duplicate Tab',
      'Mute Site',
      'Pin Tab',
      'Add Tab to New Folder',
      '!Remove from Folder',
      'Close Other Tabs',
      'Close Tabs to the Right',
      'Move Tab to New Window',
      'Add Tab to New Split View',
      'Search Tabs…'
    ])
    expect(tabMenuProblems(horizontal, expectedTabMenu('site-among-others', 'horizontal'))).toEqual(
      []
    )
    expect(tabMenuProblems(horizontal, expectedTabMenu('site-among-others'))[0]).toMatch(
      /^rows .*"New Tab to the Right".*expected .*"New Tab Below"/
    )
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
      'Close Tabs Below is enabled, expected greyed',
      'Move Tab to New Window is enabled, expected greyed'
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
  /** The Help rows with Report an Unsafe Site… greyed, a new tab page's reading. */
  const unreportable = HELP_MENU_ROWS.map((l) =>
    l === 'Report an Unsafe Site…' ? '!Report an Unsafe Site…' : l
  )
  it('accepts the Help rows with Report an Issue… on Chrome’s chord, Report an Unsafe Site… enabled on a site page and greyed on a new tab page', () => {
    expect(helpMenuProblems(rows(HELP_MENU_ROWS, HELP_MENU_CHORDS), { reportable: true })).toEqual(
      []
    )
    expect(helpMenuProblems(rows(unreportable, HELP_MENU_CHORDS), { reportable: false })).toEqual(
      []
    )
    expect(HELP_MENU_ROWS.slice(-2)).toEqual(['Report an Issue…', 'Report an Unsafe Site…'])
    expect(HELP_MENU_CHORDS).toEqual({ 'Report an Issue…': 'Cmd+Alt+Shift+I' })
  })
  it('names a stray About row, a missing row, a wrong state and a chord off the table', () => {
    const withAbout = rows([...HELP_MENU_ROWS, 'About Zenium'], HELP_MENU_CHORDS)
    const problems = helpMenuProblems(withAbout, { reportable: true })
    expect(problems[0]).toMatch(/^rows /)
    expect(problems).toContain('About Zenium is in the Help menu')
    const without = rows(
      HELP_MENU_ROWS.filter((l) => l !== 'Report an Unsafe Site…'),
      HELP_MENU_CHORDS
    )
    expect(helpMenuProblems(without, { reportable: true })).toEqual([
      expect.stringMatching(/^rows .*expected .*"Report an Unsafe Site…"/)
    ])
    expect(
      helpMenuProblems(
        rows(
          HELP_MENU_ROWS.map((l) => (l === 'Zenium Help' ? '!Zenium Help' : l)),
          HELP_MENU_CHORDS
        ),
        { reportable: true }
      )
    ).toEqual(['Zenium Help is greyed, expected enabled'])
    expect(helpMenuProblems(rows(HELP_MENU_ROWS, HELP_MENU_CHORDS), { reportable: false })).toEqual(
      ['Report an Unsafe Site… is enabled, expected greyed']
    )
    expect(helpMenuProblems(rows(unreportable, HELP_MENU_CHORDS), { reportable: true })).toEqual([
      'Report an Unsafe Site… is greyed, expected enabled'
    ])
    expect(
      helpMenuProblems(
        rows(HELP_MENU_ROWS, { ...HELP_MENU_CHORDS, 'Zenium Help': 'Cmd+Shift+/' }),
        {
          reportable: true
        }
      )
    ).toEqual(['Zenium Help shows Cmd+Shift+/, expected none'])
    expect(helpMenuProblems(rows(HELP_MENU_ROWS, {}), { reportable: true })).toEqual([
      'Report an Issue… shows no chord, expected Cmd+Alt+Shift+I'
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

describe('aboutPageProblems', () => {
  it('accepts the Settings page at about as the front page tab', () => {
    expect(aboutPageProblems({ section: 'about', frontTabUrl: 'zen://settings/about' })).toEqual([])
  })
  it('names another section, and a front tab that is not the Settings › About page tab (the page opened somewhere else, or not as a tab)', () => {
    expect(
      aboutPageProblems({ section: 'general', frontTabUrl: 'zen://settings/general' })
    ).toEqual([
      'the Settings page opened at general, not about',
      'the front tab is zen://settings/general, not the Settings › About page tab'
    ])
    expect(aboutPageProblems({ section: 'about', frontTabUrl: 'https://news.example/' })).toEqual([
      'the front tab is https://news.example/, not the Settings › About page tab'
    ])
    expect(aboutPageProblems({ section: 'about', frontTabUrl: null })).toEqual([
      'the front tab is none, not the Settings › About page tab'
    ])
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
