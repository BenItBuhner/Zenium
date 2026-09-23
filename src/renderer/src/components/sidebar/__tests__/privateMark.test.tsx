// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PRIVATE_CONTAINER_ID, type Tab, type UIState } from '@shared/types'

/*
 * The private window's mark (profiles-25; design language v2 §9.19): Firefox's mask indicator
 * in the slot Chrome's incognito glyph takes from the profile avatar – between the extensions
 * and the ⋯ menu button of the toolbar row – drawn only in a private window, in every layout
 * the row is drawn in. An indicator, not a button: a toolbar button's box and glyph, no stop in
 * the tab order, its name as its tooltip.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NavRow } = await import('../SidebarTop')
const { browserStore } = await import('@renderer/lib/ui')
const { defaultShortcuts } = await import('@shared/shortcuts')

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/** The text of the first `selector {` rule in the stylesheet. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

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

const mark = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>('[data-zen-private-mark]')

describe('the private window’s mark in the toolbar row', () => {
  it('is drawn in a private window, just before the menu button, as an indicator and not a button', () => {
    const page = tab(PRIVATE_CONTAINER_ID)
    const el = render(<NavRow state={state(page, 'private')} tab={page} compact={false} />)
    const m = mark(el)
    expect(m).not.toBeNull()
    expect(m!.tagName).toBe('SPAN')
    expect(m!.getAttribute('role')).toBe('img')
    expect(m!.getAttribute('aria-label')).toBe('Private browsing')
    expect(m!.getAttribute('title')).toBe('Private browsing')
    expect(m!.tabIndex).toBeLessThan(0)
    expect(m!.classList.contains('zen-toolbar-mark')).toBe(true)
    // The mask at the toolbar glyph's size and stroke (§9.3).
    const glyph = m!.querySelector('svg.lucide-venetian-mask')
    expect(glyph).not.toBeNull()
    expect(glyph!.getAttribute('class')).toContain('h-4 w-4')
    expect(glyph!.getAttribute('stroke-width')).toBe('1.5')
    // The avatar's slot: the last thing before ⋯.
    expect(m!.nextElementSibling?.hasAttribute('data-zen-app-menu-button')).toBe(true)
    // One of a kind in the row.
    expect(el.querySelectorAll('[data-zen-private-mark]')).toHaveLength(1)
  })

  it('is drawn in the compact column too, where no sidebar header names the window', () => {
    const page = tab(PRIVATE_CONTAINER_ID)
    const el = render(<NavRow state={state(page, 'private')} tab={page} compact />)
    expect(mark(el)).not.toBeNull()
    expect(mark(el)!.nextElementSibling?.hasAttribute('data-zen-app-menu-button')).toBe(true)
  })

  it('is not drawn in a regular window – not even for a private tab shown in one (the pill’s mask marks that)', () => {
    expect(
      mark(render(<NavRow state={state(tab(), 'normal')} tab={tab()} compact={false} />))
    ).toBeNull()
    const secret = tab(PRIVATE_CONTAINER_ID)
    act(() => root?.unmount())
    host?.remove()
    expect(
      mark(render(<NavRow state={state(secret, 'normal')} tab={secret} compact={false} />))
    ).toBeNull()
  })

  it('holds a toolbar button’s box in the window’s ink, with no hover fill of its own', () => {
    const box = rule('.zen-toolbar-mark')
    expect(box).toContain('width: 28px')
    expect(box).toContain('height: 28px')
    expect(box).toContain('color: var(--zen-fg)')
    expect(rule('.zen-toolbar-mark > svg')).toContain('opacity: 0.85')
    expect(css).not.toContain('.zen-toolbar-mark:hover')
  })
})
