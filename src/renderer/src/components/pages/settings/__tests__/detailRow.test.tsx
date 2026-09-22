// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DetailRow, ItemRow, RowGroup } from '../model'
import { GroupList, type SheetRequest } from '../rows'
import { useSheetStack } from '../useSheetStack'

/*
 * The §10.4 detail row (wave 4 of the extensions UI): a pressable row whose trailing side is
 * the summary in 13 at 69 % and the 16 px chevron, opening its own sheet one level down. The
 * page's stack keeps at most two sheets (§9.24): the details sheet an item row opens is depth
 * one, a detail row inside it opens depth two, and nothing opens over that – a third request
 * replaces the top.
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
})

const errors: DetailRow = {
  kind: 'detail',
  id: 'ext:errors',
  label: 'Errors',
  summary: '2 errors, 1 warning',
  sheet: {
    title: 'Errors',
    description: 'Dark Reader',
    groups: [
      {
        id: 'ext-errors-list',
        heading: null,
        rows: [
          { kind: 'info', id: 'ext:error:2', label: 'Deprecated API', clamp: true },
          { kind: 'info', id: 'ext:error:1', label: 'Uncaught TypeError', clamp: true }
        ],
        empty: 'No errors'
      }
    ]
  }
}

const permissions: DetailRow = {
  kind: 'detail',
  id: 'ext:permissions',
  label: 'Permissions',
  summary: 'None',
  sheet: {
    title: 'Permissions',
    groups: [{ id: 'ext-permissions', heading: null, rows: [], empty: 'No permissions' }]
  }
}

const item: ItemRow = {
  kind: 'item',
  id: 'ext',
  label: 'Dark Reader',
  sheet: {
    title: 'Dark Reader',
    groups: [{ id: 'ext-controls', heading: null, rows: [errors, permissions] }]
  }
}

const groups: RowGroup[] = [{ id: 'extensions', heading: 'Extensions', rows: [item] }]

describe('the detail row (§10.4)', () => {
  it('is a pressable row with the summary and a chevron trailing, opening a detail sheet', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const h = render(
      <GroupList groups={errors.sheet.groups.concat(item.sheet.groups)} ctx={{ open }} />
    )
    const row = h.querySelector<HTMLButtonElement>('[data-row="ext:errors"]')
    expect(row).not.toBeNull()
    expect(row!.tagName).toBe('BUTTON')
    expect(row!.getAttribute('aria-haspopup')).toBe('dialog')
    expect(row!.classList.contains('zen-settings-row-pressable')).toBe(true)
    expect(row!.querySelector('.zen-settings-label')?.textContent).toBe('Errors')
    const trailing = row!.querySelector('.zen-settings-trailing')
    expect(trailing).not.toBeNull()
    expect(trailing!.querySelector('.zen-settings-summary')?.textContent).toBe(
      '2 errors, 1 warning'
    )
    expect(trailing!.querySelector('svg.lucide-chevron-right')).not.toBeNull()
    // The summary follows the label's line: it is the trailing side's text, not a description.
    expect(row!.querySelector('.zen-settings-description')).toBeNull()

    act(() => row!.click())
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith({ kind: 'detail', rowId: 'ext:errors' })

    // A clamped info row inside its sheet carries the two-line class for its label.
    const line = h.querySelector('[data-row="ext:error:2"]')
    expect(line?.classList.contains('zen-settings-row-clamp')).toBe(true)
  })

  it('a truncating action row carries the one-line class (a page title from another device), not the clamp', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const groups: RowGroup[] = [
      {
        id: 'sync-remote-tabs:dev',
        heading: 'Work laptop',
        rows: [
          {
            kind: 'action',
            id: 'sync-remote-tab:dev:t1',
            label: 'Software Library : Free Software : Internet Archive',
            description: 'archive.org · 50 min ago',
            truncate: true,
            closesSheet: true,
            onPress: () => undefined
          },
          { kind: 'action', id: 'plain', label: 'Manage…', onPress: () => undefined }
        ],
        empty: ''
      }
    ]
    const h = render(<GroupList groups={groups} ctx={{ open }} />)
    const title = h.querySelector('[data-row="sync-remote-tab:dev:t1"]')
    expect(title?.classList.contains('zen-settings-row-pressable')).toBe(true)
    expect(title?.classList.contains('zen-settings-row-truncate')).toBe(true)
    // One line, never two: the info rows' two-line clamp is not this row's.
    expect(title?.classList.contains('zen-settings-row-clamp')).toBe(false)
    // Opt-in only: an action row without the flag keeps its free-wrapping label.
    expect(
      h.querySelector('[data-row="plain"]')?.classList.contains('zen-settings-row-truncate')
    ).toBe(false)
  })

  it('draws no summary span when the row has none, keeping the chevron', () => {
    const bare: DetailRow = { ...permissions, summary: undefined }
    const h = render(
      <GroupList
        groups={[{ id: 'g', heading: null, rows: [bare] }]}
        ctx={{ open: () => undefined }}
      />
    )
    const trailing = h.querySelector('[data-row="ext:permissions"] .zen-settings-trailing')
    expect(trailing?.querySelector('.zen-settings-summary')).toBeNull()
    expect(trailing?.querySelector('svg')).not.toBeNull()
  })
})

describe('the sheet stack under a detail row (§9.24)', () => {
  function Harness({ report }: { report: (s: ReturnType<typeof useSheetStack>) => void }): null {
    report(useSheetStack())
    return null
  }

  it('stacks the details sheet then its detail sheet, and a third request replaces the top', () => {
    let stack: ReturnType<typeof useSheetStack> | null = null
    render(
      <Harness
        report={(s) => {
          stack = s
        }}
      />
    )
    const current = (): ReturnType<typeof useSheetStack> => {
      if (!stack) throw new Error('no stack')
      return stack
    }
    expect(current().requests).toEqual([])
    act(() => current().ctx.open({ kind: 'item', rowId: 'ext' }))
    expect(current().requests).toEqual([{ kind: 'item', rowId: 'ext' }])
    act(() => current().ctx.open({ kind: 'detail', rowId: 'ext:errors' }))
    expect(current().requests).toEqual([
      { kind: 'item', rowId: 'ext' },
      { kind: 'detail', rowId: 'ext:errors' }
    ])
    // Depth two is the ceiling: another sheet asked for from there takes the top's place.
    act(() => current().ctx.open({ kind: 'detail', rowId: 'ext:permissions' }))
    expect(current().requests).toEqual([
      { kind: 'item', rowId: 'ext' },
      { kind: 'detail', rowId: 'ext:permissions' }
    ])
    act(() => current().closeTop())
    expect(current().requests).toEqual([{ kind: 'item', rowId: 'ext' }])
    act(() => current().closeAll())
    expect(current().requests).toEqual([])
  })

  it('the item row asks for depth one and the detail rows of its sheet for depth two', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    // The details sheet's rows render through the same GroupList with the same context.
    const h = render(<GroupList groups={groups.concat(item.sheet.groups)} ctx={{ open }} />)
    act(() => h.querySelector<HTMLButtonElement>('[data-row="ext"]')!.click())
    expect(open).toHaveBeenLastCalledWith({ kind: 'item', rowId: 'ext' })
    act(() => h.querySelector<HTMLButtonElement>('[data-row="ext:permissions"]')!.click())
    expect(open).toHaveBeenLastCalledWith({ kind: 'detail', rowId: 'ext:permissions' })
    expect(open).toHaveBeenCalledTimes(2)
  })
})
