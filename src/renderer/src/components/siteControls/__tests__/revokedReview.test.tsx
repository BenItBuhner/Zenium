// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PermissionRule, SafetyCheckResult, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  run: vi.fn(),
  cmd: vi.fn(async () => null),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { FrameDialogHost } from '@renderer/lib/portals'
import { findRow, type RowGroup } from '../../pages/settings/model'
import { GroupList, type SheetRequest } from '../../pages/settings/rows'
import type { SectionContext } from '../../pages/settings/sections'
import { SheetStack } from '../../pages/settings/sheets'
import { safetyCheckGroups } from '../settingsRows'

/*
 * The removed-permissions block of the Safety check's Site permissions review (PS-41), drawn
 * for real: the desktop's Allow again button reads Chrome's sentence to a reader; the focus a
 * pressed inline action holds moves on as the check's result removes its row – to the next
 * row's control, else the group's heading, the next group's first control, the row before, or
 * the dialog – rather than falling to `body` (the independent review's nit 4, shared with the
 * Reset rows); and the phone's item sheet opened for a site leaves with the site's row (the
 * stack's orphan rule), while the review sheet under it stays.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => root?.render(element))
  return host!
}

/** The commit that removed a row is through, and so is the hand-off's microtask after it. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.mocked(run).mockClear()
})

const MEET = 'https://meet.example'
const MAPS = 'https://maps.example'
const DOCS = 'https://docs.example'
const REVIEW = 'safety-check:permissions'
const rowOf = (origin: string): string => `[data-row="${REVIEW}:revoked:${origin}"]`
const BUTTON = '.zen-settings-trailing.zen-settings-control > button.zen-v2-button'

const REVOKED = {
  [MEET]: { origin: MEET, permissions: ['camera', 'microphone'], revokedAt: 1_700_000_000_000 },
  [MAPS]: { origin: MAPS, permissions: ['geolocation'], revokedAt: 1_700_000_100_000 }
}

/** The review sheet's groups for the given removed sites and granted origins, as the state builds them. */
function reviewGroups(revoked: string[], granted: string[]): RowGroup[] {
  const result = {
    checkedAt: 1_700_000_200_000,
    updates: { state: 'safe', summary: 'Up to date', currentVersion: '0.3.0', latestVersion: null },
    safeBrowsing: {
      state: 'safe',
      summary: 'Safe Browsing is on',
      configured: true,
      enabled: true
    },
    passwords: {
      state: 'safe',
      summary: 'No passwords saved',
      compromised: 0,
      weak: 0,
      reused: 0,
      known: false,
      checkedAt: null
    },
    permissions: {
      state: revoked.length > 0 ? 'info' : 'safe',
      summary: `Permissions removed from ${revoked.length} sites`,
      grantedSites: granted.length,
      review: [],
      revoked: revoked.map((origin) => REVOKED[origin as keyof typeof REVOKED])
    },
    notifications: { state: 'safe', summary: 'No site may send notifications', sites: [] },
    extensions: { state: 'unavailable', summary: 'This host runs no extensions', flagged: [] }
  } as unknown as SafetyCheckResult
  const rules = granted.map(
    (origin): PermissionRule =>
      ({ origin, permission: 'geolocation', decision: 'allow' }) as PermissionRule
  )
  const state = {
    platform: 'linux',
    updates: { phase: 'idle', mode: 'auto' },
    passwords: { locked: true, count: 0 },
    permissionRules: rules,
    lastSafetyCheck: result
  } as unknown as UIState
  const ctx = { state, navigate: () => undefined } as unknown as SectionContext
  const review = findRow(safetyCheckGroups(ctx), REVIEW)
  if (!review || review.kind !== 'item') throw new Error('no review row')
  return review.sheet.groups
}

const open = vi.fn<(request: SheetRequest) => void>()

/** The desktop review inside a dialog's held root, as `dialogs.tsx` stands it. */
function desktop(groups: RowGroup[]): ReactElement {
  return (
    <div role="dialog" tabIndex={-1} data-testid="dialog">
      <GroupList groups={groups} ctx={{ open }} variant="desktop" />
    </div>
  )
}

describe('the removed-permissions review, drawn (PS-41, #637 nits 4 and 5)', () => {
  it('names the desktop button as Chrome does – "Allow permissions again for <host>" – while a Reset keeps the label-then-row name', () => {
    const h = render(desktop(reviewGroups([MEET, MAPS], [DOCS])))
    const allow = h.querySelector<HTMLButtonElement>(`${rowOf(MEET)} ${BUTTON}`)!
    expect(allow.textContent).toBe('Allow again')
    expect(allow.getAttribute('aria-label')).toBe('Allow permissions again for meet.example')
    expect(allow.hasAttribute('data-danger')).toBe(false)
    const reset = h.querySelector<HTMLButtonElement>(`[data-row="${REVIEW}:${DOCS}"] ${BUTTON}`)!
    expect(reset.textContent).toBe('Reset')
    expect(reset.getAttribute('aria-label')).toBe('Reset docs.example')
    // The row's line is the permissions alone; the block's description says why once.
    expect(h.querySelector(`${rowOf(MEET)} .zen-settings-description`)?.textContent).toBe(
      'Camera, Microphone'
    )
    expect(
      h.querySelector(`[data-group="${REVIEW}:revoked"] .zen-settings-group-description`)
        ?.textContent
    ).toBe(
      "To protect your data, permissions were removed from sites you haven't visited recently."
    )
  })

  it('hands the focus on as the check’s result removes the pressed row: the next row’s control, then – the block gone whole – the next group’s first control', async () => {
    let h = render(desktop(reviewGroups([MEET, MAPS], [DOCS])))
    const allowMeet = h.querySelector<HTMLButtonElement>(`${rowOf(MEET)} ${BUTTON}`)!
    act(() => {
      allowMeet.focus()
      allowMeet.click()
    })
    expect(document.activeElement).toBe(allowMeet)
    expect(run).toHaveBeenCalledWith('permissions.regrantRevoked', { origin: MEET })

    // The result lands without meet.example: its row leaves, and the focus lands on the next
    // row's control – maps.example's Allow again – not on `body`.
    h = render(desktop(reviewGroups([MAPS], [DOCS])))
    await settle()
    expect(h.querySelector(rowOf(MEET))).toBeNull()
    const allowMaps = h.querySelector<HTMLButtonElement>(`${rowOf(MAPS)} ${BUTTON}`)!
    expect(allowMaps).not.toBeNull()
    expect(document.activeElement).toBe(allowMaps)

    // The last removed site allowed again: the block goes whole – its heading and Got it with
    // it – and the focus moves to the next group's first control, the granted site's Reset.
    act(() => allowMaps.click())
    h = render(desktop(reviewGroups([], [DOCS])))
    await settle()
    expect(h.querySelector(`[data-group="${REVIEW}:revoked"]`)).toBeNull()
    const resetDocs = h.querySelector<HTMLButtonElement>(
      `[data-row="${REVIEW}:${DOCS}"] ${BUTTON}`
    )!
    expect(document.activeElement).toBe(resetDocs)
  })

  it('falls back to the row before, and to the dialog’s held root when a headingless list empties', async () => {
    const item = (id: string): RowGroup['rows'][number] => ({
      kind: 'item',
      id,
      label: id,
      action: { label: 'Remove', onPress: () => undefined },
      sheet: { title: id, groups: [] }
    })
    const list = (rows: RowGroup['rows']): RowGroup[] => [
      { id: 'list', heading: null, rows, empty: 'Nothing here' }
    ]
    let h = render(desktop(list([item('a'), item('b')])))
    const removeB = h.querySelector<HTMLButtonElement>(`[data-row="b"] ${BUTTON}`)!
    act(() => removeB.focus())
    // The last row goes with no row after it and no heading: the row before takes the focus.
    h = render(desktop(list([item('a')])))
    await settle()
    const removeA = h.querySelector<HTMLButtonElement>(`[data-row="a"] ${BUTTON}`)!
    expect(document.activeElement).toBe(removeA)
    // The list empties: the dialog's root, where Tab enters at the first control (§9.22).
    h = render(desktop(list([])))
    await settle()
    expect(h.querySelector('.zen-settings-empty')?.textContent).toBe('Nothing here')
    expect(document.activeElement).toBe(h.querySelector('[data-testid="dialog"]'))
  })

  it('moves the focus to the group’s heading when the last row of a headed list goes', async () => {
    let h = render(desktop(reviewGroups([MEET], [DOCS])))
    const resetDocs = h.querySelector<HTMLButtonElement>(
      `[data-row="${REVIEW}:${DOCS}"] ${BUTTON}`
    )!
    act(() => {
      resetDocs.focus()
      resetDocs.click()
    })
    expect(run).toHaveBeenCalledWith('permissions.resetOrigin', { origin: DOCS })
    h = render(desktop(reviewGroups([MEET], [])))
    await settle()
    const heading = h.querySelector<HTMLElement>(
      `[data-group="${REVIEW}:sites"] .zen-settings-heading`
    )!
    expect(heading.textContent).toBe('Sites with permissions you granted')
    expect(document.activeElement).toBe(heading)
    expect(heading.getAttribute('tabindex')).toBe('-1')
  })

  it('leaves the focus where a user or the dialog put it meanwhile', async () => {
    let h = render(desktop(reviewGroups([MEET, MAPS], [DOCS])))
    const allowMeet = h.querySelector<HTMLButtonElement>(`${rowOf(MEET)} ${BUTTON}`)!
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    act(() => allowMeet.focus())
    // The row leaves while the focus is elsewhere: nothing to hand on.
    act(() => elsewhere.focus())
    h = render(desktop(reviewGroups([MAPS], [DOCS])))
    await settle()
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
    expect(h.querySelector(rowOf(MAPS))).not.toBeNull()
  })

  it('on the phone closes the site’s item sheet as its row goes with its act, the review’s stack resolving the row by id', async () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    // The layout given sizes, as `sheets.test.tsx` gives them: a sheet with room to stand,
    // which a chassis measuring nothing would take as fallen.
    const sizes = ['clientHeight', 'offsetHeight'].map(
      (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const
    )
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('zen-sheet-scroll') ? 300 : 800
      }
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 300
    })
    try {
      await phoneSheetLeavesWithItsAct()
    } finally {
      for (const [name, descriptor] of sizes) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
      }
    }
  })

  async function phoneSheetLeavesWithItsAct(): Promise<void> {
    const closeTop = vi.fn()
    const request: SheetRequest = { kind: 'item', rowId: `${REVIEW}:revoked:${MEET}` }
    const stack = (groups: RowGroup[]): ReactElement => (
      <FrameDialogHost>
        <SheetStack requests={[request]} groups={groups} ctx={{ open }} closeTop={closeTop} />
      </FrameDialogHost>
    )
    let h = render(stack(reviewGroups([MEET, MAPS], [DOCS])))
    await settle()
    expect(closeTop).not.toHaveBeenCalled()
    const allow = h.querySelector<HTMLElement>(
      `[data-row="${REVIEW}:revoked:${MEET}:allow-again"]`
    )!
    expect(allow).not.toBeNull()
    expect(allow.getAttribute('aria-haspopup')).toBeNull()
    act(() => allow.click())
    expect(run).toHaveBeenCalledWith('permissions.regrantRevoked', { origin: MEET })
    // The check's result rebuilds the groups without the site: the sheet's request resolves to
    // no row, and the stack closes it.
    h = render(stack(reviewGroups([MAPS], [DOCS])))
    await settle()
    expect(closeTop).toHaveBeenCalledTimes(1)
    expect(h.querySelector(`[data-row="${REVIEW}:revoked:${MEET}:allow-again"]`)).toBeNull()
  }
})
