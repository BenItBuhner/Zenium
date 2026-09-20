import { describe, expect, it } from 'vitest'
import type { ExtensionAction, ExtensionInfo, MenuItemDescriptor } from '@shared/types'
import {
  actionMenuCommand,
  actionMenuGroups,
  actionMenuItems,
  actionSheetRows,
  actionTapCommand,
  isOwnMenuItem,
  ownMenuCommand,
  removeConfirm
} from '../phoneActions'

const action = (over: Partial<ExtensionAction> = {}): ExtensionAction => ({
  badgeText: '',
  badgeBackgroundColor: null,
  badgeTextColor: null,
  title: '',
  icon: null,
  popup: null,
  enabled: true,
  ...over
})

const ext = (over: Partial<ExtensionInfo>): ExtensionInfo => ({
  id: 'a'.repeat(32),
  name: 'Ext',
  version: '1.0',
  description: '',
  path: '/x',
  enabled: true,
  icon: 'data:manifest',
  popup: null,
  error: null,
  source: 'unpacked',
  publisher: null,
  updateUrl: null,
  installedAt: 0,
  updatedAt: 0,
  pinned: false,
  toolbarPinned: false,
  allowFileAccess: false,
  allowPrivate: false,
  allowUserScripts: false,
  manifestVersion: 3,
  permissions: [],
  hostPermissions: [],
  optionsPage: null,
  newTabPage: null,
  newTabOverride: false,
  warnings: [],
  pendingWarnings: null,
  updateState: 'unknown',
  availableVersion: null,
  updateError: null,
  updateCheckedAt: null,
  errors: [],
  action: action(),
  ...over
})

// A state fixture: the shapes the runtime's `list()` produces.
const fixture: ExtensionInfo[] = [
  ext({
    id: 'popup'.padEnd(32, 'a'),
    name: 'Popup',
    popup: 'popup.html',
    action: action({ popup: 'chrome-extension://p/popup.html' })
  }),
  ext({
    id: 'click'.padEnd(32, 'b'),
    name: 'Clicker',
    action: action({ badgeText: '12', title: 'Click me' })
  }),
  ext({
    id: 'coloured'.padEnd(32, 'c'),
    name: 'Blocker',
    icon: null,
    action: action({
      badgeText: '12345',
      badgeBackgroundColor: '#1a237e',
      icon: 'data:action',
      enabled: false
    })
  }),
  ext({ id: 'disabled'.padEnd(32, 'd'), name: 'Off', enabled: false }),
  ext({ id: 'broken'.padEnd(32, 'e'), name: 'Broken', error: 'Manifest file is missing' }),
  ext({ id: 'noaction'.padEnd(32, 'f'), name: 'Unloaded', action: undefined })
]

describe('actionSheetRows', () => {
  const rows = actionSheetRows(fixture)

  it('lists enabled, loaded extensions with an action state, in the list order', () => {
    expect(rows.map((row) => row.name)).toEqual(['Popup', 'Clicker', 'Blocker'])
  })

  it('leaves out a disabled extension, one that failed to load and one without an action', () => {
    const names = rows.map((row) => row.name)
    expect(names).not.toContain('Off')
    expect(names).not.toContain('Broken')
    expect(names).not.toContain('Unloaded')
    expect(actionSheetRows([])).toEqual([])
  })

  it('carries the badge as Chrome shows it: at most four characters, empty for none', () => {
    expect(rows.map((row) => row.badge)).toEqual(['', '12', '1234'])
  })

  it('takes the extension’s badge colours when it set them and leaves the surface’s accent otherwise', () => {
    expect(rows[1].badgeColours).toBeNull()
    expect(rows[2].badgeColours).toEqual({
      background: 'rgb(26 35 126)',
      color: 'rgb(255 255 255)'
    })
  })

  it('draws the action icon before the manifest icon, and the title before the name', () => {
    expect(rows[0].icon).toBe('data:manifest')
    expect(rows[2].icon).toBe('data:action')
    expect(rows[0].title).toBe('Popup')
    expect(rows[1].title).toBe('Click me')
  })

  it('knows which rows open a popup and which are off for this tab', () => {
    expect(rows.map((row) => row.hasPopup)).toEqual([true, false, false])
    expect(rows.map((row) => row.enabled)).toEqual([true, true, false])
  })

  it('names an extension by its id when the manifest gave no name', () => {
    const [row] = actionSheetRows([ext({ name: '' })])
    expect(row.name).toBe('a'.repeat(32))
    expect(row.title).toBe('')
  })
})

describe('actionTapCommand', () => {
  const anchor = { x: 0, y: 500, width: 412, height: 44 }

  it('is the desktop button’s one command path, popup or not: the host resolves onClicked', () => {
    expect(actionTapCommand({ id: 'x', enabled: true }, anchor)).toEqual({
      name: 'extension.openPopup',
      args: { id: 'x', anchor }
    })
  })

  it('is nothing for an action turned off for this tab', () => {
    expect(actionTapCommand({ id: 'x', enabled: false }, anchor)).toBeNull()
  })
})

/** A descriptor as `extension.actionMenuItems` answers one. */
const own = (over: Partial<MenuItemDescriptor> & { id: string }): MenuItemDescriptor => ({
  type: 'normal',
  label: over.id,
  enabled: true,
  checked: false,
  icon: null,
  submenu: null,
  ...over
})

describe('the hold’s menu', () => {
  it('offers Options only when the manifest names an options page, then Manage, and Remove last', () => {
    expect(actionMenuItems({ optionsPage: 'options.html' }).map((item) => item.label)).toEqual([
      'Options',
      'Manage Extension',
      'Remove from Zenium'
    ])
    expect(actionMenuItems({ optionsPage: null }).map((item) => item.id)).toEqual([
      'manage',
      'remove'
    ])
  })

  it('puts the destructive row alone in the last group, under a hairline (§10.4)', () => {
    const groups = actionMenuGroups({ optionsPage: 'o.html' })
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['options', 'manage'], ['remove']])
    expect(groups.every((g) => g.kind === 'browser')).toBe(true)
  })

  it('marks Remove as the destructive entry and no other', () => {
    const items = actionMenuItems({ optionsPage: 'o.html' })
    expect(items.filter((item) => item.danger).map((item) => item.id)).toEqual(['remove'])
  })

  it('puts the extension’s own action-context items first, in their own groups, above the browser’s', () => {
    const items = [
      own({ id: 'a1', label: 'Open Dashboard' }),
      own({ id: 'a2', label: 'Dark Mode', type: 'checkbox', checked: true }),
      own({ id: 'sep', type: 'separator', label: '' }),
      own({ id: 'a3', label: 'More', submenu: [own({ id: 'a4', label: 'Report' })] })
    ]
    const groups = actionMenuGroups({ optionsPage: 'o.html' }, items)
    expect(groups.map((g) => [g.kind, g.items.map((i) => i.id)])).toEqual([
      ['own', ['a1', 'a2']],
      ['own', ['a3']],
      ['browser', ['options', 'manage']],
      ['browser', ['remove']]
    ])
    // The extension's separators break its items into groups and are never rows themselves.
    expect(
      groups.flatMap((g) => g.items).some((i) => isOwnMenuItem(i) && i.type === 'separator')
    ).toBe(false)
    // Without items of its own the menu is the browser's alone.
    expect(actionMenuGroups({ optionsPage: null }, []).map((g) => g.kind)).toEqual([
      'browser',
      'browser'
    ])
    expect(
      actionMenuGroups({ optionsPage: null }, [own({ id: 'sep', type: 'separator' })])
    ).toHaveLength(2)
  })

  it('tells the extension’s own items from the browser’s', () => {
    expect(isOwnMenuItem(own({ id: 'x' }))).toBe(true)
    expect(isOwnMenuItem({ id: 'remove', label: 'Remove from Zenium' })).toBe(false)
  })

  it('runs one of the extension’s items as extension.actionMenuClick with its handle, not a submenu or an off item', () => {
    expect(ownMenuCommand('ext', own({ id: 'action_1_2' }))).toEqual({
      name: 'extension.actionMenuClick',
      args: { id: 'ext', itemId: 'action_1_2' }
    })
    expect(ownMenuCommand('ext', own({ id: 'p', submenu: [own({ id: 'c' })] }))).toBeNull()
    expect(ownMenuCommand('ext', own({ id: 'off', enabled: false }))).toBeNull()
  })

  it('never offers Pin or Unpin: the phone has no toolbar', () => {
    for (const item of actionMenuItems({ optionsPage: 'o.html' }))
      expect(item.label).not.toMatch(/pin/i)
  })

  it('runs Options as the options tab and a confirmed Remove as the removal', () => {
    expect(actionMenuCommand('options', 'x')).toEqual({
      name: 'extension.openOptions',
      args: { id: 'x' }
    })
    expect(actionMenuCommand('remove', 'x')).toEqual({
      name: 'extension.remove',
      args: { id: 'x' }
    })
  })

  it('asks before removing, in the words of the Settings page’s Remove row', () => {
    expect(removeConfirm({ id: 'x', name: 'Vimium' })).toEqual({
      title: 'Remove Vimium?',
      description: 'Its settings and data on this device go with it.',
      action: 'Remove'
    })
    expect(removeConfirm({ id: 'abc', name: '' }).title).toBe('Remove abc?')
  })
})
