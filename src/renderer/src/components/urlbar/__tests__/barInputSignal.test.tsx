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
const { uiStore } = await import('@renderer/lib/ui')

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
  return { open: true, mode: 'new-tab', tabId: 't1', initialText: undefined, attached: false, ...patch }
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
