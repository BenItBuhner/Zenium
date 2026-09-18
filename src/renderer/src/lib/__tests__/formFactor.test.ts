// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { ViewportMetrics } from '@shared/formFactor'
import type { UIState, WindowChrome } from '@shared/types'
import { formFactorFor, viewportStore } from '../formFactor'
import { browserStore } from '../ui'

function resizeTo(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  window.dispatchEvent(new Event('resize'))
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
