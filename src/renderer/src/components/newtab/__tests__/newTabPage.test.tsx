// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { DEFAULT_NEW_TAB_SETTINGS } from '@shared/newTab'
import { DEFAULT_PRIVACY_SETTINGS, emptyPrivacyStatus } from '@shared/privacy'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { BLANK_URL } from '@shared/url'

/*
 * The one new tab route keyed on the tab's container (NTP-31): a private tab's blank page is the
 * private page – the explainer in the window family, the search field, the Block third-party
 * cookies switch over the core's private-only setting (#218), no tiles and no gear – and every
 * other blank tab's is the space's page. A blank tab of the other mode mounts the other page.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'history.topSites' ? [] : null
)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { NewTabPage } = await import('../NewTabPage')
const { uiStore } = await import('@renderer/lib/ui')

function tab(id: string, containerId: string): Tab {
  return {
    id,
    spaceId: 'space',
    containerId,
    url: BLANK_URL,
    title: '',
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

const state = {
  platform: 'android',
  capabilities: { privateTabs: true },
  tabs: {},
  spaces: [],
  activeSpaceId: 'space',
  folders: {},
  settings: {
    newTab: structuredClone(DEFAULT_NEW_TAB_SETTINGS),
    privacy: structuredClone(DEFAULT_PRIVACY_SETTINGS),
    colorScheme: 'light',
    searchEngineId: 'google'
  },
  searchEngines: DEFAULT_SEARCH_ENGINES,
  newTabShortcuts: [],
  newTabHiddenHosts: [],
  bookmarks: [],
  privacy: emptyPrivacyStatus()
} as unknown as UIState

/**
 * The state with the private contexts' third-party cookie status as the core publishes it
 * (`PrivacyStatus.privateThirdPartyCookies`): the switch reads that, not the settings.
 */
function withPrivateCookies(blocked: boolean, locked = false): UIState {
  return {
    ...state,
    privacy: { ...state.privacy, privateThirdPartyCookies: { blocked, locked } }
  }
}

let root: Root | null = null
let host: HTMLElement | null = null

function render(t: Tab, s: UIState = state): HTMLElement {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => root!.render(createElement(NewTabPage, { state: s, tab: t, hidden: false })))
  return host!
}

function cookiesRow(): HTMLElement {
  return host!.querySelector<HTMLElement>('[data-testid="private-ntp-cookies"]')!
}

beforeEach(() => {
  invoke.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  uiStore.set({ urlbar: { open: false, mode: 'edit', tabId: null } } as never)
})

describe('the new tab route keyed on the container', () => {
  it("a private tab's blank page is the private page: the explainer, the field, no tiles, no gear", () => {
    render(tab('p', PRIVATE_CONTAINER_ID))
    const page = host!.querySelector<HTMLElement>('[data-testid="private-ntp"]')!
    expect(page).not.toBeNull()
    // A window surface on the bare gradient (§9.29): the private theme the window has blended to.
    expect(page.dataset.surface).toBe('window')
    expect(page.dataset.wallpaper).toBe('none')
    expect(page.querySelector('h1')!.textContent).toBe("You're browsing privately")
    expect(page.querySelector('[data-testid="private-ntp-glyph"]')).not.toBeNull()
    const headings = [...page.querySelectorAll('h2')].map((h) => h.textContent)
    expect(headings).toEqual(["Zenium won't save", 'Still visible to', 'Third-party cookies'])
    const rows = [...page.querySelectorAll('li')].map((li) => li.textContent)
    expect(rows).toEqual([
      'Browsing history',
      'Cookies and site data',
      'Information entered in forms',
      'Websites you visit',
      'Your employer or school',
      'Your internet service provider'
    ])
    expect(page.textContent).toContain('Downloads you save and bookmarks you add are kept')
    expect(page.querySelector('[aria-label="Most visited"]')).toBeNull()
    expect(page.querySelector('[aria-label="Customise the new tab page"]')).toBeNull()
    // Nothing of the regular history is asked for.
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain('history.topSites')
  })

  it('its field opens the omnibox for the private tab, as the regular page does', async () => {
    render(tab('p', PRIVATE_CONTAINER_ID))
    const field = host!.querySelector<HTMLElement>('.zen-ntp-field-main')!
    expect(field.textContent).toContain('Search or enter address')
    await act(async () => {
      field.click()
      await Promise.resolve()
    })
    expect(uiStore.get().urlbar).toMatchObject({ open: true, tabId: 'p', attached: true })
  })

  it("its Block third-party cookies switch is the private contexts' status: on while they are blocked there, and a press writes allow through the private command", () => {
    render(tab('p', PRIVATE_CONTAINER_ID), withPrivateCookies(true))
    const row = cookiesRow()
    // A §10.4 switch row on the row primitive with its window modifier: the whole row is the switch.
    expect(row.tagName).toBe('BUTTON')
    expect(row.getAttribute('role')).toBe('switch')
    expect(row.classList.contains('zen-v2-row')).toBe(true)
    expect(row.classList.contains('zen-ntp-row')).toBe(true)
    expect(row.getAttribute('aria-checked')).toBe('true')
    expect(row.getAttribute('aria-disabled')).toBeNull()
    expect(row.textContent).toContain('Block third-party cookies')
    // Private-only, and the line says so (the interface's wording); nothing about every tab.
    expect(row.textContent).toContain('Blocks third-party cookies in private tabs.')
    expect(row.textContent).not.toContain('every tab')
    expect(row.querySelector('.zen-v2-switch')).not.toBeNull()
    act(() => row.click())
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('privacy.setThirdPartyCookiesPrivate', { mode: 'allow' })
    // The global mode is not what it writes: regular tabs keep theirs.
    expect(invoke).not.toHaveBeenCalledWith('settings.update', expect.anything())
  })

  it('off while third-party cookies are allowed in private tabs, and a press writes block – never default', () => {
    render(tab('p', PRIVATE_CONTAINER_ID), withPrivateCookies(false))
    const row = cookiesRow()
    expect(row.getAttribute('aria-checked')).toBe('false')
    expect(row.getAttribute('aria-disabled')).toBeNull()
    expect(row.textContent).toContain('Blocks third-party cookies in private tabs.')
    act(() => row.click())
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('privacy.setThirdPartyCookiesPrivate', { mode: 'block' })
    expect(invoke).not.toHaveBeenCalledWith(
      'privacy.setThirdPartyCookiesPrivate',
      expect.objectContaining({ mode: 'default' })
    )
  })

  it('on and disabled while the global mode blocks them everywhere (locked): the line says why, and a tap writes nothing', () => {
    render(tab('p', PRIVATE_CONTAINER_ID), withPrivateCookies(true, true))
    const row = cookiesRow()
    expect(row.getAttribute('aria-checked')).toBe('true')
    // §9.30: the whole control disabled – `aria-disabled` is what `.zen-ntp-row` lays out at .4.
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain('Blocked in every tab by Settings → Privacy.')
    expect(row.textContent).not.toContain('Blocks third-party cookies in private tabs.')
    act(() => row.click())
    expect(invoke).not.toHaveBeenCalled()
  })

  it('the global mode alone does not drive it: the switch follows the status the core computes with the private override', () => {
    // Global `block-private` (the old binding's "on") with a private `allow` override: the core
    // says third-party cookies are allowed in private tabs, and the switch is off.
    const overridden: UIState = {
      ...withPrivateCookies(false),
      settings: {
        ...state.settings,
        privacy: {
          ...DEFAULT_PRIVACY_SETTINGS,
          thirdPartyCookies: 'block-private',
          thirdPartyCookiesPrivate: 'allow'
        }
      }
    }
    render(tab('p', PRIVATE_CONTAINER_ID), overridden)
    expect(cookiesRow().getAttribute('aria-checked')).toBe('false')
  })

  it("a regular blank tab's page is the space's, and the tab changing mode mounts the other page", () => {
    render(tab('r', 'default'))
    expect(host!.querySelector('[data-testid="private-ntp"]')).toBeNull()
    const regular = host!.querySelector<HTMLElement>('.zen-ntp')!
    expect(regular.querySelector('[aria-label="Customise the new tab page"]')).not.toBeNull()
    expect(regular.querySelector('[data-testid="private-ntp-cookies"]')).toBeNull()
    render(tab('p', PRIVATE_CONTAINER_ID))
    const priv = host!.querySelector<HTMLElement>('[data-testid="private-ntp"]')!
    expect(priv).not.toBeNull()
    expect(priv).not.toBe(regular)
    expect(regular.isConnected).toBe(false)
  })
})

describe('the field’s engine mark (NTP-09)', () => {
  const withEngine = (id: string): UIState =>
    ({ ...state, settings: { ...state.settings, searchEngineId: id } }) as UIState
  const slot = (): HTMLElement =>
    host!.querySelector<HTMLElement>('.zen-ntp-field [data-testid="engine-field-glyph"]')!

  it('shows the magnifier for the vendor’s default, and no favicon', () => {
    render(tab('r', 'default'), withEngine('google'))
    expect(slot().querySelector('svg')).not.toBeNull()
    expect(slot().querySelector('img')).toBeNull()
  })

  it('shows the chosen engine’s favicon at 20 once it loads, the magnifier until then', () => {
    render(tab('r', 'default'), withEngine('duckduckgo'))
    const img = slot().querySelector<HTMLImageElement>('[data-testid="engine-field-favicon"]')!
    expect(img.getAttribute('src')).toBe('https://duckduckgo.com/favicon.ico')
    // Not yet loaded: the magnifier is painted, the image held out of the slot.
    expect(slot().querySelector('svg')).not.toBeNull()
    expect(img.className).toContain('invisible')
    act(() => {
      img.dispatchEvent(new Event('load'))
    })
    expect(slot().querySelector('svg')).toBeNull()
    expect(img.className).not.toContain('invisible')
    expect(img.className).toContain('h-5 w-5')
    // Arrived after the fallback was painted: it fades in place (§11.4).
    expect(img.dataset.arrived).toBe('true')
  })

  it('keeps the magnifier when the favicon fails to load', () => {
    render(tab('r', 'default'), withEngine('ecosia'))
    const img = slot().querySelector<HTMLImageElement>('[data-testid="engine-field-favicon"]')!
    act(() => {
      img.dispatchEvent(new Event('error'))
    })
    expect(slot().querySelector('svg')).not.toBeNull()
    expect(slot().querySelector('img')).toBeNull()
  })
})

const { setFakeboxPainter, fakeboxMorphStore } = await import('@renderer/lib/fakeboxMorph')

describe('the page for the bar’s edge (NTP-29)', () => {
  const PINNED = [
    { id: 's1', title: 'Docs', url: 'https://docs.example/' },
    { id: 's2', title: 'News', url: 'https://news.example/' }
  ]
  const withDock = (dock: 'top' | 'bottom'): UIState =>
    ({
      ...state,
      settings: { ...state.settings, phoneBarPosition: dock },
      newTabShortcuts: PINNED
    }) as UIState

  /** Render and let the history's answer (no most visited) land, so the grid draws the pins. */
  async function renderAt(dock: 'top' | 'bottom'): Promise<HTMLElement> {
    render(tab('r', 'default'), withDock(dock))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    return host!.querySelector<HTMLElement>('.zen-ntp')!
  }
  const before = (a: Element, b: Element): boolean =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
  /** The column's spacers – its first and last children – by their `flex` share. */
  const spacers = (column: HTMLElement): string[] =>
    [column.firstElementChild, column.lastElementChild].map((el) =>
      el instanceof HTMLElement ? el.style.flexGrow || el.style.flex : ''
    )

  afterEach(() => {
    setFakeboxPainter(null)
    vi.restoreAllMocks()
  })

  it('with the bar at the bottom the shortcuts stand above the field and the gear moves to the top corner', async () => {
    const page = await renderAt('bottom')
    expect(page.dataset.dock).toBe('bottom')
    const field = page.querySelector<HTMLElement>('.zen-ntp-field')!
    const grid = page.querySelector<HTMLElement>('[aria-label="Most visited"]')!
    expect(grid.textContent).toContain('Docs')
    expect(before(grid, field)).toBe(true)
    // Both in the one scrolling column, whose scroll carries the field toward the pill (#243).
    const column = field.closest<HTMLElement>('.zen-ntp-scroll')!
    expect(grid.closest('.zen-ntp-scroll')).toBe(column)
    // One geometry measured from the bar's edge (§9.29): the free height 3 : 5 with the block on
    // the bar's side – here 5 parts above the tiles, 3 under the field – and the 24 between the
    // tiles and the field on the tiles' side.
    expect(spacers(column)).toEqual(['5', '3'])
    expect(grid.classList.contains('mb-6')).toBe(true)
    const gear = page.querySelector<HTMLElement>('[aria-label="Customise the new tab page"]')!
    expect(gear.style.top).toBe('12px')
    expect(gear.style.bottom).toBe('')
  })

  it('with the bar at the top the layout is the one it was: the field first, the tiles under it, the gear low', async () => {
    const page = await renderAt('top')
    expect(page.dataset.dock).toBe('top')
    const field = page.querySelector<HTMLElement>('.zen-ntp-field')!
    const grid = page.querySelector<HTMLElement>('[aria-label="Most visited"]')!
    expect(before(field, grid)).toBe(true)
    // The same 3 : 5 the other way up: 3 parts over the field, 5 under the tiles, the 24 above them.
    expect(spacers(field.closest<HTMLElement>('.zen-ntp-scroll')!)).toEqual(['3', '5'])
    expect(grid.classList.contains('mt-6')).toBe(true)
    const gear = page.querySelector<HTMLElement>('[aria-label="Customise the new tab page"]')!
    expect(gear.style.bottom).toBe('12px')
    expect(gear.style.top).toBe('')
  })

  it('the field is the morph’s origin wherever it rests: the dock changing measures it there anew', async () => {
    // The field's rectangle as the layout would give it: high on the page at a top dock, low at
    // a bottom one; everything else has no size (the bar is not in this document).
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (!this.classList.contains('zen-ntp-field')) return new DOMRect(0, 0, 0, 0)
      const dock = this.closest<HTMLElement>('.zen-ntp')?.dataset.dock
      return new DOMRect(16, dock === 'bottom' ? 760 : 200, 380, 52)
    })
    const rests: number[] = []
    setFakeboxPainter((frame) => void rests.push(frame.geometry.rest.y))
    await renderAt('top')
    expect(fakeboxMorphStore.get().tabId).toBe('r')
    expect(rests.at(-1)).toBe(200)
    await renderAt('bottom')
    // Registered again for the same tab, and the origin is the field's new place.
    expect(fakeboxMorphStore.get().tabId).toBe('r')
    expect(rests.at(-1)).toBe(760)
    await renderAt('top')
    expect(rests.at(-1)).toBe(200)
  })
})
