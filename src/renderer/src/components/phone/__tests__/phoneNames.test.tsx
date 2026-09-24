// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import type { PillGestureHandlers } from '../usePillGestures'

/*
 * Spoken names against visible text on the phone's surfaces (A11Y-10, matrix rows for Voice
 * Access and Switch Access): the bar's buttons and the pill's chips (`PhoneShell.tsx`), the
 * overview's header, segment, cards and their controls (`TabOverview.tsx`), rendered for real
 * and read by the audit in `lib/a11yNames.ts` – every control a reader is given has a name, and
 * a control that shows text carries that text in its name (the word a Voice Access user would
 * say); no glyph-only control goes unnamed. The app menu's rows and icon row are audited in
 * `menus/__tests__/menuIconRow.test.tsx` with the menu's own fixture.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'session.recentlyClosed' ? [] : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PhoneBar } = await import('../PhoneShell')
const { TabOverview } = await import('../TabOverview')
const { auditNames, formatNameFindings } = await import('@renderer/lib/a11yNames')
const { viewportStore } = await import('@renderer/lib/formFactor')

const SPACE = 'space'
const GROUP = 'g'

function tab(id: string, url: string, title: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId: 'default',
    url,
    title,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: true,
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
    ...patch
  } as Tab
}

const folder: Folder = {
  id: GROUP,
  spaceId: SPACE,
  name: 'Research',
  icon: '📚',
  collapsed: false,
  color: 'blue'
}

/** `tabs` in track order; the first is active; a group with two members among them. */
function stateOf(tabs: Tab[]): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: { [GROUP]: folder },
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS, phoneBarPosition: 'bottom' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    closingTabIds: [],
    translate: { available: true, tabs: {} },
    sync: { enabled: false, scope: { openTabs: false } }
  } as unknown as UIState
}

const TABS = [
  tab('a', 'https://example.com/', 'Example Domain'),
  tab('m1', 'https://en.wikipedia.org/wiki/Tea', 'Tea - Wikipedia', { folderId: GROUP }),
  tab('m2', 'https://www.rfc-editor.org/rfc/rfc1149.html', 'RFC 1149', { folderId: GROUP }),
  tab('b', 'http://info.cern.ch/', 'World Wide Web', { audible: true }),
  tab('c', 'https://news.ycombinator.com/', 'Hacker News', { discarded: true })
]

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  viewportStore.set({ ...viewportStore.get(), coarse: true, hover: false, formFactor: 'phone' })
  act(() => root!.render(el))
  return mount
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  act(() => viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' }))
})

const controls = (el: ParentNode): string[] =>
  [...el.querySelectorAll('button, [role="button"], [role="tab"]')]
    .filter((c) => c.closest('[aria-hidden="true"]') === null)
    .map((c) => c.getAttribute('aria-label') ?? c.textContent ?? '')

describe('spoken names match visible text (A11Y-10)', () => {
  it('the bar and the pill: every button and chip is named, and a control showing text carries it in its name', () => {
    const state = stateOf(TABS)
    const el = render(
      <PhoneBar
        state={state}
        edge="bottom"
        pill={{} as PillGestureHandlers}
        overviewOpen={false}
        pillLook="docked"
      />
    )
    const names = controls(el)
    // The audit has something to read: the bar's buttons and the pill's address and chips.
    expect(names.length).toBeGreaterThanOrEqual(5)
    expect(names.some((n) => n.startsWith('Address, example.com'))).toBe(true)
    const findings = auditNames(el)
    expect(formatNameFindings(findings)).toBe('')
  })

  it('the overview: the header controls, the segment, every card and its close, the group header and the New Tab card', () => {
    const state = stateOf(TABS)
    const el = render(
      createElement(TabOverview, {
        state,
        overview: { phase: 'open', progress: 1, heroTabId: null, target: 1 },
        area: { x: 0, y: 0, width: 360, height: 700 },
        edge: 'bottom'
      })
    )
    const names = controls(el)
    expect(names.some((n) => /^Example Domain, tab \d+ of \d+/.test(n))).toBe(true)
    expect(names).toContain('Close Example Domain')
    const findings = auditNames(el)
    expect(formatNameFindings(findings)).toBe('')
  })
})
