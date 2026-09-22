// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FrameDialogHost } from '@renderer/lib/portals'
import { DialogStack } from '../dialogs'
import type { ItemRow, RowGroup } from '../model'
import type { RowContext, SheetRequest } from '../rows'

/*
 * The desktop's item dialog (dialogs.tsx, v2 §9.24) and a row of it that acts *after* the dialog
 * has gone (`ActionRow.closesSheet`: Tabs from other devices opening a tab, an address's Edit
 * opening its editor). The row asks the dialog's dismissal for it, and the dialog – which has no
 * exit motion – must run the row's action right after dropping its request: a dismissal that
 * only closed left every such row on the desktop doing nothing.
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

const ctx: RowContext = { open: () => undefined }

function itemRow(onPress: () => void, onStay: () => void): ItemRow {
  return {
    kind: 'item',
    id: 'sync-remote-tabs',
    label: 'Tabs from other devices',
    sheet: {
      title: 'Tabs from other devices',
      groups: [
        {
          id: 'sync-remote-tabs:laptop',
          heading: 'Work laptop',
          rows: [
            {
              kind: 'action',
              id: 'sync-remote-tab:laptop:1',
              label: 'Web browser - Wikipedia',
              closesSheet: true,
              onPress
            },
            {
              kind: 'action',
              id: 'sync-remote-tab:laptop:copy',
              label: 'Copy link',
              onPress: onStay
            }
          ]
        }
      ]
    }
  }
}

describe('a desktop item dialog and its rows (§9.24)', () => {
  it('a closesSheet row closes the dialog and then runs its action; a plain row acts and stays', () => {
    const onPress = vi.fn()
    const onStay = vi.fn()
    const closeTop = vi.fn()
    const row = itemRow(onPress, onStay)
    const groups: RowGroup[] = [{ id: 'sync-devices', heading: 'Other devices', rows: [row] }]
    const requests: SheetRequest[] = [{ kind: 'item', rowId: row.id }]
    const h = render(
      <FrameDialogHost>
        <DialogStack requests={requests} groups={groups} ctx={ctx} closeTop={closeTop} />
      </FrameDialogHost>
    )
    const dialog = h.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('data-dialog')).toBe('item:sync-remote-tabs')
    expect(dialog!.textContent).toContain('Work laptop')

    // A row that stays: its action runs, the dialog is left alone.
    act(() =>
      h.querySelector<HTMLButtonElement>('[data-row="sync-remote-tab:laptop:copy"]')!.click()
    )
    expect(onStay).toHaveBeenCalledTimes(1)
    expect(closeTop).not.toHaveBeenCalled()

    // The row that leaves: the request is dropped first, the action runs right after (the
    // dialog has no exit motion to wait for), once.
    const order: string[] = []
    closeTop.mockImplementation(() => order.push('close'))
    onPress.mockImplementation(() => order.push('press'))
    act(() => h.querySelector<HTMLButtonElement>('[data-row="sync-remote-tab:laptop:1"]')!.click())
    expect(order).toEqual(['close', 'press'])
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(closeTop).toHaveBeenCalledTimes(1)
  })

  it('Escape and the scrim close the dialog without running any row', () => {
    const onPress = vi.fn()
    const closeTop = vi.fn()
    const row = itemRow(onPress, () => undefined)
    const groups: RowGroup[] = [{ id: 'sync-devices', heading: 'Other devices', rows: [row] }]
    render(
      <FrameDialogHost>
        <DialogStack
          requests={[{ kind: 'item', rowId: row.id }]}
          groups={groups}
          ctx={ctx}
          closeTop={closeTop}
        />
      </FrameDialogHost>
    )
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closeTop).toHaveBeenCalledTimes(1)
    expect(onPress).not.toHaveBeenCalled()
  })

  it('the first group’s heading drops its 20 under the title block, which carries its own 16 (§9.23, §10.3 as ruled on #239)', () => {
    const row = itemRow(
      () => undefined,
      () => undefined
    )
    const groups: RowGroup[] = [{ id: 'sync-devices', heading: 'Other devices', rows: [row] }]
    const h = render(
      <FrameDialogHost>
        <DialogStack
          requests={[{ kind: 'item', rowId: row.id }]}
          groups={groups}
          ctx={ctx}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    // The shape the stylesheet's rule keys on: the row list is the body's direct child, the
    // first group its first child, the heading the group's first – no wrapper between.
    const body = h.querySelector('.zen-settings-dialog-body')!
    const list = body.firstElementChild!
    expect(list.classList.contains('zen-settings-sheet-rows')).toBe(true)
    const group = list.firstElementChild!
    expect(group.classList.contains('zen-settings-group')).toBe(true)
    expect(group.firstElementChild!.classList.contains('zen-settings-heading')).toBe(true)
    expect(group.firstElementChild!.textContent).toBe('Work laptop')
    const css = readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
    expect(css).toContain(
      '.zen-settings-sheet-body > .zen-settings-sheet-rows > .zen-settings-group:first-child > .zen-settings-heading, ' +
        '.zen-settings-dialog-body > .zen-settings-sheet-rows > .zen-settings-group:first-child > .zen-settings-heading { margin-top: 0; }'
    )
    // The primitive's 20 above stays for every heading after the first.
    expect(css).toContain('.zen-v2-heading { margin: 20px 0 4px;')
  })
})
