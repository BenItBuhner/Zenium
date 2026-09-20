// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  PRIVATE_CONTAINER_ID,
  type AutofillPrompt,
  type BookmarkNode,
  type MediaState,
  type Space,
  type Tab,
  type UIState
} from '@shared/types'

/*
 * The chips inside the URL pill (design language v2 §9.22): the address first, then every chip
 * as a real button in the tab order with its own label, `aria-haspopup` and `aria-expanded`
 * where it opens something, `aria-pressed` where it toggles. Rendered for real, on both the
 * desktop pill (`NavRow`) and the phone pill (`PillContent`), collapsed and expanded. The
 * desktop pill ends in the bookmark star, whose popup is the star bubble; the autofill key
 * sits just before it while a save prompt is pending for the page, and its popup is the prompt.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NavRow, SidebarTop } = await import('../sidebar/SidebarTop')
const { Toolbar } = await import('../Toolbar')
const { PillContent } = await import('../phone/PhoneShell')
const { PillChip } = await import('../urlbar/PillChip')
const { TOOLBAR_STROKE } = await import('../v2/controls')
const { browserStore, openUrlbar, uiStore } = await import('@renderer/lib/ui')
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

function state(
  t: Tab | null,
  bookmarks: BookmarkNode[] = [],
  prompts: AutofillPrompt[] = []
): UIState {
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
    blockedPopups: {},
    // The host runs the translation engine (every desktop build); no tab has left idle.
    translate: { available: true, tabs: {} },
    securityPrompts: [],
    autofill: { prompts, picker: null }
  } as unknown as UIState
}

/** A pending offer to save the password just used on the page. */
const savePrompt: AutofillPrompt = {
  id: 'p1',
  kind: 'save-login',
  tabId: 't1',
  origin: 'https://example.com',
  site: 'example.com',
  username: 'ada@example.com',
  existingId: null
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
  browserStore.set({ state: null })
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
      'Translate this page',
      'Boost this site',
      'Copy URL',
      'Bookmark this tab'
    ])
    for (const [i, chip] of order.slice(1).entries()) expectChip(chip, labels(order.slice(1))[i]!)
    // The site icon is drawn ahead of the field, after it in the DOM.
    expect(order[1].className).toContain('order-first')
  })

  // Design language v2 §9.3: one stroke per toolbar row – every 16 px glyph in the row (the
  // navigation buttons, the puzzle piece, the menu, the pill's 16 px chips) at the desktop's
  // 1.5, the `--v2-icon-stroke` token's value, not Lucide's default 2 beside it (the #245
  // review's chassis item (d)); the SVG attribute, which is what a reviewer reads off the DOM.
  it('draws every 16 px glyph in the row at the toolbar stroke', () => {
    // A page with a pop-up refused, a save prompt pending and the blocking engine on: every chip
    // with a 16 px glyph up.
    const base = state(page, [], [savePrompt])
    const el = render(
      <NavRow
        state={
          {
            ...base,
            capabilities: { ...base.capabilities, requestBlocking: true },
            settings: { ...base.settings, blocking: { level: 'standard' } },
            blocking: { enabled: true, siteExceptions: [] },
            blockedPopups: withBlocked(page, 1).blockedPopups
          } as unknown as UIState
        }
        tab={page}
        compact={false}
      />
    )
    // The shield's glyph is sized by the chip's own rule (`.zen-v2-blocked-chip > svg`), the
    // others by the `h-4 w-4` utilities.
    const glyphs = Array.from(el.querySelectorAll<SVGElement>('[data-zen-nav-row] svg')).filter(
      (svg) => svg.classList.contains('h-4') || svg.parentElement?.matches('.zen-v2-blocked-chip')
    )
    // Back, forward, reload, the shield, the blocked pop-ups chip, the key chip, the star and the
    // menu (the puzzle piece, the downloads and media buttons wait on an extension, a download, a
    // player).
    expect(el.querySelector('.zen-v2-blocked-chip')).not.toBeNull()
    expect(el.querySelector('[aria-label="Pop-up blocked"]')).not.toBeNull()
    expect(el.querySelector('[data-af-chip]')).not.toBeNull()
    expect(glyphs.length).toBe(8)
    for (const svg of glyphs) expect(svg.getAttribute('stroke-width')).toBe(String(TOOLBAR_STROKE))
    expect(TOOLBAR_STROKE).toBe(1.5)
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
    expect(chip('Translate this page').hasAttribute('aria-haspopup')).toBe(false)
    expect(chip('Translate this page').hasAttribute('aria-pressed')).toBe(false)
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
      'Translate this page',
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
    expect(el.querySelectorAll('[data-pill-chip]').length).toBe(6)
    expect(field.hasAttribute('data-pill-chip')).toBe(false)
    const scope = pill.querySelector<HTMLElement>('.group\\/chips')!
    expect(scope.className).toContain('contents')
    expect(scope.contains(field)).toBe(false)
    expect(scope.querySelectorAll('[data-pill-chip]').length).toBe(6)
    for (const label of ['Translate this page', 'Boost this site', 'Copy URL']) {
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

  it('shows the key chip before the star only while a save prompt is pending for the page', () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    expect(el.querySelector('[data-af-chip]')).toBeNull()

    act(() =>
      root!.render(<NavRow state={state(page, [], [savePrompt])} tab={page} compact={false} />)
    )
    const pill = el.querySelector<HTMLElement>('[role="group"]')!
    const chips = focusable(pill).slice(1)
    expect(labels(chips).slice(-2)).toEqual(['Save password', 'Bookmark this tab'])
    const key = el.querySelector<HTMLElement>('[data-af-chip]')!
    expectChip(key, 'Save password')
    expect(key.hasAttribute('data-pill-chip')).toBe(true)
    // Its popup is the prompt, up by default and put away behind the chip by Escape.
    expect(key.getAttribute('aria-haspopup')).toBe('dialog')
    expect(key.getAttribute('aria-expanded')).toBe('true')
    expect(key.getAttribute('data-open')).toBe('true')
    act(() => uiStore.set({ autofillPromptCollapsed: 'p1' }))
    expect(key.getAttribute('aria-expanded')).toBe('false')
    expect(key.getAttribute('data-open')).toBe('false')

    // The chip brings the prompt back, and puts it away again.
    act(() => key.click())
    expect(uiStore.get().autofillPromptCollapsed).toBeNull()
    expect(key.getAttribute('aria-expanded')).toBe('true')
    act(() => key.click())
    expect(uiStore.get().autofillPromptCollapsed).toBe('p1')

    // A prompt for another tab is not this pill's.
    act(() =>
      root!.render(
        <NavRow
          state={state(page, [], [{ ...savePrompt, tabId: 't2' }])}
          tab={page}
          compact={false}
        />
      )
    )
    expect(el.querySelector('[data-af-chip]')).toBeNull()
  })

  it('names the key chip after the prompt it stands for', () => {
    const update = { ...savePrompt, kind: 'update-login' as const, existingId: 'c1' }
    const el = render(<NavRow state={state(page, [], [update])} tab={page} compact={false} />)
    expectChip(el.querySelector<HTMLElement>('[data-af-chip]')!, 'Update password')
    const card: AutofillPrompt = {
      id: 'p2',
      kind: 'save-card',
      tabId: 't1',
      origin: 'https://example.com',
      site: 'example.com',
      last4: '4242',
      network: 'visa',
      expMonth: 12,
      expYear: 2031,
      name: 'Ada Lovelace'
    }
    act(() => root!.render(<NavRow state={state(page, [], [card])} tab={page} compact={false} />))
    expectChip(el.querySelector<HTMLElement>('[data-af-chip]')!, 'Save card')
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
    // The address speaks the connection's state too (A11Y-01): the lock is drawn, and said.
    expect(order[0].getAttribute('aria-label')).toBe('Address, example.com, Connection is secure')
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
    // No chip draws the state, so the address says it (A11Y-01 on OMN-02).
    expect(labels(focusable(el))).toEqual(['Address, example.com, Not secure', 'Site information'])
  })

  it('names an extension’s page after the extension, its icon in the slot, no lock or translate chip (§10.1)', () => {
    // Both forms the tab's URL takes: Chrome's scheme, and the origin the Android runtime
    // serves the page from – which is never shown, not even as a host.
    const id = 'dbepggeogbaibhgnhhndojpepiihcmeb'
    const icon = 'data:image/png;base64,icon'
    const vimium = {
      id,
      name: 'Vimium',
      icon,
      enabled: true
    } as unknown as UIState['extensions'][number]
    for (const url of [
      `chrome-extension://${id}/pages/options.html`,
      `https://${id}.ext.zenium.invalid/pages/options.html`
    ]) {
      const page = tab(url, { title: 'Vimium Options' })
      const s = { ...state(page), extensions: [vimium] }
      // The translation engine offered the page: a website would show the translate chip.
      s.translate = { available: true, tabs: { [page.id]: { status: 'offered' } } } as never
      // The favicon slot reads the window's list (the same state, through the store; the store's
      // other readers want the sidebar's collections too).
      browserStore.set({ state: { ...s, folders: {}, essentialTabIds: [], glance: null } })
      const el = render(<PillContent state={s} tab={page} space={space} interactive />)
      expect(labels(focusable(el))).toEqual(['Address, Vimium, Extension page', 'Site information'])
      expect(el.textContent).toContain('Vimium')
      expect(el.textContent).not.toContain(id)
      expect(el.textContent).not.toContain('.ext.zenium.invalid')
      expect(el.querySelector('[data-translate]')).toBeNull()
      expect(el.querySelector('img')?.getAttribute('src')).toBe(icon)
      act(() => root?.unmount())
      host?.remove()
    }
    // The control: the same offer on a website shows the translate chip.
    const site = tab('https://example.com/')
    const s = state(site)
    s.translate = { available: true, tabs: { [site.id]: { status: 'offered' } } } as never
    const el = render(<PillContent state={s} tab={site} space={space} interactive />)
    expect(el.querySelector('[data-translate]')).not.toBeNull()
  })

  it('says "Extension page" for an extension the chrome does not know, never the id, still without a lock', () => {
    const id = 'dbepggeogbaibhgnhhndojpepiihcmeb'
    const page = tab(`https://${id}.ext.zenium.invalid/pages/options.html`)
    const el = render(<PillContent state={state(page)} tab={page} space={space} interactive />)
    expect(labels(focusable(el))).toEqual(['Address, Extension page', 'Site information'])
    expect(el.textContent).toContain('Extension page')
    expect(el.textContent).not.toContain(id)
    expect(el.textContent).not.toContain('.ext.zenium.invalid')
    // The puzzle glyph, not a letter of the id.
    expect(el.querySelector('svg.zen-ext-icon-glyph')).not.toBeNull()
  })

  /*
   * The private marker (v2 §9.19): the mask glyph in the leading slot on every private tab, page
   * or none, in place of the favicon; the slot stays the site-information chip.
   */
  describe('on a private tab', () => {
    const privatePage = tab('https://example.com/some/path', {
      containerId: PRIVATE_CONTAINER_ID,
      favicon: 'data:image/png;base64,AAAA'
    })

    it('puts the mask in the leading slot in place of the favicon, on a page as on an empty tab', () => {
      for (const t of [privatePage, tab('zen://newtab', { containerId: PRIVATE_CONTAINER_ID })]) {
        const el = render(<PillContent state={state(t)} tab={t} space={space} interactive />)
        const slot = el.querySelector<HTMLElement>('[data-site-info].order-first')!
        expect(slot.hasAttribute('data-private-mark')).toBe(true)
        expect(slot.querySelector('svg.lucide-venetian-mask')).not.toBeNull()
        expect(slot.querySelector('img, .zen-tab-favicon')).toBeNull()
        act(() => root?.unmount())
        host?.remove()
      }
    })

    it('keeps the slot a site-information chip (the pill opens the sheet from it), and carries no badge', () => {
      const el = render(
        <PillContent state={state(privatePage)} tab={privatePage} space={space} interactive />
      )
      const order = focusable(el)
      expect(labels(order)).toEqual([
        'Address, example.com, Connection is secure',
        'Site information',
        'Connection is secure'
      ])
      expectChip(order[1], 'Site information')
      expect(order[1].getAttribute('aria-haspopup')).toBe('dialog')
      // The pill's tap recogniser routes a tap on a `data-site-info` target to the site information.
      expect(order[1].hasAttribute('data-site-info')).toBe(true)
      expect(order[1].hasAttribute('data-private-mark')).toBe(true)
      act(() => uiStore.set({ siteInfoOpen: true }))
      expect(order[1].getAttribute('aria-expanded')).toBe('true')
      expect(el.querySelector('.zen-v2-badge')).toBeNull()
      expect(el.textContent).not.toContain('Private')
    })

    it('shows the favicon, not the mask, on a regular tab beside it', () => {
      const regular = tab('https://example.com/', { favicon: 'data:image/png;base64,AAAA' })
      const el = render(
        <PillContent state={state(regular)} tab={regular} space={space} interactive />
      )
      const slot = el.querySelector<HTMLElement>('[data-site-info].order-first')!
      expect(slot.hasAttribute('data-private-mark')).toBe(false)
      expect(slot.querySelector('svg.lucide-venetian-mask')).toBeNull()
      expect(slot.querySelector('img')).not.toBeNull()
    })
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

  // The Now playing chip (MW-16): the in-app player's entry, there while a tab holds the media
  // session – the tab the OS controls show, this pill's or another's – and its popup is the
  // media sheet.
  describe('Now playing chip', () => {
    const playing = (over: Partial<MediaState> = {}): MediaState => ({
      tabId: 't1',
      playing: true,
      title: 'Nocturne',
      session: true,
      ...over
    })
    const withMedia = (t: Tab, media: MediaState[]): UIState => ({ ...state(t), media })

    it('is absent without a session, even while a tab is audible', () => {
      const el = render(
        <PillContent
          state={withMedia(page, [{ tabId: 't1', playing: true }])}
          tab={page}
          space={space}
          interactive
        />
      )
      expect(el.querySelector('[data-media]')).toBeNull()
      expect(labels(focusable(el))).toEqual([
        'Address, example.com, Connection is secure',
        'Site information',
        'Connection is secure'
      ])
    })

    it('comes after the lock as a chip whose popup is the media sheet, named by the state', () => {
      const el = render(
        <PillContent state={withMedia(page, [playing()])} tab={page} space={space} interactive />
      )
      const order = focusable(el)
      expect(labels(order)).toEqual([
        'Address, example.com, Connection is secure',
        'Site information',
        'Connection is secure',
        'Now playing'
      ])
      const chip = el.querySelector<HTMLElement>('[data-media]')!
      expectChip(chip, 'Now playing')
      expect(chip.hasAttribute('data-pill-chip')).toBe(true)
      expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
      expect(chip.getAttribute('aria-expanded')).toBe('false')
      expect(chip.getAttribute('data-state')).toBe('playing')
      // In the accent while it plays, muted while paused – the translation glyph's two tones.
      expect(chip.className).toContain('text-[var(--zen-accent)]')

      act(() =>
        root!.render(
          <PillContent
            state={withMedia(page, [playing({ playing: false })])}
            tab={page}
            space={space}
            interactive
          />
        )
      )
      expectChip(chip, 'Media paused')
      expect(chip.getAttribute('data-state')).toBe('paused')
      expect(chip.className).toContain('opacity-50')
      expect(chip.className).not.toContain('text-[var(--zen-accent)]')

      // The sheet up: the chip reads expanded.
      act(() => uiStore.set({ mediaSheet: 't1' }))
      expect(chip.getAttribute('aria-expanded')).toBe('true')
      act(() => uiStore.set({ mediaSheet: null }))
      expect(chip.getAttribute('aria-expanded')).toBe('false')
    })

    it('stands on another tab’s pill too, for the session tab', () => {
      // The session belongs to t2, gone from this pill's tab list unless it is there.
      const session = playing({ tabId: 't2' })
      const el = render(
        <PillContent state={withMedia(page, [session])} tab={page} space={space} interactive />
      )
      expect(el.querySelector('[data-media]')).toBeNull()
      const both = withMedia(page, [session])
      both.tabs = { ...both.tabs, t2: { ...tab('https://music.example/'), id: 't2' } }
      act(() => root!.render(<PillContent state={both} tab={page} space={space} interactive />))
      expectChip(el.querySelector<HTMLElement>('[data-media]')!, 'Now playing')
    })

    it('is a hidden span on the ghost pill', () => {
      const el = render(
        <PillContent
          state={withMedia(page, [playing()])}
          tab={page}
          space={space}
          interactive={false}
        />
      )
      expect(focusable(el).length).toBe(0)
      expect(el.querySelectorAll('[aria-label]').length).toBe(0)
      // A third hidden span beside the site icon's and the lock's, with no tap target on it.
      expect(el.querySelector('[data-media]')).toBeNull()
      const row = el.firstElementChild!
      expect(row.querySelectorAll(':scope > span[aria-hidden]').length).toBe(3)
    })
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
