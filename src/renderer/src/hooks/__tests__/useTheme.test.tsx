// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, StrictMode, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { resolveTheme, rgbToHex, themeCssVariables, type ResolvedTheme } from '@shared/theme'

/*
 * The theme hook rendered for real on the phone (MOT-14): a private tab coming into view runs
 * the root's colour variables from the space theme to the private theme on the blend spring,
 * through intermediate colours, and flips the polarity (`data-theme`, the returned `isDark`) at
 * the midpoint; leaving it runs them back. A chrome that mounts on a private tab is painted
 * private at once, with no run. The host hears the painted theme through `zen-theme-painted`.
 */

Object.assign(window, { zen: { invoke: async () => null, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PRIVATE_RESOLVED, THEME_PAINTED_EVENT, useTheme } = await import('../useTheme')

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

function stateOn(activeTabId: 'r1' | 'x1'): UIState {
  const space: Space = {
    id: 's1',
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
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

/** `run(n)` advances the clock 16 ms a frame and runs the pending animation frames. */
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

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
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
  onTheme
}: {
  state: UIState
  onTheme: (theme: ResolvedTheme) => void
}): null {
  const theme = useTheme(state, 'phone')
  useEffect(() => onTheme(theme), [theme, onTheme])
  return null
}

function render(state: UIState, strict = false): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  const el = createElement(Probe, { state, onTheme: report })
  act(() => root!.render(strict ? createElement(StrictMode, null, el) : el))
}

function rerender(state: UIState): void {
  act(() => root!.render(createElement(Probe, { state, onTheme: report })))
}

const rootStyle = (): CSSStyleDeclaration => document.documentElement.style
const painted = (): string => rootStyle().getPropertyValue(BG)

beforeEach(() => {
  frames.install()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  answer.returned = null
  frames.queue.clear()
  vi.unstubAllGlobals()
  const style = rootStyle()
  for (const key of Object.keys(themeCssVariables(SPACE_LIGHT))) style.removeProperty(key)
  delete document.documentElement.dataset.theme
})

describe('the private theme blend (MOT-14)', () => {
  it('paints the space theme on a regular tab, and the private theme reaches the root through intermediate colours', () => {
    const events: Array<{ dark: boolean; background: string }> = []
    window.addEventListener(THEME_PAINTED_EVENT, (e) =>
      events.push((e as CustomEvent<{ dark: boolean; background: string }>).detail)
    )
    render(stateOn('r1'))
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(answer.returned?.isDark).toBe(false)

    rerender(stateOn('x1'))
    // The run is under way: the first frames paint colours that are neither theme.
    frames.run(3)
    const midway = painted()
    expect(midway).not.toBe(bgOf(SPACE_LIGHT))
    expect(midway).not.toBe(bgOf(PRIVATE_RESOLVED))
    expect(frames.queue.size).toBe(1)

    // Some 500 ms later the spring has rested exactly on the private theme.
    frames.run(30)
    expect(painted()).toBe(bgOf(PRIVATE_RESOLVED))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(frames.queue.size).toBe(0)
    // The hook's answer is the private theme itself once the polarity has flipped.
    expect(answer.returned).toBe(PRIVATE_RESOLVED)
    // The host heard the flip and the rest, with the private theme's solid colour.
    const dark = events.filter((e) => e.dark)
    expect(dark.length).toBeGreaterThanOrEqual(2)
    expect(dark[dark.length - 1]!.background).toBe(rgbToHex(PRIVATE_RESOLVED.averageColor))
  })

  it('runs back to the space theme when the private tab goes', () => {
    render(stateOn('r1'))
    rerender(stateOn('x1'))
    frames.run(40)
    expect(painted()).toBe(bgOf(PRIVATE_RESOLVED))

    rerender(stateOn('r1'))
    frames.run(3)
    expect(painted()).not.toBe(bgOf(PRIVATE_RESOLVED))
    expect(painted()).not.toBe(bgOf(SPACE_LIGHT))
    frames.run(40)
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(answer.returned?.isDark).toBe(false)
  })

  it('a chrome mounting on a private tab is painted private at once, without a run', () => {
    render(stateOn('x1'), true)
    expect(painted()).toBe(bgOf(PRIVATE_RESOLVED))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(answer.returned).toBe(PRIVATE_RESOLVED)
    // No frame pending: StrictMode's remount placed its fresh spring at rest as well.
    expect(frames.queue.size).toBe(0)
  })

  it('a private tab coming into view mid-run turns the blend around from where it stands', () => {
    render(stateOn('r1'))
    rerender(stateOn('x1'))
    frames.run(2)
    const turned = painted()
    rerender(stateOn('r1'))
    frames.run(1)
    // The way back starts near where the run had got to, not from the private theme.
    expect(painted()).not.toBe(bgOf(PRIVATE_RESOLVED))
    expect(painted()).not.toBe(turned)
    frames.run(40)
    expect(painted()).toBe(bgOf(SPACE_LIGHT))
  })
})
