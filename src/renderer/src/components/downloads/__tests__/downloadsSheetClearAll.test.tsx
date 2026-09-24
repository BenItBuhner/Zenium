// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadItem, UIState } from '@shared/types'
import { downloadItem } from '@shared/__tests__/downloadFixtures'

/*
 * The phone's Downloads sheet – what `zen://downloads` opens as on a phone (`internalPages.ts`,
 * `TAB_LAYOUTS`) – and its bulk action: "Clear all" as the action row under the list in the
 * danger ink (§10.5: the list's bulk action prompts first), asking on the primitive's sheet
 * mirror (`ConfirmSheet`) with the page's words (`ClearAllConfirm`, one prompt for both
 * surfaces), the prompt stacked over the sheet in the frame's host; Cancel and Escape are the
 * prompt's and leave the list and the sheet as they were; the verb clears once the prompt has
 * gone, and the sheet stays up over the emptied list.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { DownloadsSheet } = await import('../DownloadsSheet')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore } = await import('@renderer/lib/browserStore')

const NOW = Date.now()
const done = downloadItem({
  id: 'done',
  filename: 'report.pdf',
  totalBytes: 2048,
  receivedBytes: 2048,
  startedAt: NOW - 60_000,
  completedAt: NOW - 50_000,
  endedAt: NOW - 50_000
})
const running: DownloadItem = downloadItem({
  id: 'running',
  filename: 'video.mp4',
  state: 'progressing',
  totalBytes: 10_000_000,
  receivedBytes: 2_500_000,
  bytesPerSecond: 500_000,
  etaMs: 15_000,
  startedAt: NOW - 20_000,
  completedAt: 0,
  endedAt: 0
})
const failed: DownloadItem = downloadItem({
  id: 'failed',
  filename: 'archive.zip',
  state: 'interrupted',
  receivedBytes: 512,
  error: 'network-disconnected',
  errorMessage: 'Check internet connection',
  startedAt: NOW - 120_000,
  completedAt: 0,
  endedAt: NOW - 110_000
})
const ITEMS: DownloadItem[] = [done, running, failed]

function state(items: DownloadItem[] = ITEMS): UIState {
  return {
    downloads: items,
    platform: 'android',
    shortcuts: [],
    spaces: [{ id: 'space', activeTabId: null, tabIds: [] }],
    activeSpaceId: 'space',
    tabs: {},
    overlay: { kind: 'downloads' }
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []
let windowSize: [number, number] = [0, 0]

/** The overlay beside the frame's dialog host, as the shell mounts them; the sheet portals into the host. */
async function mountSheet(s: UIState = state()): Promise<void> {
  browserStore.set({ state: s })
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () =>
    root!.render(
      createElement(
        'div',
        null,
        createElement(DownloadsSheet, { state: s }),
        createElement(FrameDialogHost, { frame: true })
      )
    )
  )
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Every `invoke` of `name`, in order. */
function calls(name: string): unknown[] {
  return invoke.mock.calls.filter((c) => c[0] === name).map((c) => c[1])
}

/** The sheets standing in the host (one on its way out is gone for the user), in stacking order. */
const standing = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-sheet[role="dialog"]')].filter(
    (d) => !d.closest('[data-leaving]') && !d.hasAttribute('data-leaving')
  )
/** The Downloads sheet itself: the one the header names. */
const downloadsSheet = (): HTMLElement | null =>
  standing().find((d) => text(d.querySelector('.zen-sheet-title')) === 'Downloads') ?? null
/** The Clear all prompt: the title-block sheet asking the question. */
const prompt = (): HTMLElement | null =>
  standing().find(
    (d) => text(d.querySelector('.zen-sheet-title-block h2')) === 'Clear all downloads?'
  ) ?? null
const labels = (el: ParentNode): string[] =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].map((b) => text(b)).filter((t) => t !== '')
const button = (el: ParentNode, label: string): HTMLButtonElement =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === label)!

/** A sheet's leave is a spring (§11.2): wait, a frame at a time, until `done`. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
  expect(done()).toBe(true)
}

beforeEach(() => {
  invoke.mockClear()
  // The window itself is a phone's, so the layout stays the phone's through the mount.
  windowSize = [window.innerWidth, window.innerHeight]
  window.innerWidth = 412
  window.innerHeight = 915
  act(() =>
    viewportStore.set({
      ...viewportStore.get(),
      formFactor: 'phone',
      width: 412,
      height: 915,
      coarse: true,
      hover: false
    })
  )
  // The sheet chassis measures its layer and its content (happy-dom lays nothing out): a layer
  // 800 tall and a sheet of 300, so a sheet has room to stand rather than landing down.
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  browserStore.set({ state: null })
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  ;[window.innerWidth, window.innerHeight] = windowSize
})

describe('the Downloads sheet’s Clear all', () => {
  it('is the action row under the list in the danger ink, and asks first on the confirmation sheet with the page’s words; Cancel leaves the list and the sheet as they were', async () => {
    await mountSheet()
    const sheet = downloadsSheet()!
    expect(sheet).not.toBeNull()
    const clear = sheet.querySelector<HTMLButtonElement>('[data-testid="downloads-clear-all"]')!
    expect(text(clear)).toBe('Clear all')
    expect(clear.classList.contains('zen-sheet-item')).toBe(true)
    expect(clear.hasAttribute('data-danger')).toBe(true)
    // Past the hairline, after the rows.
    expect(clear.closest('li')?.previousElementSibling?.classList.contains('zen-sheet-sep')).toBe(
      true
    )

    await act(async () => {
      clear.focus()
      clear.click()
    })
    // Nothing cleared yet: the prompt stands, over the sheet, in the same host.
    expect(calls('download.removeCompleted')).toEqual([])
    const p = prompt()!
    expect(p).not.toBeNull()
    expect(p).not.toBe(sheet)
    expect(downloadsSheet()).toBe(sheet)
    expect(p.closest('.zen-frame-dialogs-slot')).toBe(sheet.closest('.zen-frame-dialogs-slot'))
    expect(document.querySelector('[data-confirm="downloads:clear-all"]')).toBeNull()
    // The words are the page's: the two clearable rows counted (the running one is not touched).
    expect(text(p.querySelector('.zen-sheet-title-block p'))).toBe(
      '2 downloads will be removed from the list. The files stay where they were saved, and downloads still running are not touched.'
    )
    expect(labels(p)).toEqual(['Cancel', 'Clear all'])
    expect(button(p, 'Clear all').classList.contains('zen-settings-danger-button')).toBe(true)
    expect(p.querySelector('[data-primary]')).toBeNull()
    // The primitive's keyboard: the prompt holds the focus.
    expect(document.activeElement).toBe(p)

    await act(async () => button(p, 'Cancel').click())
    await until(() => prompt() === null)
    expect(calls('download.removeCompleted')).toEqual([])
    expect(downloadsSheet()).toBe(sheet)
    expect(sheet.querySelector('[data-testid="downloads-clear-all"]')).not.toBeNull()
  })

  it('Escape while the prompt stands is the prompt’s Cancel, not the sheet’s dismiss; the verb clears once the prompt has gone and the sheet stays', async () => {
    await mountSheet()
    const sheet = downloadsSheet()!
    const clear = sheet.querySelector<HTMLButtonElement>('[data-testid="downloads-clear-all"]')!
    await act(async () => clear.click())
    const p = prompt()!
    await act(async () => {
      p.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    await until(() => prompt() === null)
    expect(downloadsSheet()).toBe(sheet)
    expect(calls('download.removeCompleted')).toEqual([])

    await act(async () => clear.click())
    const again = prompt()!
    await act(async () => button(again, 'Clear all').click())
    await until(() => calls('download.removeCompleted').length === 1)
    await until(() => prompt() === null)
    expect(downloadsSheet()).toBe(sheet)
  })
})
