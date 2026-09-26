import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import type { UIState } from '@shared/types'
import { NEW_TAB_URL } from '@shared/url'
import { cmd, run } from '../api'
import {
  browserStore,
  closeUrlbar,
  interceptUrlbarClose,
  openNewTabPageUrlbar,
  openUrlbar,
  uiStore,
  type UrlbarCloseOptions
} from '../ui'

/**
 * A desktop window on one space with the tabs given, `active` in front: the boot's New Tab `a`
 * (`ensureFirstTab` → `openFreshTab` → `newtab.opened`, its palette bound to it) and the page `b`
 * something else makes active under the palette (an extension's `chrome.tabs.create({ active:
 * true })`, the bridge's `tab.create`, Ctrl+Tab, a `window.open`).
 */
const window = (
  active: string | null,
  opts: { tabs?: Record<string, string>; palette?: boolean; page?: boolean } = {}
): UIState => {
  const urls = opts.tabs ?? { a: NEW_TAB_URL, b: 'https://gamma.test/' }
  const tabs = Object.fromEntries(
    Object.entries(urls).map(([id, url]) => [
      id,
      { id, url, title: id, spaceId: 's1', containerId: 'default' }
    ])
  )
  return {
    platform: 'electron',
    capabilities: { newTabPage: opts.page ?? true, pageTabs: true },
    tabs,
    spaces: [{ id: 's1', name: 'Space', activeTabId: active, tabIds: Object.keys(tabs) }],
    activeSpaceId: 's1',
    settings: { onboardingDone: true, newTab: { enabled: opts.palette ?? true } },
    window: { kind: 'synced', chrome: 'full' }
  } as unknown as UIState
}

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** The boot's palette: the bar in new-tab mode bound to `a`, the window showing `a`. */
async function bootPalette(): Promise<void> {
  browserStore.set({ state: window('a') })
  openNewTabPageUrlbar('a', undefined, false)
  await settled()
  expect(uiStore.get().urlbar).toMatchObject({ open: true, mode: 'new-tab', tabId: 'a' })
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
}

afterEach(() => {
  uiStore.set((s) => ({
    urlbar: { ...s.urlbar, open: false, tabId: null },
    snapshot: null,
    snapshotTabId: null
  }))
  browserStore.set({ state: null })
  vi.mocked(run).mockClear()
  vi.mocked(cmd).mockClear()
})

describe("the New Tab's palette and the window's active tab", () => {
  it('closes, without a keyboard reason, when another tab is made active under it', async () => {
    await bootPalette()
    const closes: UrlbarCloseOptions[] = []
    const release = interceptUrlbarClose((opts) => {
      closes.push(opts)
      return false
    })
    try {
      // The core's state after `tab.create({ active: true, url })`: `b` in front, the palette
      // still bound to `a`. The bar goes so `b`'s view comes on screen (`overlayCoversContent`
      // held it hidden) – no Escape needed.
      browserStore.set({ state: window('b') })
    } finally {
      release()
    }
    expect(uiStore.get().urlbar.open).toBe(false)
    // Not a dismissal (the phone's field morph runs back on one; a draft is kept on one), no
    // pane shortcut keeping the keyboard: the plain close another surface's takeover runs.
    expect(closes).toEqual([{}])
    // The keyboard goes to the page that is now in front, as after a submit.
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('stays where the active tab is still the one it is bound to', async () => {
    await bootPalette()
    // A tab created in the background, the state otherwise renewed: `a` stays in front.
    browserStore.set({ state: window('a', { tabs: { a: NEW_TAB_URL, b: 'https://gamma.test/' } }) })
    browserStore.set({ state: window('a') })
    expect(uiStore.get().urlbar).toMatchObject({ open: true, mode: 'new-tab', tabId: 'a' })
    expect(run).not.toHaveBeenCalledWith('focus.content', undefined)
  })

  it('re-binds to a fresh New Tab made active under it, never closing on the way', async () => {
    await bootPalette()
    let closedOnTheWay = false
    const unsubscribe = uiStore.subscribe(() => {
      if (!uiStore.get().urlbar.open) closedOnTheWay = true
    })
    try {
      // Ctrl+T over the palette (`NewTabService.open`): the state with the new tab `n` active
      // comes first, the `newtab.opened` for it after the broadcast.
      browserStore.set({ state: window('n', { tabs: { a: NEW_TAB_URL, n: NEW_TAB_URL } }) })
      // The bar is still `a`'s until `n`'s capture is in, as the reopening flow has it.
      expect(uiStore.get().urlbar).toMatchObject({ open: true, tabId: 'a' })
      await settled()
      expect(uiStore.get().urlbar).toMatchObject({ open: true, mode: 'new-tab', tabId: 'n' })
      expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'n' })
      // The core's `newtab.opened` for `n` finds the bar bound already: nothing to do.
      vi.mocked(cmd).mockClear()
      openNewTabPageUrlbar('n', undefined, false)
      await settled()
      expect(uiStore.get().urlbar).toMatchObject({ open: true, mode: 'new-tab', tabId: 'n' })
      expect(cmd).not.toHaveBeenCalledWith('overlay.snapshot', expect.anything())
    } finally {
      unsubscribe()
    }
    expect(closedOnTheWay).toBe(false)
    expect(run).not.toHaveBeenCalledWith('focus.content', undefined)
  })

  it('closes for an empty tab where no palette is to show: the new tab page off', async () => {
    await bootPalette()
    browserStore.set({
      state: window('n', { tabs: { a: NEW_TAB_URL, n: NEW_TAB_URL }, palette: false })
    })
    expect(uiStore.get().urlbar.open).toBe(false)
  })

  it('closes when the tab it is bound to is gone and nothing is in front', async () => {
    await bootPalette()
    browserStore.set({ state: window(null, { tabs: {} }) })
    expect(uiStore.get().urlbar.open).toBe(false)
  })

  it('leaves the bar bound to no tab alone: it is the window’s, not a tab’s', async () => {
    browserStore.set({ state: window('a') })
    // Ctrl+T with the new tab page off (`urlbar.toggle` in new-tab mode): `tabId` null.
    await openUrlbar('new-tab', 'a', { attached: false })
    expect(uiStore.get().urlbar).toMatchObject({ open: true, mode: 'new-tab', tabId: null })
    browserStore.set({ state: window('b') })
    expect(uiStore.get().urlbar).toMatchObject({ open: true, mode: 'new-tab', tabId: null })
    closeUrlbar()
  })
})
