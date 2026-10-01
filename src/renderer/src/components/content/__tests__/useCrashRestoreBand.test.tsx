// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CrashRestoreOffer, UIState } from '@shared/types'
import { BAND_HEIGHT_TWO_LINE } from '@renderer/lib/motion/band'
import type { BandHost } from '../../band/PageEdgeBand'

/*
 * "Restore pages?" as the page-edge band's crash-restore tenant (motion spec §3.4; the Design
 * Lead's ruling on item 8, W8-M3 – the strip across the frame's top before it): a state about
 * the browser in the warn ink, the strip's words on the band's two lines, Restore loading the
 * pages and the × starting fresh, each answering the core as the strip's buttons did; the band's
 * own put-aways answer as the × does, since the session holds its pages for the answer.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: vi.fn(),
  onEvent: () => () => undefined
}))

const { PageEdgeBand } = await import('../../band/PageEdgeBand')
const { useCrashRestoreBand, crashRestoreQuestion } = await import('../useCrashRestoreBand')
const { bandStore, chooseBand, dismissBandByKey, resetBands, setBandFrame } =
  await import('@renderer/lib/band')

function state(crashRestore: CrashRestoreOffer | null): UIState {
  return { crashRestore } as unknown as UIState
}

/** The page under the band stands still here: the seam is the host's business (PageBandHost's tests). */
const HOST: BandHost = { translate: () => undefined, rest: () => undefined }

function Band({ state }: { state: UIState }): JSX.Element {
  useCrashRestoreBand(state)
  return <PageEdgeBand host={HOST} />
}

let container: HTMLDivElement
let root: Root

function render(s: UIState): void {
  act(() => root.render(<Band state={s} />))
}

const band = (): HTMLElement | null => container.querySelector<HTMLElement>('.zen-band')
const content = (): HTMLElement =>
  band()!.querySelector<HTMLElement>('.zen-band-content:not([data-leaving])')!
const restoreButton = (): HTMLButtonElement =>
  content().querySelector<HTMLButtonElement>('.zen-band-button')!
const dismissButton = (): HTMLButtonElement =>
  content().querySelector<HTMLButtonElement>('.zen-band-close')!
/** What the tenant answered the core. */
const answers = (): unknown[][] => run.mock.calls.filter(([c]) => c === 'session.crashRestore')
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  run.mockClear()
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  resetBands()
  setBandFrame({ front: 't1', ok: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetBands()
  vi.unstubAllGlobals()
})

describe('the crash-restore band (the strip above the frame until W8-M3)', () => {
  it('stands on the offer as a two-line state about the browser in the warn ink: the question for the title, the fault for the detail, Restore and the ×', () => {
    render(state({ tabCount: 3, windowCount: 2 }))
    const el = band()!
    expect(el).not.toBeNull()
    expect(chooseBand(bandStore.get())!.key).toBe('crash-restore')
    // About the window, not a tab: it stands on every page tab of the window.
    expect(chooseBand(bandStore.get())!.tabId).toBeNull()
    expect(el.getAttribute('role')).toBe('status')
    expect(el.dataset.surface).toBe('page')
    expect(el.dataset.key).toBe('crash-restore')
    expect(el.dataset.form).toBe('state')
    expect(el.dataset.tone).toBe('warn')
    expect(el.querySelector('.zen-band-glyph')).not.toBeNull()
    expect(el.querySelector('.zen-band-title')!.textContent).toBe('Restore 3 pages in 2 windows?')
    expect(el.querySelector('.zen-band-detail')!.textContent).toBe(
      'Zenium did not shut down correctly.'
    )
    expect(el.style.getPropertyValue('--zen-band-height')).toBe(`${BAND_HEIGHT_TWO_LINE}px`)
    expect([...el.querySelectorAll('button')]).toHaveLength(2)
    expect(restoreButton().textContent).toBe('Restore')
    expect(dismissButton().getAttribute('aria-label')).toBe('Dismiss')
    // Nothing of the strip remains.
    expect(container.querySelector('.zen-frame-strip')).toBeNull()
    expect(container.querySelector('[data-crash-restore]')).toBeNull()
    expect(answers()).toEqual([])
  })

  it('counts as the strip did: one page in the singular, the window unsaid when there is one', () => {
    expect(crashRestoreQuestion({ tabCount: 1, windowCount: 1 })).toBe('Restore 1 page?')
    expect(crashRestoreQuestion({ tabCount: 2, windowCount: 1 })).toBe('Restore 2 pages?')
    expect(crashRestoreQuestion({ tabCount: 1, windowCount: 2 })).toBe(
      'Restore 1 page in 2 windows?'
    )
    render(state({ tabCount: 1, windowCount: 1 }))
    expect(band()!.querySelector('.zen-band-title')!.textContent).toBe('Restore 1 page?')
  })

  it('Restore loads the pages that were showing – the strip’s Restore – and the band leaves with the act', () => {
    render(state({ tabCount: 2, windowCount: 1 }))
    click(restoreButton())
    expect(answers()).toEqual([['session.crashRestore', { restore: true }]])
    expect(chooseBand(bandStore.get())).toBeNull()
  })

  it('the × starts fresh – the strip’s Dismiss – and nothing else is written', () => {
    render(state({ tabCount: 2, windowCount: 1 }))
    click(dismissButton())
    expect(answers()).toEqual([['session.crashRestore', { restore: false }]])
    expect(run).toHaveBeenCalledTimes(1)
    expect(chooseBand(bandStore.get())).toBeNull()
  })

  it('the band’s own put-aways – a swipe, Escape, Android’s Back – answer as the × does: the session holds its pages for an answer, and a band gone unanswered would leave the frame empty and held', () => {
    for (const reason of ['swipe', 'escape', 'back'] as const) {
      run.mockClear()
      resetBands()
      setBandFrame({ front: 't1', ok: true })
      act(() => root.render(null))
      render(state({ tabCount: 2, windowCount: 1 }))
      act(() => dismissBandByKey('crash-restore', reason))
      expect(answers(), reason).toEqual([['session.crashRestore', { restore: false }]])
    }
    // Escape as the keyboard reaches it – with focus in the band: the same answer.
    run.mockClear()
    resetBands()
    setBandFrame({ front: 't1', ok: true })
    act(() => root.render(null))
    render(state({ tabCount: 2, windowCount: 1 }))
    act(() => {
      const close = dismissButton()
      close.focus()
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(answers()).toEqual([['session.crashRestore', { restore: false }]])
  })

  it('the band going for any other reason – the offer answered elsewhere, the window closing – answers nothing: the state stands for the next window', () => {
    render(state({ tabCount: 2, windowCount: 1 }))
    // Answered in another window: the core's offer clears and the band goes with it.
    render(state(null))
    expect(chooseBand(bandStore.get())).toBeNull()
    expect(answers()).toEqual([])
    // The host unmounting with the offer still open (the window closing).
    render(state({ tabCount: 2, windowCount: 1 }))
    expect(chooseBand(bandStore.get())!.key).toBe('crash-restore')
    act(() => root.render(null))
    expect(chooseBand(bandStore.get())).toBeNull()
    expect(answers()).toEqual([])
  })

  it('follows the offer’s counts, not the state object: a new commit with the same counts leaves the band standing, a new count re-words it', () => {
    render(state({ tabCount: 2, windowCount: 1 }))
    const first = chooseBand(bandStore.get())!
    render(state({ tabCount: 2, windowCount: 1 }))
    expect(chooseBand(bandStore.get())!.id).toBe(first.id)
    render(state({ tabCount: 3, windowCount: 1 }))
    expect(chooseBand(bandStore.get())!.id).not.toBe(first.id)
    expect(
      band()!.querySelector('.zen-band-content:not([data-leaving]) .zen-band-title')!.textContent
    ).toBe('Restore 3 pages?')
    expect(answers()).toEqual([])
  })
})
