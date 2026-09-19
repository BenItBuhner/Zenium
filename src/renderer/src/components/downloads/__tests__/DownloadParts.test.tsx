// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DownloadDeleteFileResult, DownloadItem } from '@shared/types'
import { downloadItem } from '@shared/__tests__/downloadFixtures'

/*
 * The download row on the engine's #166 additions, rendered for real: a failed row's
 * `Failed · <reason>` line with the engine's sentence as its tooltip and Retry only where the
 * reason allows one, Chrome's greyed Deleted row for a finished file gone from disk, and the
 * Delete file action – busy while the engine works, the row's state afterwards, a toast when
 * the file would not go.
 */

type Invoke = (name: string, args?: unknown) => Promise<unknown>
const invoke = vi.fn<Invoke>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { DownloadRow } = await import('../DownloadParts')
const { uiStore } = await import('@renderer/lib/ui')

let root: Root | null = null
let host: HTMLElement | null = null

function render(item: DownloadItem): HTMLElement {
  host = document.createElement('ul')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(createElement(DownloadRow, { item, draggable: true })))
  return host.querySelector('[data-download-id]') as HTMLElement
}

const actions = (row: HTMLElement): string[] =>
  [...row.querySelectorAll<HTMLButtonElement>('.zen-dl-actions button')].map(
    (b) => b.getAttribute('aria-label') ?? ''
  )

const status = (row: HTMLElement): HTMLElement =>
  row.querySelector('.zen-dl-status span') as HTMLElement

const finished = (over: Partial<DownloadItem> = {}): DownloadItem =>
  downloadItem({
    id: 'dl-1',
    filename: 'report.pdf',
    finalName: 'report.pdf',
    savePath: '/home/u/Downloads/report.pdf',
    totalBytes: 2048,
    receivedBytes: 2048,
    state: 'completed',
    ...over
  })

beforeEach(() => {
  invoke.mockClear()
  invoke.mockImplementation(async () => null)
  uiStore.set({ toasts: [] })
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('a failed row', () => {
  it('reads Failed · <reason> in the danger ink with the engine’s sentence as its tooltip', () => {
    const row = render(
      finished({
        state: 'interrupted',
        receivedBytes: 512,
        error: 'network-disconnected',
        errorMessage: 'Check internet connection'
      })
    )
    const line = status(row)
    expect(line.textContent).toBe('Failed · Check internet connection')
    expect(line.className).toContain('zen-dl-status-danger')
    expect(line.getAttribute('title')).toBe('Check internet connection')
    expect(row.getAttribute('aria-label')).toBe('report.pdf. Failed · Check internet connection')
    expect(actions(row)).toEqual(['Retry', 'Remove from list'])
  })

  it('offers no Retry for a verdict a retry would meet again', () => {
    const row = render(
      finished({
        state: 'interrupted',
        receivedBytes: 0,
        error: 'file-blocked',
        errorMessage: 'Blocked by your organization'
      })
    )
    expect(status(row).textContent).toBe('Failed · Blocked by your organization')
    expect(actions(row)).toEqual(['Remove from list'])
  })
})

describe('the Deleted row', () => {
  it('greys the name and glyph, reads Deleted, and keeps Retry and Remove only', () => {
    const row = render(finished({ fileMissing: true }))
    expect(row.getAttribute('data-deleted')).toBe('true')
    expect(status(row).textContent).toBe('Deleted')
    expect(status(row).className).not.toContain('zen-dl-status-danger')
    // The name is no longer a button that opens the file, and sits in the deemphasised ink.
    const name = row.querySelector('.zen-dl-name') as HTMLElement
    expect(name.tagName).toBe('SPAN')
    expect(name.className).toContain('zen-dl-deemph')
    expect(row.querySelector('.zen-dl-glyph')?.className).toContain('opacity-40')
    expect(actions(row)).toEqual(['Retry', 'Remove from list'])
    // Nothing to drag out either.
    expect(row.getAttribute('draggable')).toBe('false')
  })

  it('is a plain finished row again once the file is back', () => {
    const row = render(finished({ fileMissing: false }))
    expect(row.hasAttribute('data-deleted')).toBe(false)
    expect(status(row).textContent).toBe('Done · 2.0 KB')
    expect((row.querySelector('.zen-dl-name') as HTMLElement).tagName).toBe('BUTTON')
    expect(actions(row)).toEqual(['Show in folder', 'Delete file', 'Remove from list'])
    expect(row.getAttribute('draggable')).toBe('true')
  })
})

describe('Delete file', () => {
  /** The engine answers when the test says so. */
  function pendingDelete(): { resolve: (result: DownloadDeleteFileResult) => void } {
    let resolve: (result: DownloadDeleteFileResult) => void = () => undefined
    invoke.mockImplementation((name) => {
      if (name !== 'download.deleteFile') return Promise.resolve(null)
      return new Promise<DownloadDeleteFileResult>((r) => {
        resolve = r
      })
    })
    return { resolve: (result) => resolve(result) }
  }

  const deleteButton = (row: HTMLElement): HTMLButtonElement =>
    row.querySelector('[data-zen-dl-action="delete-file"]') as HTMLButtonElement

  it('asks the engine once, spinning meanwhile (§9.30), and says nothing when the file went', async () => {
    const gate = pendingDelete()
    const row = render(finished())
    const button = deleteButton(row)
    expect(button.getAttribute('aria-busy')).toBeNull()
    act(() => button.click())
    expect(invoke).toHaveBeenCalledWith('download.deleteFile', { id: 'dl-1' })
    // Busy: full opacity, the glyph gives way to the spinner, presses are ignored.
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.className).toContain('zen-dl-busy')
    expect(button.querySelector('.zen-dl-spinner')).not.toBeNull()
    expect(button.disabled).toBe(false)
    act(() => button.click())
    expect(invoke.mock.calls.filter(([name]) => name === 'download.deleteFile')).toHaveLength(1)
    await act(async () => {
      gate.resolve('deleted')
      await Promise.resolve()
    })
    expect(button.getAttribute('aria-busy')).toBeNull()
    expect(uiStore.get().toasts).toEqual([])
  })

  it('says nothing either when the file was gone already – the row reads Deleted', async () => {
    const gate = pendingDelete()
    const row = render(finished())
    act(() => deleteButton(row).click())
    await act(async () => {
      gate.resolve('missing')
      await Promise.resolve()
    })
    expect(uiStore.get().toasts).toEqual([])
  })

  it('toasts when the file would not go', async () => {
    const gate = pendingDelete()
    const row = render(finished())
    act(() => deleteButton(row).click())
    await act(async () => {
      gate.resolve('failed')
      await Promise.resolve()
    })
    expect(deleteButton(row).getAttribute('aria-busy')).toBeNull()
    expect(uiStore.get().toasts.map((t) => [t.message, t.kind])).toEqual([
      ['Couldn’t delete “report.pdf”', 'error']
    ])
  })

  it('treats a command that never came back as a file still there', async () => {
    invoke.mockImplementation((name) =>
      name === 'download.deleteFile' ? Promise.reject(new Error('ipc')) : Promise.resolve(null)
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const row = render(finished())
    await act(async () => {
      deleteButton(row).click()
      await Promise.resolve()
    })
    expect(uiStore.get().toasts.map((t) => t.message)).toEqual(['Couldn’t delete “report.pdf”'])
    error.mockRestore()
  })
})
