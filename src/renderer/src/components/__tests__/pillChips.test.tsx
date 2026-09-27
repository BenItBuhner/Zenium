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
  type PermissionPrompt,
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
const { browserStore, closeMemorySaverBubble, openUrlbar, uiStore } =
  await import('@renderer/lib/ui')
const { closeSiteInfo, openSiteInfo, siteInfoStore } = await import('@renderer/lib/siteInfo')
const { MEMORY_SAVER_LEAF_MS } = await import('@renderer/lib/siteChips')
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
    // No site has a stored permission decision: no blocked-permission icon in the pill.
    permissionRules: [],
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
  uiStore.set({
    siteInfoOpen: false,
    overlay: 'none',
    starDialog: null,
    blockedPopupsPanel: null,
    memorySaverBubble: null
  })
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false } }))
  siteInfoStore.set({ tabId: null, anchor: null, level: 'overview', openedBy: null })
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
    // Back, forward, reload, the site-information slot's lock (§9.19's 16, as ruled for #406),
    // the shield, the blocked pop-ups chip, the key chip, the star and the menu (the puzzle
    // piece, the downloads and media buttons wait on an extension, a download, a player).
    expect(el.querySelector('.zen-v2-blocked-chip')).not.toBeNull()
    expect(el.querySelector('[aria-label="Pop-up blocked"]')).not.toBeNull()
    expect(el.querySelector('[data-af-chip]')).not.toBeNull()
    expect(el.querySelector('[data-site-chip] svg.lucide-lock.h-4')).not.toBeNull()
    expect(glyphs.length).toBe(9)
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

    // The site information reads open on the chip that opened it (§9.20; `openedBy`), not on
    // every chip that could have.
    act(() => {
      uiStore.set({ siteInfoOpen: true })
      siteInfoStore.set({ tabId: 't1', openedBy: 'site' })
    })
    expect(chip('Site information').getAttribute('aria-expanded')).toBe('true')
    expect(chip('Boost this site').getAttribute('aria-expanded')).toBe('false')
    act(() => siteInfoStore.set({ openedBy: null }))
    expect(chip('Site information').getAttribute('aria-expanded')).toBe('false')

    act(() => {
      uiStore.set({ siteInfoOpen: false, overlay: 'boosts' })
      siteInfoStore.set({ tabId: null })
    })
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
    expect(star.getAttribute('data-tooltip')).toBe('Bookmark this tab (Ctrl+D)')

    act(() =>
      root!.render(
        <NavRow state={state(page, [bookmarkOf(page.url)])} tab={page} compact={false} />
      )
    )
    expectChip(star, 'Edit bookmark')
    expect(star.getAttribute('data-filled')).toBe('true')
    expect(star.getAttribute('data-tooltip')).toBe('Edit bookmark (Ctrl+D)')
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

  // omnibox-38 (design language v2 §9.29): the pill's word on the page's live capture and on
  // the permissions the user blocked on the site is the site-information slot's glyph – one
  // state at a time, never a second chip – leading to the site information's Permissions level.
  describe('the site-information slot’s state glyph (omnibox-38)', () => {
    const using = (capture: Tab['capture']): Tab => tab(page.url, { readerable: true, capture })
    /** The state with the site's stored decisions. */
    const withRules = (t: Tab, rules: UIState['permissionRules']): UIState => ({
      ...state(t),
      permissionRules: rules
    })
    const deny = (
      permission: string,
      origin = 'https://example.com'
    ): UIState['permissionRules'][0] => ({
      origin,
      permission,
      decision: 'deny'
    })
    /** The state with the blocking engine on: the shield is in the pill beside the slot. */
    const withShield = (s: UIState): UIState =>
      ({
        ...s,
        capabilities: { ...s.capabilities, requestBlocking: true },
        settings: { ...s.settings, blocking: { level: 'standard' } },
        blocking: { enabled: true, siteExceptions: [] }
      }) as unknown as UIState
    const slotOf = (el: HTMLElement): HTMLElement =>
      el.querySelector<HTMLElement>('[data-site-chip]')!
    const chipLabels = (el: HTMLElement): (string | null)[] =>
      labels(Array.from(el.querySelectorAll<HTMLElement>('[data-pill-chip]')))
    /** The token the slot's ink comes from: the class the chip carries, once, with no opacity over it. */
    const inkOf = (chip: HTMLElement): string[] =>
      chip.className.split(/\s+/).filter((c) => /^text-\[var\(--v2-/.test(c))
    /** A rest opacity on the chip (a `focus-visible:` lift is the chassis's and no rest state). */
    const restOpacity = (chip: HTMLElement): string[] =>
      chip.className.split(/\s+/).filter((c) => /^opacity-/.test(c))

    it('swaps the glyph for the camera / microphone / screen the page is using, at full ink, named for what it holds', () => {
      const call = using({ camera: true, microphone: true, display: false })
      const el = render(<NavRow state={state(call)} tab={call} compact={false} />)
      const slot = slotOf(el)
      expectChip(slot, 'Site information · This page is using your camera and microphone')
      expect(slot.getAttribute('data-slot-state')).toBe('capture')
      expect(slot.getAttribute('data-slot-glyph')).toBe('camera')
      expect(slot.querySelector('svg.lucide-camera')).not.toBeNull()
      expect(slot.querySelector('svg.lucide-lock')).toBeNull()
      // The chrome tooltip (a11y-26) carries the state's name; never a native title.
      expect(slot.getAttribute('data-tooltip')).toBe(
        'This page is using your camera and microphone'
      )
      expect(slot.hasAttribute('title')).toBe(false)
      expect(slot.getAttribute('aria-haspopup')).toBe('dialog')
      expect(slot.getAttribute('aria-expanded')).toBe('false')
      // §9.19's 16 glyph in the 24 box, at the row's stroke.
      expect(slot.classList.contains('h-6')).toBe(true)
      expect(slot.querySelector('svg')?.classList.contains('h-4')).toBe(true)
      expect(slot.querySelector('svg')?.getAttribute('stroke-width')).toBe(String(TOOLBAR_STROKE))
      // A live state is full ink, and no coloured mark (the tab row's dot says recording).
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text)]'])
      expect(restOpacity(slot)).toEqual([])
      expect(slot.className).not.toContain('--v2-danger')

      const mic = using({ camera: false, microphone: true, display: false })
      act(() => root!.render(<NavRow state={state(mic)} tab={mic} compact={false} />))
      expect(slot.getAttribute('data-slot-glyph')).toBe('microphone')
      expect(slot.getAttribute('aria-label')).toBe(
        'Site information · This page is using your microphone'
      )
      expect(slot.querySelector('svg.lucide-mic')).not.toBeNull()

      const share = using({ camera: false, microphone: false, display: true })
      act(() => root!.render(<NavRow state={state(share)} tab={share} compact={false} />))
      expect(slot.getAttribute('data-slot-glyph')).toBe('display')
      expect(slot.getAttribute('aria-label')).toBe(
        'Site information · This page is sharing your screen'
      )
      expect(slot.querySelector('svg.lucide-screen-share')).not.toBeNull()

      // Nothing captured: the connection's glyph, the plain name, the tooltip on the connection.
      act(() => root!.render(<NavRow state={state(page)} tab={page} compact={false} />))
      expect(slot.getAttribute('data-slot-state')).toBe('connection')
      expect(slot.hasAttribute('data-slot-glyph')).toBe(false)
      expect(slot.getAttribute('aria-label')).toBe('Site information')
      expect(slot.getAttribute('data-tooltip')).toBe('Connection is secure · Site information')
      expect(slot.querySelector('svg.lucide-lock')).not.toBeNull()
    })

    it('draws the first blocked permission’s crossed-out glyph at rest, at the slot’s 69 % ink, the name listing every one', () => {
      const rules = [
        deny('notifications'),
        deny('camera'),
        deny('geolocation', 'https://other.example'),
        { origin: 'https://example.com', permission: 'microphone', decision: 'allow' as const }
      ]
      const el = render(<NavRow state={withRules(page, rules)} tab={page} compact={false} />)
      const slot = slotOf(el)
      // The pill's order, whatever the rules': the camera's glyph leads; an allow and another
      // site's block are no state.
      expectChip(slot, 'Site information · Camera and notifications blocked')
      expect(slot.getAttribute('data-slot-state')).toBe('blocked')
      expect(slot.getAttribute('data-slot-glyph')).toBe('camera-off')
      expect(slot.querySelector('svg.lucide-camera-off')).not.toBeNull()
      expect(slot.getAttribute('data-tooltip')).toBe('Camera and notifications blocked')
      expect(slot.hasAttribute('title')).toBe(false)
      expect(slot.getAttribute('aria-haspopup')).toBe('dialog')
      expect(slot.querySelector('svg')?.getAttribute('stroke-width')).toBe(String(TOOLBAR_STROKE))
      // A standing decision rests at the deemphasised ink, the token's own alpha once.
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])
      expect(restOpacity(slot)).toEqual([])
      // No second chip for it anywhere in the pill.
      expect(el.querySelectorAll('[data-blocked-permission], [data-capture-chip]').length).toBe(0)
      // The block lifted: the glyph and the name follow.
      act(() =>
        root!.render(
          <NavRow state={withRules(page, [deny('notifications')])} tab={page} compact={false} />
        )
      )
      expect(slot.getAttribute('data-slot-glyph')).toBe('notifications-off')
      expect(slot.getAttribute('aria-label')).toBe('Site information · Notifications blocked')
      expect(slot.querySelector('svg.lucide-bell-off')).not.toBeNull()
      act(() => root!.render(<NavRow state={withRules(page, [])} tab={page} compact={false} />))
      expect(slot.getAttribute('data-slot-state')).toBe('connection')
      expect(slot.getAttribute('aria-label')).toBe('Site information')
    })

    it('shows one state at a time: a certificate error over a capture, a capture over a block', () => {
      const call = using({ camera: true, microphone: false, display: false })
      const el = render(
        <NavRow state={withRules(call, [deny('microphone')])} tab={call} compact={false} />
      )
      const slot = slotOf(el)
      // Live beats standing: the camera, not the crossed-out microphone.
      expect(slot.getAttribute('data-slot-glyph')).toBe('camera')
      expect(slot.getAttribute('aria-label')).toBe(
        'Site information · This page is using your camera'
      )
      // The identity in question beats both: the danger glyph in the danger ink, the state's
      // name gone with the state.
      const broken = tab(page.url, {
        readerable: true,
        capture: { camera: true, microphone: false, display: false },
        certificateError: { code: -201, url: page.url, certificate: null, bypassed: false }
      })
      act(() =>
        root!.render(
          <NavRow state={withRules(broken, [deny('microphone')])} tab={broken} compact={false} />
        )
      )
      expect(slot.getAttribute('data-indicator')).toBe('certificate-error')
      expect(slot.getAttribute('data-slot-state')).toBe('connection')
      expect(slot.getAttribute('aria-label')).toBe('Site information')
      expect(slot.querySelector('svg.lucide-triangle-alert')).not.toBeNull()
      expect(inkOf(slot)).toEqual(['text-[var(--v2-danger)]'])
      expect(restOpacity(slot)).toEqual([])
      // The "Not secure" label is the label's own and stays beside it.
      expect(el.querySelector('.zen-pill-label')?.textContent).toBe('Not secure')
    })

    // §9.19 / §9.29 as ruled for #406: the slot has one 16 glyph on the desktop – the lock, the
    // mask – and a glyph that grew when a state came on would move the address by the difference
    // at every capture start (the 12 was the shield's one-off). The box is the slot's 24 either
    // way; the glyph inside it is the same size at rest and in a state.
    const box = (el: HTMLElement): string[] =>
      el.className.split(/\s+/).filter((c) => /^(-ml-|h-|w-)/.test(c))
    const glyphOf = (el: HTMLElement): SVGElement => el.querySelector('svg')!
    const glyphSize = (svg: SVGElement): string[] =>
      Array.from(svg.classList).filter((c) => /^(h-|w-)/.test(c))
    const expectSlotGlyph = (svg: SVGElement): void => {
      expect(glyphSize(svg).sort()).toEqual(['h-4', 'w-4'])
      expect(svg.getAttribute('stroke-width')).toBe(String(TOOLBAR_STROKE))
    }

    it('draws the connection’s resting glyph at the slot’s one size – 16 in the 24 box at the row stroke – so nothing moves when a state comes on', () => {
      const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
      const slot = slotOf(el)
      // At rest: the lock, 16 at the row's stroke, in the 24 box pulled 4 into the pill's pad.
      expect(slot.getAttribute('data-slot-state')).toBe('connection')
      expect(glyphOf(slot).classList.contains('lucide-lock')).toBe(true)
      expectSlotGlyph(glyphOf(slot))
      const atRest = box(slot)
      expect(atRest.sort()).toEqual(['-ml-1', 'h-6', 'w-6'])
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])
      // A capture comes on: the camera in the same box, the same size – the address's room is
      // the box's, and the box did not change.
      const call = using({ camera: true, microphone: false, display: false })
      act(() => root!.render(<NavRow state={state(call)} tab={call} compact={false} />))
      expect(glyphOf(slot).classList.contains('lucide-camera')).toBe(true)
      expectSlotGlyph(glyphOf(slot))
      expect(box(slot).sort()).toEqual(atRest)
      // A block at rest: the same again.
      act(() =>
        root!.render(
          <NavRow state={withRules(page, [deny('camera')])} tab={page} compact={false} />
        )
      )
      expect(glyphOf(slot).classList.contains('lucide-camera-off')).toBe(true)
      expectSlotGlyph(glyphOf(slot))
      expect(box(slot).sort()).toEqual(atRest)
      // The other resting glyphs take the one size too: http's info circle, and the certificate
      // error's triangle – whose danger ink is the chip's and stays as it was.
      const http = tab('http://example.com/some/path', { readerable: true })
      act(() => root!.render(<NavRow state={state(http)} tab={http} compact={false} />))
      expect(glyphOf(slot).classList.contains('lucide-info')).toBe(true)
      expectSlotGlyph(glyphOf(slot))
      expect(box(slot).sort()).toEqual(atRest)
      const broken = tab(page.url, {
        readerable: true,
        certificateError: { code: -201, url: page.url, certificate: null, bypassed: false }
      })
      act(() => root!.render(<NavRow state={state(broken)} tab={broken} compact={false} />))
      expect(glyphOf(slot).classList.contains('lucide-triangle-alert')).toBe(true)
      expectSlotGlyph(glyphOf(slot))
      expect(box(slot).sort()).toEqual(atRest)
      expect(inkOf(slot)).toEqual(['text-[var(--v2-danger)]'])
      expect(restOpacity(slot)).toEqual([])
      // No glyph in the slot is ever the shield's old 12 or a 14.
      expect(el.querySelector('[data-site-chip] svg.h-3, [data-site-chip] svg.h-3\\.5')).toBeNull()
    })

    it('draws a private tab’s mask as the slot’s glyph – the slot stays the site-information button (§9.19; #406 §G) – at the same size and stroke, in the slot’s rest ink, the token once', async () => {
      const secret = tab(page.url, { readerable: true, containerId: PRIVATE_CONTAINER_ID })
      const el = render(<NavRow state={state(secret)} tab={secret} compact={false} />)
      // The mask is the site chip's glyph state, in its 24 box (§9.19's leading slot): a real
      // button, named as the slot is, opening the site information as the slot does – no bare
      // mark beside it (the desktop's since #108/#346, the behaviour defect #406 §G named).
      expect(el.querySelector('[data-private-slot]')).toBeNull()
      const slot = slotOf(el)
      expectChip(slot, 'Site information')
      expect(slot.getAttribute('aria-haspopup')).toBe('dialog')
      expect(slot.getAttribute('data-slot-state')).toBe('private')
      expect(slot.getAttribute('data-indicator')).toBe('secure')
      // The tooltip says what the glyph is and what it stands in for.
      expect(slot.getAttribute('data-tooltip')).toBe(
        'Private tab · Connection is secure · Site information'
      )
      expect(box(slot).sort()).toEqual(['-ml-1', 'h-6', 'w-6'])
      const mask = glyphOf(slot)
      expect(mask.classList.contains('lucide-venetian-mask')).toBe(true)
      expect(mask.hasAttribute('data-private-mark')).toBe(true)
      expectSlotGlyph(mask)
      expect(el.querySelectorAll('svg.lucide-venetian-mask')).toHaveLength(1)
      // The window's deemphasised token, once: no opacity stacked on it, on the box or the glyph.
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])
      expect(restOpacity(slot)).toEqual([])
      expect(Array.from(mask.classList).filter((c) => /^opacity-/.test(c))).toEqual([])
      // A click opens the site information on the overview, from the slot, and the slot is the
      // pressed anchor while it is up.
      await openFromChip(slot)
      expect(siteInfoStore.get().tabId).toBe('t1')
      expect(siteInfoStore.get().level).toBe('overview')
      expect(siteInfoStore.get().openedBy).toBe('site')
      expect(slot.getAttribute('aria-expanded')).toBe('true')
      await dismiss()
      expect(document.activeElement).toBe(slot)
      // The regular tab's slot in the same box: a private tab's address has the room any tab's has.
      act(() => root!.render(<NavRow state={state(page)} tab={page} compact={false} />))
      expect(box(slotOf(el)).sort()).toEqual(['-ml-1', 'h-6', 'w-6'])
      expect(el.querySelector('svg.lucide-venetian-mask')).toBeNull()
    })

    it('the mask stands at the connection glyph’s rank: a certificate error, a live capture and a standing block each take the one box over it, and the mask returns as the state ends', () => {
      const secret = (patch: Partial<Tab> = {}): Tab =>
        tab(page.url, { readerable: true, containerId: PRIVATE_CONTAINER_ID, ...patch })
      const el = render(<NavRow state={state(secret())} tab={secret()} compact={false} />)
      const slot = slotOf(el)
      expect(glyphOf(slot).classList.contains('lucide-venetian-mask')).toBe(true)
      const atRest = box(slot)
      // The danger tier over the mask: the triangle in the danger ink, the mask gone.
      const broken = secret({
        certificateError: { code: -201, url: page.url, certificate: null, bypassed: false }
      })
      act(() => root!.render(<NavRow state={state(broken)} tab={broken} compact={false} />))
      expect(glyphOf(slot).classList.contains('lucide-triangle-alert')).toBe(true)
      expect(slot.getAttribute('data-slot-state')).toBe('connection')
      expect(inkOf(slot)).toEqual(['text-[var(--v2-danger)]'])
      expect(el.querySelector('svg.lucide-venetian-mask')).toBeNull()
      expect(slot.querySelectorAll('svg')).toHaveLength(1)
      expectSlotGlyph(glyphOf(slot))
      expect(box(slot)).toEqual(atRest)
      // A live capture over the mask: the camera at full ink, named for what it holds, still
      // leading to Permissions.
      const call = secret({ capture: { camera: true, microphone: false, display: false } })
      act(() => root!.render(<NavRow state={state(call)} tab={call} compact={false} />))
      expect(glyphOf(slot).classList.contains('lucide-camera')).toBe(true)
      expect(slot.getAttribute('data-slot-state')).toBe('capture')
      expect(slot.getAttribute('aria-label')).toBe(
        'Site information · This page is using your camera'
      )
      expect(el.querySelector('svg.lucide-venetian-mask')).toBeNull()
      expect(slot.querySelectorAll('svg')).toHaveLength(1)
      // A standing block over the mask: the crossed-out glyph.
      act(() =>
        root!.render(
          <NavRow state={withRules(secret(), [deny('camera')])} tab={secret()} compact={false} />
        )
      )
      expect(glyphOf(slot).classList.contains('lucide-camera-off')).toBe(true)
      expect(slot.getAttribute('data-slot-state')).toBe('blocked')
      expect(el.querySelector('svg.lucide-venetian-mask')).toBeNull()
      // The state ends: the mask returns, in the same box, the rest ink.
      act(() => root!.render(<NavRow state={state(secret())} tab={secret()} compact={false} />))
      expect(glyphOf(slot).classList.contains('lucide-venetian-mask')).toBe(true)
      expect(slot.getAttribute('data-slot-state')).toBe('private')
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])
      expect(box(slot)).toEqual(atRest)
      // A private http page: the "Not secure" label still precedes the address, the mask keeps
      // the box (the info circle is the connection glyph's rank, which the mask holds).
      const http = secret({ url: 'http://example.com/some/path' })
      act(() => root!.render(<NavRow state={state(http)} tab={http} compact={false} />))
      expect(glyphOf(slot).classList.contains('lucide-venetian-mask')).toBe(true)
      expect(el.querySelector('.zen-pill-label')?.textContent).toBe('Not secure')
    })

    it('an empty tab has no site and no slot (#406 §G): the field leads with §6’s engine favicon at 16 – the slot’s glyph size – in place of the 12 px search glass', () => {
      const empty = tab('zen://newtab')
      const engines = [
        {
          id: 'ddg',
          name: 'DuckDuckGo',
          glyph: 'D',
          searchUrl: 'https://duckduckgo.com/?q=%s',
          suggestUrl: null,
          favicon: 'https://duckduckgo.com/favicon.ico',
          builtIn: true
        }
      ]
      const withEngines = {
        ...state(empty),
        searchEngines: engines,
        settings: { urlbarBehavior: 'normal', searchEngineId: 'ddg' }
      } as unknown as UIState
      const el = render(<NavRow state={withEngines} tab={empty} compact={false} />)
      const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')!
      // No site-information slot, no private mark, no glass of its own before the field.
      expect(pill.querySelector('[data-site-chip]')).toBeNull()
      expect(pill.querySelector('[data-private-slot]')).toBeNull()
      expect(pill.querySelector('svg.lucide-search.h-3')).toBeNull()
      expect(pill.querySelector('.order-first')).toBeNull()
      // The field's own mark, inside its button ahead of the prompt: the engine's favicon at 16,
      // in the slot's 24 box pulled the same 4 into the pad, so the prompt starts where an
      // address does.
      const address = focusable(pill)[0]
      expect(address.textContent).toBe('Search or enter address')
      const mark = address.querySelector<HTMLElement>('[data-field-glyph="engine"]')!
      expect(mark).not.toBeNull()
      expect(mark.getAttribute('aria-hidden')).toBe('true')
      expect(box(mark).sort()).toEqual(['-ml-1', 'h-6', 'w-6'])
      expect(mark.nextElementSibling?.textContent).toBe('Search or enter address')
      const glyph = mark.querySelector<HTMLElement>('[data-testid="engine-field-glyph"]')!
      expect(glyph).not.toBeNull()
      expect(
        Array.from(glyph.classList)
          .filter((c) => /^(h-|w-)/.test(c))
          .sort()
      ).toEqual(['h-4', 'w-4'])
      const img = mark.querySelector<HTMLImageElement>('[data-testid="engine-field-favicon"]')!
      expect(img).not.toBeNull()
      expect(img.getAttribute('src')).toBe('https://duckduckgo.com/favicon.ico')
      expect(
        Array.from(img.classList)
          .filter((c) => /^(h-|w-)/.test(c))
          .sort()
      ).toEqual(['h-4', 'w-4'])
      // Until it arrives, the magnifier at the same 16 and the row stroke stands in – never 12.
      const magnifier = mark.querySelector<SVGElement>('svg.lucide-search')!
      expect(magnifier).not.toBeNull()
      expectSlotGlyph(magnifier)
      // The pill lists no site chip: the address keeps the whole tier.
      expect(chipLabels(el)).not.toContain('Site information')

      // A state that lists no engine yet: the magnifier alone, at the slot's size and stroke.
      act(() => root!.render(<NavRow state={state(empty)} tab={empty} compact={false} />))
      const bare = pill.querySelector<HTMLElement>('[data-field-glyph="engine"]')!
      expect(bare.querySelector('[data-testid="engine-field-glyph"]')).toBeNull()
      expectSlotGlyph(bare.querySelector<SVGElement>('svg.lucide-search')!)

      // A page arrives: the mark leaves with the prompt, the slot stands in its box.
      act(() => root!.render(<NavRow state={state(page)} tab={page} compact={false} />))
      expect(pill.querySelector('[data-field-glyph]')).toBeNull()
      expect(box(slotOf(el)).sort()).toEqual(['-ml-1', 'h-6', 'w-6'])
    })

    it('an empty private tab keeps the mask alone in the leading slot – identity with nothing to open, standing in for the engine’s mark – and no button', () => {
      const empty = tab('zen://newtab', { containerId: PRIVATE_CONTAINER_ID })
      const el = render(<NavRow state={state(empty)} tab={empty} compact={false} />)
      const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')!
      expect(pill.querySelector('[data-site-chip]')).toBeNull()
      expect(pill.querySelector('[data-field-glyph]')).toBeNull()
      const slot = pill.querySelector<HTMLElement>('[data-private-slot]')!
      expect(slot).not.toBeNull()
      expect(slot.tagName).toBe('SPAN')
      expect(slot.getAttribute('aria-hidden')).toBe('true')
      expect(box(slot).sort()).toEqual(['-ml-1', 'h-6', 'w-6'])
      const mask = glyphOf(slot)
      expect(mask.classList.contains('lucide-venetian-mask')).toBe(true)
      expect(mask.hasAttribute('data-private-mark')).toBe(true)
      expectSlotGlyph(mask)
      expect(pill.querySelectorAll('svg.lucide-venetian-mask')).toHaveLength(1)
      expect(labels(focusable(pill))).not.toContain('Site information')
      expect(focusable(pill)[0].textContent).toBe('Search or enter address')
    })

    it('adds nothing to the pill: the same chips, in the same order, with a state as at rest', () => {
      const rest = render(<NavRow state={withShield(state(page))} tab={page} compact={false} />)
      const atRest = chipLabels(rest)
      expect(atRest[0]).toBe('Site information')
      const call = using({ camera: true, microphone: true, display: false })
      act(() =>
        root!.render(
          <NavRow
            state={withShield(withRules(call, [deny('geolocation')]))}
            tab={call}
            compact={false}
          />
        )
      )
      const withState = chipLabels(rest)
      expect(withState.length).toBe(atRest.length)
      expect(withState.slice(1)).toEqual(atRest.slice(1))
      expect(withState[0]).toBe('Site information · This page is using your camera and microphone')
      // The slot keeps its 24 box (§9.19): the address's room at the 240 sidebar is what it was.
      const slot = slotOf(rest)
      expect(slot.classList.contains('w-6')).toBe(true)
      expect(slot.classList.contains('-ml-1')).toBe(true)
      expect(rest.querySelectorAll('.zen-v2-blocked-chip').length).toBe(1)
    })

    it('opens the site information on its Permissions level from a state, the overview from the connection, and hands the keyboard back', async () => {
      const call = using({ camera: true, microphone: false, display: false })
      const el = render(
        <NavRow state={withRules(call, [deny('microphone')])} tab={call} compact={false} />
      )
      const slot = slotOf(el)
      await openFromChip(slot)
      expect(siteInfoStore.get().tabId).toBe('t1')
      expect(siteInfoStore.get().level).toBe('permissions')
      expect(siteInfoStore.get().openedBy).toBe('site')
      expect(uiStore.get().urlbar.open).toBe(false)
      expect(slot.getAttribute('aria-expanded')).toBe('true')
      await dismiss()
      expect(document.activeElement).toBe(slot)
      expect(siteInfoStore.get().level).toBe('overview')
      expect(siteInfoStore.get().openedBy).toBeNull()
      expect(slot.getAttribute('aria-expanded')).toBe('false')

      // A block alone leads to Permissions as well.
      act(() =>
        root!.render(
          <NavRow state={withRules(page, [deny('microphone')])} tab={page} compact={false} />
        )
      )
      await openFromChip(slot)
      expect(siteInfoStore.get().level).toBe('permissions')
      await dismiss()
      expect(document.activeElement).toBe(slot)

      // The connection's glyph still opens the overview.
      act(() => root!.render(<NavRow state={state(page)} tab={page} compact={false} />))
      expect(slot.getAttribute('aria-label')).toBe('Site information')
      await openFromChip(slot)
      expect(siteInfoStore.get().level).toBe('overview')
      await dismiss()
    })

    it('has one pressed anchor: the chip that opened the popover, and no other', async () => {
      const el = render(<NavRow state={withShield(state(page))} tab={page} compact={false} />)
      const slot = slotOf(el)
      const shield = el.querySelector<HTMLElement>('.zen-v2-blocked-chip')!
      expect(shield.getAttribute('aria-expanded')).toBe('false')
      expect(slot.getAttribute('aria-expanded')).toBe('false')
      // The pressed fill is the window control's (`--v2-control-fill-hover` at full ink), on
      // the opener alone – the class itself, not its `hover:` variant, which every chip carries.
      const hasPressedFill = (chip: HTMLElement): boolean =>
        chip.className.split(/\s+/).includes('bg-[var(--v2-control-fill-hover)]')

      await openFromChip(slot)
      expect(siteInfoStore.get().openedBy).toBe('site')
      expect(slot.getAttribute('aria-expanded')).toBe('true')
      expect(shield.getAttribute('aria-expanded')).toBe('false')
      expect(hasPressedFill(slot)).toBe(true)
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text)]'])
      expect(el.querySelectorAll('[aria-expanded="true"]').length).toBe(1)
      await dismiss()
      expect(hasPressedFill(slot)).toBe(false)
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])
      expect(el.querySelectorAll('[aria-expanded="true"]').length).toBe(0)

      await openFromChip(shield)
      expect(siteInfoStore.get().openedBy).toBe('shield')
      expect(shield.getAttribute('aria-expanded')).toBe('true')
      expect(slot.getAttribute('aria-expanded')).toBe('false')
      expect(hasPressedFill(slot)).toBe(false)
      expect(el.querySelectorAll('[aria-expanded="true"]').length).toBe(1)
      await dismiss()
      expect(document.activeElement).toBe(shield)

      // Opened with no chip (the app menu's Page info): nothing in the pill reads pressed.
      await act(async () => {
        await openSiteInfo(page)
        await vi.waitFor(() => expect(uiStore.get().siteInfoOpen).toBe(true))
      })
      expect(siteInfoStore.get().openedBy).toBeNull()
      expect(el.querySelectorAll('[aria-expanded="true"]').length).toBe(0)
      await dismiss()
    })

    // §9.29 as amended on #428 (the lead's ruling 2): the press changes the fill, never the
    // message – a certificate error's triangle keeps the danger ink on the pressed fill while
    // its popover is up, where the lock and the mask take the pressed full ink. The chip's
    // classes go through `twMerge`, where the last text colour wins: the danger class must
    // survive the pressed anchor's.
    it('holds the danger tier’s ink under the press: the triangle stays in the danger ink on the pressed fill while its popover is up; the lock and the mask take the pressed ink', async () => {
      const hasPressedFill = (chip: HTMLElement): boolean =>
        chip.className.split(/\s+/).includes('bg-[var(--v2-control-fill-hover)]')
      const broken = tab(page.url, {
        readerable: true,
        certificateError: { code: -201, url: page.url, certificate: null, bypassed: false }
      })
      const el = render(<NavRow state={state(broken)} tab={broken} compact={false} />)
      const slot = slotOf(el)
      expect(glyphOf(slot).classList.contains('lucide-triangle-alert')).toBe(true)
      expect(inkOf(slot)).toEqual(['text-[var(--v2-danger)]'])
      expect(hasPressedFill(slot)).toBe(false)

      await openFromChip(slot)
      expect(siteInfoStore.get().openedBy).toBe('site')
      expect(slot.getAttribute('aria-expanded')).toBe('true')
      // The pressed fill comes on; the message does not change: the danger ink, once, and no
      // full-ink class beside it for the fill's sake.
      expect(hasPressedFill(slot)).toBe(true)
      expect(inkOf(slot)).toEqual(['text-[var(--v2-danger)]'])
      expect(restOpacity(slot)).toEqual([])
      await dismiss()
      expect(hasPressedFill(slot)).toBe(false)
      expect(inkOf(slot)).toEqual(['text-[var(--v2-danger)]'])

      // The connection glyph under the press, as before: the lock at the pressed full ink.
      act(() => root!.render(<NavRow state={state(page)} tab={page} compact={false} />))
      expect(glyphOf(slot).classList.contains('lucide-lock')).toBe(true)
      await openFromChip(slot)
      expect(hasPressedFill(slot)).toBe(true)
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text)]'])
      await dismiss()
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])

      // The mask under the press, as before: the pressed full ink (it is identity, not danger).
      const secret = tab(page.url, { readerable: true, containerId: PRIVATE_CONTAINER_ID })
      act(() => root!.render(<NavRow state={state(secret)} tab={secret} compact={false} />))
      expect(glyphOf(slot).classList.contains('lucide-venetian-mask')).toBe(true)
      await openFromChip(slot)
      expect(hasPressedFill(slot)).toBe(true)
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text)]'])
      await dismiss()
      expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])

      // The danger tier over the mask, pressed: still the danger ink – the tier, not the tab.
      const brokenSecret = tab(page.url, {
        readerable: true,
        containerId: PRIVATE_CONTAINER_ID,
        certificateError: { code: -201, url: page.url, certificate: null, bypassed: false }
      })
      act(() =>
        root!.render(<NavRow state={state(brokenSecret)} tab={brokenSecret} compact={false} />)
      )
      expect(glyphOf(slot).classList.contains('lucide-triangle-alert')).toBe(true)
      await openFromChip(slot)
      expect(hasPressedFill(slot)).toBe(true)
      expect(inkOf(slot)).toEqual(['text-[var(--v2-danger)]'])
      await dismiss()
    })

    // omnibox-40 / tabs-40: Chrome's Memory Saver chip as the slot's glyph – the leaf for ten
    // seconds after a tab the core slept wakes (`Tab.memorySaver`, written by `Tabs.load`),
    // below a standing block and above the connection glyph or the private mask; its click
    // opens the Memory Saver bubble, not the site information.
    describe('the Memory Saver leaf (omnibox-40)', () => {
      const woken = (patch: Partial<Tab> = {}, wokeAt = Date.now()): Tab =>
        tab(page.url, { readerable: true, memorySaver: { savedMb: 312, wokeAt }, ...patch })
      const hasPressedFill = (chip: HTMLElement): boolean =>
        chip.className.split(/\s+/).includes('bg-[var(--v2-control-fill-hover)]')

      it('draws the leaf for a tab just woken from sleep at the slot’s one size and rest ink, named with the number the discard recorded', () => {
        const el = render(<NavRow state={state(woken())} tab={woken()} compact={false} />)
        const slot = slotOf(el)
        expectChip(slot, 'Site information · Memory Saver freed up 312 MB')
        expect(slot.getAttribute('data-slot-state')).toBe('memory-saver')
        expect(slot.getAttribute('data-slot-glyph')).toBe('leaf')
        expect(glyphOf(slot).classList.contains('lucide-leaf')).toBe(true)
        expect(slot.querySelectorAll('svg')).toHaveLength(1)
        expect(slot.getAttribute('data-tooltip')).toBe('Memory Saver freed up 312 MB')
        expect(slot.hasAttribute('title')).toBe(false)
        expect(slot.getAttribute('aria-haspopup')).toBe('dialog')
        expect(slot.getAttribute('aria-expanded')).toBe('false')
        // §9.19's 16 in the 24 box at the row's stroke: the address's room is unchanged.
        expectSlotGlyph(glyphOf(slot))
        expect(box(slot).sort()).toEqual(['-ml-1', 'h-6', 'w-6'])
        // A notice, not a live state: the slot's 69 % rest ink, the token once (§9.29).
        expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])
        expect(restOpacity(slot)).toEqual([])
        expect(hasPressedFill(slot)).toBe(false)
        // Never a second chip for it.
        expect(chipLabels(el).filter((l) => l?.includes('Memory Saver'))).toHaveLength(1)
        // A tab that never slept this session, or one whose record the core cleared: no leaf.
        act(() => root!.render(<NavRow state={state(page)} tab={page} compact={false} />))
        expect(slot.getAttribute('data-slot-state')).toBe('connection')
        expect(el.querySelector('svg.lucide-leaf')).toBeNull()
      })

      it('stands below a standing block and above the connection glyph and the private mask; a capture and a certificate error take the slot over it', () => {
        // Over the mask: a private tab that woke shows the leaf, the mask gone from the box.
        const secret = woken({ containerId: PRIVATE_CONTAINER_ID })
        const el = render(<NavRow state={state(secret)} tab={secret} compact={false} />)
        const slot = slotOf(el)
        expect(glyphOf(slot).classList.contains('lucide-leaf')).toBe(true)
        expect(slot.getAttribute('data-slot-state')).toBe('memory-saver')
        expect(el.querySelector('svg.lucide-venetian-mask')).toBeNull()
        expect(slot.querySelectorAll('svg')).toHaveLength(1)
        // Under a standing block: the user's decision over the passing notice.
        act(() =>
          root!.render(
            <NavRow state={withRules(woken(), [deny('camera')])} tab={woken()} compact={false} />
          )
        )
        expect(glyphOf(slot).classList.contains('lucide-camera-off')).toBe(true)
        expect(slot.getAttribute('data-slot-state')).toBe('blocked')
        expect(slot.getAttribute('aria-label')).toBe('Site information · Camera blocked')
        // Under a live capture.
        const call = woken({ capture: { camera: true, microphone: false, display: false } })
        act(() => root!.render(<NavRow state={state(call)} tab={call} compact={false} />))
        expect(glyphOf(slot).classList.contains('lucide-camera')).toBe(true)
        expect(slot.getAttribute('data-slot-state')).toBe('capture')
        // Under the danger tier: the triangle in the danger ink, the leaf's name gone with it.
        const broken = woken({
          certificateError: { code: -201, url: page.url, certificate: null, bypassed: false }
        })
        act(() => root!.render(<NavRow state={state(broken)} tab={broken} compact={false} />))
        expect(glyphOf(slot).classList.contains('lucide-triangle-alert')).toBe(true)
        expect(slot.getAttribute('data-slot-state')).toBe('connection')
        expect(slot.getAttribute('aria-label')).toBe('Site information')
        expect(inkOf(slot)).toEqual(['text-[var(--v2-danger)]'])
        expect(el.querySelector('svg.lucide-leaf')).toBeNull()
        // The states end: the leaf returns while its ten seconds run, in the same box.
        act(() => root!.render(<NavRow state={state(woken())} tab={woken()} compact={false} />))
        expect(glyphOf(slot).classList.contains('lucide-leaf')).toBe(true)
        expect(box(slot).sort()).toEqual(['-ml-1', 'h-6', 'w-6'])
      })

      it('leaves the slot on its own ten seconds after the wake, the connection’s glyph back in the box', async () => {
        // A wake most of the window ago: the leaf still up, its clock armed for what is left.
        const late = woken({}, Date.now() - MEMORY_SAVER_LEAF_MS + 40)
        const el = render(<NavRow state={state(late)} tab={late} compact={false} />)
        const slot = slotOf(el)
        expect(glyphOf(slot).classList.contains('lucide-leaf')).toBe(true)
        // The clock runs out: nothing else changed – no new state, no re-render from outside.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200))
        })
        expect(slot.getAttribute('data-slot-state')).toBe('connection')
        expect(glyphOf(slot).classList.contains('lucide-lock')).toBe(true)
        expect(slot.getAttribute('aria-label')).toBe('Site information')
        expect(el.querySelector('svg.lucide-leaf')).toBeNull()
        // A wake older than the window at the mount says nothing at all.
        const stale = woken({}, Date.now() - MEMORY_SAVER_LEAF_MS - 1)
        act(() => root!.render(<NavRow state={state(stale)} tab={stale} compact={false} />))
        expect(slot.getAttribute('data-slot-state')).toBe('connection')
      })

      it('opens the Memory Saver bubble on a click – not the site information – with the slot as its pressed anchor, and holds the leaf for as long as the bubble is up', async () => {
        const el = render(<NavRow state={state(woken())} tab={woken()} compact={false} />)
        const slot = slotOf(el)
        slot.focus()
        await act(async () => {
          slot.click()
          await vi.waitFor(() => expect(uiStore.get().memorySaverBubble).toEqual({ tabId: 't1' }))
        })
        // The site information stayed shut; the chrome took the keyboard for the bubble.
        expect(uiStore.get().siteInfoOpen).toBe(false)
        expect(siteInfoStore.get().tabId).toBeNull()
        expect(commands()).toContain('focus.chrome')
        // The pressed anchor (§9.20): the window fill at full ink, `aria-expanded` on.
        expect(slot.getAttribute('aria-expanded')).toBe('true')
        expect(hasPressedFill(slot)).toBe(true)
        expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text)]'])
        expect(glyphOf(slot).classList.contains('lucide-leaf')).toBe(true)
        // The ten seconds pass while the bubble is up: the leaf stays for it.
        const held = woken({}, Date.now() - MEMORY_SAVER_LEAF_MS - 5_000)
        act(() => root!.render(<NavRow state={state(held)} tab={held} compact={false} />))
        expect(slot.getAttribute('data-slot-state')).toBe('memory-saver')
        expect(glyphOf(slot).classList.contains('lucide-leaf')).toBe(true)
        // A second press on the anchor opens nothing new (the layer's light dismiss closes it).
        await act(async () => {
          slot.click()
        })
        expect(uiStore.get().memorySaverBubble).toEqual({ tabId: 't1' })
        // The bubble goes: the leaf's window is long over, so the connection glyph returns.
        act(() => closeMemorySaverBubble({ keepFocus: true }))
        expect(uiStore.get().memorySaverBubble).toBeNull()
        expect(slot.getAttribute('data-slot-state')).toBe('connection')
        expect(slot.getAttribute('aria-expanded')).toBe('false')
        expect(hasPressedFill(slot)).toBe(false)
        expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])
      })

      it('puts the bubble away when a state takes the slot over the leaf', async () => {
        const el = render(<NavRow state={state(woken())} tab={woken()} compact={false} />)
        const slot = slotOf(el)
        await act(async () => {
          slot.click()
          await vi.waitFor(() => expect(uiStore.get().memorySaverBubble).toEqual({ tabId: 't1' }))
        })
        // A capture starts on the page: the camera takes the slot, and the leaf's bubble goes
        // with the leaf.
        const call = woken({ capture: { camera: true, microphone: false, display: false } })
        act(() => root!.render(<NavRow state={state(call)} tab={call} compact={false} />))
        expect(slot.getAttribute('data-slot-state')).toBe('capture')
        expect(uiStore.get().memorySaverBubble).toBeNull()
        expect(slot.getAttribute('aria-expanded')).toBe('false')
      })
    })

    // NOT-03 / omnibox-38: a quiet notification request asks through the slot – the crossed-out
    // bell at rest, its bubble opening from the bell alone (`quietPromptId`), never on its own.
    describe('the quiet notification request’s bell (NOT-03)', () => {
      const quietAsk = (id = 'perm-q1', tabId = 't1'): PermissionPrompt => ({
        id,
        tabId,
        origin: 'https://example.com',
        permission: 'notifications',
        message: 'Notifications blocked',
        detail: 'You usually block notifications. To let example.com notify you, choose Allow.',
        allowLabel: 'Allow',
        blockLabel: 'Keep blocking',
        allowOnce: false,
        requestedAt: 0,
        quiet: true
      })
      /** The state with the prompts pending, the tab's quiet ask among them. */
      const asking = (t: Tab, prompts: PermissionPrompt[] = [quietAsk()]): UIState => ({
        ...state(t),
        permissionPrompts: prompts
      })
      const hasPressedFill = (chip: HTMLElement): boolean =>
        chip.className.split(/\s+/).includes('bg-[var(--v2-control-fill-hover)]')

      afterEach(() => {
        uiStore.set({ quietPromptId: null })
      })

      it('draws the crossed-out bell at the slot’s one size and rest ink, named as Chrome names it, and no bubble on its own', () => {
        const el = render(<NavRow state={asking(page)} tab={page} compact={false} />)
        const slot = slotOf(el)
        expectChip(slot, 'Site information · Notifications blocked')
        expect(slot.getAttribute('data-slot-state')).toBe('quiet')
        expect(slot.getAttribute('data-slot-glyph')).toBe('notifications-off')
        expect(glyphOf(slot).classList.contains('lucide-bell-off')).toBe(true)
        expect(slot.querySelectorAll('svg')).toHaveLength(1)
        expect(slot.getAttribute('data-tooltip')).toBe('Notifications blocked')
        expect(slot.hasAttribute('title')).toBe(false)
        expect(slot.getAttribute('aria-haspopup')).toBe('dialog')
        expect(slot.getAttribute('aria-expanded')).toBe('false')
        // §9.19's 16 in the 24 box at the row's stroke: the address's room is unchanged.
        expectSlotGlyph(glyphOf(slot))
        expect(box(slot).sort()).toEqual(['-ml-1', 'h-6', 'w-6'])
        // A question, not a live state: the slot's 69 % rest ink, the token once (§9.29).
        expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])
        expect(restOpacity(slot)).toEqual([])
        expect(hasPressedFill(slot)).toBe(false)
        // Nothing opened by itself: the bell waits for the user.
        expect(uiStore.get().quietPromptId).toBeNull()
        // Never a second chip for it.
        expect(chipLabels(el).filter((l) => l?.includes('Notifications'))).toHaveLength(1)
        // A loud ask on the tab, or another tab's quiet one, is no bell: the connection's glyph.
        act(() =>
          root!.render(
            <NavRow
              state={asking(page, [{ ...quietAsk(), quiet: undefined }, quietAsk('perm-q2', 't2')])}
              tab={page}
              compact={false}
            />
          )
        )
        expect(slot.getAttribute('data-slot-state')).toBe('connection')
        expect(el.querySelector('svg.lucide-bell-off')).toBeNull()
      })

      it('stands above the leaf and the private mask, below a standing block; a capture and a certificate error take the slot over it', () => {
        // Over the leaf: a question waiting on the user beats a passing notice.
        const woken = tab(page.url, {
          readerable: true,
          memorySaver: { savedMb: 312, wokeAt: Date.now() }
        })
        const el = render(<NavRow state={asking(woken)} tab={woken} compact={false} />)
        const slot = slotOf(el)
        expect(glyphOf(slot).classList.contains('lucide-bell-off')).toBe(true)
        expect(slot.getAttribute('data-slot-state')).toBe('quiet')
        expect(el.querySelector('svg.lucide-leaf')).toBeNull()
        // Over the mask: a private tab's quiet ask shows the bell, the mask gone from the box.
        const secret = tab(page.url, { readerable: true, containerId: PRIVATE_CONTAINER_ID })
        act(() => root!.render(<NavRow state={asking(secret)} tab={secret} compact={false} />))
        expect(glyphOf(slot).classList.contains('lucide-bell-off')).toBe(true)
        expect(el.querySelector('svg.lucide-venetian-mask')).toBeNull()
        expect(slot.querySelectorAll('svg')).toHaveLength(1)
        // Under a standing block of another permission: the user's decision over the question.
        act(() =>
          root!.render(
            <NavRow
              state={{ ...asking(page), permissionRules: [deny('camera')] }}
              tab={page}
              compact={false}
            />
          )
        )
        expect(glyphOf(slot).classList.contains('lucide-camera-off')).toBe(true)
        expect(slot.getAttribute('data-slot-state')).toBe('blocked')
        expect(slot.getAttribute('aria-label')).toBe('Site information · Camera blocked')
        // Under a live capture.
        const call = using({ camera: false, microphone: true, display: false })
        act(() => root!.render(<NavRow state={asking(call)} tab={call} compact={false} />))
        expect(glyphOf(slot).classList.contains('lucide-mic')).toBe(true)
        expect(slot.getAttribute('data-slot-state')).toBe('capture')
        // Under the danger tier: the triangle in the danger ink, the bell's name gone with it.
        const broken = tab(page.url, {
          readerable: true,
          certificateError: { code: -201, url: page.url, certificate: null, bypassed: false }
        })
        act(() => root!.render(<NavRow state={asking(broken)} tab={broken} compact={false} />))
        expect(glyphOf(slot).classList.contains('lucide-triangle-alert')).toBe(true)
        expect(slot.getAttribute('data-slot-state')).toBe('connection')
        expect(inkOf(slot)).toEqual(['text-[var(--v2-danger)]'])
        expect(el.querySelector('svg.lucide-bell-off')).toBeNull()
        // The states end: the bell returns, the question still waiting, in the same box.
        act(() => root!.render(<NavRow state={asking(page)} tab={page} compact={false} />))
        expect(glyphOf(slot).classList.contains('lucide-bell-off')).toBe(true)
        expect(box(slot).sort()).toEqual(['-ml-1', 'h-6', 'w-6'])
      })

      it('opens the quiet prompt on a click – not the site information – with the slot as its pressed anchor; a second press opens nothing new', async () => {
        const el = render(<NavRow state={asking(page)} tab={page} compact={false} />)
        const slot = slotOf(el)
        slot.focus()
        await act(async () => {
          slot.click()
        })
        // The bell's prompt is the one to show (`PermissionPrompts` draws it); site information
        // stayed shut.
        expect(uiStore.get().quietPromptId).toBe('perm-q1')
        expect(uiStore.get().siteInfoOpen).toBe(false)
        expect(siteInfoStore.get().tabId).toBeNull()
        // The pressed anchor (§9.20): the window fill at full ink, `aria-expanded` on, the bell
        // still the glyph.
        expect(slot.getAttribute('aria-expanded')).toBe('true')
        expect(hasPressedFill(slot)).toBe(true)
        expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text)]'])
        expect(glyphOf(slot).classList.contains('lucide-bell-off')).toBe(true)
        // A second press on the anchor opens nothing new (the layer's light dismiss closes it).
        await act(async () => {
          slot.click()
        })
        expect(uiStore.get().quietPromptId).toBe('perm-q1')
        // The bubble put away without a word (Escape, a press outside): the bell stays, at rest.
        act(() => uiStore.set({ quietPromptId: null }))
        expect(slot.getAttribute('data-slot-state')).toBe('quiet')
        expect(slot.getAttribute('aria-expanded')).toBe('false')
        expect(hasPressedFill(slot)).toBe(false)
        expect(inkOf(slot)).toEqual(['text-[var(--v2-control-text-deemphasized)]'])
        // Nothing went to the core: a quiet prompt is never dismissed from here.
        expect(commands()).not.toContain('permissions.respond')
      })

      it('puts the bubble away when a state takes the slot over the bell, or another tab comes forward', async () => {
        const el = render(<NavRow state={asking(page)} tab={page} compact={false} />)
        const slot = slotOf(el)
        await act(async () => {
          slot.click()
        })
        expect(uiStore.get().quietPromptId).toBe('perm-q1')
        // The camera starts on the page: the capture takes the slot, and the bell's bubble goes
        // with the bell – the question is still pending, so the bell returns when the state ends.
        const call = using({ camera: true, microphone: false, display: false })
        act(() => root!.render(<NavRow state={asking(call)} tab={call} compact={false} />))
        expect(slot.getAttribute('data-slot-state')).toBe('capture')
        expect(uiStore.get().quietPromptId).toBeNull()
        expect(slot.getAttribute('aria-expanded')).toBe('false')
        act(() => root!.render(<NavRow state={asking(page)} tab={page} compact={false} />))
        expect(slot.getAttribute('data-slot-state')).toBe('quiet')
        expect(uiStore.get().quietPromptId).toBeNull()
        // Opened again, then another tab in front: the bubble hung from this tab's bell.
        await act(async () => {
          slot.click()
        })
        expect(uiStore.get().quietPromptId).toBe('perm-q1')
        const other = tab('https://other.example/', { id: 't2' })
        act(() =>
          root!.render(
            <NavRow
              state={{
                ...asking(other),
                tabs: { t1: page, t2: other },
                spaces: [{ ...space, tabIds: ['t1', 't2'], activeTabId: 't2' }]
              }}
              tab={other}
              compact={false}
            />
          )
        )
        expect(slot.getAttribute('data-slot-state')).toBe('connection')
        expect(uiStore.get().quietPromptId).toBeNull()
        // The prompt answered or withdrawn while its bubble was up: the flag goes too (the
        // bubble's own effect; the slot's one sees the bell gone).
        act(() => root!.render(<NavRow state={asking(page)} tab={page} compact={false} />))
        await act(async () => {
          slot.click()
        })
        expect(uiStore.get().quietPromptId).toBe('perm-q1')
        act(() => root!.render(<NavRow state={asking(page, [])} tab={page} compact={false} />))
        expect(slot.getAttribute('data-slot-state')).toBe('connection')
        expect(uiStore.get().quietPromptId).toBeNull()
      })
    })
  })

  // omnibox-43 / dnd-11: the slot is the handle the address is dragged out by, as Chrome's
  // location icon is – an HTML5 drag carrying the link, the text and an anchor with the page's
  // name (`lib/addressDrag.ts`), which the bookmarks bar files and a tab row navigates to.
  describe('the address dragged out by the slot (omnibox-43)', () => {
    const slotOf = (el: HTMLElement): HTMLElement =>
      el.querySelector<HTMLElement>('[data-site-chip]')!
    /** A `dragstart` on the chip with a transfer that records what the chip writes. */
    function dragStart(chip: HTMLElement): {
      effectAllowed: string
      data: Map<string, string>
      image: { el: Element; x: number; y: number } | null
    } {
      const record = {
        effectAllowed: 'uninitialized',
        data: new Map<string, string>(),
        image: null as { el: Element; x: number; y: number } | null
      }
      const dt = {
        get effectAllowed() {
          return record.effectAllowed
        },
        set effectAllowed(v: string) {
          record.effectAllowed = v
        },
        setData: (type: string, value: string) => void record.data.set(type, value),
        setDragImage: (el: Element, x: number, y: number) => void (record.image = { el, x, y })
      }
      const ev = new Event('dragstart', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'dataTransfer', { value: dt })
      act(() => void chip.dispatchEvent(ev))
      return record
    }

    it('is draggable on a page, carrying the link, the text and an anchor named for the page, with the link card as the image', () => {
      const named = tab(page.url, { readerable: true, title: 'Example Domain' })
      const el = render(<NavRow state={state(named)} tab={named} compact={false} />)
      const slot = slotOf(el)
      expect(slot.getAttribute('draggable')).toBe('true')
      expect(slot.getAttribute('data-drag-address')).toBe('https://example.com/some/path')
      // The slot is still the site-information button: its click is unchanged.
      expectChip(slot, 'Site information')
      expect(slot.getAttribute('aria-haspopup')).toBe('dialog')
      const drag = dragStart(slot)
      expect(drag.effectAllowed).toBe('copyLink')
      expect([...drag.data.keys()]).toEqual(['text/uri-list', 'text/plain', 'text/html'])
      expect(drag.data.get('text/uri-list')).toBe('https://example.com/some/path')
      expect(drag.data.get('text/plain')).toBe('https://example.com/some/path')
      expect(drag.data.get('text/html')).toBe(
        '<a href="https://example.com/some/path">Example Domain</a>'
      )
      // The ghost: the link card off screen, the page's name in it, the grip at its left.
      const ghost = el.querySelector<HTMLElement>('.zen-link-ghost')!
      expect(ghost).not.toBeNull()
      expect(ghost.getAttribute('aria-hidden')).toBe('true')
      // The page's icon (its letter here, no favicon) and its name on the card.
      expect(ghost.querySelector('.zen-link-ghost-card span.truncate')?.textContent).toBe(
        'Example Domain'
      )
      expect(drag.image).toEqual({ el: ghost, x: 12, y: 14 })
      // The URL bar did not open and no site information came up on the drag.
      expect(uiStore.get().urlbar.open).toBe(false)
      expect(uiStore.get().siteInfoOpen).toBe(false)
    })

    it('lifts a private tab’s address too, but nothing from an empty tab or a Zenium page', () => {
      const secret = tab(page.url, { readerable: true, containerId: PRIVATE_CONTAINER_ID })
      const el = render(<NavRow state={state(secret)} tab={secret} compact={false} />)
      expect(slotOf(el).getAttribute('draggable')).toBe('true')
      const empty = tab('zen://newtab')
      act(() => root!.render(<NavRow state={state(empty)} tab={empty} compact={false} />))
      // An empty tab has no slot at all (#406 §G); no ghost either.
      expect(el.querySelector('[data-site-chip]')).toBeNull()
      expect(el.querySelector('.zen-link-ghost')).toBeNull()
      const settings = tab('zen://settings', { title: 'Settings' })
      act(() => root!.render(<NavRow state={state(settings)} tab={settings} compact={false} />))
      const internal = el.querySelector<HTMLElement>('[data-site-chip]')
      expect(internal?.hasAttribute('draggable') ?? false).toBe(false)
      expect(el.querySelector('.zen-link-ghost')).toBeNull()
    })
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

  it('puts the mask in the leading slot in place of the site icon – the slot still the site-information chip', () => {
    const el = render(<NavRow state={tablet(privatePage)} tab={privatePage} compact={false} />)
    const pill = el.querySelector<HTMLElement>('[role="group"][aria-label="Address"]')!
    // The mask in the slot's 24 box at the pill's start (§9.19), the site icon's place, as the
    // glyph of the site-information button the slot stays (#406 §G).
    expect(
      pill.querySelector('[data-site-chip].order-first > svg.lucide-venetian-mask')
    ).not.toBeNull()
    expect(pill.querySelector('[data-private-slot]')).toBeNull()
    const slot = pill.querySelector<HTMLElement>('[aria-label="Site information"]')!
    expect(slot).not.toBeNull()
    expect(slot.getAttribute('data-slot-state')).toBe('private')
    expect(focusable(pill)[0].textContent).toBe('example.com/some/path')
    expect(labels(focusable(pill))).toContain('Site information')
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
      expect(pill.getAttribute('data-tooltip')).toBe('Private tab')
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
    expect(pill.getAttribute('data-tooltip')).toBe('zenium://settings/privacy')
  })

  it('names the page once the field cannot fit the address; the tooltip keeps the address', () => {
    widths.probe = 150
    widths.field = 60
    const el = render(<NavRow state={state(settings)} tab={settings} compact={false} />)
    const { pill, field } = pillOf(el)
    expect(focusable(pill)[0].textContent).toBe('Settings')
    expect(field.getAttribute('data-reads')).toBe('title')
    // `zenium://`, never the canonical `zen://` the tab carries (§10.1).
    expect(pill.getAttribute('data-tooltip')).toBe('zenium://settings/privacy')
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
    expect(pill.getAttribute('data-tooltip')).toBe('https://example.com/some/path')
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
    expect(pill.getAttribute('data-tooltip')).toBe('https://www.example.com/some/path')
    // The probe still holds the address the field is measured against.
    expect(pill.querySelector('[data-pill-probe]')!.textContent).toBe('example.com/some/path')
  })

  it('offers the search prompt, not `zen://newtab`, as the empty tab’s tooltip', () => {
    const empty = tab('zen://newtab')
    const el = render(<NavRow state={state(empty)} tab={empty} compact={false} />)
    const { pill } = pillOf(el)
    expect(pill.getAttribute('data-tooltip')).toBe('Search or enter address')
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

  it('draws the Not secure chip in the lock’s room on a plain http page (ERR-09)', () => {
    const http = tab('http://example.com/')
    const el = render(<PillContent state={state(http)} tab={http} space={space} interactive />)
    // The open lock takes the lock's room – same chassis, the warn ink – and the address says
    // the state as before (A11Y-01 on OMN-02).
    const order = focusable(el)
    expect(labels(order)).toEqual([
      'Address, example.com, Not secure',
      'Site information',
      'Not secure'
    ])
    expectChip(order[2], 'Not secure')
    expect(order[2].hasAttribute('data-site-info')).toBe(true)
    expect(order[2].getAttribute('data-verdict')).toBe('warn')
    expect(order[2].querySelector('svg.lucide-lock-open')).not.toBeNull()
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

/*
 * The pinned toolbar button's right-click menu (context-menus-112, W8-1): the desktop bar's
 * pinnable action controls – the pill's Reader View, Translate and star chips, the media hub's
 * button – are marked `data-zen-menu="toolbar"` with their control in `data-zen-menu-control`,
 * for the host to read under the pointer and the core to answer with Chrome's Unpin / Customise
 * Toolbar… rows. The star keeps its own `star` target and takes the control alone. Forward
 * carries no mark: its right-click is the stack's menu, as Chrome's Forward keeps its
 * `BackForwardMenuModel`. The desktop layout's alone: on the tablet no button is marked.
 */
const { viewportStore } = await import('@renderer/lib/formFactor')

describe('the toolbar button menu marks (context-menus-112, W8-1)', () => {
  const page = tab('https://example.com/some/path', {
    readerable: true,
    canGoBack: true,
    canGoForward: true
  })
  const byLabel = (el: HTMLElement, label: string): HTMLElement =>
    el.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!
  const marks = (el: HTMLElement): [string | null, string | null] => [
    el.getAttribute('data-zen-menu'),
    el.getAttribute('data-zen-menu-control')
  ]

  it('marks Reader View, Translate and the star with their controls on the desktop; Back, Forward and the reload button carry none', () => {
    const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
    expect(marks(byLabel(el, 'Reader View'))).toEqual(['toolbar', 'reader'])
    expect(marks(byLabel(el, 'Translate this page'))).toEqual(['toolbar', 'translate'])
    expect(marks(byLabel(el, 'Bookmark this tab'))).toEqual(['star', 'star'])
    for (const label of ['Back', 'Forward']) {
      const button = el.querySelector<HTMLElement>(`button[aria-label^="${label}"]`)!
      expect(button).not.toBeNull()
      expect(marks(button)).toEqual([null, null])
    }
    expect(marks(el.querySelector<HTMLElement>('[data-zen-menu="reload"]')!)).toEqual([
      'reload',
      null
    ])
    // The pill's field keeps its own target and no control.
    expect(marks(el.querySelector<HTMLElement>('[data-zen-menu="urlpill"]')!)).toEqual([
      'urlpill',
      null
    ])
    expect(el.querySelectorAll('[data-zen-menu="toolbar"]')).toHaveLength(2)
  })

  it('on the tablet no control is marked: the pins are the desktop layout’s', () => {
    const before = viewportStore.get()
    act(() => viewportStore.set({ ...before, formFactor: 'tablet', coarse: true, hover: false }))
    try {
      const el = render(<NavRow state={state(page)} tab={page} compact={false} />)
      expect(el.querySelector('[data-zen-menu="toolbar"]')).toBeNull()
      expect(el.querySelector('[data-zen-menu-control]')).toBeNull()
      expect(marks(byLabel(el, 'Bookmark this tab'))).toEqual(['star', null])
    } finally {
      act(() => viewportStore.set(before))
    }
  })
})
