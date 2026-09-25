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
import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { NavRow } from '../SidebarTop'

/*
 * Chrome's middle-click / Ctrl+click (⌘+click on macOS) on the toolbar's Back and Forward
 * (shortcuts-menus-93): the step's page in a new background tab through `tab.backInNewTab` /
 * `tab.forwardInNewTab`; a plain click still navigates this tab.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const page: Tab = {
  id: 't1',
  url: 'https://example.com/article',
  title: 'Page',
  canGoBack: true,
  canGoForward: true,
  loading: false,
  readerable: false,
  errorCode: null,
  blockedCount: 0
} as Tab

function state(t: Tab): UIState {
  return {
    platform: 'linux',
    capabilities: { windowControls: false, windows: true },
    tabs: { [t.id]: t },
    spaces: [{ id: 'space', activeTabId: t.id, tabIds: [t.id], containerId: 'default' }],
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
    media: []
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

const nameOf = (b: HTMLButtonElement): string => b.getAttribute('aria-label') ?? b.title
const navButton = (name: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-zen-nav-row] > button')
  ].find((b) => nameOf(b).startsWith(name))
  if (!found) throw new Error(`no ${name} button`)
  return found
}

function click(el: HTMLElement, init: MouseEventInit = {}): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}

function auxclick(el: HTMLElement, button: number): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button, buttons: 0 })
    )
  })
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  viewportStore.set({ formFactor: 'desktop' })
  vi.mocked(run).mockClear()
})

describe('Back / Forward in a new tab (shortcuts-menus-93)', () => {
  it('a plain click navigates this tab; Ctrl+click and ⌘+click open the step in a new tab', () => {
    render(<NavRow state={state(page)} tab={page} compact={false} />)
    click(navButton('Back'))
    expect(run).toHaveBeenLastCalledWith('tab.back', { tabId: 't1' })
    click(navButton('Back'), { ctrlKey: true })
    expect(run).toHaveBeenLastCalledWith('tab.backInNewTab', { tabId: 't1' })
    click(navButton('Forward'), { metaKey: true })
    expect(run).toHaveBeenLastCalledWith('tab.forwardInNewTab', { tabId: 't1' })
    click(navButton('Forward'))
    expect(run).toHaveBeenLastCalledWith('tab.forward', { tabId: 't1' })
  })

  it('a middle click opens the step in a new tab; the right button is the stack menu’s and opens nothing', () => {
    render(<NavRow state={state(page)} tab={page} compact={false} />)
    auxclick(navButton('Back'), 1)
    expect(run).toHaveBeenLastCalledWith('tab.backInNewTab', { tabId: 't1' })
    auxclick(navButton('Forward'), 1)
    expect(run).toHaveBeenLastCalledWith('tab.forwardInNewTab', { tabId: 't1' })
    vi.mocked(run).mockClear()
    auxclick(navButton('Back'), 2)
    expect(run).not.toHaveBeenCalled()
  })

  it('with nothing to go back to the button is disabled and no click reaches it', () => {
    render(
      <NavRow
        state={state({ ...page, canGoBack: false })}
        tab={{ ...page, canGoBack: false }}
        compact={false}
      />
    )
    const back = navButton('Back')
    expect(back.disabled).toBe(true)
    auxclick(back, 1)
    click(back, { ctrlKey: true })
    expect(run).not.toHaveBeenCalled()
  })

  it('Shift or Alt alone is a plain click: the modifier is Ctrl or ⌘, nothing else', () => {
    render(<NavRow state={state(page)} tab={page} compact={false} />)
    click(navButton('Back'), { shiftKey: true })
    expect(run).toHaveBeenLastCalledWith('tab.back', { tabId: 't1' })
    click(navButton('Forward'), { altKey: true })
    expect(run).toHaveBeenLastCalledWith('tab.forward', { tabId: 't1' })
  })
})
