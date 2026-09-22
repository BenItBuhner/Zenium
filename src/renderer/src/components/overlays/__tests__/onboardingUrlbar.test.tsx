// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'

/*
 * The first run and the new tab's URL bar. The tour's last click ends in a new tab whose bar
 * opens with its field focused; the bar used to open under the tour as well (the boot path's
 * `newtab.opened`, Ctrl+T), focus its field once on mount and lose the keyboard to the tour's
 * buttons – after the tour it stood with no caret. Now the bar waits for the tour to end
 * (`onboardingUp`, the terms the shells mount the tour on) and the new tab's `newtab.opened`
 * opens it over the tour's leavings, then keeps the field when the new tab's own view takes the
 * keyboard (lib/panes.ts `pageTookKeyboard`). Rendered as `App.tsx` and `ContentArea.tsx` mount
 * the two: the tour on the state's word, the bar keyed by its tab.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'urlbar.suggest' ? [] : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { Onboarding } = await import('../Onboarding')
const { Urlbar } = await import('../../urlbar/Urlbar')
const { browserStore, openNewTabPageUrlbar, uiStore } = await import('@renderer/lib/ui')
const { onboardingCovers } = await import('@renderer/lib/onboarding')
const { pageTookKeyboard } = await import('@renderer/lib/panes')

function tab(id: string): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: 'default',
    url: 'zen://newtab',
    title: 'New Tab',
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
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
    blockedCount: 0
  } as Tab
}

/** The profile window's state, before or after the tour, with the tabs the bar may open over. */
function profile(onboardingDone: boolean): UIState {
  return {
    platform: 'linux',
    capabilities: {},
    tabs: { t1: tab('t1'), t2: tab('t2') },
    spaces: [{ id: 'space', activeTabId: onboardingDone ? 't2' : 't1', tabIds: ['t1', 't2'] }],
    activeSpaceId: 'space',
    essentialTabIds: [],
    folders: {},
    settings: { ...DEFAULT_SETTINGS, onboardingDone, searchEngineId: 'google' },
    searchEngines: DEFAULT_SEARCH_ENGINES,
    shortcuts: [],
    systemDark: false,
    window: { kind: 'synced', chrome: 'full', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

/** What the desktop shell and its content area mount of the two, on the same terms. */
function Shell(): JSX.Element | null {
  const state = browserStore.use((s) => s.state)
  const ui = uiStore.use()
  if (!state) return null
  return createElement(
    'div',
    null,
    ui.urlbar.open &&
      createElement(Urlbar, {
        key: `${ui.urlbar.mode}-${ui.urlbar.tabId ?? 'new'}`,
        state,
        urlbar: ui.urlbar,
        area: { x: 0, y: 0, width: 1200, height: 800 },
        phoneEdge: undefined
      }),
    onboardingCovers(state) && createElement(Onboarding, { state })
  )
}

let root: Root | null = null
let host: HTMLElement | null = null

const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
const commands = (): string[] => invoke.mock.calls.map(([name]) => name)
const field = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('[data-testid="urlbar-input"]')
const tour = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="onboarding"]')
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!

/** A click as Chromium on Linux delivers it: the button takes the focus, then is activated. */
async function click(b: HTMLButtonElement): Promise<void> {
  await act(async () => {
    b.focus()
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false, tabId: null } }))
  browserStore.set({ state: null })
  invoke.mockClear()
})

describe('the first run and the new tab bar', () => {
  it("the bar does not open under the tour; the new tab the tour's last click opens has it up with the caret, kept from the page's view", async () => {
    browserStore.set({ state: profile(false) })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => root!.render(createElement(Shell)))
    expect(tour()).not.toBeNull()

    // The boot path's bar for the first tab, 150 ms after the chrome is ready, and Ctrl+T during
    // the tour: nothing opens under it.
    openNewTabPageUrlbar('t1', undefined, false)
    await settle()
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(field()).toBeNull()

    // The user clicks through: the buttons take the focus as they are clicked.
    await click(button('Continue'))
    await click(button('Skip tour'))
    expect(commands()).toContain('onboarding.complete')
    // The core: the state that ends the tour is broadcast first – the tour unmounts, and the
    // focus it held falls to the body…
    await act(async () => browserStore.set({ state: profile(true) }))
    expect(tour()).toBeNull()
    expect(document.activeElement).toBe(document.body)
    // …then the new tab it opened is announced. The bar opens over that tab, field focused.
    openNewTabPageUrlbar('t2', undefined, false)
    await settle()
    expect(uiStore.get().urlbar).toMatchObject({ open: true, mode: 'new-tab', tabId: 't2' })
    expect(field()).not.toBeNull()
    expect(document.activeElement).toBe(field())

    // The new tab's own view takes the keyboard as it is shown (focus.page for the tab): the
    // field is not let go, and the bar asks the chrome's keyboard back.
    invoke.mockClear()
    await act(async () => {
      expect(pageTookKeyboard('t2')).toBe('kept')
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(field())
    expect(commands()).toContain('focus.chrome')
  })
})
