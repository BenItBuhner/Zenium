// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { useGlobalKeys } from '../App'

/*
 * The chrome's Escape stack (`App.tsx` useGlobalKeys) ends in Stop: with nothing else claiming
 * the key, Escape stops the active tab's load, as Chrome and Firefox do when the keyboard is in
 * the toolbar (BUG-009, shortcuts-menus-73). The keyboard is in the chrome while a tab's first
 * navigation has no document yet (`window.ts` focusContent keeps it there) and after the URL
 * bar has handed the key back, so without this rung a page that never answers kept its spinner
 * unless the page itself had the focus (`core/keys.ts` stops it there).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(id: string, loading: boolean): Tab {
  return { id, url: 'http://127.0.0.1:9/never-answers', title: 'Loading…', loading } as Tab
}

function stateWith(active: Tab, glance: UIState['glance'] = null): UIState {
  return {
    platform: 'linux',
    capabilities: { windows: true },
    tabs: { [active.id]: active },
    spaces: [{ id: 'space', activeTabId: active.id, tabIds: [active.id], containerId: 'default' }],
    activeSpaceId: 'space',
    folders: {},
    essentialTabIds: [],
    settings: {},
    shortcuts: [],
    media: [],
    glance
  } as unknown as UIState
}

function Probe({ state }: { state: UIState }): null {
  useGlobalKeys(state)
  return null
}

let root: Root | null = null
let mount: HTMLElement | null = null
const initialUi = uiStore.get()

function render(state: UIState): void {
  browserStore.set({ state })
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(<Probe state={state} />))
}

/** Escape pressed with the keyboard in the chrome; returns whether the chrome consumed it. */
function escape(prevented = false): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  if (prevented) event.preventDefault()
  act(() => {
    window.dispatchEvent(event)
  })
  return event.defaultPrevented
}

function stops(): unknown[][] {
  return vi.mocked(run).mock.calls.filter(([name]) => name === 'tab.stop')
}

beforeEach(() => {
  vi.mocked(run).mockClear()
  uiStore.set(initialUi)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
})

describe('Escape in the chrome and a page that never answers', () => {
  it('stops the active tab while it is loading, and consumes the key', () => {
    render(stateWith(tab('t1', true)))
    expect(escape()).toBe(true)
    expect(stops()).toEqual([['tab.stop', { tabId: 't1' }]])
  })

  it('does nothing to a tab at rest: the key stays free for the page and the OS', () => {
    render(stateWith(tab('t1', false)))
    expect(escape()).toBe(false)
    expect(stops()).toEqual([])
  })

  it('reads the tab live, not the render it mounted with', () => {
    render(stateWith(tab('t1', false)))
    // The load starts after the mount: the store moves on, the listener stays.
    browserStore.set({ state: stateWith(tab('t1', true)) })
    expect(escape()).toBe(true)
    expect(stops()).toEqual([['tab.stop', { tabId: 't1' }]])
  })

  it('is the last rung: a popover that claimed the key, the URL bar, a menu and the find bar come first', () => {
    render(stateWith(tab('t1', true)))

    // A Radix layer or a Settings menulist closed itself on this Escape.
    expect(escape(true)).toBe(true)
    expect(stops()).toEqual([])

    uiStore.set({ urlbar: { ...initialUi.urlbar, open: true } })
    expect(escape()).toBe(false)
    expect(stops()).toEqual([])
    uiStore.set({ urlbar: initialUi.urlbar })

    uiStore.set({ menu: { kind: 'app', x: 0, y: 0 } as never })
    expect(escape()).toBe(false)
    expect(stops()).toEqual([])
    uiStore.set({ menu: null })

    // The find bar takes this Escape; the load is still spinning for the next one.
    uiStore.set({ findOpen: true, findTabId: 't1' })
    escape()
    expect(stops()).toEqual([])
    expect(uiStore.get().findOpen).toBe(false)
    expect(vi.mocked(run).mock.calls.some(([name]) => name === 'find.stop')).toBe(true)

    expect(escape()).toBe(true)
    expect(stops()).toEqual([['tab.stop', { tabId: 't1' }]])
  })

  it('closes Glance before it stops anything', () => {
    render(stateWith(tab('t1', true), { tabId: 'g1', parentTabId: 't1' } as UIState['glance']))
    expect(escape()).toBe(true)
    expect(stops()).toEqual([])
    expect(vi.mocked(run).mock.calls).toEqual([['glance.close', undefined]])
  })
})
