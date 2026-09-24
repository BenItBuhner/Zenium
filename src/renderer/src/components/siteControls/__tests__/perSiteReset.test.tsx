// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PermissionRule, SafetyCheckResult, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  run: vi.fn(),
  cmd: vi.fn(async () => null),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { findRow, type RowGroup } from '../../pages/settings/model'
import { GroupList, type SheetRequest } from '../../pages/settings/rows'
import type { SectionContext } from '../../pages/settings/sections'
import { safetyCheckGroups, siteSettingsGroups } from '../settingsRows'

/*
 * The two per-site resets run at once (the lead's #431 Q1 ruling, §10.5 amended: "bulk" is the
 * list emptied; a per-site reset is the same plain act as one Forget and asks nothing). The
 * Safety check's review lists each site as an item row in the grant rows' shape whose one
 * action, Reset, runs `permissions.resetOrigin` and the check again – the desktop's 32 button
 * named "Reset <host>", the phone's sheet holding Reset as a plain row; the site sheet's Reset
 * site settings trails a plain Reset, no ellipsis, no confirmation. Notifications' Stop… and
 * the bulk Reset all sites keep their confirmations.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.mocked(run).mockClear()
})

const RULES: PermissionRule[] = [
  { origin: 'https://meet.example', permission: 'camera', decision: 'allow' },
  { origin: 'https://meet.example', permission: 'microphone', decision: 'deny' }
] as PermissionRule[]

const RESULT: SafetyCheckResult = {
  checkedAt: Date.now() - 60_000,
  updates: { state: 'safe', summary: 'Up to date', currentVersion: '0.4.40', latestVersion: null },
  safeBrowsing: { state: 'safe', summary: 'Safe Browsing is on', configured: true, enabled: true },
  passwords: {
    state: 'info',
    summary: 'No passwords saved',
    compromised: 0,
    weak: 0,
    reused: 0,
    known: false,
    checkedAt: null
  },
  permissions: {
    state: 'warning',
    summary: '1 site worth a look: unused permissions or several at once',
    grantedSites: 1,
    review: [{ origin: 'https://meet.example', permissions: ['camera'], reason: 'unused' }]
  },
  notifications: {
    state: 'info',
    summary: '1 site may send notifications',
    sites: [{ origin: 'https://news.example', shown: 4 }]
  },
  extensions: { state: 'safe', summary: 'No extensions', flagged: [] }
} as SafetyCheckResult

function state(): UIState {
  return {
    platform: 'linux',
    permissionDefaults: {},
    permissionRules: RULES,
    deviceGrants: [],
    lastSafetyCheck: RESULT,
    updates: { phase: 'idle', mode: 'manual' },
    passwords: { locked: true, count: 0 },
    capabilities: { extensions: false }
  } as unknown as UIState
}

function context(): SectionContext {
  return { state: state(), tab: { id: 'tab-1' }, navigate: vi.fn() } as unknown as SectionContext
}

/** The Safety check's Site permissions sheet: the sites holding a permission. */
function permissionsSheet(): RowGroup[] {
  const review = findRow(safetyCheckGroups(context()), 'safety-check:permissions')
  if (!review || review.kind !== 'item') throw new Error('no permissions review')
  return review.sheet.groups
}

/** The Safety check's Notifications sheet: the sites sending notifications. */
function notificationsSheet(): RowGroup[] {
  const review = findRow(safetyCheckGroups(context()), 'safety-check:notifications')
  if (!review || review.kind !== 'item') throw new Error('no notifications review')
  return review.sheet.groups
}

/** The site sheet of meet.example under Sites with their own settings. */
function siteSheet(): RowGroup[] {
  const site = findRow(siteSettingsGroups(context()), 'sites:site:https://meet.example')
  if (!site || site.kind !== 'item') throw new Error('no site row')
  return site.sheet.groups
}

const REVIEW_ROW = '[data-row="safety-check:permissions:https://meet.example"]'
const REVIEW_RESET = '[data-row="safety-check:permissions:https://meet.example:reset"]'
const SITE_RESET = '[data-row="sites:site:https://meet.example:reset"]'
const TRAILING = '.zen-settings-trailing.zen-settings-control > button.zen-v2-button'

describe('the Safety check’s per-site Reset runs at once (the lead’s #431 Q1 ruling)', () => {
  it('on the desktop trails a plain Reset named for the host, pressed at once, with no confirmation', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const h = render(<GroupList groups={permissionsSheet()} ctx={{ open }} variant="desktop" />)
    const el = h.querySelector<HTMLElement>(REVIEW_ROW)!
    expect(el).not.toBeNull()
    expect(el.hasAttribute('data-static')).toBe(true)
    expect(el.querySelector('.zen-settings-label')?.textContent).toBe('meet.example')
    expect(el.querySelector('.zen-settings-description')?.textContent).toBe(
      'Camera · Not used for weeks'
    )
    const button = el.querySelector<HTMLButtonElement>(TRAILING)!
    expect(button).not.toBeNull()
    // No ellipsis: the press is the act. Plain ink: the answers are not the user's own data.
    expect(button.textContent).toBe('Reset')
    expect(button.getAttribute('aria-label')).toBe('Reset meet.example')
    expect(button.getAttribute('aria-haspopup')).toBeNull()
    expect(button.hasAttribute('data-danger')).toBe(false)
    expect(button.hasAttribute('data-primary')).toBe(false)
    act(() => button.click())
    // The one reset command, then the check reads again – nothing asked in between.
    expect(vi.mocked(run).mock.calls).toEqual([
      ['permissions.resetOrigin', { origin: 'https://meet.example' }],
      ['privacy.safetyCheck', undefined]
    ])
    expect(open).not.toHaveBeenCalled()
    expect(h.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
  })

  it('on the phone is the pressable row opening its sheet, whose one Reset row is plain and runs at once too', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const groups = permissionsSheet()
    const h = render(<GroupList groups={groups} ctx={{ open }} />)
    const el = h.querySelector<HTMLElement>(REVIEW_ROW)!
    expect(el.tagName).toBe('BUTTON')
    expect(el.getAttribute('aria-haspopup')).toBe('dialog')
    expect(el.querySelector('.zen-v2-button')).toBeNull()
    act(() => el.click())
    expect(open).toHaveBeenCalledWith({
      kind: 'item',
      rowId: 'safety-check:permissions:https://meet.example'
    })
    expect(run).not.toHaveBeenCalled()
    const row = findRow(groups, 'safety-check:permissions:https://meet.example')
    if (!row || row.kind !== 'item') throw new Error('not an item row')
    expect(row.sheet.title).toBe('meet.example')
    expect(row.sheet.groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual([
      'safety-check:permissions:https://meet.example:reset'
    ])
    const sheet = render(<GroupList groups={row.sheet.groups} ctx={{ open }} />)
    const reset = sheet.querySelector<HTMLElement>(REVIEW_RESET)!
    expect(reset.tagName).toBe('BUTTON')
    expect(reset.getAttribute('aria-haspopup')).toBeNull()
    expect(reset.classList.contains('zen-settings-row-danger')).toBe(false)
    expect(reset.querySelector('.zen-settings-label')?.textContent).toBe('Reset')
    act(() => reset.click())
    expect(vi.mocked(run).mock.calls).toEqual([
      ['permissions.resetOrigin', { origin: 'https://meet.example' }],
      ['privacy.safetyCheck', undefined]
    ])
  })

  it('leaves Notifications’ Stop… as it is: a new Block is a decision, confirmed first', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const h = render(<GroupList groups={notificationsSheet()} ctx={{ open }} variant="desktop" />)
    const el = h.querySelector<HTMLElement>(
      '[data-row="safety-check:notifications:https://news.example"]'
    )!
    const button = el.querySelector<HTMLButtonElement>(TRAILING)!
    expect(button.textContent).toBe('Stop…')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    act(() => button.click())
    expect(open).toHaveBeenCalledWith({
      kind: 'confirm',
      rowId: 'safety-check:notifications:https://news.example'
    })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the site sheet’s Reset site settings runs at once (the lead’s #431 Q1 ruling)', () => {
  it('on the desktop trails a plain Reset, no ellipsis, pressed at once, with no confirmation', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const h = render(<GroupList groups={siteSheet()} ctx={{ open }} variant="desktop" />)
    const el = h.querySelector<HTMLElement>(SITE_RESET)!
    expect(el).not.toBeNull()
    expect(el.hasAttribute('data-static')).toBe(true)
    expect(el.classList.contains('zen-settings-row-danger')).toBe(false)
    expect(el.querySelector('.zen-settings-label')?.textContent).toBe('Reset site settings')
    const button = el.querySelector<HTMLButtonElement>(TRAILING)!
    expect(button).not.toBeNull()
    expect(button.textContent).toBe('Reset')
    expect(button.getAttribute('aria-haspopup')).toBeNull()
    expect(button.hasAttribute('data-danger')).toBe(false)
    expect(button.hasAttribute('data-primary')).toBe(false)
    act(() => button.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('permissions.resetOrigin', { origin: 'https://meet.example' })
    expect(open).not.toHaveBeenCalled()
    expect(h.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
  })

  it('on the phone is a plain row of the site’s sheet, pressed at once', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const h = render(<GroupList groups={siteSheet()} ctx={{ open }} />)
    const el = h.querySelector<HTMLElement>(SITE_RESET)!
    expect(el.tagName).toBe('BUTTON')
    expect(el.getAttribute('aria-haspopup')).toBeNull()
    expect(el.classList.contains('zen-settings-row-danger')).toBe(false)
    act(() => el.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('permissions.resetOrigin', { origin: 'https://meet.example' })
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves the bulk Reset all sites destructive and confirmed: the list emptied is §10.5’s bulk', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const groups = siteSettingsGroups(context())
    const h = render(<GroupList groups={groups} ctx={{ open }} variant="desktop" />)
    const el = h.querySelector<HTMLElement>('[data-row="sites-reset-all"]')!
    const button = el.querySelector<HTMLButtonElement>(TRAILING)!
    expect(button.textContent).toBe('Reset all…')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.hasAttribute('data-danger')).toBe(true)
    act(() => button.click())
    expect(open).toHaveBeenCalledWith({ kind: 'confirm', rowId: 'sites-reset-all' })
    expect(run).not.toHaveBeenCalled()
  })
})
