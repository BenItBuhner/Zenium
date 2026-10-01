// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, SpaceTheme, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { PRIVATE_CONTAINER_ID } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
vi.mock(import('@renderer/lib/ui'), async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, openOverlay: vi.fn(async () => undefined) }
})

import { run } from '@renderer/lib/api'
import { openOverlay } from '@renderer/lib/ui'
import { OVERVIEW_LABELS } from '@shared/overviewMenu'
import { SpacesSheet } from '../SpacesSheet'

/*
 * The Spaces sheet (tab overview cleanup spec §1): the overview's title opens the Spaces
 * drawer's rows as a §9.23 sheet – each space with its dot, its name and the overview's count
 * of it, the current one checked, "New Space…" last. A pick of another space asks the core to
 * switch once the sheet is gone; the current one just closes; New Space… opens the editor.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(id: string, spaceId: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId,
    containerId: 'default',
    url: `https://${id}.example/`,
    title: id,
    folderId: null,
    pinned: false,
    essential: false,
    ...over
  } as Tab
}

function space(id: string, name: string, tabs: Tab[], over: Partial<Space> = {}): Space {
  return {
    id,
    name,
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false,
    ...over
  } as Space
}

const WORK = [tab('w1', 'work'), tab('w2', 'work'), tab('w3', 'work')]
const HOME = [tab('h1', 'home'), tab('hp', 'home', { containerId: PRIVATE_CONTAINER_ID })]
/** Work's theme: one blue, floating – the accent is the colour itself. */
const BLUE: SpaceTheme = {
  type: 'gradient',
  colors: [{ c: [51, 102, 255], x: 0.5, y: 0.5, isPrimary: true }],
  opacity: 0.5,
  texture: 0,
  algorithm: 'floating',
  monochrome: false,
  rotation: 0
}

function stateOf(active = 'work'): UIState {
  return {
    platform: 'android',
    capabilities: { windowControls: false, privateTabs: true },
    tabs: Object.fromEntries([...WORK, ...HOME].map((t) => [t.id, t])),
    spaces: [space('work', 'Work', WORK, { theme: BLUE }), space('home', 'Home', HOME)],
    activeSpaceId: active,
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS }
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLDivElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

// The sheet's springs run on the animation frame: the frames are stepped by hand.
const frames = new Map<number, (t: number) => void>()
let nextFrame = 1
let now = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ now })
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    const id = nextFrame++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  vi.mocked(run).mockClear()
  vi.mocked(openOverlay).mockClear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Frames and timers pass until every spring in flight has landed. */
const settle = (): void => {
  act(() => {
    for (let i = 0; i < 600 && frames.size; i++) {
      now += 16
      vi.advanceTimersByTime(16)
      const batch = [...frames.values()]
      frames.clear()
      for (const cb of batch) cb(now)
    }
    vi.runOnlyPendingTimers()
  })
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const all = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector)
]
const rows = (): HTMLButtonElement[] => all('.zen-sheet .zen-sheet-item') as HTMLButtonElement[]

/** A fresh sheet: the one before, dismissed, is unmounted first. */
function sheet(state: UIState): void {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  render(<SpacesSheet state={state} isDark={false} onClose={() => undefined} />)
}

describe('the Spaces sheet (§1)', () => {
  it('lists the spaces with their dots, names and the overview’s counts, the current one checked, New Space… last', () => {
    sheet(stateOf('work'))
    expect(q('.zen-sheet .zen-sheet-title')?.textContent).toBe(OVERVIEW_LABELS.spaces)
    const items = rows()
    expect(items.map((r) => r.querySelector('.flex-1')?.textContent)).toEqual([
      'Work',
      'Home',
      OVERVIEW_LABELS.newSpace
    ])
    // The counts are the header's: Home's private tab is not among its cards (TAB-02).
    expect(items.map((r) => r.querySelector('.tabular-nums')?.textContent ?? '')).toEqual([
      '3 tabs',
      '1 tab',
      ''
    ])
    expect(items.map((r) => r.getAttribute('aria-current'))).toEqual(['true', null, null])
    expect(items.map((r) => Boolean(r.querySelector('[data-check]')))).toEqual([true, false, false])
    expect(items.map((r) => r.dataset.testid)).toEqual([
      'spaces-sheet-space',
      'spaces-sheet-space',
      'spaces-sheet-new'
    ])
    // Work's dot in its theme's accent; Home, with no theme, the ink ring.
    const workDot = items[0]!.querySelector<HTMLElement>('.rounded-full')!
    expect(workDot.style.background.toLowerCase()).toMatch(/#3366ff|51, 102, 255/)
    expect(items[1]!.querySelector('svg')).not.toBeNull()
  })

  it('a pick of another space asks the core to switch once the sheet is gone; the current one just closes', () => {
    sheet(stateOf('work'))
    act(() => rows()[1]!.click())
    settle()
    expect(run).toHaveBeenCalledWith('space.activate', { spaceId: 'home' })
    vi.mocked(run).mockClear()
    sheet(stateOf('work'))
    act(() => rows()[0]!.click())
    settle()
    expect(run).not.toHaveBeenCalled()
  })

  it('New Space… opens the space editor over the tab in view', () => {
    sheet(stateOf('work'))
    act(() => rows()[2]!.click())
    settle()
    expect(openOverlay).toHaveBeenCalledWith('space-editor', 'w1', null)
    expect(run).not.toHaveBeenCalled()
  })
})
