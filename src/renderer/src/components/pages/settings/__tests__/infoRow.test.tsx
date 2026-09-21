// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { InfoRow } from '../model'
import { RowView } from '../rows'

/*
 * The info row's status inks (§9.33, one ink per row – the §1 status ink on the line that
 * reports the status): a row whose second line is the status carries `tone`, and the renderer
 * puts the ink on the description; a row whose LABEL is the status (a failure's sentence as the
 * row's first line, as a result's headline is) carries `danger`, and the renderer gives the row
 * the danger class whose label rule inks the sentence, the description keeping its 69%. PR #259's
 * independent review found the phone's run-level import failure drawn the other way round.
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

const ctx = { open: () => undefined }

function rowOf(el: HTMLElement, id: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

describe('the info row’s status ink', () => {
  it('a row whose label is the status takes the danger row class: the label rule inks the sentence, the description stays plain', () => {
    const headline: InfoRow = {
      kind: 'info',
      id: 'import-last-headline',
      label: 'The file picker could not be opened.',
      description: 'From a bookmarks HTML file',
      danger: true,
      clamp: true
    }
    const el = render(<RowView row={headline} ctx={ctx} />)
    const row = rowOf(el, 'import-last-headline')
    expect(row.classList.contains('zen-settings-row-danger')).toBe(true)
    expect(row.querySelector('.zen-settings-label')?.textContent).toBe(
      'The file picker could not be opened.'
    )
    const description = row.querySelector('.zen-settings-description')
    expect(description?.textContent).toBe('From a bookmarks HTML file')
    expect(description?.hasAttribute('data-tone')).toBe(false)
    // Still not a target (§9.34): static, no role, no fill.
    expect(row.tagName).toBe('DIV')
    expect(row.hasAttribute('data-static')).toBe(true)
  })

  it('a row whose description is the status keeps `tone` on that line alone, no danger class on the row', () => {
    const kind: InfoRow = {
      kind: 'info',
      id: 'import-last-bookmarks',
      label: 'Bookmarks',
      description: 'No bookmarks were found in that file.',
      tone: 'danger'
    }
    const el = render(<RowView row={kind} ctx={ctx} />)
    const row = rowOf(el, 'import-last-bookmarks')
    expect(row.classList.contains('zen-settings-row-danger')).toBe(false)
    expect(row.querySelector('.zen-settings-description')?.getAttribute('data-tone')).toBe('danger')
  })

  it('a plain fact carries neither', () => {
    const fact: InfoRow = {
      kind: 'info',
      id: 'about-version',
      label: 'Version',
      description: '0.3.78'
    }
    const el = render(<RowView row={fact} ctx={ctx} />)
    const row = rowOf(el, 'about-version')
    expect(row.classList.contains('zen-settings-row-danger')).toBe(false)
    expect(row.querySelector('.zen-settings-description')?.hasAttribute('data-tone')).toBe(false)
  })
})
