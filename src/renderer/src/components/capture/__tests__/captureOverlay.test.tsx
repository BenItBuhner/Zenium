// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CaptureTooLargeError, type PageCaptureResult, type PageViewport } from '@shared/capture'
import type { Rect, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { cmd, run } from '@renderer/lib/api'
import {
  NUDGE_AFTER_MS,
  PAINT_TIMED_OUT,
  PAINT_TIMEOUT_MS,
  TOO_LARGE_TITLE
} from '@renderer/lib/captureOverlay'
import { closeAllPopovers, FrameDialogHost } from '@renderer/lib/portals'
import { browserStore, contentAreaStore, uiStore } from '@renderer/lib/ui'
import { CaptureLayer } from '../CaptureOverlay'

/*
 * The desktop's Web capture overlay (components/capture/CaptureOverlay.tsx) in the frame dialog
 * host, over the page's stand-in: the toolbar on the dimmed page and the keyboard on the
 * overlay's container (§9.22); a drag that draws the marquee with its size and, on the release,
 * asks the engine for that box of the page's document (capture-02); the result card with Copy
 * and Save (capture-21), Copy through the engine's clipboard (capture-10) and Save through its
 * downloads, each saying so on a toast; the engine's refusal on the failed card in its own words;
 * the visible-area fallback named on the card; Escape from every phase closing cleanly with the
 * page given back (capture-16); the overlay following its tab off the screen; and the paint's
 * nudge and patience while the engine is out.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AREA: Rect = { x: 0, y: 48, width: 1200, height: 800 }
const VIEWPORT: PageViewport = {
  scrollX: 0,
  scrollY: 600,
  width: 1200,
  height: 800,
  zoom: 1,
  devicePixelRatio: 1,
  documentWidth: 1200,
  documentHeight: 3000
}
const RESULT: PageCaptureResult = {
  dataUrl: 'data:image/png;base64,AAAA',
  width: 400,
  height: 300,
  devicePixelRatio: 1
}

/** The window's state with `activeTabId` in front (what the back stack and the overlay read of it). */
function stateWith(activeTabId = 't1'): UIState {
  return {
    platform: 'linux',
    capabilities: { windows: true },
    window: { kind: 'synced', fullscreen: false, htmlFullscreenTabId: null },
    tabs: {
      t1: { id: 't1', url: 'https://example.test/', title: 'Example' },
      t2: { id: 't2', url: 'https://docs.example/', title: 'Docs' }
    },
    spaces: [
      { id: 'space', name: 'Home', tabIds: ['t1', 't2'], activeTabId, pinnedCollapsed: false }
    ],
    activeSpaceId: 'space',
    folders: {},
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    glance: null
  } as unknown as UIState
}

const invoke = vi.fn<(name: string, args: unknown) => Promise<unknown>>()
let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

function layer(): ReactElement {
  return (
    <FrameDialogHost frame>
      <CaptureLayer />
    </FrameDialogHost>
  )
}

/** The overlay up for `t1` with the page's geometry, as `openCapture` leaves it. */
function open(viewport: PageViewport | null = VIEWPORT): HTMLElement {
  browserStore.set({ state: stateWith() })
  contentAreaStore.set({ area: AREA })
  uiStore.set({ capture: { tabId: 't1', viewport, seq: 1 } })
  return render(layer())
}

function overlay(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>('[data-capture]')
}

function click(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function keydown(target: Element | null, key: string): void {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

function pointer(target: Element, type: string, x: number, y: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1
      })
    )
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** The engine's answer to `page.capture`, and nothing for the nudge's stand-in. */
function engine(answer: () => Promise<PageCaptureResult | null>): void {
  invoke.mockImplementation((name) => {
    if (name === 'page.capture') return answer()
    return Promise.resolve(null)
  })
}

beforeEach(() => {
  invoke.mockReset()
  engine(async () => RESULT)
  vi.stubGlobal('zen', { invoke })
  vi.mocked(cmd).mockReset()
  vi.mocked(cmd).mockImplementation(async () => null)
  vi.mocked(run).mockReset()
  uiStore.set({ capture: null, snapshot: null, snapshotTabId: null })
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  uiStore.set({ capture: null, snapshot: null, snapshotTabId: null })
  browserStore.set({ state: null })
  contentAreaStore.set({ area: null })
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('the dimmed page (capture-02)', () => {
  it('is a modal dialog over the frame with the §9.5 scrim, the toolbar’s three ways and Cancel, and the keyboard on its container', () => {
    const el = open()
    const dialog = overlay(el)!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Web capture')
    expect(dialog.dataset.capture).toBe('selecting')
    expect(dialog.dataset.selecting).toBe('true')
    expect(el.querySelector('.zen-capture-scrim')).not.toBeNull()
    const toolbar = el.querySelector<HTMLElement>('[data-capture-toolbar]')!
    expect(toolbar.getAttribute('role')).toBe('toolbar')
    expect(toolbar.querySelector('[data-capture-free]')?.getAttribute('aria-pressed')).toBe('true')
    expect(toolbar.querySelector('[data-capture-visible]')?.textContent).toBe('Visible area')
    expect(toolbar.querySelector('[data-capture-full]')?.textContent).toBe('Full page')
    expect(toolbar.querySelector('[data-capture-cancel]')).not.toBeNull()
    expect(document.activeElement).toBe(dialog)
    // Nothing is asked of the engine until a way is picked.
    expect(invoke).not.toHaveBeenCalled()
  })

  it('the toolbar sits at the top centre of the page’s frame, 12 px in, its left a whole pixel (§9.16)', () => {
    // The toolbar's width is the font's, fractional: 273.7 here. Its left is the centre less
    // half of that, rounded – not a translate that would rest the box on the fraction.
    const computed = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((node, pseudo) =>
      node instanceof HTMLElement && node.hasAttribute('data-capture-toolbar')
        ? ({ width: '273.7px' } as CSSStyleDeclaration)
        : computed(node, pseudo)
    )
    const el = open()
    const toolbar = el.querySelector<HTMLElement>('[data-capture-toolbar]')!
    expect(toolbar.style.left).toBe(`${Math.round(AREA.x + AREA.width / 2 - 273.7 / 2)}px`)
    expect(toolbar.style.left).toBe('463px')
    expect(toolbar.style.top).toBe(`${AREA.y + 12}px`)
    expect(toolbar.style.translate).toBe('')
  })

  it('a page whose geometry the host could not give has Free select off and only the visible area and the full page to offer', () => {
    const el = open(null)
    const free = el.querySelector<HTMLButtonElement>('[data-capture-free]')!
    expect(free.disabled).toBe(true)
    expect(free.getAttribute('aria-pressed')).toBe('false')
    expect(overlay(el)!.dataset.selecting).toBeUndefined()
    // A drag draws nothing.
    const dialog = overlay(el)!
    pointer(dialog, 'pointerdown', 100, 200)
    pointer(dialog, 'pointermove', 500, 500)
    expect(el.querySelector('[data-capture-marquee]')).toBeNull()
  })

  it('a drag draws the marquee, cut out of the scrim, with the picture’s size at its corner', () => {
    const el = open()
    const dialog = overlay(el)!
    pointer(dialog, 'pointerdown', 100, 200)
    pointer(dialog, 'pointermove', 500, 500)
    const marquee = el.querySelector<HTMLElement>('[data-capture-marquee]')!
    expect(marquee.style.left).toBe('100px')
    expect(marquee.style.top).toBe('200px')
    expect(marquee.style.width).toBe('400px')
    expect(marquee.style.height).toBe('300px')
    expect(el.querySelector('[data-capture-size]')?.textContent).toBe('400 × 300')
    const scrim = el.querySelector<HTMLElement>('.zen-capture-scrim')!
    expect(scrim.style.clipPath).toContain('evenodd')
    expect(scrim.style.clipPath).toContain('100px 200px')
    expect(scrim.style.clipPath).toContain('500px 500px')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('the release asks the engine for the marquee’s box of the page’s document – scrolled, below the fold – and the answer is the result card', async () => {
    const el = open()
    const dialog = overlay(el)!
    pointer(dialog, 'pointerdown', 100, 200)
    pointer(dialog, 'pointermove', 500, 500)
    pointer(dialog, 'pointerup', 500, 500)
    expect(dialog.dataset.capture).toBe('capturing')
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    // The marquee, at (100, 200) in the overlay, is (100, 152) in the page's frame (the frame
    // starts 48 down); the page is scrolled 600: the document's y is 752.
    expect(invoke).toHaveBeenCalledWith('page.capture', {
      tabId: 't1',
      mode: 'region',
      region: { x: 100, y: 752, width: 400, height: 300 },
      format: 'png'
    })
    // The toolbar is gone while the engine paints; the marquee stays as the frame of what is coming.
    expect(el.querySelector('[data-capture-toolbar]')).toBeNull()
    expect(el.querySelector('[data-capture-marquee]')).not.toBeNull()
    await settle()
    expect(dialog.dataset.capture).toBe('captured')
    expect(el.querySelector('[data-capture-result="ok"]')).not.toBeNull()
  })

  it('a press without a drag captures nothing and leaves the page dimmed for another go', () => {
    const el = open()
    const dialog = overlay(el)!
    pointer(dialog, 'pointerdown', 100, 200)
    pointer(dialog, 'pointerup', 100, 200)
    expect(dialog.dataset.capture).toBe('selecting')
    expect(invoke).not.toHaveBeenCalled()
    expect(el.querySelector('[data-capture-toolbar]')).not.toBeNull()
  })

  it('a press on the toolbar draws nothing: Visible area captures at once, with no region', async () => {
    const el = open()
    const visible = el.querySelector<HTMLElement>('[data-capture-visible]')!
    pointer(visible, 'pointerdown', 600, 70)
    expect(el.querySelector('[data-capture-marquee]')).toBeNull()
    click(visible)
    expect(invoke).toHaveBeenCalledWith('page.capture', {
      tabId: 't1',
      mode: 'viewport',
      format: 'png'
    })
    await settle()
    expect(el.querySelector('[data-capture-result="ok"]')).not.toBeNull()
  })

  it('Full page captures at once too', async () => {
    const el = open()
    click(el.querySelector('[data-capture-full]'))
    expect(invoke).toHaveBeenCalledWith('page.capture', {
      tabId: 't1',
      mode: 'fullPage',
      format: 'png'
    })
  })

  it('the toolbar’s Cancel closes: the flag clears, the picture goes, the page has the keyboard back', () => {
    const el = open()
    click(el.querySelector('[data-capture-cancel]'))
    expect(uiStore.get().capture).toBeNull()
    expect(overlay(el)).toBeNull()
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })
})

describe('the result card (capture-21)', () => {
  async function captured(result: PageCaptureResult = RESULT): Promise<HTMLElement> {
    engine(async () => result)
    const el = open()
    click(el.querySelector('[data-capture-visible]'))
    await settle()
    return el
  }

  it('is a §9.20 dialog at 400 over the page, titled with the picture’s size, the picture on it, and Close, Copy, Save (the primary) in its footer; the keyboard lands on it', async () => {
    const el = await captured()
    const card = el.querySelector<HTMLElement>('[data-capture-result]')!
    expect(card.dataset.captureResult).toBe('ok')
    expect(card.style.width).toBe('400px')
    // §9.22's container that holds the keyboard: a dialog at tabindex −1 (the chassis paints no
    // ring around one), not a group (which it would ring whole).
    expect(card.getAttribute('role')).toBe('dialog')
    expect(card.getAttribute('aria-modal')).toBe('true')
    expect(card.tabIndex).toBe(-1)
    expect(card.querySelector('#zen-capture-title')?.textContent).toBe('Web capture')
    expect(card.querySelector('#zen-capture-description')?.textContent).toBe('400 × 300 pixels')
    const img = card.querySelector<HTMLImageElement>('img')!
    expect(img.getAttribute('src')).toBe(RESULT.dataUrl)
    // 400 × 300 CSS px, fitted to the card's 364 column: the 400 less the card's hairline, the
    // 16 gutters and the picture box's own hairline, so the box fits the column border-box and
    // the picture fills it with no band of the fill inside the hairline.
    expect(img.getAttribute('width')).toBe('364')
    expect(img.getAttribute('height')).toBe('273')
    const box = card.querySelector<HTMLElement>('.zen-capture-picture-box')!
    expect(box.style.width).toBe('364px')
    expect(box.style.height).toBe('273px')
    const buttons = [...card.querySelectorAll<HTMLButtonElement>('button')].map(
      (b) => b.textContent
    )
    expect(buttons).toEqual(['Close', 'Copy', 'Save'])
    expect(card.querySelector('[data-capture-save]')?.hasAttribute('data-primary')).toBe(true)
    expect(document.activeElement).toBe(card)
    // No fallback: nothing said of the visible area.
    expect(card.textContent).not.toContain('Visible area captured')
  })

  it('a small picture is shown at its CSS size, never scaled up; a DPR 2 one at half its device pixels', async () => {
    let el = await captured({ ...RESULT, width: 200, height: 120 })
    let img = el.querySelector<HTMLImageElement>('[data-capture-result] img')!
    expect(img.getAttribute('width')).toBe('200')
    expect(img.getAttribute('height')).toBe('120')

    act(() => root?.unmount())
    root = null
    mount?.remove()
    el = await captured({ ...RESULT, width: 1600, height: 600, devicePixelRatio: 2 })
    img = el.querySelector<HTMLImageElement>('[data-capture-result] img')!
    // 800 × 300 CSS, fitted to the card's 364 column: 364 × 137.
    expect(img.getAttribute('width')).toBe('364')
    expect(img.getAttribute('height')).toBe('137')
    expect(el.querySelector('#zen-capture-description')?.textContent).toBe('1,600 × 600 pixels')
  })

  it('Copy hands the picture to the engine’s clipboard and says so on a toast; the card stays up (capture-10)', async () => {
    vi.mocked(cmd).mockImplementation(async (name: string) =>
      name === 'capture.copy' ? true : null
    )
    const el = await captured()
    click(el.querySelector('[data-capture-copy]'))
    await settle()
    expect(cmd).toHaveBeenCalledWith('capture.copy', { dataUrl: RESULT.dataUrl })
    const toast = el.querySelector<HTMLElement>('[data-capture-toast]')!
    expect(toast.textContent).toBe('Copied')
    expect(toast.dataset.kind).toBe('info')
    expect(toast.dataset.surface).toBe('page')
    expect(toast.getAttribute('role')).toBe('status')
    expect(el.querySelector('[data-capture-result]')).not.toBeNull()
    expect(uiStore.get().capture).not.toBeNull()
  })

  it('a clipboard that would not take it is an error toast', async () => {
    vi.mocked(cmd).mockImplementation(async () => false)
    const el = await captured()
    click(el.querySelector('[data-capture-copy]'))
    await settle()
    const toast = el.querySelector<HTMLElement>('[data-capture-toast]')!
    expect(toast.textContent).toBe('Couldn’t copy the picture')
    expect(toast.dataset.kind).toBe('error')
  })

  it('Save hands the picture to the engine’s downloads and names the file on the toast', async () => {
    vi.mocked(cmd).mockImplementation(async (name: string) =>
      name === 'capture.save'
        ? { path: '/home/b/Downloads/Screenshot 2026-09-23 at 14.05.09.png' }
        : null
    )
    const el = await captured()
    click(el.querySelector('[data-capture-save]'))
    await settle()
    expect(cmd).toHaveBeenCalledWith('capture.save', { dataUrl: RESULT.dataUrl, tabId: 't1' })
    expect(el.querySelector('[data-capture-toast]')?.textContent).toBe(
      'Saved Screenshot 2026-09-23 at 14.05.09.png'
    )
    expect(el.querySelector('[data-capture-result]')).not.toBeNull()
  })

  it('a save the engine could not make is an error toast', async () => {
    vi.mocked(cmd).mockImplementation(async () => null)
    const el = await captured()
    click(el.querySelector('[data-capture-save]'))
    await settle()
    expect(el.querySelector('[data-capture-toast]')?.textContent).toBe('Couldn’t save the picture')
  })

  it('the visible-area fallback is named on the card, in the warn ink', async () => {
    const el = await captured({ ...RESULT, fallback: 'viewport' })
    const card = el.querySelector<HTMLElement>('[data-capture-result]')!
    expect(card.dataset.captureResult).toBe('viewport')
    const note = card.querySelector<HTMLElement>('.zen-capture-note')!
    expect(note.textContent).toContain('Visible area captured')
    expect(note.textContent).toContain(
      'The page couldn’t be captured whole, so this is what was on screen.'
    )
    expect(note.dataset.tone).toBe('warn')
  })

  it('Close takes the overlay down; a press on the scrim with the card up is Close too', async () => {
    let el = await captured()
    click(el.querySelector('[data-capture-close]'))
    expect(uiStore.get().capture).toBeNull()
    expect(overlay(el)).toBeNull()

    act(() => root?.unmount())
    root = null
    mount?.remove()
    el = await captured()
    pointer(el.querySelector('.zen-capture-scrim')!, 'pointerdown', 20, 700)
    expect(uiStore.get().capture).toBeNull()
  })

  it('a press on the scrim while the page is dimmed is the start of a drag, not a close', () => {
    const el = open()
    pointer(el.querySelector('.zen-capture-scrim')!, 'pointerdown', 20, 700)
    expect(uiStore.get().capture).not.toBeNull()
    expect(overlay(el)!.dataset.capture).toBe('selecting')
  })
})

describe('the failed card', () => {
  it('shows the engine’s budget refusal in its own words, and "Select again" is the dimmed page once more', async () => {
    const refusal = new CaptureTooLargeError(50_000_000, { width: 10000, height: 5000 })
    engine(() => Promise.reject(refusal))
    const el = open()
    const dialog = overlay(el)!
    pointer(dialog, 'pointerdown', 100, 200)
    pointer(dialog, 'pointermove', 500, 500)
    pointer(dialog, 'pointerup', 500, 500)
    await settle()
    const card = el.querySelector<HTMLElement>('[data-capture-failed]')!
    expect(card.style.width).toBe('320px')
    expect(card.getAttribute('role')).toBe('dialog')
    expect(card.getAttribute('aria-modal')).toBe('true')
    expect(card.tabIndex).toBe(-1)
    expect(card.querySelector('#zen-capture-title')?.textContent).toBe(TOO_LARGE_TITLE)
    expect(card.querySelector('#zen-capture-description')?.textContent).toBe(refusal.message)
    expect(document.activeElement).toBe(card)
    const again = card.querySelector<HTMLButtonElement>('[data-capture-again]')!
    expect(again.textContent).toBe('Select again')
    click(again)
    expect(dialog.dataset.capture).toBe('selecting')
    expect(el.querySelector('[data-capture-toolbar]')).not.toBeNull()
    expect(document.activeElement).toBe(dialog)
  })

  it('the bridge’s rejection is read through to the refusal too, and a picked mode offers "Try again"', async () => {
    engine(() =>
      Promise.reject(
        new Error(
          "Error invoking remote method 'page.capture': CaptureTooLarge: The capture would be 10,000 × 5,000 pixels, more than the 36 megapixels a capture can hold. Zoom out or select a smaller area."
        )
      )
    )
    const el = open()
    click(el.querySelector('[data-capture-full]'))
    await settle()
    const card = el.querySelector<HTMLElement>('[data-capture-failed]')!
    expect(card.querySelector('#zen-capture-title')?.textContent).toBe(TOO_LARGE_TITLE)
    expect(card.querySelector('#zen-capture-description')?.textContent).toBe(
      'The capture would be 10,000 × 5,000 pixels, more than the 36 megapixels a capture can hold. Zoom out or select a smaller area.'
    )
    expect(card.querySelector('[data-capture-again]')?.textContent).toBe('Try again')
  })

  it('a page that gave no picture is "Nothing to capture"', async () => {
    engine(async () => null)
    const el = open()
    click(el.querySelector('[data-capture-visible]'))
    await settle()
    expect(el.querySelector('#zen-capture-title')?.textContent).toBe('Nothing to capture')
  })
})

describe('the paint’s nudge and patience', () => {
  it('while the engine is out the page’s stand-in is asked afresh from 60 ms on; the answer stops it', async () => {
    vi.useFakeTimers()
    let answer: (r: PageCaptureResult) => void = () => undefined
    engine(() => new Promise<PageCaptureResult>((resolve) => (answer = resolve)))
    const el = open()
    click(el.querySelector('[data-capture-visible]'))
    expect(invoke).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(NUDGE_AFTER_MS))
    expect(invoke).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1', fresh: true })
    await act(async () => {
      answer(RESULT)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(el.querySelector('[data-capture-result]')).not.toBeNull()
    const nudges = invoke.mock.calls.filter(([name]) => name === 'overlay.snapshot').length
    act(() => vi.advanceTimersByTime(2000))
    expect(invoke.mock.calls.filter(([name]) => name === 'overlay.snapshot').length).toBe(nudges)
  })

  it('a paint that never comes is the failed card after 15 s, in the overlay’s words', async () => {
    vi.useFakeTimers()
    engine(() => new Promise<PageCaptureResult>(() => undefined))
    const el = open()
    click(el.querySelector('[data-capture-full]'))
    act(() => vi.advanceTimersByTime(PAINT_TIMEOUT_MS - 1))
    expect(el.querySelector('[data-capture-failed]')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    const card = el.querySelector<HTMLElement>('[data-capture-failed]')!
    expect(card.querySelector('#zen-capture-title')?.textContent).toBe(PAINT_TIMED_OUT.title)
    expect(card.querySelector('#zen-capture-description')?.textContent).toBe(
      PAINT_TIMED_OUT.message
    )
    // The nudges stopped with the wait.
    const nudges = invoke.mock.calls.filter(([name]) => name === 'overlay.snapshot').length
    act(() => vi.advanceTimersByTime(2000))
    expect(invoke.mock.calls.filter(([name]) => name === 'overlay.snapshot').length).toBe(nudges)
  })
})

describe('Escape closes cleanly from every phase (capture-16)', () => {
  const closedCleanly = (el: HTMLElement): void => {
    expect(uiStore.get().capture).toBeNull()
    expect(overlay(el)).toBeNull()
    expect(el.querySelector('[data-capture-toast]')).toBeNull()
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  }

  it('from the dimmed page', () => {
    const el = open()
    keydown(overlay(el), 'Escape')
    closedCleanly(el)
  })

  it('mid-drag', () => {
    const el = open()
    const dialog = overlay(el)!
    pointer(dialog, 'pointerdown', 100, 200)
    pointer(dialog, 'pointermove', 300, 400)
    keydown(dialog, 'Escape')
    closedCleanly(el)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('while the engine paints: a late answer changes nothing', async () => {
    let answer: (r: PageCaptureResult) => void = () => undefined
    engine(() => new Promise<PageCaptureResult>((resolve) => (answer = resolve)))
    const el = open()
    click(el.querySelector('[data-capture-visible]'))
    keydown(overlay(el), 'Escape')
    closedCleanly(el)
    await act(async () => {
      answer(RESULT)
      await Promise.resolve()
    })
    expect(overlay(el)).toBeNull()
    expect(uiStore.get().capture).toBeNull()
  })

  it('with the result card up', async () => {
    const el = open()
    click(el.querySelector('[data-capture-visible]'))
    await settle()
    keydown(el.querySelector('[data-capture-result]'), 'Escape')
    closedCleanly(el)
  })

  it('with the failed card up', async () => {
    engine(() => Promise.reject(new Error('boom')))
    const el = open()
    click(el.querySelector('[data-capture-visible]'))
    await settle()
    expect(el.querySelector('[data-capture-failed]')).not.toBeNull()
    keydown(el.querySelector('[data-capture-failed]'), 'Escape')
    closedCleanly(el)
  })
})

describe('the overlay is its tab’s', () => {
  it('another tab in front takes it down', () => {
    const el = open()
    act(() => browserStore.set({ state: stateWith('t2') }))
    expect(uiStore.get().capture).toBeNull()
    expect(overlay(el)).toBeNull()
  })

  it('the layer shows nothing without the flag', () => {
    browserStore.set({ state: stateWith() })
    const el = render(layer())
    expect(overlay(el)).toBeNull()
  })
})
