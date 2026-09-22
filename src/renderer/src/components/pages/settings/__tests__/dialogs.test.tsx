// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useState, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FrameDialogHost } from '@renderer/lib/portals'
import { DialogStack } from '../dialogs'
import type { ActionRow, ItemRow, RowGroup } from '../model'
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

  it('the container carries the shared no-ring mark and its controls do not: role=dialog with tabindex=-1 (§1, §9.22)', () => {
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
    // main.css: `:root [role='dialog'][tabindex='-1']:focus-visible { outline: none }` – the
    // one shared rule (focusRing.test.ts pins it) reaches the root and nothing inside it.
    const mark = "[role='dialog'][tabindex='-1']"
    const dialog = h.querySelector<HTMLElement>('[data-dialog]')!
    expect(dialog.matches(mark)).toBe(true)
    expect(dialog.classList.contains('zen-v2-dialog')).toBe(true)
    const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, [tabindex]')]
    expect(controls.length).toBeGreaterThan(0)
    expect(controls.filter((el) => el.matches(mark))).toEqual([])
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

// ---------------------------------------------------------------------------
// The keyboard (§9.22, §9.24)
// ---------------------------------------------------------------------------

/** The Remove action a container's item dialog carries, with its prompt. */
function deleteRow(onPress: () => void): ActionRow {
  return {
    kind: 'action',
    id: 'container-delete:personal',
    label: 'Delete container',
    destructive: true,
    confirm: {
      title: 'Delete Personal?',
      description: 'Its tabs close and its cookies and site data go with it.',
      action: 'Delete'
    },
    onPress
  }
}

/** An item dialog's rows: a row that stays, then the Remove action that opens the prompt. */
function containerRow(remove: ActionRow): ItemRow {
  return {
    kind: 'item',
    id: 'container:personal',
    label: 'Personal',
    sheet: {
      title: 'Personal',
      groups: [
        {
          id: 'container:personal:rows',
          heading: 'Container',
          rows: [
            { kind: 'action', id: 'container-rename:personal', label: 'Rename', onPress: () => {} },
            remove
          ]
        }
      ]
    }
  }
}

/**
 * The page's stack as `useSheetStack` keeps it: a row's press pushes a request, `closeTop`
 * drops the last, and a page row stands before the host in the document as the thing that
 * opened the first dialog (its press opens `opens`). `[data-cover]` around the host stands for
 * an `inert` the stack does not manage.
 */
function Stack({
  groups,
  initial,
  opens
}: {
  groups: readonly RowGroup[]
  initial: readonly SheetRequest[]
  opens?: SheetRequest
}): JSX.Element {
  const [requests, setRequests] = useState<readonly SheetRequest[]>(initial)
  return (
    <>
      <button
        type="button"
        data-page-row
        onClick={() => opens && setRequests([...requests, opens])}
      >
        Personal
      </button>
      <div data-cover>
        <FrameDialogHost>
          <DialogStack
            requests={requests}
            groups={groups}
            ctx={{ open: (request) => setRequests([...requests, request]) }}
            closeTop={() => setRequests(requests.slice(0, -1))}
          />
        </FrameDialogHost>
      </div>
    </>
  )
}

const escape = (): void =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

/** The mutation observers' callbacks run as microtasks; let them. */
const tick = (): Promise<void> => act(async () => undefined)

/** A Tab press on `from`; the event comes back, `defaultPrevented` when the dialog moved the focus itself. */
function tab(from: Element, shift = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true
  })
  act(() => {
    from.dispatchEvent(e)
  })
  return e
}

describe('a prompt holds the focus itself as it opens (§9.22, §9.23)', () => {
  it('focuses the container, not Cancel, and is announced by its title and description', () => {
    const remove = deleteRow(() => undefined)
    const groups: RowGroup[] = [{ id: 'containers', heading: 'Containers', rows: [remove] }]
    const h = render(<Stack groups={groups} initial={[{ kind: 'confirm', rowId: remove.id }]} />)
    const dialog = h.querySelector<HTMLElement>(
      '[data-dialog="confirm:container-delete:personal"]'
    )!
    expect(dialog).not.toBeNull()
    expect(document.activeElement).toBe(dialog)
    const [cancel, verb] = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    expect(cancel!.textContent).toBe('Cancel')
    expect(verb!.textContent).toBe('Delete')
    expect(document.activeElement).not.toBe(cancel)
    // What a reader says as the container takes the focus: the question, then the notice.
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)
    expect(title?.textContent).toBe('Delete Personal?')
    expect(description?.textContent).toBe(
      'Its tabs close and its cookies and site data go with it.'
    )
  })

  it('Tab from the container reaches Cancel, then the verb, and wraps; Shift+Tab reaches the verb first', () => {
    const remove = deleteRow(() => undefined)
    const groups: RowGroup[] = [{ id: 'containers', heading: 'Containers', rows: [remove] }]
    const h = render(<Stack groups={groups} initial={[{ kind: 'confirm', rowId: remove.id }]} />)
    const dialog = h.querySelector<HTMLElement>('[data-dialog^="confirm:"]')!
    const [cancel, verb] = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    expect(document.activeElement).toBe(dialog)
    // From the container, Tab enters at the first control: the dialog's own move.
    expect(tab(dialog).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
    // A step within the dialog is the browser's (Cancel to the verb): the key is left to it.
    expect(tab(cancel!).defaultPrevented).toBe(false)
    act(() => verb!.focus())
    // At the last control Tab wraps to the first; Shift+Tab at the first wraps to the last.
    expect(tab(verb!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
    expect(tab(cancel!, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
    // From the container again: Shift+Tab enters at the end – the verb – and never leaves for
    // the page row that stands before the host in the document.
    act(() => dialog.focus())
    expect(document.activeElement).toBe(dialog)
    expect(tab(dialog, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(verb)
  })

  it('an item dialog still opens on its first row, a form on its field (§9.22 leaves the container to a notice)', () => {
    const remove = deleteRow(() => undefined)
    const item = containerRow(remove)
    const groups: RowGroup[] = [{ id: 'containers', heading: 'Containers', rows: [item] }]
    const h = render(<Stack groups={groups} initial={[{ kind: 'item', rowId: item.id }]} />)
    expect(document.activeElement).toBe(
      h.querySelector(
        '[data-dialog="item:container:personal"] [data-row="container-rename:personal"]'
      )
    )
  })
})

/**
 * A page row opens the item dialog, its Remove row opens the prompt over it: two dialogs on the
 * stack, the lower inert. The way back is what the tests are about.
 */
function stackTwo(): {
  h: HTMLElement
  pageRow: HTMLElement
  removeRow: HTMLElement
} {
  const remove = deleteRow(() => undefined)
  const item = containerRow(remove)
  const groups: RowGroup[] = [{ id: 'containers', heading: 'Containers', rows: [item] }]
  const h = render(<Stack groups={groups} initial={[]} opens={{ kind: 'item', rowId: item.id }} />)
  const pageRow = h.querySelector<HTMLElement>('[data-page-row]')!
  act(() => pageRow.focus())
  act(() => pageRow.click())
  const itemDialog = h.querySelector<HTMLElement>('[data-dialog="item:container:personal"]')!
  expect(itemDialog).not.toBeNull()
  const removeRow = itemDialog.querySelector<HTMLElement>('[data-row="container-delete:personal"]')!
  act(() => removeRow.focus())
  act(() => removeRow.click())
  const prompt = h.querySelector<HTMLElement>('[data-dialog="confirm:container-delete:personal"]')!
  expect(prompt).not.toBeNull()
  expect(document.activeElement).toBe(prompt)
  expect(itemDialog.hasAttribute('inert')).toBe(true)
  return { h, pageRow, removeRow }
}

/** The prompt while it is open: the host keeps a closed panel in the slot, `[data-leaving]`, for its way out. */
const LIVE_PROMPT = '[data-dialog^="confirm:"]:not([data-leaving])'

describe('Escape gives the focus back down the stack one hop at a time (§9.22, §9.24)', () => {
  it('two stacked dialogs, Escape twice: the prompt returns to the row that opened it in the item dialog, the item dialog to the page row', () => {
    const { h, pageRow, removeRow } = stackTwo()
    // The first Escape closes the prompt alone; the item dialog is live again and the control
    // that opened the prompt has the focus – not `body`, not the page row.
    escape()
    expect(h.querySelector(LIVE_PROMPT)).toBeNull()
    const itemDialog = h.querySelector<HTMLElement>('[data-dialog="item:container:personal"]')!
    expect(itemDialog).not.toBeNull()
    expect(itemDialog.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(removeRow)
    // The second closes the item dialog: the row that opened it on the page.
    escape()
    expect(h.querySelector('[data-dialog]:not([data-leaving])')).toBeNull()
    expect(document.activeElement).toBe(pageRow)
  })

  it('a return the lower dialog’s inert still refuses waits for that inert to go, not one fixed frame', async () => {
    const { h, removeRow } = stackTwo()
    // A cover the stack does not drop with the prompt (a dialog's own state, let go of a render
    // later): the control refuses the focus as the prompt's cleanup runs, and it falls to `body`.
    const cover = h.querySelector<HTMLElement>('[data-cover]')!
    cover.setAttribute('inert', '')
    escape()
    expect(h.querySelector(LIVE_PROMPT)).toBeNull()
    expect(document.activeElement).toBe(document.body)
    // Nothing happens while the cover stands.
    await tick()
    expect(document.activeElement).toBe(document.body)
    // As the inert goes the control takes the focus.
    cover.removeAttribute('inert')
    await tick()
    expect(document.activeElement).toBe(removeRow)
  })

  it('leaves the focus where something else put it meanwhile', async () => {
    const { h } = stackTwo()
    const cover = h.querySelector<HTMLElement>('[data-cover]')!
    cover.setAttribute('inert', '')
    escape()
    expect(document.activeElement).toBe(document.body)
    const other = document.createElement('button')
    document.body.appendChild(other)
    act(() => other.focus())
    cover.removeAttribute('inert')
    await tick()
    expect(document.activeElement).toBe(other)
    other.remove()
  })
})
