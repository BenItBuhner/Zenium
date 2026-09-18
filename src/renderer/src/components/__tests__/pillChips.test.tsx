// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, Space, Tab, UIState } from '@shared/types'

/*
 * The chips inside the URL pill (design language v2 §9.22): the address first, then every chip
 * as a real button in the tab order with its own label, `aria-haspopup` and `aria-expanded`
 * where it opens something, `aria-pressed` where it toggles. Rendered for real, on both the
 * desktop pill (`NavRow`) and the phone pill (`PillContent`), collapsed and expanded. The
 * desktop pill ends in the bookmark star, whose popup is the star bubble.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NavRow, SidebarTop } = await import('../sidebar/SidebarTop')
const { Toolbar } = await import('../Toolbar')
const { PillContent } = await import('../phone/PhoneShell')
const { PillChip } = await import('../urlbar/PillChip')
const { openUrlbar, uiStore } = await import('@renderer/lib/ui')
const { closeSiteInfo, siteInfoStore } = await import('@renderer/lib/siteInfo')
const { defaultShortcuts } = await import('@shared/shortcuts')

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

function state(t: Tab | null, bookmarks: BookmarkNode[] = []): UIState {
  return {
    platform: 'linux',
    capabilities: { windowControls: false },
    tabs: t ? { [t.id]: t } : {},
    spaces: [space],
    activeSpaceId: 'space',
    settings: { urlbarBehavior: 'normal' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks,
    // Nothing downloading: the bar's downloads button stays away.
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    // Tooltips quote the chord from the active key table (the default Chrome set here).
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {}
  } as unknown as UIState
}

/** A bookmark of `url` on the bookmarks bar. */
function bookmarkOf(url: string): BookmarkNode {
  return { id: 'b1', parentId: '1', index: 0, type: 'url', title: 'Example', url, dateAdded: 0 }
}

/** The state with `n` pop-ups refused for the tab: the blocked pop-ups chip shows. */
function withBlocked(t: Tab, n: number): UIState {
  const refused = Array.from({ length: n }, (_, i) => ({
    url: `https://ads.example/${i}`,
    at: i,
    kind: 'popup' as const
  }))
  return { ...state(t), blockedPopups: { [t.id]: refused } }
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

/** The commands the chrome sent the host so far, in order. */
const commands = (): string[] => invoke.mock.calls.map(([name]) => name)

/** Open the site information from the chip with the keyboard: Enter on the focused button. */
async function openFromChip(chip: HTMLElement): Promise<void> {
  chip.focus()
  expect(document.activeElement).toBe(chip)
  await act(async () => {
    chip.click()
    await vi.waitFor(() => expect(uiStore.get().siteInfoOpen).toBe(true))
  })
}

/**
 * Escape, a click outside or the back gesture: the sheet's dismissal, whose spring runs on the
 * animation frame (`setImmediate` under happy-dom) and ends where every close does.
 */
async function dismiss(): Promise<void> {
  await act(async () => {
    closeSiteInfo()
    await vi.waitFor(() => expect(uiStore.get().siteInfoOpen).toBe(false))
  })
}

function expectChip(el: HTMLElement, label: string): void {
  expect(el.tagName).toBe('BUTTON')
  expect(el.getAttribute('type')).toBe('button')
  expect(el.tabIndex).toBe(0)
  expect(el.getAttribute('aria-label')).toBe(label)
}

beforeEach(() => {
  uiStore.set({ siteInfoOpen: false, overlay: 'none', starDialog: null, blockedPopupsPanel: null })
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
      'Copy URL',
      'Bookmark this tab'
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
    expect(chip('Bookmark this tab').getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip('Bookmark this tab').getAttribute('aria-expanded')).toBe('false')
    expect(chip('Bookmark this tab').hasAttribute('aria-pressed')).toBe(false)
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

    // The star bubble is the star's popup, and only for the tab it was opened for.
    const bubble = { tabId: 't1', nodeId: 'b1', created: true, anchor: null, pill: null }
    act(() => uiStore.set({ overlay: 'none', starDialog: bubble }))
    expect(chip('Bookmark this tab').getAttribute('aria-expanded')).toBe('true')
    expect(chip('Bookmark this tab').getAttribute('data-open')).toBe('true')
    act(() => uiStore.set({ starDialog: { ...bubble, tabId: 't2' } }))
    expect(chip('Bookmark this tab').getAttribute('aria-expanded')).toBe('false')
  })

  it('names the star by whether the page is bookmarked and fills it once it is', () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const star = el.querySelector<HTMLElement>('[data-bm-star]')!
    expectChip(star, 'Bookmark this tab')
    expect(star.getAttribute('data-filled')).toBe('false')
    expect(star.title).toBe('Bookmark this tab (Ctrl+D)')

    act(() =>
      root!.render(
        <NavRow state={state(page, [bookmarkOf(page.url)])} tab={page} compact={false} />
      )
    )
    expectChip(star, 'Edit bookmark')
    expect(star.getAttribute('data-filled')).toBe('true')
    expect(star.title).toBe('Edit bookmark (Ctrl+D)')
  })

  it('stars the page from the chip, and puts its bubble away from the chip again', async () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const star = el.querySelector<HTMLElement>('[data-bm-star]')!
    star.focus()
    await act(async () => {
      star.click()
      await Promise.resolve()
    })
    expect(invoke.mock.calls.at(-1)).toEqual(['bookmark.star', { tabId: 't1' }])
    expect(uiStore.get().urlbar.open).toBe(false)

    // The bubble up (the host's `bookmark.star` event opens it): the chip closes it and keeps
    // the keyboard, as the anchor does after Escape (§9.22).
    const bubble = { tabId: 't1', nodeId: 'b1', created: true, anchor: null, pill: null }
    act(() => uiStore.set({ starDialog: bubble }))
    invoke.mockClear()
    await act(async () => {
      star.click()
      await Promise.resolve()
    })
    expect(uiStore.get().starDialog).toBeNull()
    expect(document.activeElement).toBe(star)
    expect(commands()).not.toContain('focus.content')
  })

  it('adds the blocked pop-ups chip after Reader View, a button that opens the list', async () => {
    const el = render(<NavRow state={withBlocked(page, 2)} tab={page} compact={false} />)
    const pill = el.querySelector<HTMLElement>('[role="group"]')!
    expect(labels(focusable(pill).slice(1))).toEqual([
      'Site information',
      'Reader View',
      '2 pop-ups blocked',
      'Boost this site',
      'Copy URL',
      'Bookmark this tab'
    ])
    const chip = el.querySelector<HTMLElement>('[aria-label="2 pop-ups blocked"]')!
    expectChip(chip, '2 pop-ups blocked')
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    // The count pill shows from two on; one refusal is the glyph alone.
    expect(chip.textContent).toBe('2')
    act(() => root!.render(<NavRow state={withBlocked(page, 1)} tab={page} compact={false} />))
    const one = el.querySelector<HTMLElement>('[aria-label="Pop-up blocked"]')!
    expectChip(one, 'Pop-up blocked')
    expect(one.textContent).toBe('')

    // Its click opens the list for the tab, not the URL bar; the chip reads expanded meanwhile.
    await act(async () => {
      one.click()
      await vi.waitFor(() => expect(uiStore.get().blockedPopupsPanel).not.toBeNull())
    })
    expect(uiStore.get().blockedPopupsPanel?.tabId).toBe('t1')
    expect(uiStore.get().urlbar.open).toBe(false)
    expect(one.getAttribute('aria-expanded')).toBe('true')
    act(() => uiStore.set({ blockedPopupsPanel: null }))
    expect(one.getAttribute('aria-expanded')).toBe('false')
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

  it('hands the keyboard back to the chip once the site information closes', async () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const chip = el.querySelector<HTMLElement>('[aria-label="Site information"]')!
    await openFromChip(chip)
    expect(commands()).toContain('focus.chrome')
    expect(chip.getAttribute('aria-expanded')).toBe('true')

    await dismiss()
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(chip)
    // The page gets the keyboard back only when it had it; the chip did.
    expect(commands()).not.toContain('focus.content')
  })

  it('hands the keyboard to the page instead once the chip is gone', async () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const chip = el.querySelector<HTMLElement>('[aria-label="Site information"]')!
    await openFromChip(chip)
    // The tab went away: the pill re-renders without its chips.
    act(() => root!.render(<NavRow state={state(null)} tab={null} compact={false} />))
    expect(chip.isConnected).toBe(false)

    await dismiss()
    expect(document.activeElement).not.toBe(chip)
    expect(commands()).toContain('focus.content')
  })

  it('leaves the keyboard alone when another surface takes over from the sheet', async () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const chip = el.querySelector<HTMLElement>('[aria-label="Site information"]')!
    await openFromChip(chip)
    chip.blur()
    expect(document.activeElement).not.toBe(chip)

    // The URL bar opening over the sheet dismisses it at once and wants the keyboard itself.
    await act(async () => {
      await openUrlbar('edit', page.id, { attached: true })
    })
    expect(uiStore.get().urlbar.open).toBe(true)
    expect(uiStore.get().siteInfoOpen).toBe(false)
    expect(document.activeElement).not.toBe(chip)
    expect(commands()).not.toContain('focus.content')
  })

  it('reveals the hover-only chips while the keyboard is on one of the chips', () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    const pill = el.querySelector<HTMLElement>('[role="group"]')!
    // Every chip carries the marker and sits in the chips' focus scope; the address does neither.
    const field = focusable(pill)[0]
    expect(el.querySelectorAll('[data-pill-chip]').length).toBe(5)
    expect(field.hasAttribute('data-pill-chip')).toBe(false)
    const scope = pill.querySelector<HTMLElement>('.group\\/chips')!
    expect(scope.className).toContain('contents')
    expect(scope.contains(field)).toBe(false)
    expect(scope.querySelectorAll('[data-pill-chip]').length).toBe(5)
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

  // Design language v2 §9.29: a chip takes the token family of the surface it sits on, read from
  // the `data-surface` of its nearest surface root; the pill's root is window chrome either way.
  it('sits on a window surface at the top of the sidebar', () => {
    const el = render(<SidebarTop state={state(page)} tab={page} compact={false} showToolbar />)
    const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')!
    expect(pill.closest('[data-surface]')).toBe(el.firstElementChild)
    expect(el.firstElementChild!.getAttribute('data-surface')).toBe('window')
  })

  it('sits on a window surface in the top toolbar', () => {
    const el = render(<Toolbar state={state(page)} tab={page} />)
    const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')!
    expect(pill.closest('[data-surface]')).toBe(el.firstElementChild)
    expect(el.firstElementChild!.getAttribute('data-surface')).toBe('window')
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

describe('PillChip', () => {
  it('opens something or toggles, never both', () => {
    // The prop type refuses `popup` together with `pressed`, so no chip can carry
    // `aria-haspopup` and `aria-pressed` at once; the compiler is the check here.
    const opens = createElement(PillChip, { label: 'Boost this site', popup: 'dialog' })
    const toggles = createElement(PillChip, { label: 'Reader View', pressed: true })
    const acts = createElement(PillChip, { label: 'Copy URL' })
    // @ts-expect-error a chip opens something or toggles, never both
    const both = createElement(PillChip, { label: 'x', popup: 'dialog', pressed: true })
    expect([opens, toggles, acts, both].every((chip) => chip.type === PillChip)).toBe(true)
  })
})
