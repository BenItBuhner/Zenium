// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useState, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FrameDialogHost } from '@renderer/lib/portals'
import { DialogStack } from '../dialogs'
import { useSheetDismiss } from '../sheetContext'
import type { ActionRow, FieldRow, ItemRow, RowGroup, SettingsRow } from '../model'
import { RowView, type RowContext, type SheetRequest } from '../rows'

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

  it('a confirmation over an item dialog is §9.20’s 320 notice, never the 400 of the dialog it covers (§9.5; the #324 lead check)', () => {
    const onPress = vi.fn()
    const row: ItemRow = {
      kind: 'item',
      id: 'search-engine:custom:example-search',
      label: 'Example Search',
      sheet: {
        title: 'Example Search',
        groups: [
          {
            id: 'search-engine:custom:example-search:actions',
            heading: null,
            rows: [
              {
                kind: 'action',
                id: 'search-engine:custom:example-search:remove',
                label: 'Remove',
                destructive: true,
                confirm: { title: 'Remove Example Search?', action: 'Remove' },
                onPress
              }
            ]
          }
        ]
      }
    }
    const groups: RowGroup[] = [{ id: 'search-engines', heading: 'Search engines', rows: [row] }]
    const h = render(
      <FrameDialogHost>
        <DialogStack
          requests={[
            { kind: 'item', rowId: row.id },
            { kind: 'confirm', rowId: 'search-engine:custom:example-search:remove' }
          ]}
          groups={groups}
          ctx={ctx}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    // The item dialog is the Settings chassis's `role=dialog`; the prompt over it is the program's
    // prompt primitive (`ConfirmDialog`, `role=alertdialog`) – the stack's `data-dialog` handle on
    // both, beside the primitive's own `data-confirm`.
    const dialogs = [...h.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
    expect(dialogs.map((d) => d.getAttribute('data-dialog'))).toEqual([
      'item:search-engine:custom:example-search',
      'confirm:search-engine:custom:example-search:remove'
    ])
    const [item, prompt] = dialogs
    expect(prompt!.getAttribute('role')).toBe('alertdialog')
    expect(prompt!.getAttribute('data-confirm')).toBe('search-engine:custom:example-search:remove')
    expect(prompt!.hasAttribute('data-destructive')).toBe(true)
    // The item's rows take the form width; the prompt over it is the notice – 320 inside the
    // 400, its edges inside the lower dialog's – and the lower dialog is inert under it.
    expect(item!.style.width).toBe('400px')
    expect(prompt!.style.width).toBe('320px')
    expect(item!.hasAttribute('inert')).toBe(true)
    expect(prompt!.hasAttribute('inert')).toBe(false)
    // A title block and the two footer buttons, nothing else.
    expect(prompt!.textContent).toContain('Remove Example Search?')
    expect([...prompt!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Cancel',
      'Remove'
    ])
    expect(prompt!.querySelector('[data-row], input')).toBeNull()
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

  it('a dialog body’s headings end 8 above the first row’s box, the desktop’s number (§9.27; the lead’s #314 ruling), the phone sheet’s keep the primitive’s 4', () => {
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
    // The heading is in the dialog's body with the first row right after it (no description
    // between), the shape the pane's rule keys on with `:not(:has(+ description))`.
    const body = h.querySelector('.zen-settings-dialog-body')!
    const heading = body.querySelector('.zen-settings-heading')!
    expect(heading.textContent).toBe('Work laptop')
    expect(heading.nextElementSibling?.classList.contains('zen-settings-group-description')).toBe(
      false
    )
    expect(heading.nextElementSibling?.classList.contains('zen-settings-row')).toBe(true)
    const css = readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
    // One rule, the pane's and the dialog body's: the desktop surface's 8 below.
    expect(css).toContain(
      '.zen-settings-pane .zen-settings-heading:not(:has(+ .zen-settings-group-description)), ' +
        '.zen-settings-dialog-body .zen-settings-heading:not(:has(+ .zen-settings-group-description)) { margin-bottom: 8px; }'
    )
    // The phone sheet's body has no such rule: its headings keep the primitive's 4 (§10.3).
    expect(css).not.toMatch(
      /\.zen-settings-sheet-body[^{]*\.zen-settings-heading[^{]*\{[^}]*margin-bottom/
    )
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

/**
 * A page's control row with a confirmation (Security's "Forget all…", sections.tsx): on the
 * desktop an action row with `button` is `ControlRow` (rows.tsx) – its `data-row` on the static
 * `div`, the button trailing inside it – and the row stays once its verb has run.
 */
function forgetAllRow(onPress: () => void): ActionRow {
  return {
    kind: 'action',
    id: 'security-forget-all',
    label: 'Forget all site permissions',
    description: 'Every site asks again the next time it needs something.',
    button: 'Forget all…',
    destructive: true,
    confirm: {
      title: 'Forget all site permissions?',
      description: 'Every site asks again the next time it needs something.',
      action: 'Forget all'
    },
    onPress
  }
}

/** A confirmation that destroys nothing (a sign-out): its verb is the primary, and the default. */
function signOutRow(onPress: () => void): ActionRow {
  return {
    kind: 'action',
    id: 'sync-sign-out',
    label: 'Sign out',
    confirm: {
      title: 'Sign out of sync?',
      description: 'Your bookmarks and passwords stay on this device.',
      action: 'Sign out'
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
 * opened the first dialog (its press opens `opens`); `pageRow` names the row it is the control
 * of (`data-row`, as rows.tsx marks an action row's button), when a test wants the prompt's way
 * back to find it; `page` puts the real desktop row (`RowView`, rows.tsx) on the page instead of
 * the stand-in, its own control opening what the row opens. `[data-cover]` around the host
 * stands for an `inert` the stack does not manage.
 */
function Stack({
  groups,
  initial,
  opens,
  pageRow,
  page
}: {
  groups: readonly RowGroup[]
  initial: readonly SheetRequest[]
  opens?: SheetRequest
  pageRow?: string
  page?: SettingsRow
}): JSX.Element {
  const [requests, setRequests] = useState<readonly SheetRequest[]>(initial)
  const ctx: RowContext = { open: (request) => setRequests([...requests, request]) }
  return (
    <>
      {page ? (
        <RowView row={page} ctx={ctx} variant="desktop" />
      ) : (
        <button
          type="button"
          data-page-row
          data-row={pageRow}
          onClick={() => opens && setRequests([...requests, opens])}
        >
          Personal
        </button>
      )}
      <div data-cover>
        <FrameDialogHost>
          <DialogStack
            requests={requests}
            groups={groups}
            ctx={ctx}
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

/** An Enter press on `from`; the event comes back, `defaultPrevented` when the prompt took the key as its own. */
function enter(from: Element): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  act(() => {
    from.dispatchEvent(e)
  })
  return e
}

/*
 * The builder's confirmation is the program's prompt primitive (`ConfirmDialog`,
 * components/dialogs; W4-1), so its keyboard is the primitive's (§9.22 as amended by the design
 * lead on #392): the container holds the focus as the prompt opens and no verb is preselected,
 * Tab enters at Cancel and Shift+Tab at the verb, Enter from the container is the verb on a
 * prompt that is not destructive and inert on one that is – a destructive prompt has no
 * default – and Escape is Cancel, the focus going back to the row's control (`data-row`).
 */
describe('a prompt holds the focus itself as it opens (§9.22, §9.23)', () => {
  it('focuses the container – `tabindex -1`, no verb preselected – and is announced by its title and description', () => {
    const remove = deleteRow(() => undefined)
    const groups: RowGroup[] = [{ id: 'containers', heading: 'Containers', rows: [remove] }]
    const h = render(<Stack groups={groups} initial={[{ kind: 'confirm', rowId: remove.id }]} />)
    const dialog = h.querySelector<HTMLElement>(
      '[data-dialog="confirm:container-delete:personal"]'
    )!
    expect(dialog).not.toBeNull()
    expect(document.activeElement).toBe(dialog)
    expect(dialog.getAttribute('tabindex')).toBe('-1')
    // main.css: `[role='alertdialog'][tabindex='-1']:focus-visible { outline: none }` – the
    // primitive's held container draws no ring.
    expect(dialog.matches("[role='alertdialog'][tabindex='-1']")).toBe(true)
    const [cancel, verb] = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    expect(cancel!.textContent).toBe('Cancel')
    expect(verb!.textContent).toBe('Delete')
    expect(document.activeElement).not.toBe(cancel)
    expect(document.activeElement).not.toBe(verb)
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

  it('is the program’s prompt primitive, not a Settings dialog: the `ConfirmDialog` root with its footer (§9.11), the verb last in the danger ink with no primary', () => {
    const remove = deleteRow(() => undefined)
    const groups: RowGroup[] = [{ id: 'containers', heading: 'Containers', rows: [remove] }]
    const h = render(<Stack groups={groups} initial={[{ kind: 'confirm', rowId: remove.id }]} />)
    const prompt = h.querySelector<HTMLElement>('[data-dialog^="confirm:"]')!
    // The primitive's panel (components/dialogs/ConfirmDialog.tsx): its own class and role, no
    // Settings dialog chassis around or inside it – the builder consumes the export whole.
    expect(prompt.classList.contains('zen-confirm-dialog')).toBe(true)
    expect(prompt.classList.contains('zen-settings-dialog')).toBe(false)
    expect(prompt.closest('.zen-settings-dialog')).toBeNull()
    expect(
      prompt.querySelector('.zen-settings-sheet-actions, .zen-settings-dialog-body')
    ).toBeNull()
    // The shape the primitive's rules key on: the footer is the prompt body's direct child,
    // Cancel then the verb, the verb in the danger ink and no button the primary.
    const footer = prompt.querySelector<HTMLElement>(
      ':scope > .zen-confirm-dialog-body > .zen-confirm-dialog-footer'
    )!
    expect(footer).not.toBeNull()
    const buttons = [...footer.querySelectorAll<HTMLButtonElement>(':scope > .zen-v2-button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Delete'])
    expect(buttons.map((b) => b.getAttribute('data-action'))).toEqual(['cancel', 'confirm'])
    expect(buttons[1]!.hasAttribute('data-danger')).toBe(true)
    expect(footer.querySelector('[data-primary]')).toBeNull()
    const css = readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
    // The primitive's footer hugs the right at the 8 gap, its buttons at the button's own 96.
    expect(css).toContain(
      '.zen-confirm-dialog-footer { display: flex; justify-content: flex-end; gap: 8px; }'
    )
    expect(css).toContain(
      '.zen-v2-button { display: inline-flex; align-items: center; justify-content: center; height: var(--v2-control); min-width: 96px;'
    )
  })

  it('a form dialog’s footer still hugs on the desktop (§9.11): the dialog’s own pose over the phone sheet’s split, the verb last', () => {
    const field: FieldRow = {
      kind: 'field',
      id: 'sync-device-name',
      label: 'Device name',
      value: 'Pixel',
      input: 'text',
      onCommit: () => undefined
    }
    const groups: RowGroup[] = [{ id: 'sync', heading: 'Sync', rows: [field] }]
    const h = render(<Stack groups={groups} initial={[{ kind: 'field', rowId: field.id }]} />)
    // The shape the rules key on: the footer is the dialog body's direct child, inside
    // `.zen-settings-dialog`, Cancel then the verb.
    const footer = h.querySelector<HTMLElement>(
      '.zen-settings-dialog .zen-settings-dialog-body .zen-settings-sheet-actions'
    )!
    expect(footer).not.toBeNull()
    const buttons = [...footer.querySelectorAll<HTMLButtonElement>(':scope > .zen-v2-button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Save'])
    const css = readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
    // The phone sheet's split stands as it was, and the dialog's hug follows it in the sheet:
    // the two buttons at their own width – the primitive's 96 floor back, which the split
    // lifts – right-aligned; 32 tall and 8 apart are the primitive's and the footer's own.
    const split = '.zen-settings-sheet-actions > * { flex: 1 1 0; min-width: 0; }'
    const hug =
      '.zen-settings-dialog .zen-settings-sheet-actions { justify-content: flex-end; } ' +
      '.zen-settings-dialog .zen-settings-sheet-actions > * { flex: 0 0 auto; min-width: 96px; }'
    expect(css).toContain(split)
    expect(css).toContain(hug)
    expect(css.indexOf(hug)).toBeGreaterThan(css.indexOf(split))
    expect(css).toContain('.zen-settings-sheet-actions { display: flex; gap: 8px; }')
    // The pose is the surface's, not a pointer or form-factor query's: no phone-keyed rule
    // touches the footer, and nothing else sets the footer's `justify-content`.
    expect(css).not.toMatch(/\[data-form-factor='phone'\][^{]*zen-settings-sheet-actions/)
    const aligning = css
      .split('}')
      .map((rule) => rule.split('{') as [string, string?])
      .filter(
        ([selector, body]) =>
          selector.includes('zen-settings-sheet-actions') && body?.includes('justify-content')
      )
      .map(([selector]) => selector.trim())
    expect(aligning).toEqual(['.zen-settings-dialog .zen-settings-sheet-actions'])
  })

  it('Enter from the held container of a DESTRUCTIVE prompt does nothing: no default (§9.22 as amended on #392) – the key is consumed, the prompt stands, the row does not act', () => {
    const onPress = vi.fn()
    const remove = deleteRow(onPress)
    const groups: RowGroup[] = [{ id: 'containers', heading: 'Containers', rows: [remove] }]
    const h = render(<Stack groups={groups} initial={[{ kind: 'confirm', rowId: remove.id }]} />)
    const prompt = h.querySelector<HTMLElement>('[data-dialog^="confirm:"]')!
    expect(document.activeElement).toBe(prompt)
    expect(enter(prompt).defaultPrevented).toBe(true)
    expect(h.querySelector(LIVE_PROMPT)).toBe(prompt)
    expect(onPress).not.toHaveBeenCalled()
    // Enter on the verb itself is the button's own (its click, which the browser synthesises):
    // the prompt does not take it, and does not act on it either.
    const verb = prompt.querySelector<HTMLButtonElement>('[data-action="confirm"]')!
    act(() => verb.focus())
    expect(enter(verb).defaultPrevented).toBe(false)
    expect(onPress).not.toHaveBeenCalled()
    expect(h.querySelector(LIVE_PROMPT)).toBe(prompt)
  })

  it('Enter from the held container of a prompt that is not destructive is the verb: the primary is the default, the row acts and the prompt closes', () => {
    const onPress = vi.fn()
    const signOut = signOutRow(onPress)
    const groups: RowGroup[] = [{ id: 'sync', heading: 'Sync', rows: [signOut] }]
    const h = render(<Stack groups={groups} initial={[{ kind: 'confirm', rowId: signOut.id }]} />)
    const prompt = h.querySelector<HTMLElement>('[data-dialog="confirm:sync-sign-out"]')!
    expect(prompt.hasAttribute('data-destructive')).toBe(false)
    const verb = prompt.querySelector<HTMLButtonElement>('[data-action="confirm"]')!
    expect(verb.textContent).toBe('Sign out')
    expect(verb.hasAttribute('data-primary')).toBe(true)
    expect(verb.hasAttribute('data-danger')).toBe(false)
    expect(document.activeElement).toBe(prompt)
    expect(enter(prompt).defaultPrevented).toBe(true)
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(h.querySelector(LIVE_PROMPT)).toBeNull()
  })

  it('Escape is Cancel: the prompt closes without the row acting, and the focus goes back to the row’s control on the page (`data-row`), never to Cancel', () => {
    const onPress = vi.fn()
    const remove = deleteRow(onPress)
    const groups: RowGroup[] = [{ id: 'containers', heading: 'Containers', rows: [remove] }]
    const h = render(
      <Stack
        groups={groups}
        initial={[]}
        opens={{ kind: 'confirm', rowId: remove.id }}
        pageRow={remove.id}
      />
    )
    const pageRow = h.querySelector<HTMLElement>('[data-row="container-delete:personal"]')!
    act(() => pageRow.focus())
    act(() => pageRow.click())
    const prompt = h.querySelector<HTMLElement>(LIVE_PROMPT)!
    expect(document.activeElement).toBe(prompt)
    escape()
    expect(h.querySelector(LIVE_PROMPT)).toBeNull()
    expect(onPress).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(pageRow)
  })

  it('the way back from a control row’s confirmation is the row’s button – `data-row` sits on the static div (rows.tsx `ControlRow`), which cannot hold the focus – after Escape, and after the verb on a row that stays; never `body`', () => {
    const onPress = vi.fn()
    const forgetAll = forgetAllRow(onPress)
    const groups: RowGroup[] = [{ id: 'security', heading: 'Security', rows: [forgetAll] }]
    const h = render(<Stack groups={groups} initial={[]} page={forgetAll} />)
    // The real desktop shape (Security's Forget all…, Agents' Regenerate…, a container's
    // Delete…, an agent's Disconnect…): the row is a static `div` and the control is the 32 px
    // button trailing in it.
    const row = h.querySelector<HTMLElement>('[data-row="security-forget-all"]')!
    expect(row.tagName).toBe('DIV')
    expect(row.hasAttribute('data-static')).toBe(true)
    expect(row.classList.contains('zen-settings-control-row')).toBe(true)
    const button = row.querySelector<HTMLButtonElement>('button.zen-v2-button')!
    expect(button.textContent).toBe('Forget all…')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')

    // Escape: the prompt goes and the focus is back on the button. Not on the div – in Chromium a
    // `.focus()` on it is a no-op and the way back falls to `body`; happy-dom lets the div take
    // it – so the button is the one landing that reads the same in both.
    act(() => button.focus())
    act(() => button.click())
    const prompt = h.querySelector<HTMLElement>(LIVE_PROMPT)!
    expect(prompt.getAttribute('data-dialog')).toBe('confirm:security-forget-all')
    expect(document.activeElement).toBe(prompt)
    escape()
    expect(h.querySelector(LIVE_PROMPT)).toBeNull()
    expect(onPress).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button)

    // The verb, on a row that stays: the row acts once, the prompt goes, and the focus is back
    // on the same button – the row is still on the page (re-rendered or not, `data-row` finds it).
    act(() => button.click())
    const again = h.querySelector<HTMLElement>(LIVE_PROMPT)!
    expect(document.activeElement).toBe(again)
    const verb = again.querySelector<HTMLButtonElement>('[data-action="confirm"]')!
    expect(verb.textContent).toBe('Forget all')
    act(() => verb.focus())
    act(() => verb.click())
    expect(h.querySelector(LIVE_PROMPT)).toBeNull()
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(h.querySelector('[data-row="security-forget-all"]')).toBe(row)
    expect(document.activeElement).toBe(button)
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

  it('follows the hold that is left: an outer inert standing after the nearest went is watched in its turn', async () => {
    const { h, removeRow } = stackTwo()
    // Two holds, one inside the other (none nests today – the chrome hold and a dialog's cover
    // are siblings – but the return must not depend on it): the control refuses under both.
    const inner = h.querySelector<HTMLElement>('[data-cover]')!
    inner.setAttribute('inert', '')
    h.setAttribute('inert', '')
    escape()
    expect(h.querySelector(LIVE_PROMPT)).toBeNull()
    expect(document.activeElement).toBe(document.body)
    // The nearest hold goes; the outer still refuses, and the watch moves to it.
    inner.removeAttribute('inert')
    await tick()
    expect(document.activeElement).toBe(document.body)
    // The outer goes: the control takes the focus – not after the wait's cap, now.
    h.removeAttribute('inert')
    await tick()
    expect(document.activeElement).toBe(removeRow)
  })
})

/*
 * The dialog's dismiss as the forms inside know it (`useSheetDismiss`) takes an optional `after`
 * to run once the dialog is gone. A form that binds it straight to a button (`onClick={dismiss}`)
 * hands it the click's event instead; the phone sheet's landing used to throw calling one (#145),
 * and the desktop host runs `after` at once – so it runs only a function, the two hosts alike.
 */
describe('a desktop dialog’s dismiss runs only a function as its after', () => {
  /** A form whose Cancel binds the sheet dismiss itself to the click, the hazard as written. */
  function Cancel(): JSX.Element {
    const dismiss = useSheetDismiss()
    return (
      <button type="button" onClick={dismiss}>
        Cancel
      </button>
    )
  }

  it('Cancel bound straight to onClick closes the dialog and raises no error', () => {
    // React hands an event handler's throw to `window.onerror` (`reportError`), not to the
    // caller, so the dialog closed either way and the failure was a console error alone – on
    // the phone the same call landed before the sheet told the chrome it was gone (#145).
    const errors: unknown[] = []
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error ?? e.message)
      e.preventDefault()
    }
    window.addEventListener('error', onError)
    const closeTop = vi.fn()
    const row: ActionRow = {
      kind: 'action',
      id: 'clear-data',
      label: 'Clear browsing data',
      form: { title: 'Clear browsing data', render: () => <Cancel /> }
    }
    const groups: RowGroup[] = [{ id: 'privacy', heading: null, rows: [row] }]
    const requests: SheetRequest[] = [{ kind: 'form', rowId: row.id }]
    const h = render(
      <FrameDialogHost>
        <DialogStack requests={requests} groups={groups} ctx={ctx} closeTop={closeTop} />
      </FrameDialogHost>
    )
    const cancel = [...h.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent === 'Cancel'
    )!
    expect(cancel).toBeDefined()
    try {
      act(() => cancel.click())
    } finally {
      window.removeEventListener('error', onError)
    }
    expect(closeTop).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })
})
