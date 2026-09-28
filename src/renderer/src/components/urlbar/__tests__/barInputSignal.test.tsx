// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HostCapabilities, Tab, UIState } from '@shared/types'
import type { UrlbarState } from '@renderer/lib/ui'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { NEW_TAB_URL } from '@shared/url'

/*
 * W8-F15 — the per-tab URL-bar-input signal the core's `freshTabIn` reads. The desktop bar, over a
 * fresh new tab page, tells the core through `urlbar.input { tabId, active }` when the field first
 * holds a draft the user typed, and when it goes back to empty or the bar closes. The signal fires
 * on the FLIP of that boolean, not per keystroke, so a tab being typed into is not a fresh empty
 * one a launch URL may take, as Chrome's omnibox keeps its NTP from being reused while
 * `user_input_in_progress()`.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'urlbar.suggest') return []
  return null
})
const on = (): (() => void) => () => undefined
Object.assign(window, { zen: { invoke, on } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { Urlbar } = await import('../Urlbar')
const { browserStore, openNewTabPageUrlbar, uiStore } = await import('@renderer/lib/ui')
const { refreshViewport, viewportStore } = await import('@renderer/lib/formFactor')

function tab(patch: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    spaceId: 'space',
    containerId: 'default',
    url: NEW_TAB_URL,
    title: '',
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
    blockedCount: 0,
    ...patch
  } as Tab
}

function state(t: Tab, capabilities: Partial<HostCapabilities> = { newTabPage: true }): UIState {
  return {
    platform: 'linux',
    capabilities,
    tabs: { [t.id]: t },
    spaces: [],
    activeSpaceId: 'space',
    settings: { ...DEFAULT_SETTINGS, searchEngineId: 'google' },
    searchEngines: DEFAULT_SEARCH_ENGINES,
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

function urlbarState(patch: Partial<UrlbarState> = {}): UrlbarState {
  return {
    open: true,
    mode: 'new-tab',
    tabId: 't1',
    initialText: undefined,
    attached: false,
    ...patch
  }
}

const view = (
  t: Tab = tab(),
  urlbar: UrlbarState = urlbarState(),
  phoneEdge: 'top' | 'bottom' | undefined = undefined
): ReactElement =>
  createElement(Urlbar, {
    state: state(t),
    urlbar,
    area: { x: 0, y: 0, width: 1200, height: 800 },
    phoneEdge
  })

let root: Root | null = null
let host: HTMLElement | null = null

async function render(el: ReactElement): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(el)
  })
  await act(async () => {
    await Promise.resolve()
  })
  return host
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = null
  host?.remove()
  host = null
}

const inputEl = (el: HTMLElement): HTMLInputElement =>
  el.querySelector<HTMLInputElement>('[data-testid="urlbar-input"]')!

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    nativeValue.call(el, value)
    el.setSelectionRange(value.length, value.length)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

const inputs = (): Array<{ tabId: string; active: boolean }> =>
  invoke.mock.calls
    .filter(([name]) => name === 'urlbar.input')
    .map(([, args]) => args as { tabId: string; active: boolean })

beforeEach(() => {
  invoke.mockClear()
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: true } }))
})

afterEach(async () => {
  await unmount()
})

describe('the URL bar tells the core when it holds input for a tab (W8-F15)', () => {
  it('a fresh NTP with nothing typed announces no input', async () => {
    await render(view())
    expect(inputs()).toEqual([])
  })

  it('text typed into the bar flips the signal true, once, not per keystroke', async () => {
    const el = await render(view())
    await type(inputEl(el), 'f')
    await type(inputEl(el), 'fo')
    await type(inputEl(el), 'foo')
    // Three keystrokes, one flip to true.
    expect(inputs()).toEqual([{ tabId: 't1', active: true }])
  })

  it('clearing the field flips the signal false', async () => {
    const el = await render(view())
    await type(inputEl(el), 'foo')
    await type(inputEl(el), '')
    expect(inputs()).toEqual([
      { tabId: 't1', active: true },
      { tabId: 't1', active: false }
    ])
  })

  it('closing the bar with a draft out flips the signal false (the draft is gone with it)', async () => {
    const el = await render(view())
    await type(inputEl(el), 'foo')
    expect(inputs()).toEqual([{ tabId: 't1', active: true }])
    await unmount()
    expect(inputs()).toEqual([
      { tabId: 't1', active: true },
      { tabId: 't1', active: false }
    ])
  })

  it('closing the bar with no draft sends nothing (never was active)', async () => {
    await render(view())
    await unmount()
    expect(inputs()).toEqual([])
  })

  it('a window-level bar bound to no tab marks nothing', async () => {
    const el = await render(view(tab(), urlbarState({ tabId: null })))
    await type(inputEl(el), 'foo')
    expect(inputs()).toEqual([])
  })

  it('the phone runs the same signal (its host leaves it unread)', async () => {
    const el = await render(view(tab(), urlbarState(), 'bottom'))
    await type(inputEl(el), 'foo')
    // The same command fires on the phone; the core has no `freshTabIn` caller there.
    expect(inputs()).toEqual([{ tabId: 't1', active: true }])
  })
})

/*
 * Round two of W8-F15 – the draft goes with the tab (Chrome's per-tab omnibox state). The palette
 * bound to a tab follows the window's active tab (W5-F4, `urlbarFollowsActiveTab`); what its
 * field held when it left is saved by tab id and comes back – text, selection, keyword chip –
 * when the tab is active again, and the signal above follows it: false on the leave, true again
 * on the return. The bar is mounted as the desktop shell mounts it (`ContentArea`): one instance
 * per bound tab, keyed so, gone when the bar is down.
 */

/** A window on one space with `tabs`, `active` in front, for the shell's mount below. */
function windowState(active: string, tabs: Tab[]): UIState {
  return {
    ...state(tabs[0]!),
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [{ id: 'space', name: 'Space', activeTabId: active, tabIds: tabs.map((t) => t.id) }],
    essentialTabIds: [],
    folders: {},
    // Not under the first-run tour, which holds the bar (`onboardingUp`).
    settings: { ...DEFAULT_SETTINGS, onboardingDone: true, searchEngineId: 'google' },
    shortcuts: [],
    systemDark: false,
    window: { kind: 'synced', chrome: 'full', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

/**
 * The shell's mount of the bar: `ContentArea` and `TabletShell` mount it bare, `PhoneShell` with
 * its `phoneEdge` – the same component, keyed to the tab it is bound to.
 */
function Host({ phoneEdge }: { phoneEdge?: 'top' | 'bottom' }): ReactElement | null {
  const urlbar = uiStore.use((s) => s.urlbar)
  const st = browserStore.use((s) => s.state)
  if (!urlbar.open || !st) return null
  return createElement(Urlbar, {
    key: `${urlbar.mode}-${urlbar.tabId ?? 'new'}`,
    state: st,
    urlbar,
    area: { x: 0, y: 0, width: 1200, height: 800 },
    phoneEdge
  })
}

/**
 * The chrome's layout, forced the way the preview host forces it (`?formFactor=`,
 * `forcedFormFactor`): the renderer re-derives its layout from the window on every state tick
 * (`formFactor.ts`, `refresh`), so a value set on the store alone would not outlive the first
 * `arrive` – the chrome URL does. `null` lets the window decide again (happy-dom's: a desktop).
 */
function layout(formFactor: 'phone' | 'tablet' | 'desktop' | null): void {
  history.replaceState(null, '', formFactor ? `?formFactor=${formFactor}` : location.pathname)
  refreshViewport()
  expect(viewportStore.get().formFactor).toBe(formFactor ?? 'desktop')
}

/** A state from the core, and the turn after it: the capture behind a palette's open, the rows' fetch. */
async function arrive(st: UIState): Promise<void> {
  await act(async () => {
    browserStore.set({ state: st })
    await new Promise((r) => setTimeout(r, 0))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function key(target: HTMLElement, k: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

const field = (): HTMLInputElement | null =>
  host?.querySelector<HTMLInputElement>('[data-testid="urlbar-input"]') ?? null

describe('the draft goes with the tab, and the signal with it (W8-F15, round two)', () => {
  const ntp = tab()
  const page = tab({ id: 't2', url: 'https://gamma.test/' })
  const other = tab({ id: 't3' })

  /** The boot's palette over the New Tab `t1`, mounted by the shell. */
  async function bootPalette(
    tabs: Tab[] = [ntp, page],
    phoneEdge?: 'top' | 'bottom'
  ): Promise<HTMLInputElement> {
    await render(createElement(Host, { phoneEdge }))
    await arrive(windowState('t1', tabs))
    await act(async () => {
      openNewTabPageUrlbar('t1', undefined, false)
      await new Promise((r) => setTimeout(r, 0))
    })
    // The bar's own dismissal draft (`Urlbar.tsx`, `drafts`: what was typed is kept through an
    // Escape on the desktop layout – `urlbarKeepsTabDrafts`, the one predicate; W8-F17) may be
    // up from an earlier pin's Escape – the bar's rule, not these pins' subject: cleared, so
    // each pin starts from an empty field.
    const el = field()!
    if (el.value) await type(el, '')
    invoke.mockClear()
    return el
  }

  beforeEach(() => {
    layout('desktop')
    uiStore.set({
      urlbar: {
        open: false,
        mode: 'new-tab',
        tabId: null,
        initialText: undefined,
        attached: false
      },
      urlbarDrafts: {}
    })
  })

  afterEach(async () => {
    await unmount()
    browserStore.set({ state: null })
    layout(null)
    uiStore.set({
      urlbar: {
        open: false,
        mode: 'new-tab',
        tabId: null,
        initialText: undefined,
        attached: false
      },
      urlbarDrafts: {}
    })
  })

  it('typed into the NTP, the handed-over URL opens active, back: the bar is up with the same text and caret, the signal true again', async () => {
    const el = await bootPalette()
    await type(el, 'hello world')
    el.setSelectionRange(6, 11)
    expect(inputs()).toEqual([{ tabId: 't1', active: true }])
    // The handed-over URL opened in the foreground (`freshTabIn` found `t1` typed into, so the
    // launch URL took a tab of its own): `t2` in front, the bar down, the signal false.
    await arrive(windowState('t2', [ntp, page]))
    expect(field()).toBeNull()
    expect(inputs()).toEqual([
      { tabId: 't1', active: true },
      { tabId: 't1', active: false }
    ])
    // Back to the New Tab: the bar is up over it as it was left – the text, "world" selected,
    // the field focused – and the core hears the tab is typed into again.
    await arrive(windowState('t1', [ntp, page]))
    const back = field()
    expect(back).not.toBeNull()
    expect(back!.value).toBe('hello world')
    expect([back!.selectionStart, back!.selectionEnd]).toEqual([6, 11])
    expect(document.activeElement).toBe(back)
    expect(inputs()).toEqual([
      { tabId: 't1', active: true },
      { tabId: 't1', active: false },
      { tabId: 't1', active: true }
    ])
    // The field is one instance again: typing on carries the signal as ever.
    await type(back!, 'hello there')
    expect(inputs()).toHaveLength(3)
  })

  it('a tab left with nothing typed restores no bar, and the signal never fired', async () => {
    await bootPalette()
    await arrive(windowState('t2', [ntp, page]))
    expect(field()).toBeNull()
    await arrive(windowState('t1', [ntp, page]))
    expect(field()).toBeNull()
    expect(inputs()).toEqual([])
  })

  it('a draft dismissed with Escape before the leave restores nothing', async () => {
    const el = await bootPalette()
    await type(el, 'hello')
    // Escape, staged (omnibox-50): the text reverts to the page's – nothing, over a New Tab –
    // then the bar closes; the signal goes false with the text.
    await key(el, 'Escape')
    if (uiStore.get().urlbar.open) await key(field()!, 'Escape')
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(inputs()).toEqual([
      { tabId: 't1', active: true },
      { tabId: 't1', active: false }
    ])
    await arrive(windowState('t2', [ntp, page]))
    await arrive(windowState('t1', [ntp, page]))
    expect(field()).toBeNull()
    expect(inputs()).toHaveLength(2)
  })

  it('a draft committed before the leave restores nothing: the tab is a page now', async () => {
    const el = await bootPalette()
    await type(el, 'gamma')
    // Enter: the bar closes, the tab loads the result.
    await key(el, 'Enter')
    expect(uiStore.get().urlbar.open).toBe(false)
    const loaded = tab({ url: 'https://gamma.test/?q=gamma' })
    await arrive(windowState('t1', [loaded, page]))
    await arrive(windowState('t2', [loaded, page]))
    await arrive(windowState('t1', [loaded, page]))
    expect(field()).toBeNull()
    expect(uiStore.get().urlbarDrafts).toEqual({})
  })

  it('the tab closed while away takes its draft with it', async () => {
    const el = await bootPalette()
    await type(el, 'hello')
    await arrive(windowState('t2', [ntp, page]))
    expect(uiStore.get().urlbarDrafts).toEqual({ t1: expect.objectContaining({ text: 'hello' }) })
    await arrive(windowState('t2', [page]))
    expect(uiStore.get().urlbarDrafts).toEqual({})
  })

  it('two tabs with two drafts keep their own, the field one instance per tab', async () => {
    const el = await bootPalette([ntp, other])
    await type(el, 'alpha')
    // Ctrl+T over the palette: the fresh New Tab `t3` in front, the palette re-bound to it.
    await arrive(windowState('t3', [ntp, other]))
    const third = field()!
    expect(third.value).toBe('')
    await type(third, 'november')
    await arrive(windowState('t1', [ntp, other]))
    expect(field()!.value).toBe('alpha')
    await arrive(windowState('t3', [ntp, other]))
    expect(field()!.value).toBe('november')
    expect(uiStore.get().urlbarDrafts).toEqual({ t1: expect.objectContaining({ text: 'alpha' }) })
    // Each tab's signal in its own turn: `t1` typed, left, back, left; `t3` typed, left, back.
    expect(inputs()).toEqual([
      { tabId: 't1', active: true },
      { tabId: 't1', active: false },
      { tabId: 't3', active: true },
      { tabId: 't3', active: false },
      { tabId: 't1', active: true },
      { tabId: 't1', active: false },
      { tabId: 't3', active: true }
    ])
  })

  it('the keyword chip comes back with the draft', async () => {
    await render(createElement(Host))
    // `t1` left in `@ddg` keyword mode, the terms alone in the field, `t2` in front.
    uiStore.set({
      urlbarDrafts: {
        t1: {
          text: 'cats',
          selectionStart: 4,
          selectionEnd: 4,
          selectionDirection: 'none',
          keyword: { engineId: 'duckduckgo', typed: '@ddg' },
          attached: false
        }
      }
    })
    await arrive(windowState('t2', [ntp, page]))
    await arrive(windowState('t1', [ntp, page]))
    const el = field()
    expect(el).not.toBeNull()
    expect(el!.value).toBe('cats')
    expect(host!.textContent).toContain('Search DuckDuckGo')
  })

  it('a restored draft is the bar’s again: dismissed, it is gone; the tab left and back restores nothing', async () => {
    const el = await bootPalette()
    await type(el, 'hello')
    await arrive(windowState('t2', [ntp, page]))
    await arrive(windowState('t1', [ntp, page]))
    const back = field()!
    expect(back.value).toBe('hello')
    await key(back, 'Escape')
    if (uiStore.get().urlbar.open) await key(field()!, 'Escape')
    expect(uiStore.get().urlbar.open).toBe(false)
    await arrive(windowState('t2', [ntp, page]))
    await arrive(windowState('t1', [ntp, page]))
    expect(field()).toBeNull()
  })

  /*
   * The form-factor gate (`urlbarKeepsTabDrafts`, `formFactor === 'desktop'`): Chrome's per-tab
   * omnibox state is Chrome desktop's; Chrome for Android drops the edit on a switcher tab
   * switch, and the Android tablet is Chrome Android too. The same `Urlbar`, two behaviours
   * (§9.34): on the phone and the tablet the palette follows the active tab as W5-F4 had it and
   * the tab's return brings no bar back – while the input signal to the core is the desktop's on
   * every layout (round one, ungated).
   */
  async function typedLeftAndBack(phoneEdge?: 'top' | 'bottom'): Promise<void> {
    const el = await bootPalette([ntp, page], phoneEdge)
    await type(el, 'hello world')
    expect(inputs()).toEqual([{ tabId: 't1', active: true }])
    await arrive(windowState('t2', [ntp, page]))
    expect(field()).toBeNull()
    // Nothing written on the leave – whatever the field held.
    expect(uiStore.get().urlbarDrafts).toEqual({})
    await arrive(windowState('t1', [ntp, page]))
    // No bar back on the return, and the signal has no `true` to add: the tab is fresh again.
    expect(field()).toBeNull()
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(inputs()).toEqual([
      { tabId: 't1', active: true },
      { tabId: 't1', active: false }
    ])
  }

  it('the TABLET shows no restore on the return: Chrome Android drops the edit on a tab switch; the signal is the same', async () => {
    // `TabletShell` mounts the bar bare, as the desktop does: the layout alone tells them apart.
    layout('tablet')
    await typedLeftAndBack()
  })

  it('the phone shows no restore on the return either; the signal is the same', async () => {
    layout('phone')
    await typedLeftAndBack('bottom')
  })
})
