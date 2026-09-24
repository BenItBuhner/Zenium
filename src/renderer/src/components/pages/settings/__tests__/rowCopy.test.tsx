// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomRow, InfoRow } from '../model'

/*
 * A row that copies on a long-press (`RowCopy`, SET-54; Chrome for Android's About copies the
 * version on a hold): the info row and a custom block carry the hold's handlers with a `copy`
 * and none without; the hold – the `contextmenu` a touch hold or a right click raises – asks
 * the core to copy the text with the toast's word, the click the release raises is swallowed,
 * and the row stays what it was: static, no role, not a target.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { RowView } = await import('../rows')

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

const fire = (el: Element, type: string): boolean => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true })
  act(() => {
    el.dispatchEvent(event)
  })
  return event.defaultPrevented
}
const copies = (): unknown[][] =>
  invoke.mock.calls.filter(([name]) => name === 'clipboard.writeText')

const ctx = { open: () => undefined }

function rowOf(el: HTMLElement, id: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

beforeEach(() => invoke.mockClear())

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('a row that copies on a hold', () => {
  it('the version row copies its report on the hold, with the toast’s word, and swallows the click the release raises', () => {
    const version: InfoRow = {
      kind: 'info',
      id: 'version',
      label: 'Zenium',
      description: 'Version 0.4.35 · running on Chromium via Android System WebView',
      copy: {
        text: 'Zenium 0.4.35 · Chromium 128.0.0.0 · Android System WebView',
        confirmation: 'Version copied'
      }
    }
    const el = render(createElement(RowView, { row: version, ctx }))
    const row = rowOf(el, 'version')
    expect(row.hasAttribute('data-copies')).toBe(true)
    // Still not a target (§9.34).
    expect(row.tagName).toBe('DIV')
    expect(row.hasAttribute('data-static')).toBe(true)
    expect(row.getAttribute('role')).toBeNull()
    fire(row, 'contextmenu')
    expect(copies()).toEqual([
      [
        'clipboard.writeText',
        {
          text: 'Zenium 0.4.35 · Chromium 128.0.0.0 · Android System WebView',
          confirmation: 'Version copied'
        }
      ]
    ])
    expect(fire(row, 'click')).toBe(true)
    expect(copies()).toHaveLength(1)
    // The next tap is a tap again: nothing swallowed, nothing copied.
    expect(fire(row, 'click')).toBe(false)
    expect(copies()).toHaveLength(1)
  })

  it('a row without a copy carries no hold: a right click copies nothing', () => {
    const engine: InfoRow = {
      kind: 'info',
      id: 'engine',
      label: 'Engine',
      description: 'Blink and V8.'
    }
    const el = render(createElement(RowView, { row: engine, ctx }))
    const row = rowOf(el, 'engine')
    expect(row.hasAttribute('data-copies')).toBe(false)
    fire(row, 'contextmenu')
    expect(copies()).toEqual([])
  })

  it('a custom block with a copy is wrapped for the hold even when bare, and copies on it', () => {
    const block: CustomRow = {
      kind: 'custom',
      id: 'version-block',
      label: 'Zenium',
      bare: true,
      render: () => createElement('div', { className: 'zen-v2-row' }, 'Zenium 0.4.35'),
      copy: { text: 'Zenium 0.4.35', confirmation: 'Version copied' }
    }
    const el = render(createElement(RowView, { row: block, ctx }))
    const row = rowOf(el, 'version-block')
    expect(row.classList.contains('zen-settings-custom-bare')).toBe(true)
    expect(row.hasAttribute('data-copies')).toBe(true)
    fire(row, 'contextmenu')
    expect(copies()).toEqual([
      ['clipboard.writeText', { text: 'Zenium 0.4.35', confirmation: 'Version copied' }]
    ])
    // Without one, a bare block is its own element, no wrapper.
    act(() => root?.unmount())
    host?.remove()
    const plain = render(createElement(RowView, { row: { ...block, copy: undefined }, ctx }))
    expect(plain.querySelector('[data-row="version-block"]')).toBeNull()
    expect(plain.querySelector('.zen-v2-row')?.textContent).toBe('Zenium 0.4.35')
  })
})
