// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
const { DEFAULT_PAGE_CONTROLS } = await import('@shared/pageControls')

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

  /*
   * The pill yields its chips to the address as it narrows, in tiers of a container query on
   * `.zen-pill` (main.css; content-box widths, 16 px inside the pill): the hover-only chips under
   * 170, the "Not secure" label under 220, and under 110 – the 270 sidebar's 126 px pill – every
   * tool after the address (the star, zoom, Reader View, Translate, Boost, Copy), so a pill at
   * the default sidebar width (96 px, content 80) is the address, or one of Zenium's pages' name,
   * and the site icon (v2 §10.1's favicon slot). The blocked pop-ups chip is the one chip after the address that stays: a
   * notice, not a tool, and the only word of a pop-up the page tried to open (#62). happy-dom
   * evaluates no container query, so the markers and the rule are pinned here; the widths are
   * measured on the packaged build.
   */
  it('marks every tool after the address for the narrow pill’s tier; the site icon and the blocked pop-ups notice stay', () => {
    // Zoomed away from the default, so the zoom chip is in the pill too; two pop-ups refused,
    // so the notice is.
    const zoomed = tab('https://example.com/some/path', { readerable: true, zoom: 1.25 })
    const s = withBlocked(zoomed, 2)
    s.settings = { ...s.settings, pageControls: DEFAULT_PAGE_CONTROLS }
    const el = render(<NavRow state={s} tab={zoomed} compact={false} />)
    const pill = el.querySelector<HTMLElement>('[role="group"]')!
    const chips = Array.from(pill.querySelectorAll<HTMLElement>('[data-pill-chip]'))
    expect(labels(chips)).toEqual([
      'Site information',
      'Reader View',
      '2 pop-ups blocked',
      'Translate this page',
      'Boost this site',
      'Copy URL',
      'Zoom: 125%',
      'Bookmark this tab'
    ])
    const stays = new Set(['Site information', '2 pop-ups blocked'])
    for (const chip of chips) {
      const label = chip.getAttribute('aria-label') ?? ''
      expect(chip.classList.contains('zen-pill-chip'), label).toBe(!stays.has(label))
    }
    // The address itself is never a chip.
    expect(focusable(pill)[0].classList.contains('zen-pill-chip')).toBe(false)

    // The tier is one container rule below the hover-only chips' 170 (content-box widths: 16 px
    // inside the pill) – unlayered, as its siblings are, to beat the `flex` and `group-hover`
    // utilities that draw the chips.
    const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    )
    const tiers = [
      ...css.matchAll(
        /@container \(width < (\d+)px\) \{\s*\.zen-pill-(\w+) \{\s*display: none;\s*\}\s*\}/g
      )
    ]
    expect(tiers.map((m) => [m[2], Number(m[1])])).toEqual([
      ['extra', 170],
      ['label', 220],
      ['chip', 110]
    ])
    for (const tier of tiers) {
      const before = css.slice(0, tier.index)
      const open = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length
      expect(open, `the ${tier[2]} tier is nested`).toBe(0)
    }
    expect(css.match(/\.zen-pill-chip\b/g)).toHaveLength(1)
  })

  /*
   * The tier measures the pill's content box through a ResizeObserver. The icon rail unmounts
   * the pill (the compact row has none) and the expanded sidebar brings a new one: the observer
   * must follow it – left on the rail's node it would report that node's 0 for good, which the
   * tier reads as "hide nothing yet", and a 110 px pill would draw every chip over a field with
   * no room (the shell pass (a) drive's finding at the 270 sidebar after the rail).
   */
  it('re-measures the pill the row has after the icon rail has come and gone', () => {
    const observed: Element[] = []
    const live = new Set<Element>()
    const Native = window.ResizeObserver
    class RecordingResizeObserver {
      private readonly targets = new Set<Element>()
      observe(target: Element): void {
        this.targets.add(target)
        observed.push(target)
        live.add(target)
      }
      unobserve(target: Element): void {
        this.targets.delete(target)
        live.delete(target)
      }
      disconnect(): void {
        for (const t of this.targets) live.delete(t)
        this.targets.clear()
      }
    }
    window.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver
    try {
      const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
      const first = el.querySelector<HTMLElement>('[data-address-pill]')!
      expect(observed).toContain(first)
      act(() => root!.render(<NavRow state={state(page)} tab={page} compact />))
      expect(el.querySelector('[data-address-pill]')).toBeNull()
      expect(live.has(first)).toBe(false)
      act(() => root!.render(<NavRow state={state(page)} tab={page} compact={false} />))
      const again = el.querySelector<HTMLElement>('[data-address-pill]')!
      expect(again).not.toBe(first)
      expect(live.has(again)).toBe(true)
      expect(live.has(first)).toBe(false)
    } finally {
      window.ResizeObserver = Native
    }
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

/*
 * The desktop pill on one of Zenium's own pages (design language v2 §10.1): `zenium://settings/
 * <section>` while the field fits it, the page's title once it does not – as the phone pill names
 * its pages – with the whole address in the tooltip either way. happy-dom lays nothing out, so
 * the widths the pill measures before its first paint (the address at its natural width in the
 * probe, the width the field is given) are set here.
 */
/*
 * The tablet keeps private browsing in tabs (`capabilities.privateTabs`), so the desktop pill
 * meets a private tab in a regular window: the mask takes the leading slot, as it does in the
 * desktop's private window; and under #250's lock the pill says nothing of the page (INC-05, the
 * phone pill's rule) – the leak W4-11 closes: the sidebar's rows under the veil, the pill above
 * them still reading the private page's address.
 */
describe('desktop pill on a tablet’s private tab', () => {
  const privatePage = tab('https://example.com/some/path', {
    containerId: PRIVATE_CONTAINER_ID,
    readerable: true
  })
  const tablet = (t: Tab): UIState => {
    const s = state(t)
    return { ...s, capabilities: { ...s.capabilities, privateTabs: true } } as UIState
  }

  it('puts the mask in the leading slot in place of the site icon', () => {
    const el = render(<NavRow state={tablet(privatePage)} tab={privatePage} compact={false} />)
    const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')!
    expect(pill.querySelector('svg.lucide-venetian-mask.order-first')).not.toBeNull()
    expect(pill.querySelector('[aria-label="Site information"]')).toBeNull()
    expect(focusable(pill)[0].textContent).toBe('example.com/some/path')
  })

  it('locked, reads "Private tab" behind the mask with no address, no chip and no menu; its click asks the unlock', async () => {
    const { applyPrivateLock, privateLockStore, resetPrivateLock, setPrivateLockHost } =
      await import('@renderer/lib/privateLock')
    // The host's prompt, which the user then cancels: the lock stands.
    const unlock = vi.fn(async () => ({ locked: true }))
    setPrivateLockHost({ unlock, verify: async () => false })
    try {
      act(() => applyPrivateLock({ locked: true, screenLock: true }))
      const el = render(<NavRow state={tablet(privatePage)} tab={privatePage} compact={false} />)
      const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')!
      expect(pill.textContent).toBe('Private tab')
      expect(pill.getAttribute('title')).toBe('Private tab')
      expect(pill.hasAttribute('data-zen-menu')).toBe(false)
      expect(pill.querySelectorAll('svg.lucide-venetian-mask')).toHaveLength(1)
      expect(pill.querySelector('[data-pill-chip]')).toBeNull()
      expect(labels(focusable(pill))).toEqual(['Private tab locked, unlock'])
      expect(pill.querySelector('[data-private-locked]')).not.toBeNull()

      await act(async () => {
        focusable(pill)[0].click()
        await vi.waitFor(() => expect(unlock).toHaveBeenCalledTimes(1))
      })
      // The unlock was asked of the host, not the URL bar – which would show the address.
      expect(uiStore.get().urlbar.open).toBe(false)
      expect(privateLockStore.get().locked).toBe(true)
    } finally {
      setPrivateLockHost(null)
      act(() => resetPrivateLock())
    }
  })

  it('reads the address again once the lock lifts', async () => {
    const { applyPrivateLock, resetPrivateLock } = await import('@renderer/lib/privateLock')
    try {
      act(() => applyPrivateLock({ locked: true, screenLock: true }))
      const el = render(<NavRow state={tablet(privatePage)} tab={privatePage} compact={false} />)
      const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')!
      expect(pill.textContent).toBe('Private tab')
      act(() => resetPrivateLock())
      expect(focusable(pill)[0].textContent).toBe('example.com/some/path')
      expect(pill.querySelector('[data-private-locked]')).toBeNull()
    } finally {
      act(() => resetPrivateLock())
    }
  })
})

describe('desktop pill on an internal page', () => {
  const settings = tab('zen://settings/privacy', { title: 'Settings' })
  const widths = { probe: 0, field: 0 }

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const width = this.hasAttribute('data-pill-probe')
        ? widths.probe
        : this.hasAttribute('data-reads')
          ? widths.field
          : 0
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect
    })
  })

  afterEach(() => vi.restoreAllMocks())

  const pillOf = (el: HTMLElement): { pill: HTMLElement; field: HTMLElement } => {
    const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')!
    return { pill, field: pill.querySelector<HTMLElement>('[data-reads]')! }
  }

  it('reads the whole address, section and all, while the field fits it', () => {
    widths.probe = 150
    widths.field = 160
    const el = render(<NavRow state={state(settings)} tab={settings} compact={false} />)
    const { pill, field } = pillOf(el)
    expect(focusable(pill)[0].textContent).toBe('zenium://settings/privacy')
    expect(field.getAttribute('data-reads')).toBe('address')
    // The probe holds the same address, out of the accessibility tree and never in the name.
    const probe = pill.querySelector<HTMLElement>('[data-pill-probe]')!
    expect(probe.textContent).toBe('zenium://settings/privacy')
    expect(probe.getAttribute('aria-hidden')).toBe('true')
    expect(probe.className).toContain('invisible')
    expect(pill.getAttribute('title')).toBe('zenium://settings/privacy')
  })

  it('names the page once the field cannot fit the address; the tooltip keeps the address', () => {
    widths.probe = 150
    widths.field = 60
    const el = render(<NavRow state={state(settings)} tab={settings} compact={false} />)
    const { pill, field } = pillOf(el)
    expect(focusable(pill)[0].textContent).toBe('Settings')
    expect(field.getAttribute('data-reads')).toBe('title')
    // `zenium://`, never the canonical `zen://` the tab carries (§10.1).
    expect(pill.getAttribute('title')).toBe('zenium://settings/privacy')
    // The star is kept: Chrome keeps it on chrome://settings, the registry says so for Settings.
    // Whether a narrow pill draws it is the width tier's (the test above), not the text's.
    expect(pill.querySelector('[aria-label="Bookmark this tab"]')).not.toBeNull()
  })

  it('leaves a site’s address to truncate while the field keeps the 56 px floor (§9.29)', () => {
    widths.probe = 150
    widths.field = 60
    const site = tab('https://example.com/some/path', { title: 'An example page' })
    const el = render(<NavRow state={state(site)} tab={site} compact={false} />)
    const { pill, field } = pillOf(el)
    expect(focusable(pill)[0].textContent).toBe('example.com/some/path')
    expect(field.getAttribute('data-reads')).toBe('address')
    // The site in full ink, the path after it dimmed (Chrome's), as ever.
    expect(field.querySelector('.opacity-70')?.textContent).toBe('/some/path')
    expect(pill.getAttribute('title')).toBe('https://example.com/some/path')
  })

  it('keeps a site’s trimmed address under the floor too – never its title (§9.29); the tooltip the full address', () => {
    widths.probe = 150
    widths.field = 40
    const site = tab('https://www.example.com/some/path', { title: 'An example page' })
    const el = render(<NavRow state={state(site)} tab={site} compact={false} />)
    const { pill, field } = pillOf(el)
    // Zen's trim: the scheme and `www.` off, the host first, then the path – truncated from the
    // end by the field's `truncate`, whatever its width.
    expect(focusable(pill)[0].textContent).toBe('example.com/some/path')
    expect(field.getAttribute('data-reads')).toBe('address')
    expect(field.querySelector('.opacity-70')?.textContent).toBe('/some/path')
    expect(pill.getAttribute('title')).toBe('https://www.example.com/some/path')
    // The probe still holds the address the field is measured against.
    expect(pill.querySelector('[data-pill-probe]')!.textContent).toBe('example.com/some/path')
  })

  it('offers the search prompt, not `zen://newtab`, as the empty tab’s tooltip', () => {
    const empty = tab('zen://newtab')
    const el = render(<NavRow state={state(empty)} tab={empty} compact={false} />)
    const { pill } = pillOf(el)
    expect(pill.getAttribute('title')).toBe('Search or enter address')
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
    // The control: the same offer on a website is spoken at the address – the offer is the
    // site-information sheet's row on the phone (OMN-02), never a chip in the pill.
    const site = tab('https://example.com/')
    const s = state(site)
    s.translate = { available: true, tabs: { [site.id]: { status: 'offered' } } } as never
    const el = render(<PillContent state={s} tab={site} space={space} interactive />)
    expect(el.querySelector('[data-translate]')).toBeNull()
    expect(labels(focusable(el))[0]).toBe(
      'Address, example.com, Connection is secure, Translation offered'
    )
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

    /*
     * Under the lock (INC-05, §9.19): the pill reads the placeholder "Private tab" behind the one
     * mask – the same glyph, still in the leading slot – and announces one thing, the unlock;
     * there is no site-information control for a page nothing may be read of, no host, no lock
     * and no other chip.
     */
    it('locked, it reads "Private tab" behind the one mask and announces the unlock alone – no site-information chip', async () => {
      const { applyPrivateLock, resetPrivateLock } = await import('@renderer/lib/privateLock')
      try {
        act(() => applyPrivateLock({ locked: true, screenLock: true }))
        const el = render(
          <PillContent state={state(privatePage)} tab={privatePage} space={space} interactive />
        )
        expect(labels(focusable(el))).toEqual(['Private tab locked, unlock'])
        expect(el.querySelector('[data-site-info]')).toBeNull()
        expect(el.querySelector('[data-pill-chip]')).toBeNull()
        expect(el.textContent).toBe('Private tab')
        expect(el.textContent).not.toContain('example.com')
        const masks = el.querySelectorAll('svg.lucide-venetian-mask')
        expect(masks).toHaveLength(1)
        const slot = masks[0].closest<HTMLElement>('.order-first')!
        expect(slot.hasAttribute('data-private-mark')).toBe(true)
        expect(slot.getAttribute('aria-hidden')).toBe('true')
        expect(el.querySelector('[data-private-locked]')).not.toBeNull()
      } finally {
        act(() => resetPrivateLock())
      }
    })
  })

  it('draws the ghost pill with nothing focusable or announced', () => {
    const el = render(
      <PillContent state={state(page)} tab={page} space={space} interactive={false} />
    )
    expect(focusable(el).length).toBe(0)
    expect(el.querySelectorAll('button').length).toBe(0)
    expect(el.querySelectorAll('[aria-label]').length).toBe(0)
    // The two chips are plain hidden spans: the site icon's in the pill's row (the favicon tile
    // is inside it), the lock's in the chip run after the address.
    const row = el.firstElementChild!
    expect(row.querySelectorAll(':scope > span[aria-hidden]').length).toBe(1)
    const run = row.querySelector('[data-testid="pill-chips"]')!
    expect(run.querySelectorAll('[data-chip] > span[aria-hidden]').length).toBe(1)
    expect(run.querySelectorAll('button').length).toBe(0)
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

    it('takes the lock’s slot as a chip whose popup is the media sheet, named by the state (v2 §9.29)', () => {
      const el = render(
        <PillContent state={withMedia(page, [playing()])} tab={page} space={space} interactive />
      )
      const order = focusable(el)
      // The lock gave way to the live state: the site icon ahead of the address still opens
      // the site information, and the address keeps speaking the connection's state (A11Y-01).
      expect(labels(order)).toEqual([
        'Address, example.com, Connection is secure',
        'Site information',
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
      // Quiet in the deemphasised window ink (§9.29), never a status colour.
      expect(chip.className).toContain('zen-pill-quiet')
      expect(chip.className).not.toContain('text-[var(--zen-accent)]')

      // The sheet up: the chip reads expanded.
      act(() => uiStore.set({ mediaSheet: 't1' }))
      expect(chip.getAttribute('aria-expanded')).toBe('true')
      act(() => uiStore.set({ mediaSheet: null }))
      expect(chip.getAttribute('aria-expanded')).toBe('false')
    })

    it('on a private tab the mask keeps the leading slot and the chip takes the lock’s trailing one (v2 §9.19 with §9.29)', () => {
      const privatePage = tab('https://example.com/some/path', {
        containerId: PRIVATE_CONTAINER_ID,
        favicon: 'data:image/png;base64,AAAA'
      })
      const el = render(
        <PillContent
          state={withMedia(privatePage, [playing()])}
          tab={privatePage}
          space={space}
          interactive
        />
      )
      const order = focusable(el)
      expect(labels(order)).toEqual([
        'Address, example.com, Connection is secure',
        'Site information',
        'Now playing'
      ])
      // The mask, leading, in place of the favicon: the site-information chip as on any private tab.
      expect(order[1].hasAttribute('data-private-mark')).toBe(true)
      expect(order[1].querySelector('svg.lucide-venetian-mask')).not.toBeNull()
      // The media chip trailing where the lock stood; no lock while the state is live.
      expect(order[2].hasAttribute('data-media')).toBe(true)
      expect(el.querySelector('svg.lucide-lock')).toBeNull()
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
      // One hidden span in the chip run – the media chip in the lock's slot – with no tap
      // target on it; the site icon is its own hidden span ahead of the address.
      expect(el.querySelector('[data-media]')).toBeNull()
      const row = el.firstElementChild!
      expect(row.querySelector(':scope > span[aria-hidden].order-first')).not.toBeNull()
      const run = row.querySelector('[data-testid="pill-chips"]')!
      expect(run.querySelectorAll('[data-chip] > span[aria-hidden]').length).toBe(1)
      expect(run.querySelector('[data-chip="media"]')).not.toBeNull()
      expect(run.querySelectorAll('button').length).toBe(0)
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
