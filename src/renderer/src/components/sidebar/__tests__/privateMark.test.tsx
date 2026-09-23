// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PRIVATE_CONTAINER_ID, type Tab, type UIState } from '@shared/types'

/*
 * The private window's toolbar row draws no mark of its own (profiles-25; design language v2
 * §9.19 as amended at #408's review): the window's one indicator is the sidebar's – the
 * labelled "Private Browsing" header row when expanded, the rail's mask when collapsed, the
 * strip's mask in the horizontal layout – and Zenium owes no avatar slot (no account, no
 * avatar), so nothing stands between the extensions and the ⋯ button to say it again. The one
 * mask the row may carry is the pill's, in the site-information slot: the TAB's private state,
 * keyed by W4-7 on the tab and not on the window.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NavRow } = await import('../SidebarTop')
const { browserStore } = await import('@renderer/lib/ui')
const { defaultShortcuts } = await import('@shared/shortcuts')

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

function tab(containerId = 'default'): Tab {
  return {
    id: 't1',
    spaceId: 'space',
    containerId,
    url: 'https://example.com/',
    title: 'Example',
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

function state(t: Tab, kind: 'normal' | 'private'): UIState {
  return {
    platform: 'linux',
    capabilities: { windowControls: false },
    tabs: { [t.id]: t },
    spaces: [
      {
        id: 'space',
        name: 'Work',
        icon: '',
        containerId: 'default',
        theme: null,
        tabIds: [t.id],
        activeTabId: t.id,
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 'space',
    settings: { urlbarBehavior: 'normal' },
    window: { kind, fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {},
    translate: { available: false, tabs: {} },
    securityPrompts: [],
    autofill: { prompts: [], picker: null }
  } as unknown as UIState
}

let root: Root | null = null
let host: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  browserStore.set({ state: null })
})

const masks = (el: HTMLElement): HTMLElement[] =>
  Array.from(el.querySelectorAll<HTMLElement>('svg.lucide-venetian-mask'))

describe('the private window’s toolbar row', () => {
  it('draws no mark of its own: the one mask in the row is the pill’s, the tab’s, in the site-information slot', () => {
    const page = tab(PRIVATE_CONTAINER_ID)
    const el = render(<NavRow state={state(page, 'private')} tab={page} compact={false} />)
    expect(el.querySelector('[data-zen-private-mark]')).toBeNull()
    expect(el.querySelector('.zen-toolbar-mark')).toBeNull()
    expect(el.querySelector('[role="img"][aria-label="Private browsing"]')).toBeNull()
    const drawn = masks(el)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.closest('[role="group"][aria-label="Address"]')).not.toBeNull()
    expect(drawn[0]!.hasAttribute('data-private-mark')).toBe(true)
    // No indicator stands before ⋯: what precedes it is the row's own (here the pill's box).
    const menu = el.querySelector('[data-zen-app-menu-button]')
    expect(menu).not.toBeNull()
    expect(menu!.previousElementSibling?.matches('[role="img"], .zen-toolbar-mark')).toBe(false)
  })

  it('draws none in the compact column either, where the rail’s own mask names the window', () => {
    const page = tab(PRIVATE_CONTAINER_ID)
    const el = render(<NavRow state={state(page, 'private')} tab={page} compact />)
    expect(masks(el)).toHaveLength(0)
    expect(el.querySelector('[data-zen-private-mark]')).toBeNull()
  })

  it('keeps the pill’s mask on the tab, not the window: a private tab in a regular window has it, a regular tab does not', () => {
    const secret = tab(PRIVATE_CONTAINER_ID)
    expect(
      masks(render(<NavRow state={state(secret, 'normal')} tab={secret} compact={false} />))
    ).toHaveLength(1)
    act(() => root?.unmount())
    host?.remove()
    expect(
      masks(render(<NavRow state={state(tab(), 'normal')} tab={tab()} compact={false} />))
    ).toHaveLength(0)
  })

  it('has no toolbar-mark rule left in the stylesheet', () => {
    expect(css).not.toContain('.zen-toolbar-mark')
  })
})
