// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
import { hoverAttribute, viewportStore } from '../formFactor'
import { hoverOf, notePointer, onLivePointerChange, resetLivePointer } from '../livePointer'
import { browserStore } from '../ui'

function resizeTo(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', {
    value: height,
    configurable: true,
    writable: true
  })
  window.dispatchEvent(new Event('resize'))
}

/** The media features' primary pointer: a finger (coarse, no hover) or a mouse. */
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

/** A pointer event as the window hears it (capture): only `type` and `pointerType` are read. */
function pointerEvent(type: string, pointerType: string): void {
  window.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { pointerType }))
}

const root = (): DOMStringMap => document.documentElement.dataset

/*
 * OS-12: the WebView answers `(hover: hover)` from the touch screen whenever there is one, so a
 * mouse on a tablet or under Samsung DeX never turns the media query on; the root's `data-hover`
 * – what every hover fill is gated on – follows the pointer that last moved over the chrome
 * instead, while the layout stays the media queries' (the tablet chrome).
 */
describe('hoverOf', () => {
  it('a mouse or a pen hovers, a finger does not, anything else says nothing', () => {
    expect(hoverOf({ type: 'pointerover', pointerType: 'mouse' })).toBe('hover')
    expect(hoverOf({ type: 'pointermove', pointerType: 'mouse' })).toBe('hover')
    expect(hoverOf({ type: 'pointerdown', pointerType: 'pen' })).toBe('hover')
    expect(hoverOf({ type: 'pointerover', pointerType: 'touch' })).toBe('none')
    expect(hoverOf({ type: 'pointerdown', pointerType: 'touch' })).toBe('none')
    // The synthetic mouse events of a tap are not pointer events; an unknown device is no word.
    expect(hoverOf({ type: 'mouseover' })).toBeNull()
    expect(hoverOf({ type: 'pointerover', pointerType: '' })).toBeNull()
    expect(hoverOf({ type: 'pointerup', pointerType: 'mouse' })).toBeNull()
  })
})

describe('hoverAttribute', () => {
  it('the media query’s hover stands; without it the live pointer decides; nothing yet is none', () => {
    expect(hoverAttribute(true, null)).toBe('hover')
    expect(hoverAttribute(true, 'none')).toBe('hover')
    expect(hoverAttribute(false, null)).toBe('none')
    expect(hoverAttribute(false, 'hover')).toBe('hover')
    expect(hoverAttribute(false, 'none')).toBe('none')
  })
})

describe('data-hover on a touch screen', () => {
  beforeEach(() => {
    resetLivePointer()
    pointer('finger')
    browserStore.set({ state: { window: { chrome: 'full' } } as unknown as UIState })
    resizeTo(1280, 800)
  })
  afterEach(() => {
    resetLivePointer()
    vi.restoreAllMocks()
    browserStore.set({ state: null })
    resizeTo(1024, 800)
  })

  it('a mouse moving over the tablet chrome turns hover on and leaves the layout a tablet’s', () => {
    expect(viewportStore.get().formFactor).toBe('tablet')
    expect(root().hover).toBe('none')
    const before = viewportStore.get()
    pointerEvent('pointerover', 'mouse')
    expect(root().hover).toBe('hover')
    expect(root().formFactor).toBe('tablet')
    expect(root().pointer).toBe('coarse')
    // The viewport itself is unchanged: nothing published, no shell re-render.
    expect(viewportStore.get()).toBe(before)
    expect(viewportStore.get().hover).toBe(false)
  })

  it('a pointer event moves data-hover alone: a viewport the store was handed stands, whatever the window would say now', () => {
    // The store holds a layout the window would not derive (a test's forced phone; a posture
    // report's): the mouse's first event must re-derive nothing and publish nothing, or the
    // shell it is over unmounts under it (the phone menu's edit pose, menuEdit.test.tsx).
    const forced = {
      ...viewportStore.get(),
      formFactor: 'phone' as const,
      coarse: true,
      hover: false
    }
    viewportStore.set(forced)
    pointerEvent('pointerover', 'mouse')
    expect(viewportStore.get()).toEqual(forced)
    expect(root().hover).toBe('hover')
    pointerEvent('pointerdown', 'touch')
    expect(viewportStore.get()).toEqual(forced)
    expect(root().hover).toBe('none')
  })

  it('a finger after the mouse turns hover off, so a tap’s sticky :hover paints nothing', () => {
    pointerEvent('pointermove', 'mouse')
    expect(root().hover).toBe('hover')
    pointerEvent('pointerover', 'touch')
    pointerEvent('pointerdown', 'touch')
    expect(root().hover).toBe('none')
    // A pen in range hovers (S Pen air view).
    pointerEvent('pointerover', 'pen')
    expect(root().hover).toBe('hover')
  })

  it('a resize keeps the live pointer’s word: the window dragged by the mouse stays hover', () => {
    pointerEvent('pointerover', 'mouse')
    resizeTo(700, 800)
    expect(viewportStore.get().formFactor).toBe('tablet')
    expect(root().hover).toBe('hover')
    resizeTo(560, 800)
    expect(viewportStore.get().formFactor).toBe('phone')
    expect(root().hover).toBe('hover')
  })

  it('a repeat of the current kind tells nobody', () => {
    const listener = vi.fn()
    const unsubscribe = onLivePointerChange(listener)
    // The first finger on a screen no pointer has touched is the first word (a change from
    // none known); the attribute it writes is the one already there.
    notePointer({ type: 'pointerover', pointerType: 'touch' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(root().hover).toBe('none')
    notePointer({ type: 'pointerdown', pointerType: 'touch' })
    expect(listener).toHaveBeenCalledTimes(1)
    notePointer({ type: 'pointerover', pointerType: 'mouse' })
    notePointer({ type: 'pointermove', pointerType: 'mouse' })
    notePointer({ type: 'pointermove', pointerType: 'mouse' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(root().hover).toBe('hover')
    unsubscribe()
  })
})

describe('data-hover on a desktop', () => {
  afterEach(() => {
    resetLivePointer()
    vi.restoreAllMocks()
    browserStore.set({ state: null })
    resizeTo(1024, 800)
  })

  it('the media query’s hover stands whatever touched the window last', () => {
    pointer('mouse')
    browserStore.set({ state: { window: { chrome: 'full' } } as unknown as UIState })
    resizeTo(1280, 800)
    expect(viewportStore.get().formFactor).toBe('desktop')
    expect(root().hover).toBe('hover')
    pointerEvent('pointerdown', 'touch')
    expect(root().hover).toBe('hover')
  })
})
