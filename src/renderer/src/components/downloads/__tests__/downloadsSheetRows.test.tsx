// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DownloadItem } from '@shared/types'
import { downloadItem } from '@shared/__tests__/downloadFixtures'

/*
 * The Android sheet's row against §9.34's two forms of the shared row: the one row that is a
 * target – a finished file on disk, which the row opens – is the plain primitive whose press
 * fill says so, with a button for its accessible body; every other row (running, paused,
 * failed, cancelled, Deleted, waiting behind a verdict) is the static form, `data-static` with
 * no role on its body, so main.css's gates keep the hover fill, the press fill and the pointer
 * cursor off the row while its icon buttons or its Keep / Delete stay the targets. Also the
 * #161 / #166 parity the rows read: `Failed · <reason>` and `Deleted` with Retry. Rendered for
 * real, no styling asserted here – the fill gates are pinned in `lib/__tests__/v2Tokens.test.ts`.
 */

type Invoke = (name: string, args?: unknown) => Promise<unknown>
const invoke = vi.fn<Invoke>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { DownloadRow } = await import('../DownloadsSheet')

const NOW = 10_000

let root: Root | null = null
let host: HTMLElement | null = null

function render(item: DownloadItem): HTMLElement {
  host = document.createElement('ul')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(createElement(DownloadRow, { item, now: NOW })))
  return host.querySelector('li.zen-v2-row') as HTMLElement
}

const body = (row: HTMLElement): HTMLElement =>
  row.querySelector('.zen-downloads-main') as HTMLElement

const buttons = (row: HTMLElement): string[] =>
  [...row.querySelectorAll<HTMLButtonElement>('button')].map(
    (b) => b.getAttribute('aria-label') ?? b.textContent ?? ''
  )

/** Static (§9.34): the row carries `data-static` and its body no role; the controls stay. */
function expectStatic(row: HTMLElement): void {
  expect(row.hasAttribute('data-static')).toBe(true)
  expect(row.hasAttribute('role')).toBe(false)
  expect(body(row).hasAttribute('role')).toBe(false)
  expect(body(row).onclick).toBeNull()
}

const finished = (over: Partial<DownloadItem> = {}): DownloadItem =>
  downloadItem({
    id: 'dl-1',
    filename: 'report.pdf',
    savePath: '/storage/emulated/0/Download/report.pdf',
    totalBytes: 2048,
    receivedBytes: 2048,
    state: 'completed',
    completedAt: NOW - 120_000,
    ...over
  })

beforeEach(() => {
  invoke.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('the sheet row as a target or the static form (§9.34)', () => {
  it('a finished file on disk is the target: the plain row, a button for its body, no data-static', () => {
    const row = render(finished())
    expect(row.className.split(' ')).toEqual(['zen-v2-row', 'zen-downloads-row'])
    expect(row.hasAttribute('data-static')).toBe(false)
    expect(body(row).getAttribute('role')).toBe('button')
    expect(body(row).getAttribute('aria-label')).toBe('report.pdf. 2.0 KB · 2 min ago')
    expect(buttons(row)).toEqual(['Show in the Downloads app', 'Remove from list'])
  })

  it('a running row is static around its Pause and Cancel', () => {
    const row = render(
      finished({ state: 'progressing', receivedBytes: 512, bytesPerSecond: 256, etaMs: 6_000 })
    )
    expectStatic(row)
    expect(body(row).getAttribute('aria-label')).toBe('report.pdf. 512 B of 2.0 KB · 6 s left')
    expect(buttons(row)).toEqual(['Pause', 'Cancel'])
  })

  it('a paused row is static around its Resume and Cancel', () => {
    const row = render(finished({ state: 'paused', receivedBytes: 512 }))
    expectStatic(row)
    expect(body(row).getAttribute('aria-label')).toBe('report.pdf. Paused · 512 B of 2.0 KB')
    expect(buttons(row)).toEqual(['Resume', 'Cancel'])
  })

  it('a failed row is static, reads Failed · <the engine’s reason> and offers Retry (#161 parity)', () => {
    const row = render(
      finished({ state: 'interrupted', receivedBytes: 512, error: 'network-failed' })
    )
    expectStatic(row)
    expect(body(row).getAttribute('aria-label')).toBe(
      'report.pdf. Failed · Check internet connection'
    )
    expect(row.querySelector('.zen-downloads-status')?.getAttribute('data-tone')).toBe('danger')
    expect(buttons(row)).toEqual(['Retry', 'Remove from list'])
  })

  it('a failed row that can resume offers Resume instead', () => {
    const row = render(
      finished({
        state: 'interrupted',
        receivedBytes: 512,
        error: 'network-failed',
        canResume: true
      })
    )
    expectStatic(row)
    expect(buttons(row)).toEqual(['Resume', 'Remove from list'])
  })

  it('a Deleted row is static, reads Deleted, dims, and offers Retry (#166 parity)', () => {
    const row = render(finished({ fileMissing: true }))
    expectStatic(row)
    expect(row.hasAttribute('data-deleted')).toBe(true)
    expect(body(row).hasAttribute('data-dim')).toBe(true)
    expect(body(row).getAttribute('aria-label')).toBe('report.pdf. Deleted')
    // Nothing to show in the Downloads app: the file is gone.
    expect(buttons(row)).toEqual(['Retry', 'Remove from list'])
  })

  it('a cancelled row is static and dimmed', () => {
    const row = render(finished({ state: 'cancelled', receivedBytes: 512 }))
    expectStatic(row)
    expect(body(row).hasAttribute('data-dim')).toBe(true)
    expect(body(row).getAttribute('aria-label')).toBe('report.pdf. Cancelled')
  })

  it('a flagged row is static around Keep / Delete, its name saying the blocked status and the verdict', () => {
    const row = render(
      finished({
        filename: 'setup.exe',
        danger: {
          level: 'dangerous',
          reason: 'executable',
          message: 'This file type can harm your device.'
        }
      })
    )
    expectStatic(row)
    expect(row.hasAttribute('data-flagged')).toBe(true)
    expect(body(row).getAttribute('aria-label')).toMatch(/^setup\.exe\. Blocked · .+\. .+/)
    expect(row.querySelector('.zen-downloads-status')?.getAttribute('data-tone')).toBe('danger')
    expect(buttons(row).map((b) => b.trim())).toEqual(['Keep', 'Delete'])
  })

  it('the row’s Retry runs the engine’s retry, the body of a static row runs nothing', () => {
    const row = render(finished({ fileMissing: true }))
    act(() => body(row).click())
    expect(invoke).not.toHaveBeenCalled()
    const retry = [...row.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.getAttribute('aria-label') === 'Retry'
    )
    act(() => retry?.click())
    expect(invoke).toHaveBeenCalledWith('download.retry', { id: 'dl-1' })
  })
})
