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
import { mediaHubFolded } from '@renderer/lib/mediaHub'
import { toolbarTiering } from '@renderer/lib/toolbarPins'
import { NavRow } from '../SidebarTop'

/*
 * The desktop toolbar under Settings › Look and Feel › Customise toolbar (settings-36): a
 * control unpinned in `Settings.toolbarPins` is not drawn – Forward leaves the row, a chip
 * leaves the pill, the media hub's button folds as the width tier folds it (the ⋯ dot and the
 * menu's "Now Playing…" row stand in) – and the pins speak for the desktop layout alone. The
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

/** Enough of a snapshot for the whole row, the pill and its chips included. */
function state(t: Tab, settings: Partial<Settings> = {}, entries: MediaState[] = []): UIState {
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
    media: entries
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
        state={state(page, { toolbarPins: { forward: false, star: false, media: false } }, [
          media()
        ])}
        tab={page}
        compact={false}
      />
    )
    expect(forwardButton()).not.toBeNull()
    expect(q('[data-bm-star]')).not.toBeNull()
    expect(q('[data-zen-media-hub-button]')).not.toBeNull()
  })
})
