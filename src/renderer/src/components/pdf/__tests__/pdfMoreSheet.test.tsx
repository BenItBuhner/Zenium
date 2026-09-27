// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FrameDialogHost } from '@renderer/lib/portals'
import { viewportStore } from '@renderer/lib/formFactor'
import type { PdfRowState } from '@renderer/lib/pdfViewer'

/*
 * The PDF viewer's overflow sheet with its Save and Print rows (CT-44's UI): Save is a row only
 * for a document with a form, at .4 until a field changed (§9.30: `aria-disabled` on the row,
 * the opacity on its content), Print a row only where the host prints; both sit after Share and
 * Open with and before Rotate, in the shared `.zen-v2-row` with the 20 glyph (§9.34). Rendered
 * for real in happy-dom on the frame's dialog host, as the bar places it.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  run: () => undefined,
  cmd: async () => null,
  onEvent: () => () => undefined
}))

const { PdfMoreSheet } = await import('../PdfSheets')

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

const noop = (): void => undefined

const sheet = (save: PdfRowState, print: PdfRowState, ready = true): ReactElement => (
  <>
    <FrameDialogHost frame />
    <PdfMoreSheet
      title="mooring-application.pdf"
      ready={ready}
      save={save}
      print={print}
      onShare={noop}
      onOpenWith={noop}
      onSave={noop}
      onPrint={noop}
      onRotate={noop}
      onClose={noop}
    />
  </>
)

const rows = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('.zen-sheet[role="dialog"] button.zen-v2-row')
]
const labels = (): string[] => rows().map((row) => row.textContent?.trim() ?? '')
const row = (label: string): HTMLButtonElement =>
  rows().find((r) => r.textContent?.trim() === label)!

beforeEach(() => {
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.unstubAllGlobals()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
})

describe('the overflow’s rows', () => {
  it('lists Share, Open with, Save, Print and Rotate in that order when the document has a form and the host prints', () => {
    render(sheet('enabled', 'enabled'))
    expect(labels()).toEqual(['Share', 'Open with', 'Save', 'Print', 'Rotate'])
    // The sheet is named by the document (§9.16's header pose).
    expect(document.querySelector('.zen-sheet h2.zen-sheet-title')?.textContent).toBe(
      'mooring-application.pdf'
    )
    // Each row carries a glyph in the leading 20 box and its label; none is disabled.
    for (const r of rows()) {
      expect(r.querySelector('svg')).not.toBeNull()
      expect(r.getAttribute('aria-disabled')).toBeNull()
    }
  })

  it('keeps Save at .4 until a field changed: aria-disabled on the row, the opacity on its content', () => {
    render(sheet('disabled', 'enabled'))
    const save = row('Save')
    expect(save.getAttribute('aria-disabled')).toBe('true')
    const [glyph, label] = [...save.children] as HTMLElement[]
    expect(glyph.className).toContain('opacity-40')
    expect(label.className).toContain('opacity-40')
    // Print stands ready beside it.
    expect(row('Print').getAttribute('aria-disabled')).toBeNull()
  })

  it('has no Save row for a document without a form, and no Print row where the host does not print', () => {
    render(sheet('absent', 'absent'))
    expect(labels()).toEqual(['Share', 'Open with', 'Rotate'])
  })

  it('offers Print for the file while the document is still loading only at .4, with Rotate', () => {
    render(sheet('absent', 'disabled', false))
    expect(labels()).toEqual(['Share', 'Open with', 'Print', 'Rotate'])
    expect(row('Print').getAttribute('aria-disabled')).toBe('true')
    expect(row('Rotate').getAttribute('aria-disabled')).toBe('true')
    expect(row('Share').getAttribute('aria-disabled')).toBeNull()
  })

  it('a Save pressed at .4 does nothing: the sheet stays, no copy is asked for', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(
      <>
        <FrameDialogHost frame />
        <PdfMoreSheet
          title="mooring-application.pdf"
          ready
          save="disabled"
          print="enabled"
          onShare={noop}
          onOpenWith={noop}
          onSave={onSave}
          onPrint={noop}
          onRotate={noop}
          onClose={onClose}
        />
      </>
    )
    act(() => {
      row('Save').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(labels()).toEqual(['Share', 'Open with', 'Save', 'Print', 'Rotate'])
  })
})
