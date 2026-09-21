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
    // Delete, the protective verb, is the accent-filled primary and trails; Keep is the plain
    // secondary; neither takes the danger ink (§6, §9.11).
    const [keep, del] = [...row.querySelectorAll<HTMLButtonElement>('button')]
    expect(keep.hasAttribute('data-primary')).toBe(false)
    expect(keep.hasAttribute('data-danger')).toBe(false)
    expect(del.hasAttribute('data-primary')).toBe(true)
    expect(del.hasAttribute('data-danger')).toBe(false)
  })

  it('a flagged row names its tier: Blocked · Suspicious in the warning ink over the verdict’s sentence, Delete filled here too (HB-19 / PS-34)', () => {
    const row = render(
      finished({
        filename: 'backup.iso',
        danger: {
          level: 'suspicious',
          reason: 'archive',
          message: 'This file may contain a program that could harm your device.'
        }
      })
    )
    expectStatic(row)
    expect(row.querySelector('.zen-downloads-status')?.textContent).toBe('Blocked · Suspicious')
    expect(row.querySelector('.zen-downloads-status')?.getAttribute('data-tone')).toBe('warn')
    expect(row.querySelector('.zen-downloads-detail')?.textContent).toBe(
      'This file may contain a program that could harm your device.'
    )
    expect(body(row).getAttribute('aria-label')).toBe(
      'backup.iso. Blocked · Suspicious. This file may contain a program that could harm your device.'
    )
    expect(buttons(row).map((b) => b.trim())).toEqual(['Keep', 'Delete'])
    // The tier names the status and its ink, not the pair: Delete is the filled primary on the
    // suspicious tier as on the dangerous one (§6 widened for #297), Keep plain, no danger ink.
    const [keep, del] = [...row.querySelectorAll<HTMLButtonElement>('button')]
    expect(keep.hasAttribute('data-primary')).toBe(false)
    expect(del.hasAttribute('data-primary')).toBe(true)
    expect(del.hasAttribute('data-danger')).toBe(false)
  })

  it('a transfer refused as insecure (HB-44) is static behind Blocked · Insecure download with Keep anyway / Discard, and dims its glyph (nothing is on disk)', () => {
    const row = render(
      finished({
        filename: 'report.pdf',
        state: 'insecure-blocked',
        savePath: '',
        receivedBytes: 0,
        url: 'http://files.test/report.pdf'
      })
    )
    expectStatic(row)
    expect(row.hasAttribute('data-flagged')).toBe(true)
    expect(body(row).hasAttribute('data-gone')).toBe(true)
    expect(body(row).hasAttribute('data-dim')).toBe(false)
    expect(row.querySelector('.zen-downloads-status')?.textContent).toBe(
      'Blocked · Insecure download'
    )
    expect(row.querySelector('.zen-downloads-status')?.getAttribute('data-tone')).toBe('warn')
    expect(row.querySelector('.zen-downloads-detail')?.textContent).toBe(
      'This file can’t be downloaded securely'
    )
    expect(body(row).getAttribute('aria-label')).toBe(
      'report.pdf. Blocked · Insecure download. This file can’t be downloaded securely'
    )
    // Discard, the protective verb, is the filled primary and trails; Keep anyway the plain
    // secondary; neither in the danger ink (§6, §9.11). No Retry, no Resume.
    expect(buttons(row).map((b) => b.trim())).toEqual(['Keep anyway', 'Discard'])
    const [keep, discard] = [...row.querySelectorAll<HTMLButtonElement>('button')]
    expect(keep.hasAttribute('data-primary')).toBe(false)
    expect(keep.hasAttribute('data-danger')).toBe(false)
    expect(discard.hasAttribute('data-primary')).toBe(true)
    expect(discard.hasAttribute('data-danger')).toBe(false)
    act(() => keep.click())
    expect(invoke).toHaveBeenCalledWith('download.acceptDanger', { id: 'dl-1' })
    expect(keep.getAttribute('aria-busy')).toBe('true')
    expect(discard.disabled).toBe(true)
  })

  it('an insecure block of a dangerous type offers Discard alone, the danger ink, both sentences', () => {
    const row = render(
      finished({
        filename: 'setup.exe',
        state: 'insecure-blocked',
        savePath: '',
        receivedBytes: 0,
        danger: {
          level: 'dangerous',
          reason: 'executable',
          message: 'This file type can harm your device.'
        }
      })
    )
    expectStatic(row)
    expect(row.querySelector('.zen-downloads-status')?.textContent).toBe(
      'Blocked · Insecure download'
    )
    expect(row.querySelector('.zen-downloads-status')?.getAttribute('data-tone')).toBe('danger')
    expect(row.querySelector('.zen-downloads-detail')?.textContent).toBe(
      'This file can’t be downloaded securely · This file type can harm your device.'
    )
    expect(buttons(row).map((b) => b.trim())).toEqual(['Discard'])
    const [discard] = [...row.querySelectorAll<HTMLButtonElement>('button')]
    // Alone, still the filled primary – the one action the app recommends – and not danger ink.
    expect(discard.hasAttribute('data-primary')).toBe(true)
    expect(discard.hasAttribute('data-danger')).toBe(false)
    act(() => discard.click())
    expect(invoke).toHaveBeenCalledWith('download.discard', { id: 'dl-1' })
  })

  it('a row the downloader will try again itself counts down in the plain ink and keeps Resume and Cancel (HB-43)', () => {
    const row = render(
      finished({
        state: 'interrupted',
        receivedBytes: 512,
        error: 'network-disconnected',
        errorMessage: 'Check internet connection',
        canResume: true,
        autoResumeAt: NOW + 4_200
      })
    )
    expectStatic(row)
    expect(row.querySelector('.zen-downloads-status')?.textContent).toBe('Resuming in 5 s…')
    expect(row.querySelector('.zen-downloads-status')?.hasAttribute('data-tone')).toBe(false)
    expect(row.querySelector('.zen-downloads-detail')).toBeNull()
    expect(body(row).getAttribute('aria-label')).toBe('report.pdf. Resuming in 5 s…')
    expect(buttons(row)).toEqual(['Resume', 'Cancel'])
    const [resume, cancel] = [...row.querySelectorAll<HTMLButtonElement>('button')]
    act(() => resume.click())
    expect(invoke).toHaveBeenCalledWith('download.resume', { id: 'dl-1' })
    act(() => cancel.click())
    expect(invoke).toHaveBeenCalledWith('download.cancel', { id: 'dl-1' })
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
