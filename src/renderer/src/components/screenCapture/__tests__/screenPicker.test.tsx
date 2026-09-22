// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ScreenCaptureRequest, ScreenCaptureSource, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { FrameDialogHost, closeAllPopovers } from '@renderer/lib/portals'
import { effectiveSelection, gridMove, hostLabels, paneColumns } from '@renderer/lib/screenPicker'
import { rememberThumbnail } from '@renderer/lib/thumbnails'
import { uiStore } from '@renderer/lib/ui'
import { ScreenPickerLayer } from '../ScreenPicker'

/*
 * The screen-capture picker (screenCapture/ScreenPicker.tsx, MW-19): the screenCapture surface
 * of a host whose pages can capture – registered through `ui.surface` there and nowhere else –
 * showing Chrome's "Choose what to share" for the active tab's request: the site in the title
 * block, the three panes on the segment with the calling tab first, the OS's screens and windows
 * once its list is in (busy until then, an empty line when it holds nothing), one pick per pane
 * with Share armed by it, a double-click or Enter on the pick sharing, the only screen coming
 * picked, "Also share system audio" on the screen pane where the OS allows and the page asked;
 * Cancel and Escape answer the core with no source (the page's refusal); the request of another
 * tab shows nothing until that tab is in front. An extension's request
 * (chrome.desktopCapture.chooseDesktopMedia) is the same dialog with the extension named and the
 * panes it asked for, modal to the tab it names as a page's is.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TAB_SOURCE: ScreenCaptureSource = {
  id: 'tab:t1',
  name: 'Meeting – Example',
  kind: 'tab',
  thumbnail: null,
  icon: 'data:image/png;base64,AAAA'
}
const OTHER_TAB: ScreenCaptureSource = {
  id: 'tab:t2',
  name: 'Docs',
  kind: 'tab',
  thumbnail: null,
  icon: null
}
const SCREEN: ScreenCaptureSource = {
  id: 'screen:1',
  name: 'Screen 1',
  kind: 'screen',
  thumbnail: 'data:image/png;base64,BBBB',
  icon: null
}
const SCREEN_2: ScreenCaptureSource = { ...SCREEN, id: 'screen:2', name: 'Screen 2' }
const WINDOW: ScreenCaptureSource = {
  id: 'window:9',
  name: 'Terminal',
  kind: 'window',
  thumbnail: 'data:image/png;base64,CCCC',
  icon: 'data:image/png;base64,DDDD'
}

const REQUEST: ScreenCaptureRequest = {
  id: 'capture-1',
  tabId: 't1',
  origin: 'meet.example',
  extension: null,
  kinds: ['tab', 'window', 'screen'],
  audio: false,
  systemAudio: false,
  loading: false,
  sources: [SCREEN, WINDOW, TAB_SOURCE, OTHER_TAB],
  requestedAt: 1
}

/** An extension's `chooseDesktopMedia(['screen', 'window', 'tab'])` for its own page. */
const EXTENSION_REQUEST: ScreenCaptureRequest = {
  ...REQUEST,
  id: 'capture-2',
  origin: '',
  extension: { name: 'Screen Recorder', icon: 'data:image/png;base64,EEEE' }
}

function stateWith(
  requests: ScreenCaptureRequest[],
  {
    activeTabId = 't1',
    screenCapture = true
  }: { activeTabId?: string; screenCapture?: boolean } = {}
): UIState {
  return {
    platform: 'linux',
    capabilities: { screenCapture, windows: true },
    tabs: {
      t1: { id: 't1', url: 'https://meet.example/' },
      t2: { id: 't2', url: 'https://docs.example/' }
    },
    spaces: [{ id: 'space', activeTabId }],
    activeSpaceId: 'space',
    screenCaptureRequests: requests
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

function rerender(el: ReactElement): void {
  act(() => root!.render(el))
}

function layer(state: UIState): ReactElement {
  return (
    <FrameDialogHost frame>
      <ScreenPickerLayer state={state} />
    </FrameDialogHost>
  )
}

function click(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function dblclick(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
}

function keydown(target: Element | null, key: string): void {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function tiles(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
}

function tile(el: HTMLElement, id: string): HTMLButtonElement | null {
  return el.querySelector<HTMLButtonElement>(`[role="radio"][data-source-id="${id}"]`)
}

function paneTab(el: HTMLElement, pane: string): HTMLButtonElement | null {
  return el.querySelector<HTMLButtonElement>(`[role="tab"][data-pane="${pane}"]`)
}

function share(el: HTMLElement): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>('[data-share]')!
}

beforeEach(() => {
  uiStore.set({ screenPickerOpen: false })
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  uiStore.set({ screenPickerOpen: false })
  vi.mocked(run).mockClear()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('ScreenPickerLayer as the screenCapture surface', () => {
  it('registers the surface on a host whose pages can capture and takes it back on unmount', () => {
    render(layer(stateWith([])))
    expect(vi.mocked(run).mock.calls).toContainEqual([
      'ui.surface',
      { surface: 'screenCapture', mounted: true }
    ])
    act(() => root!.unmount())
    root = null
    expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
      'ui.surface',
      { surface: 'screenCapture', mounted: false }
    ])
  })

  it('registers nothing and shows nothing where pages cannot capture', () => {
    const el = render(layer(stateWith([REQUEST], { screenCapture: false })))
    expect(vi.mocked(run)).not.toHaveBeenCalledWith('ui.surface', expect.anything())
    expect(el.querySelector('[data-screen-picker]')).toBeNull()
  })

  it('shows the active tab’s request only: another tab in front hides it until its tab is back', () => {
    const el = render(layer(stateWith([REQUEST], { activeTabId: 't2' })))
    expect(el.querySelector('[data-screen-picker]')).toBeNull()
    rerender(layer(stateWith([REQUEST])))
    expect(el.querySelector('[data-screen-picker]')).not.toBeNull()
  })

  it('an extension’s request is modal to the tab it names the same way (Chrome’s dialog is web-modal to the targetTab)', () => {
    const el = render(layer(stateWith([EXTENSION_REQUEST], { activeTabId: 't2' })))
    expect(el.querySelector('[data-screen-picker]')).toBeNull()
    rerender(layer(stateWith([EXTENSION_REQUEST])))
    expect(el.querySelector('[data-screen-picker]')).not.toBeNull()
  })
})

describe('ScreenPicker', () => {
  it('is Chrome’s dialog at 480: the site in the title block, the three panes, the tab pane first with the calling tab leading', async () => {
    const el = render(layer(stateWith([REQUEST])))
    await settle()
    const dialog = el.querySelector<HTMLElement>('[data-screen-picker="tab"]')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.style.width).toBe('480px')
    expect(dialog.querySelector('h2')!.textContent).toBe('Choose what to share')
    expect(dialog.querySelector('#zen-scpick-description')!.textContent).toBe(
      'meet.example wants to share the contents of your screen'
    )
    expect([...dialog.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
      'Zenium tab',
      'Window',
      'Entire screen'
    ])
    expect(paneTab(el, 'tab')!.getAttribute('aria-selected')).toBe('true')
    const cards = tiles(el)
    expect(cards.map((c) => c.dataset.sourceId)).toEqual(['tab:t1', 'tab:t2'])
    expect(cards[0]!.hasAttribute('data-current')).toBe(true)
    expect(cards[0]!.querySelector('.zen-scpick-name')!.textContent).toBe('Meeting – Example')
    // Nothing picked yet: Share waits, the one primary (§9.33).
    expect(share(el).disabled).toBe(true)
    expect(dialog.querySelectorAll('[data-primary]')).toHaveLength(1)
    // Focus starts on the calling tab's card (§9.22), the roving stop.
    expect(document.activeElement).toBe(cards[0])
    expect(cards[0]!.tabIndex).toBe(0)
    expect(cards[1]!.tabIndex).toBe(-1)
    // The page gave way to its picture and the chrome took the keyboard.
    expect(uiStore.get().screenPickerOpen).toBe(true)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
  })

  it('a tab’s card shows the tab’s own picture, a screen’s the OS’s still, and no picture leaves the kind’s glyph', () => {
    rememberThumbnail('t1', 'data:image/png;base64,COVER')
    const el = render(layer(stateWith([REQUEST])))
    const thisTab = tile(el, 'tab:t1')!
    expect(thisTab.querySelector<HTMLImageElement>('.zen-scpick-thumb img')!.src).toContain('COVER')
    expect(thisTab.querySelector<HTMLImageElement>('.zen-scpick-icon')!.src).toContain('AAAA')
    const other = tile(el, 'tab:t2')!
    expect(other.querySelector('.zen-scpick-thumb img')).toBeNull()
    expect(other.querySelector('.zen-scpick-thumb svg')).not.toBeNull()
    // A favicon that fails to load gives way to the kind's glyph: no empty slot in the caption.
    act(() => {
      thisTab.querySelector('img.zen-scpick-icon')!.dispatchEvent(new Event('error'))
    })
    expect(thisTab.querySelector('img.zen-scpick-icon')).toBeNull()
    expect(thisTab.querySelector('svg.zen-scpick-icon')).not.toBeNull()
    click(paneTab(el, 'screen'))
    expect(
      tile(el, 'screen:1')!.querySelector<HTMLImageElement>('.zen-scpick-thumb img')!.src
    ).toContain('BBBB')
  })

  it('picks with a click and shares the pick with Share, answering the core with the source', () => {
    const el = render(layer(stateWith([REQUEST])))
    click(tile(el, 'tab:t2'))
    expect(tile(el, 'tab:t2')!.getAttribute('aria-checked')).toBe('true')
    expect(tile(el, 'tab:t1')!.getAttribute('aria-checked')).toBe('false')
    expect(share(el).disabled).toBe(false)
    click(share(el))
    expect(run).toHaveBeenCalledWith('screenCapture.respond', {
      id: 'capture-1',
      sourceId: 'tab:t2',
      audio: false
    })
    // Busy until the core takes the request away (§9.30); a second press does nothing.
    expect(share(el).getAttribute('aria-busy')).toBe('true')
    click(share(el))
    expect(vi.mocked(run).mock.calls.filter(([c]) => c === 'screenCapture.respond')).toHaveLength(1)
  })

  it('a double-click on a card shares it at once, as Chrome’s does', () => {
    const el = render(layer(stateWith([REQUEST])))
    click(paneTab(el, 'window'))
    dblclick(tile(el, 'window:9'))
    expect(run).toHaveBeenCalledWith('screenCapture.respond', {
      id: 'capture-1',
      sourceId: 'window:9',
      audio: false
    })
  })

  it('keeps one pick per pane, and the only screen comes picked so Share is a press away', () => {
    const el = render(layer(stateWith([REQUEST])))
    click(tile(el, 'tab:t2'))
    click(paneTab(el, 'screen'))
    expect(el.querySelector('[data-screen-picker="screen"]')).not.toBeNull()
    const grid = el.querySelector<HTMLElement>('.zen-scpick-grid')!
    expect(grid.dataset.columns).toBe('1')
    expect(tile(el, 'screen:1')!.getAttribute('aria-checked')).toBe('true')
    expect(share(el).disabled).toBe(false)
    // Two screens: nothing comes picked, two across.
    rerender(layer(stateWith([{ ...REQUEST, sources: [...REQUEST.sources, SCREEN_2] }])))
    expect(el.querySelector<HTMLElement>('.zen-scpick-grid')!.dataset.columns).toBe('2')
    expect(tiles(el).every((c) => c.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(share(el).disabled).toBe(true)
    // Back on the tab pane its pick is still there.
    click(paneTab(el, 'tab'))
    expect(tile(el, 'tab:t2')!.getAttribute('aria-checked')).toBe('true')
  })

  it('the arrow keys move the pick in the grid and switch panes on the segment; Enter on the pick shares', () => {
    const el = render(layer(stateWith([REQUEST])))
    const first = tile(el, 'tab:t1')!
    keydown(first, 'ArrowRight')
    expect(tile(el, 'tab:t2')!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(tile(el, 'tab:t2'))
    keydown(tile(el, 'tab:t2'), 'ArrowLeft')
    expect(tile(el, 'tab:t1')!.getAttribute('aria-checked')).toBe('true')
    // Off the grid's edge: nothing moves.
    keydown(tile(el, 'tab:t1'), 'ArrowUp')
    expect(tile(el, 'tab:t1')!.getAttribute('aria-checked')).toBe('true')
    keydown(tile(el, 'tab:t1'), 'Enter')
    expect(run).toHaveBeenCalledWith('screenCapture.respond', {
      id: 'capture-1',
      sourceId: 'tab:t1',
      audio: false
    })
    act(() => root!.unmount())
    root = null
    vi.mocked(run).mockClear()

    const el2 = render(layer(stateWith([REQUEST])))
    keydown(paneTab(el2, 'tab'), 'ArrowRight')
    expect(el2.querySelector('[data-screen-picker="window"]')).not.toBeNull()
    expect(document.activeElement).toBe(paneTab(el2, 'window'))
    keydown(paneTab(el2, 'window'), 'End')
    expect(el2.querySelector('[data-screen-picker="screen"]')).not.toBeNull()
  })

  it('the Window and Entire screen panes are busy until the OS’s list is in, then say when it holds nothing', () => {
    const el = render(
      layer(stateWith([{ ...REQUEST, loading: true, sources: [TAB_SOURCE, OTHER_TAB] }]))
    )
    // The tab pane is never waiting on the OS.
    expect(el.querySelector('[role="tabpanel"]')!.getAttribute('aria-busy')).toBeNull()
    click(paneTab(el, 'window'))
    const pane = el.querySelector('[role="tabpanel"]')!
    expect(pane.getAttribute('aria-busy')).toBe('true')
    expect(pane.querySelector('.zen-v2-spinner')).not.toBeNull()
    expect(share(el).disabled).toBe(true)
    rerender(layer(stateWith([{ ...REQUEST, loading: false, sources: [TAB_SOURCE, OTHER_TAB] }])))
    expect(el.querySelector('[role="tabpanel"]')!.getAttribute('aria-busy')).toBeNull()
    expect(el.querySelector('.zen-scpick-state')!.textContent).toBe('No open windows to share')
    click(paneTab(el, 'screen'))
    expect(el.querySelector('.zen-scpick-state')!.textContent).toBe('No screens to share')
  })

  it('draws the segment’s hairline only while the cards scroll under it (§9.7), and a new pane starts at the top', () => {
    const el = render(layer(stateWith([REQUEST])))
    const segment = el.querySelector<HTMLElement>('[role="tablist"]')!
    const pane = el.querySelector<HTMLElement>('[role="tabpanel"]')!
    expect(segment.getAttribute('data-scrolled')).toBeNull()
    act(() => {
      pane.scrollTop = 120
      pane.dispatchEvent(new Event('scroll'))
    })
    expect(segment.getAttribute('data-scrolled')).toBe('true')
    act(() => {
      pane.scrollTop = 0
      pane.dispatchEvent(new Event('scroll'))
    })
    expect(segment.getAttribute('data-scrolled')).toBeNull()
    // Switching panes puts the one list box back at its top.
    act(() => {
      pane.scrollTop = 80
      pane.dispatchEvent(new Event('scroll'))
    })
    click(paneTab(el, 'window'))
    expect(pane.scrollTop).toBe(0)
  })

  it('offers "Also share system audio" on the screen pane only where the OS can and the page asked, on by default', () => {
    const withAudio = { ...REQUEST, audio: true, systemAudio: true }
    const el = render(layer(stateWith([withAudio])))
    expect(el.querySelector('.zen-scpick-audio')).toBeNull()
    click(paneTab(el, 'screen'))
    const box = el.querySelector<HTMLInputElement>('.zen-scpick-audio input')!
    expect(box.checked).toBe(true)
    expect(el.querySelector('.zen-scpick-audio')!.textContent).toBe('Also share system audio')
    click(share(el))
    expect(run).toHaveBeenCalledWith('screenCapture.respond', {
      id: 'capture-1',
      sourceId: 'screen:1',
      audio: true
    })
  })

  it('a page that asked for audio where the OS cannot hand it along, or one that did not ask, gets no box', () => {
    const el = render(layer(stateWith([{ ...REQUEST, audio: true, systemAudio: false }])))
    click(paneTab(el, 'screen'))
    expect(el.querySelector('.zen-scpick-audio')).toBeNull()
    rerender(layer(stateWith([{ ...REQUEST, audio: false, systemAudio: true }])))
    expect(el.querySelector('.zen-scpick-audio')).toBeNull()
  })

  it('an unticked box shares the screen without its sound', () => {
    const el = render(layer(stateWith([{ ...REQUEST, audio: true, systemAudio: true }])))
    click(paneTab(el, 'screen'))
    click(el.querySelector('.zen-scpick-audio input'))
    click(share(el))
    expect(run).toHaveBeenCalledWith('screenCapture.respond', {
      id: 'capture-1',
      sourceId: 'screen:1',
      audio: false
    })
  })

  it('Cancel and Escape answer the core with no source – the page’s refusal – once', () => {
    const el = render(layer(stateWith([REQUEST])))
    const cancel = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    click(cancel)
    expect(run).toHaveBeenCalledWith('screenCapture.respond', {
      id: 'capture-1',
      sourceId: null,
      audio: false
    })
    click(share(el))
    expect(vi.mocked(run).mock.calls.filter(([c]) => c === 'screenCapture.respond')).toHaveLength(1)
    act(() => root!.unmount())
    root = null
    vi.mocked(run).mockClear()

    const el2 = render(layer(stateWith([REQUEST])))
    keydown(el2.querySelector('[data-screen-picker]'), 'Escape')
    expect(run).toHaveBeenCalledWith('screenCapture.respond', {
      id: 'capture-1',
      sourceId: null,
      audio: false
    })
  })

  it('gives the page back when the core takes the request away', async () => {
    render(layer(stateWith([REQUEST])))
    await settle()
    expect(uiStore.get().screenPickerOpen).toBe(true)
    // The host keeps a leaving panel's picture for its way out; the page is back at once.
    rerender(layer(stateWith([])))
    expect(uiStore.get().screenPickerOpen).toBe(false)
    expect(run).not.toHaveBeenCalledWith('screenCapture.respond', expect.anything())
  })
})

describe('ScreenPicker for an extension (chrome.desktopCapture)', () => {
  it('names the extension where the site goes, with its icon at the title’s start, and keeps Chrome’s three panes', () => {
    const el = render(layer(stateWith([EXTENSION_REQUEST])))
    const dialog = el.querySelector<HTMLElement>('[data-screen-picker="tab"]')!
    expect(dialog.querySelector('h2')!.textContent).toBe('Choose what to share')
    expect(dialog.querySelector('#zen-scpick-description')!.textContent).toBe(
      'Screen Recorder wants to share the contents of your screen'
    )
    const glyph = dialog.querySelector<HTMLImageElement>('h2 img')!
    expect(glyph.src).toContain('EEEE')
    expect(glyph.getAttribute('width')).toBe('16')
    expect([...dialog.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
      'Zenium tab',
      'Window',
      'Entire screen'
    ])
    // The calling tab still leads the tab pane and is the one marked current.
    expect(tiles(el).map((c) => c.dataset.sourceId)).toEqual(['tab:t1', 'tab:t2'])
    expect(tiles(el)[0]!.hasAttribute('data-current')).toBe(true)
  })

  it('says whom the extension shares with when it captures for a site’s tab (targetTab)', () => {
    const el = render(layer(stateWith([{ ...EXTENSION_REQUEST, origin: 'docs.example' }])))
    expect(el.querySelector('#zen-scpick-description')!.textContent).toBe(
      'Screen Recorder wants to share the contents of your screen with docs.example'
    )
  })

  it('a long origin is never elided: it wraps, with a break opportunity after each of its dots and none inside a label (§9.23)', () => {
    const host = 'meetings.europe-west-2.collaboration-platform.example-organisation-holdings.co.uk'
    const el = render(layer(stateWith([{ ...EXTENSION_REQUEST, origin: host }])))
    const description = el.querySelector<HTMLElement>('#zen-scpick-description')!
    // The whole host is in the text, nothing cut, no ellipsis.
    expect(description.textContent).toBe(
      `Screen Recorder wants to share the contents of your screen with ${host}`
    )
    const origin = description.querySelector<HTMLElement>('.zen-scpick-origin')!
    expect(origin.textContent).toBe(host)
    expect(origin.querySelectorAll('wbr')).toHaveLength(5)
    // Each `<wbr>` sits right after a dot: the labels between them are the host's.
    const labels: string[] = []
    let label = ''
    for (const node of origin.childNodes) {
      if (node.nodeName === 'WBR') {
        labels.push(label)
        label = ''
      } else label += node.textContent
    }
    labels.push(label)
    expect(labels).toEqual([
      'meetings.',
      'europe-west-2.',
      'collaboration-platform.',
      'example-organisation-holdings.',
      'co.',
      'uk'
    ])
    // A site's own request names its host the same way.
    rerender(layer(stateWith([REQUEST])))
    const site = el.querySelector<HTMLElement>('#zen-scpick-description .zen-scpick-origin')!
    expect(site.textContent).toBe('meet.example')
    expect(site.querySelectorAll('wbr')).toHaveLength(1)
    expect(el.querySelector('#zen-scpick-description')!.textContent).toBe(
      'meet.example wants to share the contents of your screen'
    )
  })

  it('an extension without an icon gets the puzzle glyph, a site none', () => {
    const el = render(
      layer(stateWith([{ ...EXTENSION_REQUEST, extension: { name: 'Recorder', icon: null } }]))
    )
    expect(el.querySelector('h2 img')).toBeNull()
    expect(el.querySelector('h2 svg')).not.toBeNull()
    rerender(layer(stateWith([REQUEST])))
    expect(el.querySelector('h2 img')).toBeNull()
    expect(el.querySelector('h2 svg')).toBeNull()
  })

  it('shows only the panes the extension asked for, opening on the first; one pane stands alone without the segment', () => {
    const el = render(
      layer(
        stateWith([
          { ...EXTENSION_REQUEST, kinds: ['window', 'screen'], sources: [SCREEN, WINDOW] }
        ])
      )
    )
    expect([...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
      'Window',
      'Entire screen'
    ])
    expect(el.querySelector('[data-screen-picker="window"]')).not.toBeNull()
    expect(paneTab(el, 'window')!.getAttribute('aria-selected')).toBe('true')
    // The arrow keys stay within the panes on offer.
    keydown(paneTab(el, 'window'), 'ArrowRight')
    expect(el.querySelector('[data-screen-picker="screen"]')).not.toBeNull()
    keydown(paneTab(el, 'screen'), 'ArrowRight')
    expect(el.querySelector('[data-screen-picker="screen"]')).not.toBeNull()
    act(() => root!.unmount())
    root = null

    const alone = render(
      layer(stateWith([{ ...EXTENSION_REQUEST, kinds: ['screen'], sources: [SCREEN] }]))
    )
    expect(alone.querySelector('[role="tablist"]')).toBeNull()
    expect(alone.querySelector('[role="tabpanel"]')).toBeNull()
    const list = alone.querySelector<HTMLElement>('.zen-scpick-list')!
    expect(list.hasAttribute('data-alone')).toBe(true)
    expect(list.getAttribute('aria-label')).toBe('Entire screen')
    expect(alone.querySelector('[data-screen-picker="screen"]')).not.toBeNull()
    // The only screen comes picked; Share is a press away and answers the core.
    expect(tile(alone, 'screen:1')!.getAttribute('aria-checked')).toBe('true')
    click(share(alone))
    expect(run).toHaveBeenCalledWith('screenCapture.respond', {
      id: 'capture-2',
      sourceId: 'screen:1',
      audio: false
    })
  })

  it('a pane that opens while the OS’s list is on its way: the dialog holds the keyboard – not Cancel (§9.22) – over the busy list, then the first card takes it once, and not again', async () => {
    const waiting: ScreenCaptureRequest = {
      ...EXTENSION_REQUEST,
      kinds: ['screen'],
      loading: true,
      sources: []
    }
    const el = render(layer(stateWith([waiting])))
    await settle()
    const dialog = el.querySelector<HTMLElement>('[data-screen-picker="screen"]')!
    // No card to land on yet: the dialog itself, named by its title, holds the keyboard; the
    // list says it is busy.
    expect(document.activeElement).toBe(dialog)
    expect(dialog.tabIndex).toBe(-1)
    expect(dialog.getAttribute('aria-labelledby')).toBe('zen-scpick-title')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe(
      'Choose what to share'
    )
    expect(el.querySelector('.zen-scpick-list')!.getAttribute('aria-busy')).toBe('true')
    expect(document.activeElement!.textContent).not.toBe('Cancel')
    // Escape is still Cancel from there.
    keydown(dialog, 'Escape')
    expect(run).toHaveBeenCalledWith('screenCapture.respond', {
      id: 'capture-2',
      sourceId: null,
      audio: false
    })
    act(() => root!.unmount())
    root = null
    vi.mocked(run).mockClear()

    const el2 = render(layer(stateWith([waiting])))
    await settle()
    expect(document.activeElement).toBe(el2.querySelector('[data-screen-picker="screen"]'))
    // The list is in: the one move, to the first card; the list is no longer busy.
    rerender(layer(stateWith([{ ...waiting, loading: false, sources: [SCREEN, SCREEN_2] }])))
    await settle()
    expect(document.activeElement).toBe(tile(el2, 'screen:1'))
    expect(el2.querySelector('.zen-scpick-list')!.getAttribute('aria-busy')).toBeNull()
    // Later list changes leave the keyboard where the user has it.
    const cancel = [...el2.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    cancel.focus()
    rerender(
      layer(stateWith([{ ...waiting, loading: false, sources: [SCREEN, SCREEN_2, WINDOW] }]))
    )
    await settle()
    expect(document.activeElement).toBe(cancel)
  })

  it('a user who moves on while the list is on its way keeps their place when it comes in', async () => {
    const waiting: ScreenCaptureRequest = {
      ...EXTENSION_REQUEST,
      kinds: ['window', 'screen'],
      loading: true,
      sources: []
    }
    const el = render(layer(stateWith([waiting])))
    await settle()
    expect(document.activeElement).toBe(el.querySelector('[data-screen-picker="window"]'))
    paneTab(el, 'window')!.focus()
    rerender(layer(stateWith([{ ...waiting, loading: false, sources: [WINDOW, SCREEN] }])))
    await settle()
    expect(document.activeElement).toBe(paneTab(el, 'window'))
  })

  it('the keyboard stays where the page’s request put it: the calling tab’s card, whatever comes in after', async () => {
    const el = render(layer(stateWith([{ ...REQUEST, loading: true, sources: [TAB_SOURCE] }])))
    await settle()
    expect(document.activeElement).toBe(tile(el, 'tab:t1'))
    keydown(paneTab(el, 'tab'), 'ArrowRight')
    paneTab(el, 'window')!.focus()
    rerender(layer(stateWith([{ ...REQUEST, loading: false, sources: [TAB_SOURCE, WINDOW] }])))
    await settle()
    expect(document.activeElement).toBe(paneTab(el, 'window'))
  })

  it('with one pane the title block carries the scroll hairline the segment would', () => {
    const el = render(
      layer(stateWith([{ ...EXTENSION_REQUEST, kinds: ['window'], sources: [WINDOW] }]))
    )
    const block = el.querySelector<HTMLElement>('.zen-v2-title-block')!
    const list = el.querySelector<HTMLElement>('.zen-scpick-list')!
    expect(block.getAttribute('data-scrolled')).toBeNull()
    act(() => {
      list.scrollTop = 40
      list.dispatchEvent(new Event('scroll'))
    })
    expect(block.getAttribute('data-scrolled')).toBe('true')
  })

  it('offers the system-audio box on the screen pane when the extension asked for audio and the OS can', () => {
    const el = render(
      layer(
        stateWith([
          {
            ...EXTENSION_REQUEST,
            kinds: ['screen'],
            sources: [SCREEN],
            audio: true,
            systemAudio: true
          }
        ])
      )
    )
    expect(el.querySelector('.zen-scpick-audio')!.textContent).toBe('Also share system audio')
    click(share(el))
    expect(run).toHaveBeenCalledWith('screenCapture.respond', {
      id: 'capture-2',
      sourceId: 'screen:1',
      audio: true
    })
  })
})

describe('the picker’s pure parts', () => {
  it('effectiveSelection keeps a pick that is still offered, else picks the only screen, else nothing', () => {
    expect(effectiveSelection('tab', [TAB_SOURCE, OTHER_TAB], 'tab:t2')).toBe('tab:t2')
    expect(effectiveSelection('tab', [TAB_SOURCE], 'tab:t2')).toBeNull()
    expect(effectiveSelection('screen', [SCREEN], null)).toBe('screen:1')
    expect(effectiveSelection('screen', [SCREEN, SCREEN_2], null)).toBeNull()
    expect(effectiveSelection('window', [WINDOW], null)).toBeNull()
  })

  it('hostLabels keeps each label with its dot, and a host without dots whole', () => {
    expect(hostLabels('meet.example')).toEqual(['meet.', 'example'])
    expect(hostLabels('a.b.c')).toEqual(['a.', 'b.', 'c'])
    expect(hostLabels('127.0.0.1:38777')).toEqual(['127.', '0.', '0.', '1:38777'])
    expect(hostLabels('localhost:3000')).toEqual(['localhost:3000'])
  })

  it('paneColumns gives the only screen the width and everything else two across', () => {
    expect(paneColumns('screen', 1)).toBe(1)
    expect(paneColumns('screen', 2)).toBe(2)
    expect(paneColumns('window', 1)).toBe(2)
    expect(paneColumns('tab', 1)).toBe(2)
  })

  it('gridMove steps, jumps rows, goes to the ends and refuses to step off', () => {
    expect(gridMove('ArrowRight', 0, 5, 2)).toBe(1)
    expect(gridMove('ArrowLeft', 0, 5, 2)).toBeNull()
    expect(gridMove('ArrowDown', 1, 5, 2)).toBe(3)
    expect(gridMove('ArrowDown', 3, 5, 2)).toBeNull()
    expect(gridMove('ArrowUp', 4, 5, 2)).toBe(2)
    expect(gridMove('Home', 4, 5, 2)).toBe(0)
    expect(gridMove('End', 0, 5, 2)).toBe(4)
    expect(gridMove('End', 4, 5, 2)).toBeNull()
    expect(gridMove('Tab', 0, 5, 2)).toBeNull()
  })
})
