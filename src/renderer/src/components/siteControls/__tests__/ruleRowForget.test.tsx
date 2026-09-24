// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PermissionRule, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  run: vi.fn(),
  cmd: vi.fn(async () => null),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { findRow, type RowGroup } from '../../pages/settings/model'
import { GroupList, type SheetRequest } from '../../pages/settings/rows'
import type { SectionContext } from '../../pages/settings/sections'
import { siteSettingsGroups } from '../settingsRows'

/*
 * A site's answer under its type in Settings › Site settings (`ruleRow`): the grant rows' shape
 * (the lead's #418 ruling 5, §10.4) – an item row named for its host whose one action, Forget,
 * runs `permissions.forget` at once, with no confirmation and no ellipsis, as the grant rows'
 * Revoke does. The desktop trails it as the 32 button named "Forget <host>"; the phone's row
 * opens its sheet and holds Forget as a row of its own.
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
  { origin: 'https://meet.example', permission: 'camera', decision: 'allow' }
] as PermissionRule[]

/** The camera type's sheet groups, as the state with one stored answer builds them. */
function cameraSheet(): RowGroup[] {
  const state = {
    platform: 'linux',
    permissionDefaults: {},
    permissionRules: RULES,
    deviceGrants: []
  } as unknown as UIState
  const camera = findRow(siteSettingsGroups({ state } as unknown as SectionContext), 'sites:camera')
  if (!camera || camera.kind !== 'item') throw new Error('no camera row')
  return camera.sheet.groups
}

const ROW = '[data-row="sites:camera:https://meet.example:camera"]'

describe('a site’s answer row forgets at once (the lead’s #418 ruling 5)', () => {
  it('on the desktop trails a plain Forget named for the host, pressed at once, with no confirmation', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const h = render(<GroupList groups={cameraSheet()} ctx={{ open }} variant="desktop" />)
    const el = h.querySelector<HTMLElement>(ROW)!
    expect(el).not.toBeNull()
    expect(el.hasAttribute('data-static')).toBe(true)
    expect(el.querySelector('.zen-settings-label')?.textContent).toBe('meet.example')
    expect(el.querySelector('.zen-settings-description')?.textContent).toBe('Allowed')
    const button = el.querySelector<HTMLButtonElement>(
      '.zen-settings-trailing.zen-settings-control > button.zen-v2-button'
    )!
    expect(button).not.toBeNull()
    // No ellipsis: the press is the act. Plain ink: the answer is not the user's own data.
    expect(button.textContent).toBe('Forget')
    expect(button.getAttribute('aria-label')).toBe('Forget meet.example')
    expect(button.getAttribute('aria-haspopup')).toBeNull()
    expect(button.hasAttribute('data-danger')).toBe(false)
    expect(button.hasAttribute('data-primary')).toBe(false)
    act(() => button.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('permissions.forget', {
      origin: 'https://meet.example',
      permission: 'camera'
    })
    expect(open).not.toHaveBeenCalled()
    expect(h.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
  })

  it('on the phone is the pressable row opening its sheet, whose one Forget row runs at once too', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const groups = cameraSheet()
    const h = render(<GroupList groups={groups} ctx={{ open }} />)
    const el = h.querySelector<HTMLElement>(ROW)!
    expect(el.tagName).toBe('BUTTON')
    expect(el.getAttribute('aria-haspopup')).toBe('dialog')
    expect(el.querySelector('.zen-v2-button')).toBeNull()
    act(() => el.click())
    expect(open).toHaveBeenCalledWith({
      kind: 'item',
      rowId: 'sites:camera:https://meet.example:camera'
    })
    expect(run).not.toHaveBeenCalled()
    const row = findRow(groups, 'sites:camera:https://meet.example:camera')
    if (!row || row.kind !== 'item') throw new Error('not an item row')
    expect(row.sheet.title).toBe('meet.example')
    const sheet = render(<GroupList groups={row.sheet.groups} ctx={{ open }} />)
    const forget = sheet.querySelector<HTMLElement>(
      '[data-row="sites:camera:https://meet.example:camera:forget"]'
    )!
    expect(forget.tagName).toBe('BUTTON')
    expect(forget.getAttribute('aria-haspopup')).toBeNull()
    expect(forget.classList.contains('zen-settings-row-danger')).toBe(false)
    act(() => forget.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('permissions.forget', {
      origin: 'https://meet.example',
      permission: 'camera'
    })
  })
})
