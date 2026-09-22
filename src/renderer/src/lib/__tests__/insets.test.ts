// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyHostInsets } from '../insets'
import { landingStore } from '../fullscreenLanding'
import { uiStore } from '../ui'

/*
 * The host's `insets` event (lib/insets.ts): the root's four `--zen-inset-*` and the store take
 * a report that changed the numbers; a report that says what the last did – Android sends the
 * window's insets again on every layout of its root, at each gesture's rest among them (PERF-1's
 * seed) – writes and sets nothing, and the landing hears every report's word on the bars.
 */

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 }
const BARS = { top: 24, right: 0, bottom: 48, left: 0 }

let rootWrites: string[]

beforeEach(() => {
  uiStore.set({ insets: ZERO })
  landingStore.set({ settling: undefined, placed: new Map(), sized: new Map(), reports: 0 })
  document.documentElement.removeAttribute('style')
  rootWrites = []
  const style = document.documentElement.style
  const setProperty = style.setProperty.bind(style)
  vi.spyOn(style, 'setProperty').mockImplementation((name, value) => {
    rootWrites.push(`${name}:${value}`)
    setProperty(name, value)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the insets the host reports', () => {
  it('a change writes the four root properties and a fresh insets object to the store', () => {
    const listener = vi.fn()
    const off = uiStore.subscribe(listener)
    expect(applyHostInsets(BARS)).toBe(true)
    expect(rootWrites).toEqual([
      '--zen-inset-top:24px',
      '--zen-inset-right:0px',
      '--zen-inset-bottom:48px',
      '--zen-inset-left:0px'
    ])
    expect(uiStore.get().insets).toEqual(BARS)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it('the same numbers again write nothing to the root and set nothing in the store', () => {
    applyHostInsets(BARS)
    const before = uiStore.get().insets
    rootWrites = []
    const listener = vi.fn()
    const off = uiStore.subscribe(listener)
    expect(applyHostInsets({ ...BARS })).toBe(false)
    expect(applyHostInsets({ ...BARS, settling: false })).toBe(false)
    expect(rootWrites).toEqual([])
    expect(uiStore.get().insets).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it("the first report of the boot's zeros is the root's default already: nothing to write", () => {
    expect(applyHostInsets(ZERO)).toBe(false)
    expect(rootWrites).toEqual([])
  })

  it('one number moving – the keyboard – is a change; the store keeps the four numbers alone', () => {
    applyHostInsets(BARS)
    rootWrites = []
    expect(applyHostInsets({ ...BARS, bottom: 320, settling: false })).toBe(true)
    expect(rootWrites).toContain('--zen-inset-bottom:320px')
    expect(uiStore.get().insets).toEqual({ ...BARS, bottom: 320 })
  })

  it("the landing hears every report's word on the bars, changed numbers or not", () => {
    applyHostInsets({ ...BARS, settling: true })
    expect(landingStore.get().settling).toBe(true)
    applyHostInsets({ ...BARS, settling: false })
    expect(landingStore.get().settling).toBe(false)
    applyHostInsets({ ...BARS })
    expect(landingStore.get().settling).toBeUndefined()
  })
})
