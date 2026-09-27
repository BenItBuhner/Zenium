// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MediaState, Settings, Tab, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { defaultShortcuts } from '@shared/shortcuts'
import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { mediaHubFolded, mediaHubReturnRow } from '@renderer/lib/mediaHub'
import {
  FOLDING_BUTTON_PILL,
  foldingButtonFits,
  foldingButtonReturnRow,
  toolbarTiering
} from '@renderer/lib/toolbarPins'
import { NavRow } from '../SidebarTop'

/*
 * The desktop toolbar under Settings › Look and Feel › Customise toolbar (settings-36): a
 * control unpinned in `Settings.toolbarPins` is not drawn – Forward leaves the row, a chip
 * leaves the pill, the media hub's button folds as the width tier folds it (the ⋯ dot and the
 * menu's "Media Controls…" row stand in) – and the pins speak for the desktop layout alone. The
 * row publishes what the width tier hid of the pinned controls (`toolbarTiering`) for the
 * dialog's "Hidden at this width."
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    url,
    title: 'Page',
    canGoBack: true,
    canGoForward: true,
    loading: false,
    readerable: true,
    errorCode: null,
    blockedCount: 0,
    ...patch
  } as Tab
}

const page = tab('https://example.com/article')

function media(over: Partial<MediaState> = {}): MediaState {
  return {
    tabId: 't1',
    playing: true,
    title: 'Nocturne',
    artist: 'The Band',
    artwork: null,
    session: true,
    ...over
  }
}

/** The governor's snapshot with Energy Saver on: what puts the leaf in the row (W8-2). */
const SAVING = {
  resources: { system: { onBattery: true, batteryPercent: 42, energySaver: true } }
} as unknown as Partial<UIState>

/** Enough of a snapshot for the whole row, the pill and its chips included. */
function state(
  t: Tab,
  settings: Partial<Settings> = {},
  entries: MediaState[] = [],
  patch: Partial<UIState> = {}
): UIState {
  return {
    platform: 'linux',
    capabilities: { windowControls: false, windows: true },
    tabs: { [t.id]: t },
    spaces: [{ id: 'space', activeTabId: t.id, tabIds: [t.id], containerId: 'default' }],
    activeSpaceId: 'space',
    folders: {},
    essentialTabIds: [],
    settings: { urlbarBehavior: 'normal', ...settings },
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
    // The site-information slot (#406) reads the site's blocked permissions from the engine's rules.
    permissionRules: [],
    media: entries,
    ...patch
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

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

/** A nav button's name: the `aria-label` that carries its chord (a11y-26), the tooltip's text. */
const nameOf = (b: HTMLButtonElement): string => b.getAttribute('aria-label') ?? b.title
const forwardButton = (): HTMLButtonElement | null =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-zen-nav-row] > button')].find((b) =>
    nameOf(b).startsWith('Forward')
  ) ?? null
const chip = (label: string): HTMLElement | null => q(`[aria-label="${label}"]`)

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  viewportStore.set({ formFactor: 'desktop' })
  vi.mocked(run).mockClear()
})

describe('the desktop toolbar’s pins (settings-36)', () => {
  it('draws every optional control with no pins recorded – a profile from before the setting', () => {
    render(<NavRow state={state(page, {}, [media()])} tab={page} compact={false} />)
    expect(forwardButton()).not.toBeNull()
    expect(q('[data-bm-star]')).not.toBeNull()
    expect(chip('Reader View')).not.toBeNull()
    expect(chip('Translate this page')).not.toBeNull()
    expect(q('[data-zen-media-hub-button]')).not.toBeNull()
  })

  it('Forward unpinned leaves the row – Back and Reload stay – and the menu’s row is its home', () => {
    render(
      <NavRow state={state(page, { toolbarPins: { forward: false } })} tab={page} compact={false} />
    )
    expect(forwardButton()).toBeNull()
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-zen-nav-row] > button')]
    expect(buttons.some((b) => nameOf(b).startsWith('Back'))).toBe(true)
    expect(buttons.some((b) => nameOf(b).startsWith('Reload'))).toBe(true)
    // The compact rail follows the same setting.
    render(<NavRow state={state(page, { toolbarPins: { forward: false } })} tab={page} compact />)
    expect(forwardButton()).toBeNull()
  })

  it('an unpinned chip is not drawn: the star, Translate, Reader View – each on its own key', () => {
    render(
      <NavRow state={state(page, { toolbarPins: { star: false } })} tab={page} compact={false} />
    )
    expect(q('[data-bm-star]')).toBeNull()
    expect(chip('Reader View')).not.toBeNull()
    expect(chip('Translate this page')).not.toBeNull()
    render(
      <NavRow
        state={state(page, { toolbarPins: { reader: false, translate: false } })}
        tab={page}
        compact={false}
      />
    )
    expect(q('[data-bm-star]')).not.toBeNull()
    expect(chip('Reader View')).toBeNull()
    expect(chip('Translate this page')).toBeNull()
  })

  it('the lit Reader View exit on a reader tab is the document’s own control and stays whatever the pin (§10.1)', () => {
    const reader = tab('zen://reader?url=https%3A%2F%2Fexample.com%2Farticle')
    render(
      <NavRow
        state={state(reader, { toolbarPins: { reader: false } })}
        tab={reader}
        compact={false}
      />
    )
    const exit = chip('Reader View')
    expect(exit).not.toBeNull()
    expect(exit!.getAttribute('aria-pressed')).toBe('true')
  })

  it('Media unpinned folds the hub as the width tier does: no button, the dot on ⋯, the menu asked for with the fold, and no "hidden at this width"', () => {
    render(
      <NavRow
        state={state(page, { toolbarPins: { media: false } }, [media()])}
        tab={page}
        compact={false}
      />
    )
    expect(q('[data-zen-media-hub-button]')).toBeNull()
    expect(mediaHubFolded()).toBe(true)
    const menu = q<HTMLButtonElement>('[data-zen-app-menu-button]')!
    expect(menu.querySelector('.zen-mhub-dot')).not.toBeNull()
    act(() => menu.click())
    expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
      'app.menu',
      expect.objectContaining({ mediaHubFolded: true })
    ])
    expect(toolbarTiering.get().hidden).not.toContain('media')
  })

  it('the Energy Saver leaf (W8-2) is in the row while the governor says the mode is on, ahead of the hub – and its pin folds it away with no menu row', () => {
    const leaf = (): HTMLElement | null => q('[data-zen-energy-saver-button]')
    // The mode off (the shipped snapshot, no battery): no leaf, whatever the pin says.
    render(<NavRow state={state(page, {}, [media()])} tab={page} compact={false} />)
    expect(leaf()).toBeNull()
    // On: the leaf, named by Chrome's one line, before the hub's button in the row.
    render(<NavRow state={state(page, {}, [media()], SAVING)} tab={page} compact={false} />)
    const button = leaf()!
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-label')).toBe('Energy Saver is on')
    expect(button.getAttribute('data-tooltip')).toBe('Energy Saver is on')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-zen-nav-row] > button')]
    const hub = q('[data-zen-media-hub-button]')!
    expect(buttons.indexOf(button as HTMLButtonElement)).toBeLessThan(
      buttons.indexOf(hub as HTMLButtonElement)
    )
    // The compact rail draws it too.
    render(<NavRow state={state(page, {}, [], SAVING)} tab={page} compact />)
    expect(leaf()).not.toBeNull()
    // Unpinned: not drawn, and nothing of it on ⋯ – the mode runs on, Settings says so.
    render(
      <NavRow
        state={state(page, { toolbarPins: { 'energy-saver': false } }, [], SAVING)}
        tab={page}
        compact={false}
      />
    )
    expect(leaf()).toBeNull()
    expect(nameOf(q<HTMLButtonElement>('[data-zen-app-menu-button]')!)).not.toMatch(/energy/i)
    // A control the pins folded is not "hidden at this width".
    expect(toolbarTiering.get().hidden).not.toContain('energy-saver')
  })

  it('tiers the leaf by the row’s width on the hub’s rule (L2): folded at the 240 sidebar and published as hidden, back at the 302; where one of the two fits, the leaf stands and the hub folds', () => {
    const leaf = (): HTMLElement | null => q('[data-zen-energy-saver-button]')
    const hub = (): HTMLElement | null => q('[data-zen-media-hub-button]')
    const widths = { row: 240 - 16 }
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const width = this.hasAttribute('data-zen-nav-row') ? widths.row : 0
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect
    })
    try {
      // The 240 sidebar with back, forward, reload and ⋯: no room for the leaf (it took the
      // pill from "Settings" to "S…"), none for the hub – both fold, both published, in the
      // bar's order; the hub keeps its menu row and dot, the leaf has no row (the mode runs on).
      render(
        <NavRow key="240" state={state(page, {}, [media()], SAVING)} tab={page} compact={false} />
      )
      expect(leaf()).toBeNull()
      expect(hub()).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual(['energy-saver', 'media'])
      expect(q('[data-zen-app-menu-button]')!.querySelector('.zen-mhub-dot')).not.toBeNull()
      // One px short of the leaf's return: still folded.
      widths.row = 285
      render(
        <NavRow key="285" state={state(page, {}, [media()], SAVING)} tab={page} compact={false} />
      )
      expect(leaf()).toBeNull()
      // The 302 sidebar (the 286 row): the leaf returns over a pill at the tier's floor; the
      // hub, counting the leaf among the buttons it makes room against, needs 318 and folds.
      widths.row = 286
      render(
        <NavRow key="286" state={state(page, {}, [media()], SAVING)} tab={page} compact={false} />
      )
      expect(leaf()).not.toBeNull()
      expect(hub()).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual(['media'])
      // Without media the same width has nothing else to fold.
      render(
        <NavRow key="286-quiet" state={state(page, {}, [], SAVING)} tab={page} compact={false} />
      )
      expect(leaf()).not.toBeNull()
      expect(toolbarTiering.get().hidden).toEqual([])
      // 32 more: both stand.
      widths.row = 318
      render(
        <NavRow key="318" state={state(page, {}, [media()], SAVING)} tab={page} compact={false} />
      )
      expect(leaf()).not.toBeNull()
      expect(hub()).not.toBeNull()
      expect(toolbarTiering.get().hidden).toEqual([])
      // The compact rail has no pill to keep: the leaf stays at any width.
      widths.row = 60
      render(<NavRow key="compact" state={state(page, {}, [], SAVING)} tab={page} compact />)
      expect(leaf()).not.toBeNull()
      expect(toolbarTiering.get().hidden).toEqual([])
      // The mode off at the narrow width: nothing to fold, nothing published.
      widths.row = 240 - 16
      render(<NavRow key="240-off" state={state(page, {}, [])} tab={page} compact={false} />)
      expect(leaf()).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual([])
    } finally {
      rects.mockRestore()
    }
  })

  it('publishes what the width tier hid of the pinned controls, and clears it as the row leaves', () => {
    // The row at the 240 sidebar: no room for the hub's button (`mediaHubButtonFits`).
    const widths = { row: 240 - 16, pill: 0 }
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const width = this.hasAttribute('data-zen-nav-row') ? widths.row : 0
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect
    })
    // happy-dom lays nothing out: the pill's content box (`usePillInnerWidth` reads
    // `clientWidth`, defined on HTMLElement's prototype there) is set by hand.
    const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: Element) {
        return this.hasAttribute('data-address-pill') ? widths.pill : 0
      }
    })
    try {
      render(<NavRow key="narrow" state={state(page, {}, [media()])} tab={page} compact={false} />)
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      // The pill's box unmeasured shows every chip: only the hub is hidden by the width.
      expect(toolbarTiering.get().hidden).toEqual(['media'])
      // An 80 px content box (the 240 sidebar's pill): the star and the informational chips
      // hide from the lowest priority up (§9.29), in the bar's order in the published set. The
      // translate glyph is present – and so tiered – once the page has been offered a
      // translation; before that it comes up on hover alone and is no width's to hide.
      widths.pill = 80
      const offered = (settings: Partial<Settings> = {}): UIState => {
        const s = state(page, settings, [media()])
        s.translate.tabs = { t1: { tabId: 't1', status: 'offered', dismissed: false } as never }
        return s
      }
      render(<NavRow key="narrow-pill" state={offered()} tab={page} compact={false} />)
      expect(toolbarTiering.get().hidden).toEqual(['reader', 'translate', 'star', 'media'])
      expect(q('[data-bm-star]')).toBeNull()
      // A control the pins folded is not "hidden at this width", whatever the width.
      render(
        <NavRow
          key="narrow-pill-folded"
          state={offered({ toolbarPins: { star: false, media: false } })}
          tab={page}
          compact={false}
        />
      )
      expect(toolbarTiering.get().hidden).toEqual(['reader', 'translate'])
      // Room for everything: nothing hidden.
      widths.row = 400
      widths.pill = 260
      render(<NavRow key="wide" state={offered()} tab={page} compact={false} />)
      expect(q('[data-zen-media-hub-button]')).not.toBeNull()
      expect(toolbarTiering.get().hidden).toEqual([])
      widths.row = 240 - 16
      render(
        <NavRow key="narrow-again" state={state(page, {}, [media()])} tab={page} compact={false} />
      )
      expect(toolbarTiering.get().hidden).toEqual(['media'])
      act(() => root!.unmount())
      root = null
      mount?.remove()
      expect(toolbarTiering.get().hidden).toEqual([])
    } finally {
      rects.mockRestore()
      if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
    }
  })

  it('is the desktop layout’s: the tablet’s bar draws every control whatever the field says', () => {
    viewportStore.set({ formFactor: 'tablet' })
    render(
      <NavRow
        state={state(
          page,
          { toolbarPins: { forward: false, star: false, 'energy-saver': false, media: false } },
          [media()],
          SAVING
        )}
        tab={page}
        compact={false}
      />
    )
    expect(forwardButton()).not.toBeNull()
    expect(q('[data-bm-star]')).not.toBeNull()
    expect(q('[data-zen-energy-saver-button]')).not.toBeNull()
    expect(q('[data-zen-media-hub-button]')).not.toBeNull()
    // Home is a desktop pin too: the tablet's bar never draws it, shown or not.
    expect(homeButton()).toBeNull()
  })
})

const homeButton = (): HTMLButtonElement | null => q<HTMLButtonElement>('[data-zen-home-button]')

describe('the Home button (settings-32; Chrome’s HomeButton under "Show home button")', () => {
  it('is folded by default – no button with no pins recorded, as Chrome ships its toolbar', () => {
    render(<NavRow state={state(page)} tab={page} compact={false} />)
    expect(homeButton()).toBeNull()
    render(<NavRow state={state(page, { toolbarPins: {} })} tab={page} compact={false} />)
    expect(homeButton()).toBeNull()
  })

  it('shown by its pin it seats after Reload and before the address pill, as Chrome’s does, named Home with its chord and Chrome’s tooltip, and a click runs nav.home', () => {
    render(
      <NavRow state={state(page, { toolbarPins: { home: true } })} tab={page} compact={false} />
    )
    const home = homeButton()
    expect(home).not.toBeNull()
    expect(home!.className).toBe('zen-toolbar-button')
    expect(nameOf(home!)).toBe('Home (Alt+Home)')
    expect(home!.dataset.tooltip).toBe('Open the home page (Alt+Home)')
    // The seat: Back, Forward, Reload, Home, then the pill.
    const row = q('[data-zen-nav-row]')!
    const children = [...row.children]
    const at = children.indexOf(home!)
    const before = children
      .slice(0, at)
      .filter((c): c is HTMLButtonElement => c.tagName === 'BUTTON')
    expect(before.map((b) => nameOf(b).split(' (')[0])).toEqual(['Back', 'Forward', 'Reload'])
    // What follows is the address pill itself (the `group` named Address), nothing between.
    const next = children[at + 1] as HTMLElement | undefined
    expect(next?.getAttribute('role')).toBe('group')
    expect(next?.getAttribute('aria-label')).toBe('Address')
    // Right-clicked it is a pinned control (W8-1's menu: Unpin, Customise Toolbar…).
    expect(home!.dataset.zenMenu).toBe('toolbar')
    expect(home!.dataset.zenMenuControl).toBe('home')
    act(() => home!.click())
    expect(run).toHaveBeenCalledWith('nav.home', undefined)
    // The compact rail follows the same pin.
    render(<NavRow state={state(page, { toolbarPins: { home: true } })} tab={page} compact />)
    expect(homeButton()).not.toBeNull()
  })

  it('rests disabled without a tab, as Reload does', () => {
    render(
      <NavRow state={state(page, { toolbarPins: { home: true } })} tab={null} compact={false} />
    )
    expect(homeButton()!.disabled).toBe(true)
  })

  it('folds by the row’s width under §9.29’s hub-button rule, the one rule the hub folds by: gone below the 302 sidebar, back where the pill with its slot holds 126', () => {
    // The always-there buttons: back, forward, reload, ⋯ (no extensions, no downloads).
    const always = 4
    expect(FOLDING_BUTTON_PILL).toBe(126)
    expect(foldingButtonReturnRow(always)).toBe(286)
    expect(foldingButtonReturnRow(always) + 16).toBe(302)
    expect(foldingButtonFits(240 - 16, always)).toBe(false)
    expect(foldingButtonFits(302 - 16 - 1, always)).toBe(false)
    expect(foldingButtonFits(302 - 16, always)).toBe(true)
    // An unmeasured row shows the button, as the pinned actions show before a width.
    expect(foldingButtonFits(0, always)).toBe(true)
    // The hub's rule is this rule by its own name.
    expect(mediaHubReturnRow(always)).toBe(foldingButtonReturnRow(always))
    expect(mediaHubReturnRow(always + 1) - mediaHubReturnRow(always)).toBe(32)
  })

  it('shown by its pin at the 240 sidebar it is folded – the pill keeps its 96 and the title reads whole (the FIRST LINE’s F1 on #572) – with "home" published for Customise toolbar’s "Hidden at this width."; at 302 it returns, and the hub returns one slot after it', () => {
    const widths = { row: 240 - 16 }
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const width = this.hasAttribute('data-zen-nav-row') ? widths.row : 0
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect
    })
    try {
      const shown = { toolbarPins: { home: true } }
      render(<NavRow key="narrow" state={state(page, shown)} tab={page} compact={false} />)
      expect(homeButton()).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual(['home'])
      // Back, Forward, Reload, then the pill: the seat Home would take is not held open.
      const row = q('[data-zen-nav-row]')!
      const pill = row.querySelector('[role="group"][aria-label="Address"]')!
      const before = [...row.children]
        .slice(0, [...row.children].indexOf(pill))
        .filter((c): c is HTMLButtonElement => c.tagName === 'BUTTON')
      expect(before.map((b) => nameOf(b).split(' (')[0])).toEqual(['Back', 'Forward', 'Reload'])
      // One short of the return: still folded.
      widths.row = 302 - 16 - 1
      render(<NavRow key="short" state={state(page, shown)} tab={page} compact={false} />)
      expect(homeButton()).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual(['home'])
      // The 302 sidebar: with Home's slot back in the row the pill holds its 126.
      widths.row = 302 - 16
      render(<NavRow key="wide" state={state(page, shown)} tab={page} compact={false} />)
      expect(homeButton()).not.toBeNull()
      expect(toolbarTiering.get().hidden).toEqual([])
      // Home and the hub both pinned, media playing: at 302 Home is back and the hub – which
      // makes room against Home too – waits; both published at 240, in the bar's order.
      const both = (): UIState => state(page, shown, [media()])
      render(<NavRow key="both-302" state={both()} tab={page} compact={false} />)
      expect(homeButton()).not.toBeNull()
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual(['media'])
      widths.row = 302 - 16 + 32
      render(<NavRow key="both-334" state={both()} tab={page} compact={false} />)
      expect(homeButton()).not.toBeNull()
      expect(q('[data-zen-media-hub-button]')).not.toBeNull()
      expect(toolbarTiering.get().hidden).toEqual([])
      widths.row = 240 - 16
      render(<NavRow key="both-240" state={both()} tab={page} compact={false} />)
      expect(homeButton()).toBeNull()
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual(['home', 'media'])
      // The compact rail has no pill to keep: Home stays at any width.
      render(<NavRow key="compact" state={state(page, shown)} tab={page} compact />)
      expect(homeButton()).not.toBeNull()
      expect(toolbarTiering.get().hidden).toEqual([])
      // Unpinned, Home is the pin's to fold, not the width's: nothing published for it.
      render(<NavRow key="unpinned" state={state(page)} tab={page} compact={false} />)
      expect(homeButton()).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual([])
    } finally {
      rects.mockRestore()
    }
  })

  it('with the Energy Saver leaf (W8-2) and the hub beside it the row gives way from the back – Home first back, the leaf counting Home, the hub counting both – one slot (32) apart, published in the bar’s order', () => {
    const leaf = (): HTMLElement | null => q('[data-zen-energy-saver-button]')
    const hub = (): HTMLElement | null => q('[data-zen-media-hub-button]')
    const widths = { row: 240 - 16 }
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const width = this.hasAttribute('data-zen-nav-row') ? widths.row : 0
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect
    })
    try {
      // Home pinned, the mode on, media playing: three tiered controls over the four always-there
      // buttons. At the 240 sidebar all three fold, published Home first.
      const all = (): UIState => state(page, { toolbarPins: { home: true } }, [media()], SAVING)
      render(<NavRow key="240" state={all()} tab={page} compact={false} />)
      expect(homeButton()).toBeNull()
      expect(leaf()).toBeNull()
      expect(hub()).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual(['home', 'energy-saver', 'media'])
      // The 302 sidebar (the 286 row) has one slot: Home, the first in the bar, takes it.
      widths.row = 286
      render(<NavRow key="286" state={all()} tab={page} compact={false} />)
      expect(homeButton()).not.toBeNull()
      expect(leaf()).toBeNull()
      expect(hub()).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual(['energy-saver', 'media'])
      // 32 more: the leaf, counting Home among the buttons it makes room against, returns; the
      // hub, counting both, waits.
      widths.row = 318
      render(<NavRow key="318" state={all()} tab={page} compact={false} />)
      expect(homeButton()).not.toBeNull()
      expect(leaf()).not.toBeNull()
      expect(hub()).toBeNull()
      expect(toolbarTiering.get().hidden).toEqual(['media'])
      // 32 more again: all three stand.
      widths.row = 350
      render(<NavRow key="350" state={all()} tab={page} compact={false} />)
      expect(homeButton()).not.toBeNull()
      expect(leaf()).not.toBeNull()
      expect(hub()).not.toBeNull()
      expect(toolbarTiering.get().hidden).toEqual([])
      // Home ahead of the leaf, the leaf ahead of the hub: the bar's order.
      const row = q('[data-zen-nav-row]')!
      const buttons = [...row.querySelectorAll<HTMLButtonElement>(':scope > button')]
      expect(buttons.indexOf(homeButton() as HTMLButtonElement)).toBeLessThan(
        buttons.indexOf(leaf() as HTMLButtonElement)
      )
      expect(buttons.indexOf(leaf() as HTMLButtonElement)).toBeLessThan(
        buttons.indexOf(hub() as HTMLButtonElement)
      )
    } finally {
      rects.mockRestore()
    }
  })
})
