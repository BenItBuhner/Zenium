// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, SpaceTheme, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import {
  PRIVATE_THEME,
  THEME_PRESETS,
  blendResolvedThemes,
  luminance,
  resolveTheme,
  rgbToHex,
  themeCssVariables,
  type RGB,
  type ResolvedTheme
} from '@shared/theme'
import { PRIVATE_ACCENT, PRIVATE_ACCENT_RGB } from '@shared/newTabPageScript'

/*
 * The theme hook rendered for real on the phone (MOT-14, design language v2 §11.6): a private
 * tab coming into view runs the root's colour variables from the space theme to the private
 * theme in one blend over 240 ms on one value, through intermediate colours, and flips the
 * polarity (`data-theme`, the returned `isDark`) at the midpoint, 120 ms in; leaving it runs
 * them back; a Space switch blends the same way. A chrome that mounts on a private tab is
 * painted private at once, with no run; under reduced motion the blend is a cut; the desktop
 * paints at once. The host hears the painted theme through `zen-theme-painted`.
 */

Object.assign(window, { zen: { invoke: async () => null, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PRIVATE_RESOLVED, THEME_BLEND_MS, THEME_PAINTED_EVENT, useTheme } =
  await import('../useTheme')

// --- a state -----------------------------------------------------------------------------------

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 's1',
    containerId: 'default',
    url: `https://${id}.example`,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    openerTabId: null,
    fromIntent: false,
    webApp: null,
    ...patch
  }
}

function stateOn(activeTabId: 'r1' | 'x1', theme: SpaceTheme | null = null): UIState {
  const space: Space = {
    id: 's1',
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme,
    tabIds: ['r1', 'x1'],
    activeTabId,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false, privateTabs: true },
    tabs: { r1: tab('r1'), x1: tab('x1', { containerId: PRIVATE_CONTAINER_ID }) },
    spaces: [space],
    activeSpaceId: 's1',
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: {
      colorScheme: 'light',
      sidebarSide: 'left',
      sidebarWidth: 240,
      borderless: false,
      pinnedCloseBehavior: 'unload',
      containerSpecificEssentials: false
    },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null, material: 'plain' },
    boosts: [],
    extensions: [],
    bookmarks: []
  } as unknown as UIState
}

const SPACE_LIGHT = resolveTheme(null, false)
const BG = '--zen-bg-solid'
const bgOf = (theme: ResolvedTheme): string => themeCssVariables(theme)[BG]!

// --- the frame loop, hand-cranked --------------------------------------------------------------

/** `run(n)` advances the clock `step` ms a frame (16 by default) and runs the pending frames. */
class Frames {
  now = 0
  readonly queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }

  run(n: number, step = 16): void {
    for (let i = 0; i < n; i++) {
      this.now += step
      const pending = [...this.queue.values()]
      this.queue.clear()
      act(() => {
        for (const cb of pending) cb(this.now)
      })
    }
  }
}

const frames = new Frames()
let root: Root | null = null
let mount: HTMLElement | null = null
/** What the hook returned on its latest render, as the probe reports it. */
const answer: { returned: ResolvedTheme | null } = { returned: null }
const report = (theme: ResolvedTheme): void => {
  answer.returned = theme
}

function Probe({
  state,
  formFactor,
  onTheme
}: {
  state: UIState
  formFactor: 'phone' | 'desktop'
  onTheme: (theme: ResolvedTheme) => void
}): null {
  const theme = useTheme(state, formFactor)
  useEffect(() => onTheme(theme), [theme, onTheme])
  return null
}

let formFactor: 'phone' | 'desktop' = 'phone'

function render(state: UIState, strict = false): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  const el = createElement(Probe, { state, formFactor, onTheme: report })
  act(() => root!.render(strict ? createElement(StrictMode, null, el) : el))
}

function rerender(state: UIState): void {
  act(() => root!.render(createElement(Probe, { state, formFactor, onTheme: report })))
}

const rootStyle = (): CSSStyleDeclaration => document.documentElement.style
const painted = (): string => rootStyle().getPropertyValue(BG)
const paintedDark = (): boolean => document.documentElement.dataset.theme === 'dark'
/** The root's solid colour `k` of the way from `a` to `b`, as the blend paints it. */
const between = (a: ResolvedTheme, b: ResolvedTheme, k: number): string =>
  bgOf(blendResolvedThemes(a, b, k))

const heard: Array<{ dark: boolean; background: string }> = []
const listen = (e: Event): void => {
  heard.push((e as CustomEvent<{ dark: boolean; background: string }>).detail)
}

/** The media queries the hook asks: reduced motion on or off, the colour scheme always light. */
function media(reduce: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      }) as unknown as MediaQueryList
  )
}

beforeEach(() => {
  frames.install()
  frames.now = 0
  formFactor = 'phone'
  heard.length = 0
  window.addEventListener(THEME_PAINTED_EVENT, listen)
})

afterEach(() => {
  window.removeEventListener(THEME_PAINTED_EVENT, listen)
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  answer.returned = null
  frames.queue.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  const style = rootStyle()
  for (const key of Object.keys(themeCssVariables(SPACE_LIGHT))) style.removeProperty(key)
  delete document.documentElement.dataset.theme
})

describe('the theme blend (MOT-14, v2 §11.6)', () => {
  it('paints the space theme on a regular tab, and blends the root to the private theme over 240 ms on one value', () => {
    render(stateOn('r1'))
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
    expect(paintedDark()).toBe(false)
    expect(answer.returned?.isDark).toBe(false)
    expect(THEME_BLEND_MS).toBe(240)

    rerender(stateOn('x1'))
    // The blend is under way: at 48 ms the root shows the colours a fifth of the way, exactly –
    // the value is the time, linear, so the midpoint of the colours is the midpoint of the time.
    frames.run(3)
    expect(painted()).toBe(between(SPACE_LIGHT, PRIVATE_RESOLVED, 48 / 240))
    expect(painted()).not.toBe(bgOf(SPACE_LIGHT))
    expect(painted()).not.toBe(bgOf(PRIVATE_RESOLVED))
    expect(frames.queue.size).toBe(1)

    // At 240 ms it rests exactly on the private theme, and no frame is left pending.
    frames.run(12)
    expect(frames.now).toBe(240)
    expect(painted()).toBe(bgOf(PRIVATE_RESOLVED))
    expect(paintedDark()).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(frames.queue.size).toBe(0)
    // The hook's answer is the private theme itself once the polarity has flipped.
    expect(answer.returned).toBe(PRIVATE_RESOLVED)
    // The host heard the flip and the rest, the rest with the private theme's solid colour.
    const dark = heard.filter((e) => e.dark)
    expect(dark.length).toBe(2)
    expect(dark[1]!.background).toBe(rgbToHex(PRIVATE_RESOLVED.averageColor))
  })

  it('flips the colour scheme at the midpoint, 120 ms in, and not a frame before', () => {
    render(stateOn('r1'))
    rerender(stateOn('x1'))
    // 112 ms: the colours are nearly halfway, the scheme still the space theme's.
    frames.run(7)
    expect(painted()).toBe(between(SPACE_LIGHT, PRIVATE_RESOLVED, 112 / 240))
    expect(paintedDark()).toBe(false)
    expect(answer.returned?.isDark).toBe(false)
    expect(heard.filter((e) => e.dark)).toEqual([])
    // 120 ms: the flip, and the host hears it with the colour under it.
    frames.run(1, 8)
    expect(frames.now).toBe(120)
    expect(painted()).toBe(between(SPACE_LIGHT, PRIVATE_RESOLVED, 0.5))
    expect(paintedDark()).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(answer.returned?.isDark).toBe(true)
    expect(heard.filter((e) => e.dark)).toEqual([
      { dark: true, background: between(SPACE_LIGHT, PRIVATE_RESOLVED, 0.5) }
    ])
    // The blend runs on to its end, the same one blend.
    frames.run(8, 15)
    expect(frames.now).toBe(240)
    expect(painted()).toBe(bgOf(PRIVATE_RESOLVED))
    expect(frames.queue.size).toBe(0)
  })

  it('runs back to the space theme when the private tab goes, flipping back at its midpoint', () => {
    render(stateOn('r1'))
    rerender(stateOn('x1'))
    frames.run(15)
    expect(painted()).toBe(bgOf(PRIVATE_RESOLVED))

    rerender(stateOn('x1'))
    // The same theme again: no run.
    expect(frames.queue.size).toBe(0)

    rerender(stateOn('r1'))
    frames.run(7)
    expect(painted()).toBe(between(PRIVATE_RESOLVED, SPACE_LIGHT, 112 / 240))
    expect(paintedDark()).toBe(true)
    frames.run(1)
    expect(paintedDark()).toBe(false)
    expect(answer.returned?.isDark).toBe(false)
    frames.run(7)
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
    expect(frames.queue.size).toBe(0)
  })

  it('a chrome mounting on a private tab is painted private at once, without a run', () => {
    render(stateOn('x1'), true)
    expect(painted()).toBe(bgOf(PRIVATE_RESOLVED))
    expect(paintedDark()).toBe(true)
    expect(answer.returned).toBe(PRIVATE_RESOLVED)
    // No frame pending: StrictMode's remount found the root already painted and started nothing.
    expect(frames.queue.size).toBe(0)
    expect(heard).toEqual([{ dark: true, background: rgbToHex(PRIVATE_RESOLVED.averageColor) }])
  })

  it('a private tab coming into view mid-run turns the blend around from where it stands', () => {
    render(stateOn('r1'))
    rerender(stateOn('x1'))
    frames.run(2)
    const turned = painted()
    rerender(stateOn('r1'))
    frames.run(2)
    // The way back starts where the run had got to, not from the private theme, and takes its
    // own 240 ms from there.
    expect(painted()).toBe(
      between(blendResolvedThemes(SPACE_LIGHT, PRIVATE_RESOLVED, 32 / 240), SPACE_LIGHT, 32 / 240)
    )
    expect(painted()).not.toBe(bgOf(PRIVATE_RESOLVED))
    expect(painted()).not.toBe(turned)
    frames.run(13)
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
    expect(frames.queue.size).toBe(0)
  })

  it('a Space switch blends the same way: one blend of the resolved tokens, the scheme with them', () => {
    const ocean = THEME_PRESETS.find((p) => p.name === 'Ocean')!.theme
    const OCEAN_LIGHT = resolveTheme(ocean, false)
    render(stateOn('r1'))
    rerender(stateOn('r1', ocean))
    frames.run(3)
    expect(painted()).toBe(between(SPACE_LIGHT, OCEAN_LIGHT, 48 / 240))
    frames.run(12)
    expect(painted()).toBe(bgOf(OCEAN_LIGHT))
    expect(rootStyle().getPropertyValue('--zen-bg')).toBe(OCEAN_LIGHT.background)
    expect(frames.queue.size).toBe(0)
    // A state update that leaves the theme as it is starts nothing.
    rerender(stateOn('r1', { ...ocean }))
    expect(frames.queue.size).toBe(0)
  })

  it('under reduced motion the blend is a cut: the private theme at once, no frame, one word to the host', () => {
    media(true)
    render(stateOn('r1'))
    heard.length = 0
    rerender(stateOn('x1'))
    expect(frames.queue.size).toBe(0)
    expect(painted()).toBe(bgOf(PRIVATE_RESOLVED))
    expect(paintedDark()).toBe(true)
    expect(answer.returned).toBe(PRIVATE_RESOLVED)
    expect(heard).toEqual([{ dark: true, background: rgbToHex(PRIVATE_RESOLVED.averageColor) }])
    rerender(stateOn('r1'))
    expect(frames.queue.size).toBe(0)
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
  })

  it("the desktop paints its theme at once, with no run (the blend is the phone's)", () => {
    formFactor = 'desktop'
    const ocean = THEME_PRESETS.find((p) => p.name === 'Ocean')!.theme
    render(stateOn('r1'))
    rerender(stateOn('r1', ocean))
    expect(frames.queue.size).toBe(0)
    expect(painted()).toBe(bgOf(resolveTheme(ocean, false)))
  })

  /** The document's visibility as the hook reads it, with the `visibilitychange` it fires. */
  function visibility(state: 'hidden' | 'visible'): void {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('a blend in flight settles at its end as the document hides: no frozen private colours wait for the return', () => {
    render(stateOn('x1'))
    rerender(stateOn('r1'))
    frames.run(2)
    expect(painted()).toBe(between(PRIVATE_RESOLVED, SPACE_LIGHT, 32 / 240))
    expect(frames.queue.size).toBe(1)
    heard.length = 0
    // Home: the document hides mid-blend, where rAF stops. The blend cuts to the space theme,
    // the pending frame is dropped, and the host hears the rest once.
    visibility('hidden')
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
    expect(paintedDark()).toBe(false)
    expect(frames.queue.size).toBe(0)
    expect(heard).toEqual([{ dark: false, background: rgbToHex(SPACE_LIGHT.averageColor) }])
    // Back: nothing is pending, nothing runs, the theme is as it should be.
    visibility('visible')
    expect(frames.queue.size).toBe(0)
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
  })

  it('a theme change while the document is hidden is a cut: nothing would show the blend, and its frames would not run', () => {
    render(stateOn('x1'))
    visibility('hidden')
    // The private session ends from the notification while the app is away: the tab in front
    // becomes a regular one.
    rerender(stateOn('r1'))
    expect(frames.queue.size).toBe(0)
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
    expect(paintedDark()).toBe(false)
    visibility('visible')
    expect(frames.queue.size).toBe(0)
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
  })
})

describe('the frame radius the theme writes (v2 §2, §9.29)', () => {
  /** `stateOn('r1')` with the developer tools open on the tabs named, at the dock named. */
  const withDevtools = (open: string[], devtoolsDock: 'bottom' | 'right' | 'undocked'): UIState => {
    const base = stateOn('r1')
    return { ...base, devtoolsOpenFor: open, settings: { ...base.settings, devtoolsDock } }
  }
  const radius = (): string => rootStyle().getPropertyValue('--zen-content-radius')
  afterEach(() => {
    rootStyle().removeProperty('--zen-content-radius')
    rootStyle().removeProperty('--zen-padding')
  })

  it("writes the desktop's 10 px and the phone's 14 px, from the first paint", () => {
    formFactor = 'desktop'
    render(stateOn('r1'))
    expect(radius()).toBe('10px')
    rerender({ ...stateOn('r1'), settings: { ...stateOn('r1').settings, borderless: true } })
    expect(radius()).toBe('0px')
    act(() => root?.unmount())
    formFactor = 'phone'
    render(stateOn('r1'))
    expect(radius()).toBe('14px')
  })

  it('yields to a square box while a toolbox is docked in the frame, and rounds again as it undocks or closes', () => {
    formFactor = 'desktop'
    render(withDevtools(['r1'], 'bottom'))
    expect(radius()).toBe('0px')
    rerender(withDevtools(['r1'], 'right'))
    expect(radius()).toBe('0px')
    // Undocked, the toolbox is a window of its own: the frame is whole again.
    rerender(withDevtools(['r1'], 'undocked'))
    expect(radius()).toBe('10px')
    // A toolbox open on the tab out of view is not in the frame.
    rerender(withDevtools(['x1'], 'bottom'))
    expect(radius()).toBe('10px')
    rerender(withDevtools([], 'bottom'))
    expect(radius()).toBe('10px')
  })
})

describe('the private theme the phone blends to', () => {
  /** WCAG contrast of two opaque colours. */
  const contrast = (a: RGB, b: RGB): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  it("carries the desktop private window's accent, the same rgb as the chrome's and the new tab page's", () => {
    expect(rgbToHex(PRIVATE_RESOLVED.accent)).toBe(PRIVATE_ACCENT)
    expect(PRIVATE_RESOLVED.accent.join(' ')).toBe(PRIVATE_ACCENT_RGB)
    // The rest is the private theme resolved dark, as before.
    const own = resolveTheme(PRIVATE_THEME, true)
    expect({ ...PRIVATE_RESOLVED, accent: own.accent }).toEqual(own)
    expect(PRIVATE_RESOLVED.isDark).toBe(true)
  })

  it("reads above the 3:1 floor on the private backdrop, where the theme's own accent did not (v2 §9.34's line, the button, the switch)", () => {
    const own = resolveTheme(PRIVATE_THEME, true)
    expect(contrast(own.accent, own.averageColor)).toBeLessThan(3)
    expect(contrast(PRIVATE_RESOLVED.accent, PRIVATE_RESOLVED.averageColor)).toBeGreaterThan(6)
    for (const stop of PRIVATE_RESOLVED.stops)
      expect(contrast(PRIVATE_RESOLVED.accent, stop)).toBeGreaterThan(4.5)
  })
})
