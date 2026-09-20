// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MediaState, Space, Tab, UIState } from '@shared/types'

/*
 * The in-app player (MW-16): the media sheet the pill's Now playing chip opens on a phone
 * (`phone/MediaSheet.tsx`), rendered for real in happy-dom. What it shows of the tab's media
 * (title, artist · site, the times), which controls it offers (the track buttons only through
 * the page's own handlers, picture-in-picture only for a video where the host has it, Switch to
 * tab only while another tab is on screen), and what each control sends the host – the same
 * Media Session actions the OS controls send. And that it leaves with the media.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { MediaLayer } = await import('../MediaSheet')
const { uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')

function tab(id: string, url: string, title: string): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: 'default',
    url,
    title,
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
    audible: true,
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

const music = tab('t1', 'https://music.example.com/album/1', 'Album – Music')
const other = tab('t2', 'https://news.example.com/', 'News')

function space(activeTabId: string): Space {
  return {
    id: 'space',
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: ['t1', 't2'],
    activeTabId,
    pinnedCollapsed: false
  }
}

/** The report of a track two minutes long, ten seconds in, the page handling the track actions. */
function track(over: Partial<MediaState> = {}): MediaState {
  return {
    tabId: 't1',
    playing: true,
    title: 'Nocturne',
    artist: 'The Band',
    artwork: null,
    video: false,
    position: { duration: 120, position: 10, playbackRate: 1 },
    positionAt: Date.now(),
    actions: ['previoustrack', 'nexttrack'],
    session: true,
    ...over
  }
}

function state(
  media: MediaState[],
  { active = 't1', pictureInPicture = true }: { active?: string; pictureInPicture?: boolean } = {}
): UIState {
  return {
    platform: 'android',
    capabilities: { windowControls: false, pictureInPicture },
    tabs: { t1: music, t2: other },
    spaces: [space(active)],
    activeSpaceId: 'space',
    essentialTabIds: [],
    settings: {},
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    media
  } as unknown as UIState
}

let root: Root | null = null
let host: HTMLElement | null = null

function render(s: UIState): void {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => root!.render(<MediaLayer state={s} />))
}

/** The sheet up for `t1`'s media, its wait for the page's cover over (at once, with no page). */
async function open(s: UIState): Promise<void> {
  uiStore.set({ mediaSheet: 't1' })
  render(s)
  await act(async () => {
    await Promise.resolve()
  })
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const byLabel = (label: string): HTMLButtonElement | null =>
  q<HTMLButtonElement>(`[aria-label="${label}"]`)
const commands = (): [string, unknown][] =>
  invoke.mock.calls.map(([name, args]) => [name, args] as [string, unknown])

const click = (el: HTMLElement | null): void => {
  expect(el).not.toBeNull()
  act(() => el!.click())
}

const initialViewport = viewportStore.get()

beforeEach(() => {
  viewportStore.set({ ...viewportStore.get(), coarse: true, hover: false, formFactor: 'phone' })
  uiStore.set({ mediaSheet: null })
  // happy-dom lays nothing out: the layer is 800 tall and the sheet's content 300, as bottomSheet.test has it.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
  invoke.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  viewportStore.set(initialViewport)
  uiStore.set({ mediaSheet: null })
})

describe('the media sheet', () => {
  it('is a Now playing sheet on the chassis with the track, the times and the transport', async () => {
    await open(state([track()]))
    const sheet = q('.zen-sheet')
    expect(sheet).not.toBeNull()
    expect(sheet!.classList.contains('zen-media-sheet')).toBe(true)
    expect(sheet!.querySelector('.zen-sheet-title')?.textContent).toBe('Now playing')
    // A layer on the chassis already: the host's own scrim stays down for it.
    expect(sheet!.closest('[data-sheet-layer]')).not.toBeNull()

    expect(q('[data-testid="media-title"]')?.textContent).toBe('Nocturne')
    expect(q('.zen-media-detail')?.textContent).toBe('The Band · music.example.com')
    // No artwork from the page: the note glyph on a tile, never a broken image.
    expect(q('.zen-media-art-empty')).not.toBeNull()
    expect(q('.zen-media-art-empty svg')?.classList.contains('lucide-music')).toBe(true)
    expect(q('img.zen-media-art')).toBeNull()

    const times = [...q('.zen-media-times')!.children].map((c) => c.textContent)
    expect(times).toEqual(['0:10', '2:00'])
    expect(q('[data-testid="media-position"]')).not.toBeNull()

    // The transport: previous, pause (it plays), next – live, since the page handles the tracks.
    const transport = q('[data-testid="media-transport"]')!
    const buttons = [...transport.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Previous track',
      'Pause',
      'Next track'
    ])
    expect(buttons.every((b) => !b.disabled)).toBe(true)
    // Three of the one §9.3 box: the toggle carries no class of its own (no fill at rest, no
    // disc), its solid glyph between the outlined skips is the emphasis.
    expect(buttons.every((b) => b.className === 'zen-v2-icon-button')).toBe(true)
    expect(byLabel('Pause')?.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
    expect(byLabel('Next track')?.querySelector('svg')?.getAttribute('fill')).toBe('none')
  })

  it('shows a page without metadata as its title over its site, the site never twice', async () => {
    // The core filled the site in for the artist; the tab reads as its host, having no title.
    const clip = tab('t1', 'https://music.example.com/clip', 'music.example.com')
    const s = state([track({ title: undefined, artist: 'music.example.com', video: true })])
    s.tabs = { ...s.tabs, t1: clip }
    await open(s)
    expect(q('[data-testid="media-title"]')?.textContent).toBe('music.example.com')
    expect(q('.zen-media-detail')).toBeNull()
    // A video's empty tile is a film strip, not a note.
    expect(q('.zen-media-art-empty svg')?.classList.contains('lucide-film')).toBe(true)
    // With a title of its own the page shows it over the site.
    render({ ...s, tabs: { ...s.tabs, t1: { ...clip, title: 'A clip' } } })
    expect(q('[data-testid="media-title"]')?.textContent).toBe('A clip')
    expect(q('.zen-media-detail')?.textContent).toBe('music.example.com')
  })

  it('shows the page’s artwork when it has one and reads Play while paused', async () => {
    await open(state([track({ playing: false, artwork: 'https://music.example.com/art.png' })]))
    const art = q<HTMLImageElement>('img.zen-media-art')
    expect(art?.getAttribute('src')).toBe('https://music.example.com/art.png')
    expect(art?.getAttribute('alt')).toBe('')
    expect(byLabel('Play')).not.toBeNull()
    expect(byLabel('Pause')).toBeNull()
  })

  it('disables the track buttons at .4 while the page handles neither (§9.30)', async () => {
    await open(state([track({ actions: [] })]))
    expect(byLabel('Previous track')?.disabled).toBe(true)
    expect(byLabel('Next track')?.disabled).toBe(true)
    expect(byLabel('Pause')?.disabled).toBe(false)
    // One handled: only its button comes alive.
    render(state([track({ actions: ['nexttrack'] })]))
    expect(byLabel('Previous track')?.disabled).toBe(true)
    expect(byLabel('Next track')?.disabled).toBe(false)
  })

  it('sends the OS controls’ actions: the toggle, the tracks, the ten-second seeks and a scrub', async () => {
    await open(state([track()]))
    click(byLabel('Pause'))
    expect(commands().at(-1)).toEqual(['media.toggle', { tabId: 't1' }])
    click(byLabel('Next track'))
    expect(commands().at(-1)).toEqual(['media.action', { tabId: 't1', action: 'nexttrack' }])
    click(byLabel('Previous track'))
    expect(commands().at(-1)).toEqual(['media.action', { tabId: 't1', action: 'previoustrack' }])

    // Paused at 0:10 (the position holds; playing, it would have run on by the milliseconds
    // since the report): seek forward lands at 0:20, and the display holds the target until the
    // page's next report; seek backward from there goes back to 0:10, never under zero.
    render(state([track({ playing: false })]))
    click(byLabel('Seek forward'))
    expect(commands().at(-1)).toEqual([
      'media.action',
      { tabId: 't1', action: 'seekto', seekTime: 20 }
    ])
    expect(q('.zen-media-times')!.firstElementChild!.textContent).toBe('0:20')
    click(byLabel('Seek backward'))
    expect(commands().at(-1)).toEqual([
      'media.action',
      { tabId: 't1', action: 'seekto', seekTime: 10 }
    ])
    click(byLabel('Seek backward'))
    expect(commands().at(-1)).toEqual([
      'media.action',
      { tabId: 't1', action: 'seekto', seekTime: 0 }
    ])
    expect(q('.zen-media-times')!.firstElementChild!.textContent).toBe('0:00')

    // A new report from the page (a later `positionAt`) takes the display back to the live position.
    render(
      state([
        track({
          playing: false,
          position: { duration: 120, position: 30, playbackRate: 1 },
          positionAt: Date.now() + 1
        })
      ])
    )
    expect(q('.zen-media-times')!.firstElementChild!.textContent).toBe('0:30')

    // The slider is the §10.4 row (the zoom row's), the position spoken as times, ending at the duration.
    const slider = q('[data-testid="media-position"]')!
    expect(slider.classList.contains('zen-zoom-slider')).toBe(true)
    // The name and the spoken value sit on Radix's thumb, the `role="slider"` node that carries
    // `aria-valuenow` (A11Y-01): the root is the row that draws the track.
    const thumb = slider.querySelector('[role="slider"]')
    expect(thumb?.getAttribute('aria-label')).toBe('Position')
    expect(thumb?.getAttribute('aria-valuetext')).toBe('0:30 of 2:00')
    expect(thumb?.getAttribute('aria-valuemax')).toBe('120')
    expect(thumb?.getAttribute('aria-valuenow')).toBe('30')
  })

  it('a scrub seeks to where the finger let go, not where the thumb was last drawn', async () => {
    await open(state([track({ playing: false })]))
    const slider = q<HTMLElement>('[data-testid="media-position"]')!
    // happy-dom lays nothing out: the slider is 120 px wide at the left edge, a pixel a second.
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 120, height: 20, right: 120, bottom: 20, x: 0, y: 0 })
    })
    // The finger on the track (Radix takes pointer capture there; happy-dom keeps it).
    const trackEl = slider.firstElementChild as HTMLElement
    const finger = (type: string, clientX: number): void => {
      trackEl.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, pointerId: 1 }))
    }
    act(() => finger('pointerdown', 10))
    act(() => finger('pointermove', 30))
    expect(q('.zen-media-times')!.firstElementChild!.textContent).toBe('0:30')
    // The last move and the lift in one go: the thumb at 0:30 is what React last drew when
    // the finger lifts at 1:00, and Radix commits what it drew. The seek goes with the finger.
    act(() => {
      finger('pointermove', 60)
      finger('pointerup', 60)
    })
    expect(commands().at(-1)).toEqual([
      'media.action',
      { tabId: 't1', action: 'seekto', seekTime: 60 }
    ])
    expect(q('.zen-media-times')!.firstElementChild!.textContent).toBe('1:00')
  })

  it('a key on the thumb steps the position and commits it, and the display follows the page after', async () => {
    await open(state([track({ playing: false })]))
    const thumb = q<HTMLElement>('[data-testid="media-position"] [role="slider"]')!
    act(() => {
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(commands().at(-1)).toEqual([
      'media.action',
      { tabId: 't1', action: 'seekto', seekTime: expect.closeTo(10.1, 6) as number }
    ])
    // The step's own change (reported after its commit) is no scrub: the page's next report
    // takes the display, which a finger still down would hold.
    render(
      state([
        track({
          playing: false,
          position: { duration: 120, position: 45, playbackRate: 1 },
          positionAt: Date.now() + 1
        })
      ])
    )
    expect(q('.zen-media-times')!.firstElementChild!.textContent).toBe('0:45')
  })

  it('has no seek row for a stream without a duration', async () => {
    await open(state([track({ position: { duration: 0, position: 30, playbackRate: 1 } })]))
    expect(q('[data-testid="media-seek"]')).toBeNull()
    expect(q('[data-testid="media-transport"]')).not.toBeNull()
  })

  it('offers picture-in-picture for a video where the host has it, and sends the tab into it', async () => {
    await open(state([track({ video: true })]))
    const row = q<HTMLElement>('[data-testid="media-pip"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('Picture in picture')
    click(row)
    expect(commands().at(-1)).toEqual(['media.pictureInPicture', { tabId: 't1' }])
    // The window shrinks to the video: the sheet goes with it.
    await vi.waitFor(() => expect(uiStore.get().mediaSheet).toBeNull())
  })

  it('offers no picture-in-picture for audio, nor for a video where the host has none', async () => {
    await open(state([track()]))
    expect(q('[data-testid="media-pip"]')).toBeNull()
    render(state([track({ video: true })], { pictureInPicture: false }))
    expect(q('[data-testid="media-pip"]')).toBeNull()
  })

  it('offers Switch to tab only while another tab is on screen, and switches', async () => {
    await open(state([track()]))
    expect(q('[data-testid="media-switch-tab"]')).toBeNull()
    render(state([track()], { active: 't2' }))
    const row = q<HTMLElement>('[data-testid="media-switch-tab"]')
    expect(row?.textContent).toContain('Switch to tab')
    click(row)
    expect(commands().at(-1)).toEqual(['tab.activate', { tabId: 't1' }])
    await vi.waitFor(() => expect(uiStore.get().mediaSheet).toBeNull())
  })

  it('leaves with the media: a closed tab or an ended clip takes the sheet down', async () => {
    await open(state([track()]))
    expect(q('[data-testid="media-sheet"]')).not.toBeNull()
    render(state([]))
    await vi.waitFor(() => expect(uiStore.get().mediaSheet).toBeNull())
  })

  it('renders nothing while no sheet is asked for', () => {
    render(state([track()]))
    expect(q('.zen-sheet')).toBeNull()
  })
})
