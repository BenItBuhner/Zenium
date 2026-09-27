// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { defaultShortcuts } from '@shared/shortcuts'
import { viewportStore } from '@renderer/lib/formFactor'
import { NavRow } from '../SidebarTop'

/*
 * The update dot on the toolbar's menu button and the per-version 'seen' record (TB-12): the
 * TABLET's button and the DESKTOP's ⋯ take one cadence, Chrome Android's – the dot clears once
 * the app menu has been opened for the waiting version (`UIState.updateDot.seenVersion`, written
 * by the core's `Menus.showAppMenu` on every host) and returns for another version's `ready`.
 * The desktop joined at W8-F3 (the lead's ruling; Chrome desktop's own badge persists by
 * severity until the relaunch – the edge left). Both read the one `.zen-mhub-dot` seat and name
 * the dot in the button's label.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const page = {
  id: 't1',
  url: 'https://example.com/article',
  title: 'Page',
  canGoBack: true,
  canGoForward: true,
  loading: false,
  readerable: true,
  errorCode: null,
  blockedCount: 0
} as Tab

type Phase = 'idle' | 'available' | 'ready'

/** Enough of a snapshot for the row, with the updater's phase and the dot's record. */
function state(phase: Phase, seenVersion: string | null = null, version = '2.0.0'): UIState {
  return {
    platform: 'linux',
    capabilities: { windowControls: false, windows: true },
    tabs: { [page.id]: page },
    spaces: [{ id: 'space', activeTabId: page.id, tabIds: [page.id], containerId: 'default' }],
    activeSpaceId: 'space',
    folders: {},
    essentialTabIds: [],
    settings: { urlbarBehavior: 'normal' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {},
    translate: { available: true, tabs: {} },
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    permissionRules: [],
    media: [],
    updates: { phase, release: phase === 'idle' ? null : { version } },
    updateDot: { seenVersion }
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

const menuButton = (): HTMLButtonElement => {
  const b = document.querySelector<HTMLButtonElement>('[data-zen-app-menu-button]')
  expect(b).not.toBeNull()
  return b!
}
const dotShows = (): boolean =>
  menuButton().querySelector('[data-testid="update-ready-dot"]') !== null
const nameOf = (): string => menuButton().getAttribute('aria-label') ?? ''
const tooltipOf = (): string => menuButton().getAttribute('data-tooltip') ?? ''

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  viewportStore.set({ formFactor: 'desktop' })
})

describe('the toolbar menu button’s update dot and the per-version seen record (TB-12)', () => {
  it('on the tablet clears once the menu has been opened for the waiting version, and returns for another version', () => {
    viewportStore.set({ formFactor: 'tablet' })
    // Downloaded and waiting, the menu not yet opened for it: the dot and its name.
    render(<NavRow state={state('ready')} tab={page} compact={false} />)
    expect(dotShows()).toBe(true)
    expect(nameOf()).toBe(`${tooltipOf()}, update ready`)
    // The menu opened for 2.0.0 (the core's record): the dot off, the plain name.
    render(<NavRow state={state('ready', '2.0.0')} tab={page} compact={false} />)
    expect(dotShows()).toBe(false)
    expect(nameOf()).toBe(tooltipOf())
    // A newer version's `ready` after 2.0.0 was seen: the dot back – a state change.
    render(<NavRow state={state('ready', '2.0.0', '2.1.0')} tab={page} compact={false} />)
    expect(dotShows()).toBe(true)
    expect(nameOf()).toBe(`${tooltipOf()}, update ready`)
    // Found but not downloaded: nothing, seen or not.
    render(<NavRow state={state('available', '1.9.0')} tab={page} compact={false} />)
    expect(dotShows()).toBe(false)
    expect(nameOf()).toBe(tooltipOf())
  })

  it('on the tablet fails open: a `ready` snapshot without the record still lights the dot', () => {
    viewportStore.set({ formFactor: 'tablet' })
    const partial = { ...state('ready'), updateDot: undefined } as unknown as UIState
    render(<NavRow state={partial} tab={page} compact={false} />)
    expect(dotShows()).toBe(true)
    expect(nameOf()).toBe(`${tooltipOf()}, update ready`)
  })

  it('on the desktop takes the same cadence (W8-F3): present on `ready` with nothing seen, gone once the menu has been opened for the version, back for a new version', () => {
    viewportStore.set({ formFactor: 'desktop' })
    // Downloaded and waiting, the menu not yet opened for it: the dot and its name.
    render(<NavRow state={state('ready')} tab={page} compact={false} />)
    expect(dotShows()).toBe(true)
    expect(nameOf()).toBe(`${tooltipOf()}, update ready`)
    // The menu opened for 2.0.0 (the core's record, now written on the desktop's open too):
    // the dot GONE, the plain name – the row in the menu stays, the ⋯ is quiet.
    render(<NavRow state={state('ready', '2.0.0')} tab={page} compact={false} />)
    expect(dotShows()).toBe(false)
    expect(nameOf()).toBe(tooltipOf())
    // A newer version's `ready` after 2.0.0 was seen: the dot BACK – a state change.
    render(<NavRow state={state('ready', '2.0.0', '2.1.0')} tab={page} compact={false} />)
    expect(dotShows()).toBe(true)
    expect(nameOf()).toBe(`${tooltipOf()}, update ready`)
    // An older seen version (the record from a build since installed): the dot for the new one.
    render(<NavRow state={state('ready', '1.9.0', '2.0.0')} tab={page} compact={false} />)
    expect(dotShows()).toBe(true)
    // Found but not downloaded: nothing, seen or not, as before.
    render(<NavRow state={state('available')} tab={page} compact={false} />)
    expect(dotShows()).toBe(false)
    expect(nameOf()).toBe(tooltipOf())
    render(<NavRow state={state('available', '2.0.0')} tab={page} compact={false} />)
    expect(dotShows()).toBe(false)
  })

  it('on the desktop fails open too: a `ready` snapshot without the record still lights the dot', () => {
    viewportStore.set({ formFactor: 'desktop' })
    const partial = { ...state('ready'), updateDot: undefined } as unknown as UIState
    render(<NavRow state={partial} tab={page} compact={false} />)
    expect(dotShows()).toBe(true)
    expect(nameOf()).toBe(`${tooltipOf()}, update ready`)
  })
})
