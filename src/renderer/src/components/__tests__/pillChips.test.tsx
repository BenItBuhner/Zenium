// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'

/*
 * The chips inside the URL pill (design language v2 §9.22): the address first, then every chip
 * as a real button in the tab order with its own label, `aria-haspopup` and `aria-expanded`
 * where it opens something, `aria-pressed` where it toggles. Rendered for real, on both the
 * desktop pill (`NavRow`) and the phone pill (`PillContent`), collapsed and expanded.
 */

const invoke = vi.fn(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NavRow } = await import('../sidebar/SidebarTop')
const { PillContent } = await import('../phone/PhoneShell')
const { uiStore } = await import('@renderer/lib/ui')
const { siteInfoStore } = await import('@renderer/lib/siteInfo')

function tab(url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    spaceId: 'space',
    containerId: 'default',
    url,
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
    blockedCount: 0,
    ...patch
  } as Tab
}

const space: Space = {
  id: 'space',
  name: 'Work',
  icon: '',
  containerId: 'default',
  theme: null,
  tabIds: ['t1'],
  activeTabId: 't1',
  pinnedCollapsed: false
}

function state(t: Tab | null): UIState {
  return {
    platform: 'linux',
    capabilities: { windowControls: false },
    tabs: t ? { [t.id]: t } : {},
    spaces: [space],
    activeSpaceId: 'space',
    settings: { urlbarBehavior: 'normal' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: []
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

const focusable = (scope: ParentNode): HTMLElement[] =>
  Array.from(scope.querySelectorAll<HTMLElement>('button, [tabindex]')).filter(
    (el) => el.tabIndex >= 0
  )

const labels = (els: HTMLElement[]): (string | null)[] =>
  els.map((el) => el.getAttribute('aria-label'))

function expectChip(el: HTMLElement, label: string): void {
  expect(el.tagName).toBe('BUTTON')
  expect(el.getAttribute('type')).toBe('button')
  expect(el.tabIndex).toBe(0)
  expect(el.getAttribute('aria-label')).toBe(label)
}

beforeEach(() => {
  uiStore.set({ siteInfoOpen: false, overlay: 'none' })
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false } }))
  siteInfoStore.set({ tabId: null, anchor: null })
  invoke.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('desktop pill (NavRow)', () => {
  const page = tab('https://example.com/some/path', { readerable: true })

  it('is a group whose field comes first, then each chip as a button in the tab order', () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')
    expect(pill).not.toBeNull()
    // No nested interactive content: the pill itself is not a button any more.
    expect(pill!.tagName).toBe('DIV')
    expect(pill!.querySelectorAll('[role="button"]').length).toBe(0)

    const order = focusable(pill!)
    expect(order[0].tagName).toBe('BUTTON')
    expect(order[0].textContent).toBe('example.com/some/path')
    expect(labels(order.slice(1))).toEqual([
      'Site information',
      'Reader View',
      'Boost this site',
      'Copy URL'
    ])
    for (const [i, chip] of order.slice(1).entries()) expectChip(chip, labels(order.slice(1))[i]!)
    // The site icon is drawn ahead of the field, after it in the DOM.
    expect(order[1].className).toContain('order-first')
  })

  it('exposes what each chip opens and whether it is open', () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const chip = (label: string): HTMLElement =>
      el.querySelector<HTMLElement>(`[aria-label="${label}"]`)!

    expect(chip('Site information').getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip('Site information').getAttribute('aria-expanded')).toBe('false')
    expect(chip('Boost this site').getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip('Boost this site').getAttribute('aria-expanded')).toBe('false')
    // Actions and toggles open nothing.
    expect(chip('Copy URL').hasAttribute('aria-haspopup')).toBe(false)
    expect(chip('Copy URL').hasAttribute('aria-expanded')).toBe(false)
    expect(chip('Reader View').hasAttribute('aria-haspopup')).toBe(false)
    expect(chip('Reader View').getAttribute('aria-pressed')).toBe('false')

    act(() => uiStore.set({ siteInfoOpen: true }))
    expect(chip('Site information').getAttribute('aria-expanded')).toBe('true')
    expect(chip('Boost this site').getAttribute('aria-expanded')).toBe('false')

    act(() => uiStore.set({ siteInfoOpen: false, overlay: 'boosts' }))
    expect(chip('Site information').getAttribute('aria-expanded')).toBe('false')
    expect(chip('Boost this site').getAttribute('aria-expanded')).toBe('true')
  })

  it('marks Reader View pressed while the tab is in it', () => {
    const reader = tab('zen://reader?url=https%3A%2F%2Fexample.com%2F')
    const el = render(<NavRow state={state(reader)} tab={reader} compact={false} />)
    const chip = el.querySelector<HTMLElement>('[aria-label="Reader View"]')!
    expectChip(chip, 'Reader View')
    expect(chip.getAttribute('aria-pressed')).toBe('true')
  })

  it('opens the site information from the chip without also opening the URL bar', async () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const chip = el.querySelector<HTMLElement>('[aria-label="Site information"]')!
    // Enter and Space on a button dispatch a click; so does a pointer.
    await act(async () => {
      chip.click()
      await Promise.resolve()
    })
    expect(uiStore.get().siteInfoOpen).toBe(true)
    expect(siteInfoStore.get().tabId).toBe('t1')
    expect(uiStore.get().urlbar.open).toBe(false)
  })

  it('opens the URL bar from the field', async () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const field = focusable(el.querySelector('[role="group"]')!)[0]
    await act(async () => {
      field.click()
      await Promise.resolve()
    })
    expect(uiStore.get().urlbar.open).toBe(true)
    expect(uiStore.get().urlbar.mode).toBe('edit')
    expect(uiStore.get().siteInfoOpen).toBe(false)
  })

  it('reveals the hover-only chips while the keyboard is on one of the chips', () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const pill = el.querySelector<HTMLElement>('[role="group"]')!
    // Every chip carries the marker and sits in the chips' focus scope; the address does neither.
    const field = focusable(pill)[0]
    expect(el.querySelectorAll('[data-pill-chip]').length).toBe(4)
    expect(field.hasAttribute('data-pill-chip')).toBe(false)
    const scope = pill.querySelector<HTMLElement>('.group\\/chips')!
    expect(scope.className).toContain('contents')
    expect(scope.contains(field)).toBe(false)
    expect(scope.querySelectorAll('[data-pill-chip]').length).toBe(4)
    for (const label of ['Boost this site', 'Copy URL']) {
      const chip = el.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
      expect(chip.className).toContain('hidden')
      expect(chip.className).toContain('group-hover/pill:flex')
      expect(chip.className).toContain('group-focus-within/chips:flex')
    }
  })

  it('shows only the search glyph and the field with no tab', () => {
    const el = render(<NavRow state={state(null)} tab={null} compact={false} />)
    const pill = el.querySelector<HTMLElement>('[role="group"]')!
    const order = focusable(pill)
    expect(order.length).toBe(1)
    expect(order[0].textContent).toBe('Search or enter address')
  })
})

describe('phone pill (PillContent)', () => {
  const page = tab('https://example.com/some/path')

  it('puts the address first, then the site icon and the lock as chips', () => {
    const el = render(<PillContent state={state(page)} tab={page} space={space} interactive />)
    const order = focusable(el)
    expect(order.length).toBe(3)
    expect(order[0].getAttribute('aria-label')).toBe('Address, example.com')
    expectChip(order[1], 'Site information')
    expectChip(order[2], 'Connection is secure')
    expect(order[1].hasAttribute('data-site-info')).toBe(true)
    expect(order[2].hasAttribute('data-site-info')).toBe(true)
    expect(order[1].className).toContain('order-first')
  })

  it('reflects the open site-information sheet on both chips', () => {
    const el = render(<PillContent state={state(page)} tab={page} space={space} interactive />)
    const chips = focusable(el).slice(1)
    for (const chip of chips) {
      expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
      expect(chip.getAttribute('aria-expanded')).toBe('false')
    }
    act(() => uiStore.set({ siteInfoOpen: true }))
    for (const chip of chips) expect(chip.getAttribute('aria-expanded')).toBe('true')
  })

  it('has no lock chip on a plain http page', () => {
    const http = tab('http://example.com/')
    const el = render(<PillContent state={state(http)} tab={http} space={space} interactive />)
    expect(labels(focusable(el))).toEqual(['Address, example.com', 'Site information'])
  })

  it('draws the ghost pill with nothing focusable or announced', () => {
    const el = render(
      <PillContent state={state(page)} tab={page} space={space} interactive={false} />
    )
    expect(focusable(el).length).toBe(0)
    expect(el.querySelectorAll('button').length).toBe(0)
    expect(el.querySelectorAll('[aria-label]').length).toBe(0)
    // The two chips are plain hidden spans in the pill's row (the favicon tile is inside one).
    const row = el.firstElementChild!
    expect(row.querySelectorAll(':scope > span[aria-hidden]').length).toBe(2)
  })
})
