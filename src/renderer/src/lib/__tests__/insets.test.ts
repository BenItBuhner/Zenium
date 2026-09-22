// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bridge } from '../../../../android/bridge'
import { AndroidPlatform, type BootInfo } from '../../../../android/platform'
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

/*
 * The boot order #277 fixed (the chrome dropped the host's FIRST `insets`), fed through the
 * platform's bus as `useMainEvents` wires it (`onEvent('insets', applyHostInsets)`): the boot
 * payload's copy is on the bus before React has subscribed and reaches the late subscriber as
 * the sticky replay; the dedupe compares each report with the STORE's numbers – zeros until the
 * first report, the same zeros as the root's own `--zen-inset-*: 0px` defaults (main.css), and
 * `lib/insets.ts` is the one writer of both – so the first report that says anything is
 * written, a repeat is not, and every later change (a page's fullscreen and the way back, the
 * keyboard's rise and fall) is a change against what was written last.
 */
describe("the boot's first insets and the changes after them", () => {
  const boot = (insets: BootInfo['insets']): AndroidPlatform =>
    new AndroidPlatform(
      { call: async () => null, callSync: () => null, send: () => undefined } as unknown as Bridge,
      {
        version: '0.0.0-test',
        sdkInt: 34,
        signer: null,
        packageName: null,
        files: {},
        downloadsDir: '/sdcard/Download',
        insets,
        fullscreen: false
      }
    )
  const written = (): string[] => {
    const w = rootWrites
    rootWrites = []
    return w
  }

  it("the boot payload's insets, replayed to the late subscriber, are written; the host's repeat is not", () => {
    const platform = boot(BARS)
    // The host's own first dispatch reaches the bus before the subscription too (hostGlobal.flush).
    platform.hostEvent('insets', { ...BARS })
    expect(rootWrites).toEqual([])
    // useMainEvents subscribes after React's first render: the replay is its first report.
    platform.events.on('insets', (insets) => applyHostInsets(insets))
    expect(written()).toEqual([
      '--zen-inset-top:24px',
      '--zen-inset-right:0px',
      '--zen-inset-bottom:48px',
      '--zen-inset-left:0px'
    ])
    expect(uiStore.get().insets).toEqual(BARS)
    // Android's re-dispatch on the next layout of its root: the same four numbers.
    platform.hostEvent('insets', { ...BARS })
    platform.hostEvent('insets', { ...BARS, settling: false })
    expect(written()).toEqual([])
  })

  it('a boot payload measured before the first dispatch (zeros) cannot swallow the first real report', () => {
    const platform = boot({ top: 0, right: 0, bottom: 0, left: 0 })
    platform.events.on('insets', (insets) => applyHostInsets(insets))
    // Zeros are what the root's defaults say already (main.css `--zen-inset-*: 0px`): nothing to write.
    expect(written()).toEqual([])
    platform.hostEvent('insets', { ...BARS })
    expect(written()).toEqual([
      '--zen-inset-top:24px',
      '--zen-inset-right:0px',
      '--zen-inset-bottom:48px',
      '--zen-inset-left:0px'
    ])
  })

  it("a page's fullscreen, the way back and the keyboard are each a change against the last write", () => {
    const platform = boot(BARS)
    platform.events.on('insets', (insets) => applyHostInsets(insets))
    written()
    // Fullscreen: the bars go, the host says the insets are settling.
    platform.hostEvent('insets', { top: 0, right: 0, bottom: 0, left: 0, settling: true })
    expect(written()).toEqual([
      '--zen-inset-top:0px',
      '--zen-inset-right:0px',
      '--zen-inset-bottom:0px',
      '--zen-inset-left:0px'
    ])
    expect(landingStore.get().settling).toBe(true)
    // The way back: the same bars as at boot are a change against the zeros written last, once;
    // the settled repeat writes nothing but the landing hears it.
    platform.hostEvent('insets', { ...BARS, settling: true })
    expect(written()).toEqual([
      '--zen-inset-top:24px',
      '--zen-inset-right:0px',
      '--zen-inset-bottom:48px',
      '--zen-inset-left:0px'
    ])
    platform.hostEvent('insets', { ...BARS, settling: false })
    expect(written()).toEqual([])
    expect(landingStore.get().settling).toBe(false)
    // The keyboard: the bottom rises and falls, each a write of the four.
    platform.hostEvent('insets', { ...BARS, bottom: 320 })
    expect(written()).toContain('--zen-inset-bottom:320px')
    platform.hostEvent('insets', { ...BARS })
    expect(written()).toContain('--zen-inset-bottom:48px')
    expect(uiStore.get().insets).toEqual(BARS)
  })
})
