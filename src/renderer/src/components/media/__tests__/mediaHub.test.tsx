// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MediaState, Tab, UIState } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { mediaHubUi } from '@renderer/lib/mediaHub'
import { closeAllPopovers } from '@renderer/lib/portals'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { MediaHubButton } from '../MediaHubButton'
import { MediaHubLayer } from '../MediaHubPopover'

/*
 * The desktop's media hub (MW-16: Chrome's global media controls): the toolbar button
 * (`media/MediaHubButton.tsx`) that is there while any tab has media and opens the popover
 * (`media/MediaHubPopover.tsx`) of one player per tab, rendered for real in happy-dom. What a
 * player shows of its tab's media (artwork, title, artist · site, the times), which controls it
 * offers (the track buttons only through the page's own handlers, picture-in-picture only for a
 * video where the host has it) and what each sends the core – the Media Session actions the OS
 * controls send – and that the hub leaves with the last player and gives the keyboard back to
 * the button.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(id: string, url: string, title: string): Tab {
  return { id, url, title } as Tab
}

const music = tab('t1', 'https://music.example.com/album/1', 'Album – Music')
const video = tab('t2', 'https://video.example.com/watch', 'A film')

/** A track two minutes long, ten seconds in, the page handling the track actions. */
function track(over: Partial<MediaState> = {}): MediaState {
  return {
    tabId: 't1',
    playing: true,
    title: 'Nocturne',
    artist: 'The Band',
    artwork: 'data:image/png;base64,AAAA',
    position: { duration: 120, position: 10, playbackRate: 1 },
    positionAt: Date.now(),
    actions: ['play', 'pause', 'previoustrack', 'nexttrack'],
    session: true,
    ...over
  }
}

/** Enough of a snapshot for the hub and for the stores that read every push (the back state). */
function stateWith(entries: MediaState[], pip = true): UIState {
  return {
    platform: 'linux',
    capabilities: { windows: true, pictureInPicture: pip },
    tabs: { t1: music, t2: video },
    spaces: [{ id: 'space', activeTabId: 't1', tabIds: ['t1', 't2'], containerId: 'default' }],
    activeSpaceId: 'space',
    folders: {},
    essentialTabIds: [],
    settings: {},
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

function hub(): HTMLElement | null {
  return q('[data-zen-media-hub]')
}

function click(target: Element | null): void {
  act(() => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** What the hub sent the core, the chrome's own focus bookkeeping aside. */
function commands(): unknown[][] {
  return vi.mocked(run).mock.calls.filter(([name]) => name !== 'focus.chrome')
}

/** The page's capture lands and the popover takes its first paint. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** The button and the layer as the shell mounts them, the hub opened from the button. */
async function open(state: UIState): Promise<void> {
  browserStore.set({ state })
  render(
    <>
      <MediaHubButton state={state} />
      <MediaHubLayer />
    </>
  )
  click(q('[data-zen-media-hub-button]'))
  await settle()
}

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  mediaHubUi.set({ open: false, fromKeyboard: false })
  browserStore.set({ state: null })
  vi.mocked(run).mockClear()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('MediaHubButton', () => {
  it('is in the row while a tab has media, named by what plays, with the dot while anything plays', () => {
    render(<MediaHubButton state={stateWith([])} />)
    expect(q('[data-zen-media-hub-button]')).toBeNull()

    render(<MediaHubButton state={stateWith([track({ playing: false })])} />)
    const button = q('[data-zen-media-hub-button]')!
    expect(button.getAttribute('aria-label')).toBe('Media controls')
    expect(button.getAttribute('title')).toBe('Control your music, videos and more')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.querySelector('.zen-mhub-dot')).toBeNull()

    render(<MediaHubButton state={stateWith([track()])} />)
    expect(q('[data-zen-media-hub-button]')!.getAttribute('aria-label')).toBe(
      'Media controls, 1 playing'
    )
    expect(q('[data-zen-media-hub-button] .zen-mhub-dot')).not.toBeNull()

    // Media of a tab that is gone counts for nothing.
    render(<MediaHubButton state={stateWith([track({ tabId: 'closed' })])} />)
    expect(q('[data-zen-media-hub-button]')).toBeNull()
  })

  it('opens and closes the hub', async () => {
    const state = stateWith([track()])
    browserStore.set({ state })
    render(
      <>
        <MediaHubButton state={state} />
        <MediaHubLayer />
      </>
    )
    expect(hub()).toBeNull()
    click(q('[data-zen-media-hub-button]'))
    // Not before the page's picture is in place: the popover overhangs the content frame.
    expect(hub()).toBeNull()
    await settle()
    expect(hub()).not.toBeNull()
    expect(uiStore.get().floatingChrome).toBe(1)
    expect(q('[data-zen-media-hub-button]')!.getAttribute('aria-expanded')).toBe('true')
    click(q('[data-zen-media-hub-button]'))
    expect(mediaHubUi.get().open).toBe(false)
    expect(hub()).toBeNull()
    expect(uiStore.get().floatingChrome).toBe(0)
  })
})

describe('MediaHubPopover', () => {
  it('shows one player per tab with media, the session first: artwork, title, artist · site, the times', async () => {
    await open(
      stateWith([
        track({ tabId: 't2', title: '', artist: '', artwork: null, video: true, session: false }),
        track()
      ])
    )
    const panel = hub()!
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.style.width).toBe('400px')
    // No title block: the hub opens on its cards like a menu (§9.7), named as the button is.
    expect(panel.querySelector('h2, .zen-v2-title-block')).toBeNull()
    expect(panel.getAttribute('aria-label')).toBe('Media controls')
    expect(panel.firstElementChild!.classList.contains('zen-mhub-body')).toBe(true)
    const players = [...panel.querySelectorAll<HTMLElement>('[data-media-player]')]
    expect(players.map((p) => p.dataset.mediaPlayer)).toEqual(['t1', 't2'])

    const [first, second] = players
    // The artwork tile is the one both players draw (the phone sheet's `.zen-media-art`).
    expect(first!.querySelector('img.zen-media-art')!.getAttribute('src')).toBe(
      'data:image/png;base64,AAAA'
    )
    expect(first!.querySelector('.zen-mhub-name')!.textContent).toBe('Nocturne')
    expect(first!.querySelector('.zen-mhub-detail')!.textContent).toBe(
      'The Band · music.example.com'
    )
    expect([...first!.querySelectorAll('.zen-mhub-time')].map((t) => t.textContent)).toEqual([
      '0:10',
      '2:00'
    ])
    // A page without metadata: the tab's title and its site, the kind's §9.3 glyph for the artwork
    // (a film strip for video, as the phone sheet draws it; a note otherwise).
    expect(second!.querySelector('img.zen-media-art')).toBeNull()
    const empty = second!.querySelector('.zen-media-art-empty svg')!
    expect(empty.classList.contains('lucide-film')).toBe(true)
    expect(empty.classList.contains('h-[var(--v2-icon)]')).toBe(true)
    expect(second!.querySelector('.zen-mhub-name')!.textContent).toBe('A film')
    expect(second!.querySelector('.zen-mhub-detail')!.textContent).toBe('video.example.com')

    // Picture-in-picture only for a video where the host has it.
    expect(first!.querySelector('[data-media-pip]')).toBeNull()
    expect(second!.querySelector('[data-media-pip]')).not.toBeNull()

    // The keyboard is on the first control (§9.22).
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  it('offers no picture-in-picture where the host has none', async () => {
    await open(stateWith([track({ video: true })], false))
    expect(hub()!.querySelector('[data-media-pip]')).toBeNull()
  })

  it('each control sends the Media Session action the OS controls send', async () => {
    await open(stateWith([track({ video: true })]))
    const panel = hub()!
    click(panel.querySelector('[data-media-toggle]'))
    expect(commands().at(-1)).toEqual(['media.toggle', { tabId: 't1' }])

    const transport = panel.querySelector('[data-media-transport]')!
    const buttons = [...transport.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Previous track',
      'Seek backward',
      'Pause',
      'Seek forward',
      'Next track'
    ])
    click(buttons[0]!)
    click(buttons[1]!)
    click(buttons[3]!)
    click(buttons[4]!)
    expect(commands().slice(-4)).toEqual([
      ['media.action', { tabId: 't1', action: 'previoustrack', seekOffset: 10 }],
      ['media.action', { tabId: 't1', action: 'seekbackward', seekOffset: 10 }],
      ['media.action', { tabId: 't1', action: 'seekforward', seekOffset: 10 }],
      ['media.action', { tabId: 't1', action: 'nexttrack', seekOffset: 10 }]
    ])

    // Picture-in-picture goes through the core and the hub gives way to the small window.
    click(panel.querySelector('[data-media-pip]'))
    expect(commands().at(-1)).toEqual(['media.pictureInPicture', { tabId: 't1' }])
    expect(mediaHubUi.get().open).toBe(false)
  })

  it('the title is the way to the tab; the track buttons wait for the page to handle them', async () => {
    await open(stateWith([track({ actions: ['play', 'pause'], playing: false })]))
    const panel = hub()!
    expect(panel.querySelector('[data-media-toggle]')!.getAttribute('aria-label')).toBe('Play')
    const transport = panel.querySelector('[data-media-transport]')!
    const buttons = [...transport.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((b) => b.disabled)).toEqual([true, false, false, false, true])

    click(panel.querySelector('[data-media-switch]'))
    expect(commands().at(-1)).toEqual(['tab.activate', { tabId: 't1' }])
    expect(mediaHubUi.get().open).toBe(false)
  })

  it('has no seek row for a stream without a duration, and its seek buttons rest', async () => {
    await open(stateWith([track({ position: { duration: 0, position: 0, playbackRate: 1 } })]))
    const panel = hub()!
    expect(panel.querySelector('[data-media-seek]')).toBeNull()
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('[data-media-transport] button')]
    expect(buttons.map((b) => b.disabled)).toEqual([false, true, false, true, false])
  })

  it('the seek row is §10.4’s slider row, spoken as times; a scrub seeks where the pointer let go', async () => {
    await open(stateWith([track({ playing: false })]))
    const slider = hub()!.querySelector<HTMLElement>('[data-media-position]')!
    expect(slider.classList.contains('zen-zoom-slider')).toBe(true)
    // The name and the spoken value sit on Radix's thumb, the `role="slider"` node that carries
    // `aria-valuenow` (A11Y-01): the root is the row that draws the track.
    const thumb = slider.querySelector('[role="slider"]')!
    expect(thumb.getAttribute('aria-label')).toBe('Position')
    expect(thumb.getAttribute('aria-valuetext')).toBe('0:10 of 2:00')
    expect(thumb.getAttribute('aria-valuemax')).toBe('120')
    expect(thumb.getAttribute('aria-valuenow')).toBe('10')

    // happy-dom lays nothing out: the slider is 120 px wide at the left edge, a pixel a second.
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 120, height: 20, right: 120, bottom: 20, x: 0, y: 0 })
    })
    const trackEl = slider.firstElementChild as HTMLElement
    const pointer = (type: string, clientX: number): void => {
      trackEl.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, pointerId: 1 }))
    }
    act(() => pointer('pointerdown', 10))
    act(() => pointer('pointermove', 30))
    expect(hub()!.querySelector('.zen-mhub-time')!.textContent).toBe('0:30')
    // The last move and the lift in one go: Radix commits what React last drew (0:30); the
    // seek goes with the pointer (1:00).
    act(() => {
      pointer('pointermove', 60)
      pointer('pointerup', 60)
    })
    expect(commands().at(-1)).toEqual([
      'media.action',
      { tabId: 't1', action: 'seekto', seekTime: 60 }
    ])
    // The target stands until the page reports again.
    expect(hub()!.querySelector('.zen-mhub-time')!.textContent).toBe('1:00')
    const state = stateWith([
      track({
        playing: false,
        position: { duration: 120, position: 45, playbackRate: 1 },
        positionAt: Date.now() + 1
      })
    ])
    browserStore.set({ state })
    render(
      <>
        <MediaHubButton state={state} />
        <MediaHubLayer />
      </>
    )
    expect(hub()!.querySelector('.zen-mhub-time')!.textContent).toBe('0:45')
  })

  it('a key on the thumb steps the position and commits it', async () => {
    await open(stateWith([track({ playing: false })]))
    const thumb = hub()!.querySelector<HTMLElement>('[data-media-position] [role="slider"]')!
    act(() => {
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(commands().at(-1)).toEqual([
      'media.action',
      { tabId: 't1', action: 'seekto', seekTime: expect.closeTo(10.1, 6) as number }
    ])
  })

  it('Escape closes the hub and puts the keyboard back on the button', async () => {
    await open(stateWith([track()]))
    act(() => {
      hub()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(mediaHubUi.get().open).toBe(false)
    expect(hub()).toBeNull()
    expect(document.activeElement).toBe(q('[data-zen-media-hub-button]'))
  })

  it('leaves with the last player', async () => {
    await open(stateWith([track()]))
    expect(hub()).not.toBeNull()
    const state = stateWith([])
    browserStore.set({ state })
    render(
      <>
        <MediaHubButton state={state} />
        <MediaHubLayer />
      </>
    )
    expect(mediaHubUi.get().open).toBe(false)
    expect(hub()).toBeNull()
    expect(q('[data-zen-media-hub-button]')).toBeNull()
  })
})
