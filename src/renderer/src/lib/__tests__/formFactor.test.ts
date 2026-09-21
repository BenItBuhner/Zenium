// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ViewportMetrics } from '@shared/formFactor'
import type { UIState, WindowChrome } from '@shared/types'
import { forcedFormFactor, formFactorFor, viewportStore } from '../formFactor'
import { browserStore } from '../ui'

function resizeTo(width: number, height = window.innerHeight): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', {
    value: height,
    configurable: true,
    writable: true
  })
  window.dispatchEvent(new Event('resize'))
}

/**
 * The window's pointer, as the media features report it: a finger (`pointer: coarse`, no hover)
 * or a mouse. The store re-reads them on every resize.
 */
function pointer(kind: 'finger' | 'mouse'): void {
  const matches = (query: string): boolean =>
    kind === 'finger' ? query === '(pointer: coarse)' : query === '(hover: hover)'
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: matches(query),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      }) as unknown as MediaQueryList
  )
}

/** Only the window's chrome kind matters here; the rest of the snapshot is not read. */
function snapshotWith(chrome: WindowChrome): UIState {
  return { window: { chrome } } as unknown as UIState
}

/** A windowed desktop (mouse) or a handheld touch screen (finger, no hover) of the given width. */
function mouse(width: number): ViewportMetrics {
  return { width, height: 800, coarse: false, hover: true }
}
function finger(width: number): ViewportMetrics {
  return { width, height: 800, coarse: true, hover: false }
}

describe('formFactorFor', () => {
  it('narrow windows take the phone layout', () => {
    expect(formFactorFor(mouse(599), 'full')).toBe('phone')
    expect(formFactorFor(finger(599), 'full')).toBe('phone')
    expect(formFactorFor(mouse(599), null)).toBe('phone')
  })

  it('wide windows split on the pointer', () => {
    expect(formFactorFor(mouse(600), 'full')).toBe('desktop')
    expect(formFactorFor(finger(600), 'full')).toBe('tablet')
    expect(formFactorFor(mouse(1600), 'full')).toBe('desktop')
  })

  it('a toolbar-only popup window keeps the desktop layout at any width', () => {
    expect(formFactorFor(mouse(500), 'popup')).toBe('desktop')
    expect(formFactorFor(mouse(320), 'popup')).toBe('desktop')
    expect(formFactorFor(finger(320), 'popup')).toBe('tablet')
  })
})

describe('viewportStore', () => {
  afterEach(() => {
    browserStore.set({ state: null })
    resizeTo(1024)
  })

  it('re-derives the layout from the window snapshot', () => {
    resizeTo(500)
    expect(viewportStore.get().formFactor).toBe('phone')

    browserStore.set({ state: snapshotWith('popup') })
    expect(viewportStore.get().formFactor).toBe('desktop')
    expect(document.documentElement.dataset.formFactor).toBe('desktop')

    browserStore.set({ state: snapshotWith('full') })
    expect(viewportStore.get().formFactor).toBe('phone')
    expect(document.documentElement.dataset.formFactor).toBe('phone')
  })

  it('a popup window stays desktop across resizes', () => {
    browserStore.set({ state: snapshotWith('popup') })
    resizeTo(400)
    expect(viewportStore.get().formFactor).toBe('desktop')
    resizeTo(1200)
    expect(viewportStore.get().formFactor).toBe('desktop')
  })
})

/*
 * TABLET-01: the class follows the window live. A tablet's window dragged narrower in split
 * screen drops to the phone chrome at the 600 dp line and comes back when widened; the short
 * side decides for a finger (`sw600dp`), so turning the device never changes the class.
 */
describe('viewportStore on a touch screen', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    browserStore.set({ state: null })
    resizeTo(1024, 800)
  })

  it('a 10-inch tablet is a tablet in both orientations', () => {
    pointer('finger')
    browserStore.set({ state: snapshotWith('full') })
    resizeTo(1280, 800)
    expect(viewportStore.get()).toMatchObject({
      formFactor: 'tablet',
      width: 1280,
      height: 800,
      coarse: true,
      hover: false
    })
    expect(document.documentElement.dataset.formFactor).toBe('tablet')
    expect(document.documentElement.dataset.pointer).toBe('coarse')
    resizeTo(800, 1280)
    expect(viewportStore.get().formFactor).toBe('tablet')
  })

  it('split screen: the window drops to the phone chrome under 600 and comes back over it', () => {
    pointer('finger')
    browserStore.set({ state: snapshotWith('full') })
    resizeTo(1280, 800)
    expect(viewportStore.get().formFactor).toBe('tablet')
    // Half of a landscape 10-inch tablet: 640 wide on an 800 short side – still a tablet.
    resizeTo(640, 800)
    expect(viewportStore.get().formFactor).toBe('tablet')
    // A 600 wide half of a portrait 1200 screen sits on the line: a tablet, as Android says.
    resizeTo(600, 1280)
    expect(viewportStore.get().formFactor).toBe('tablet')
    // Dragged one px narrower: the phone chrome, live.
    resizeTo(599, 1280)
    expect(viewportStore.get().formFactor).toBe('phone')
    expect(document.documentElement.dataset.formFactor).toBe('phone')
    // A third of the screen: still the phone.
    resizeTo(420, 1280)
    expect(viewportStore.get().formFactor).toBe('phone')
    // Widened back past the line: the tablet chrome again.
    resizeTo(720, 1280)
    expect(viewportStore.get().formFactor).toBe('tablet')
    expect(document.documentElement.dataset.formFactor).toBe('tablet')
  })

  it('a landscape phone stays a phone: the short side decides for a finger', () => {
    pointer('finger')
    browserStore.set({ state: snapshotWith('full') })
    resizeTo(915, 412)
    expect(viewportStore.get().formFactor).toBe('phone')
    resizeTo(412, 915)
    expect(viewportStore.get().formFactor).toBe('phone')
  })

  it('a mouse arriving on the same window (DeX) gives the desktop layout', () => {
    pointer('finger')
    browserStore.set({ state: snapshotWith('full') })
    resizeTo(1280, 800)
    expect(viewportStore.get().formFactor).toBe('tablet')
    pointer('mouse')
    resizeTo(1280, 800)
    expect(viewportStore.get()).toMatchObject({ formFactor: 'desktop', coarse: false, hover: true })
    expect(document.documentElement.dataset.hover).toBe('hover')
  })

  it('does not publish a new snapshot when nothing about the window changed', () => {
    pointer('finger')
    browserStore.set({ state: snapshotWith('full') })
    resizeTo(1280, 800)
    const before = viewportStore.get()
    resizeTo(1280, 800)
    expect(viewportStore.get()).toBe(before)
  })
})

describe('forcedFormFactor', () => {
  it('reads the preview host override and nothing else', () => {
    expect(forcedFormFactor('?formFactor=tablet')).toBe('tablet')
    expect(forcedFormFactor('?formFactor=phone&platform=android')).toBe('phone')
    expect(forcedFormFactor('?formFactor=desktop')).toBe('desktop')
    expect(forcedFormFactor('?formFactor=watch')).toBeNull()
    expect(forcedFormFactor('?surface=autofill')).toBeNull()
    expect(forcedFormFactor('')).toBeNull()
    expect(forcedFormFactor(null)).toBeNull()
  })
})
