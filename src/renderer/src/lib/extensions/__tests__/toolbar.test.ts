import { describe, expect, it } from 'vitest'
import type { ExtensionInfo } from '@shared/types'
import {
  MIN_PILL_WIDTH,
  TOOLBAR_BUTTON,
  TOOLBAR_GAP,
  actionEnabled,
  actionIcon,
  actionTitle,
  actionable,
  fitToolbarActions,
  pinnedActions
} from '../toolbar'

const ext = (over: Partial<ExtensionInfo>): ExtensionInfo => ({
  id: 'a'.repeat(32),
  name: 'Ext',
  version: '1.0',
  description: '',
  path: '/x',
  enabled: true,
  icon: 'data:manifest',
  popup: 'popup.html',
  error: null,
  source: 'unpacked',
  publisher: null,
  updateUrl: null,
  installedAt: 0,
  updatedAt: 0,
  pinned: false,
  toolbarPinned: true,
  allowFileAccess: false,
  allowPrivate: false,
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
  ...over
})

describe('fitToolbarActions', () => {
  const slot = TOOLBAR_BUTTON + TOOLBAR_GAP

  it('shows every pinned action when the row is wide', () => {
    const fit = fitToolbarActions({ rowWidth: 900, fixedButtons: 5, pinned: 4 })
    expect(fit).toEqual({ shown: 4, hidden: 0 })
  })

  it('keeps the address pill at its floor and folds the rest', () => {
    // 5 fixed buttons + the pill floor + room for exactly two actions.
    const rowWidth = 5 * slot + MIN_PILL_WIDTH + 2 * slot
    expect(fitToolbarActions({ rowWidth, fixedButtons: 5, pinned: 4 })).toEqual({
      shown: 2,
      hidden: 2
    })
    expect(fitToolbarActions({ rowWidth: rowWidth - 1, fixedButtons: 5, pinned: 4 })).toEqual({
      shown: 1,
      hidden: 3
    })
  })

  it('never goes negative and never shows more than pinned', () => {
    expect(fitToolbarActions({ rowWidth: 100, fixedButtons: 5, pinned: 3 })).toEqual({
      shown: 0,
      hidden: 3
    })
    expect(fitToolbarActions({ rowWidth: 100, fixedButtons: 5, pinned: 0 })).toEqual({
      shown: 0,
      hidden: 0
    })
    expect(fitToolbarActions({ rowWidth: 0, fixedButtons: 5, pinned: 2 })).toEqual({
      shown: 0,
      hidden: 2
    })
  })

  it('a row without a pill (compact) only reserves its fixed buttons', () => {
    const rowWidth = 4 * slot + 3 * slot
    expect(fitToolbarActions({ rowWidth, fixedButtons: 4, pinned: 5, minPillWidth: 0 })).toEqual({
      shown: 3,
      hidden: 2
    })
  })
})

describe('action selectors', () => {
  const actionOff = ext({
    id: '4',
    action: {
      badgeText: '',
      badgeBackgroundColor: null,
      badgeTextColor: null,
      title: '',
      icon: null,
      popup: null,
      enabled: false
    }
  })

  it('actionable drops disabled and broken extensions and keeps one whose action is off', () => {
    const list = [
      ext({ id: '1' }),
      ext({ id: '2', enabled: false }),
      ext({ id: '3', error: 'broken' }),
      actionOff
    ]
    expect(actionable(list).map((e) => e.id)).toEqual(['1', '4'])
  })

  it('actionEnabled reads chrome.action.enable/disable, on when the engine has said nothing', () => {
    expect(actionEnabled(ext({ id: '1' }))).toBe(true)
    expect(actionEnabled(actionOff)).toBe(false)
    expect(actionEnabled(ext({ action: { ...actionOff.action!, enabled: true } }))).toBe(true)
  })

  it('pinnedActions keeps list order and unpinned ones out', () => {
    const list = [ext({ id: '1', toolbarPinned: false }), ext({ id: '2' }), ext({ id: '3' })]
    expect(pinnedActions(list).map((e) => e.id)).toEqual(['2', '3'])
  })

  it('icon and title prefer the action state and fall back to the manifest', () => {
    const plain = ext({ name: 'Dark Reader' })
    expect(actionIcon(plain)).toBe('data:manifest')
    expect(actionTitle(plain)).toBe('Dark Reader')
    const withAction = ext({
      name: 'Dark Reader',
      action: {
        badgeText: '',
        badgeBackgroundColor: null,
        badgeTextColor: null,
        title: 'Dark Reader: on',
        icon: 'data:action',
        popup: 'ui/popup/index.html',
        enabled: true
      }
    })
    expect(actionIcon(withAction)).toBe('data:action')
    expect(actionTitle(withAction)).toBe('Dark Reader: on')
    expect(actionTitle(ext({ name: 'X', action: { ...withAction.action!, title: '  ' } }))).toBe(
      'X'
    )
  })
})
