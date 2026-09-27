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

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultShortcuts } from '@shared/shortcuts'
import { run } from '@renderer/lib/api'
import {
  closeMediaHub,
  mediaHubEntries,
  mediaHubFolded,
  mediaHubFoldedAt,
  mediaHubUi,
  openMediaHub
} from '@renderer/lib/mediaHub'
import { holdExpanded } from '@renderer/lib/popover'
import { closeAllPopovers } from '@renderer/lib/portals'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { MediaHubButton, MediaLiveDot } from '../MediaHubButton'
import { MediaHubLayer } from '../MediaHubPopover'
import { SidebarBottom } from '../../sidebar/SidebarBottom'
import { NavRow } from '../../sidebar/SidebarTop'

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

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
    // Paused alone: the state joined to the name with §9.31's " · " (the #552 ruling).
    expect(button.getAttribute('aria-label')).toBe('Media controls · Paused')
    expect(button.getAttribute('data-tooltip')).toBe('Control your music, videos and more')
    expect(button.getAttribute('aria-description')).toBe('Control your music, videos and more')
    expect(button.hasAttribute('title')).toBe(false)
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

  it('wears the toolbar button menu marks the row hands it (W8-1: the desktop bar’s pinnable control), and none without them', () => {
    render(<MediaHubButton state={stateWith([track()])} />)
    let button = q('[data-zen-media-hub-button]')!
    expect(button.hasAttribute('data-zen-menu')).toBe(false)
    expect(button.hasAttribute('data-zen-menu-control')).toBe(false)
    render(
      <MediaHubButton
        state={stateWith([track()])}
        menuMarks={{ 'data-zen-menu': 'toolbar', 'data-zen-menu-control': 'media' }}
      />
    )
    button = q('[data-zen-media-hub-button]')!
    expect(button.getAttribute('data-zen-menu')).toBe('toolbar')
    expect(button.getAttribute('data-zen-menu-control')).toBe('media')
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
    // The anchor says what it has open and wears the toolbar's pressed fill off that for the
    // popover's life (§9.20), and is the toolbar's own again at rest.
    expect(q('[data-zen-media-hub-button]')!.getAttribute('aria-expanded')).toBe('true')
    click(q('[data-zen-media-hub-button]'))
    expect(mediaHubUi.get().open).toBe(false)
    expect(hub()).toBeNull()
    expect(uiStore.get().floatingChrome).toBe(0)
    expect(q('[data-zen-media-hub-button]')!.getAttribute('aria-expanded')).toBe('false')
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

  it("offers no picture-in-picture for a private tab's video (withheld, as Chrome does in Incognito)", async () => {
    await open(
      stateWith([track({ tabId: 't2', video: true, private: true, title: '', artist: '' })])
    )
    expect(hub()!.querySelector('[data-media-pip]')).toBeNull()
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

/*
 * A session lingering after its media paused or ended (W7-5, Chrome's global media controls):
 * the core keeps the tab's entry in `UIState.media` for Chrome's inactivity window
 * (`MEDIA_HUB_INACTIVE_MS`, 60 minutes without an interaction) and lets it go after, or at once
 * with its tab or its element. The hub draws what it is given: the paused player with its title,
 * artwork and a Play that resumes it through the core, the button without the dot, and the same
 * fold into the "⋯" menu at narrow widths as any entry's.
 */
describe('a paused session lingering in the hub (W7-5)', () => {
  it('shows the paused session with its title and artwork and a Play, which sends the resume through the core', async () => {
    const paused = track({
      playing: false,
      position: { duration: 120, position: 47, playbackRate: 1 }
    })
    await open(stateWith([paused]))
    // The button is in the row for the paused session, bare of the dot: nothing plays – and its
    // name says so, the state joined to the name with §9.31's " · " (the #552 ruling).
    const button = q('[data-zen-media-hub-button]')!
    expect(button.getAttribute('aria-label')).toBe('Media controls · Paused')
    expect(button.querySelector('.zen-mhub-dot')).toBeNull()

    const player = hub()!.querySelector<HTMLElement>('[data-media-player="t1"]')!
    expect(player.hasAttribute('data-playing')).toBe(false)
    expect(player.querySelector('.zen-mhub-name')!.textContent).toBe('Nocturne')
    expect(player.querySelector('.zen-mhub-detail')!.textContent).toBe(
      'The Band · music.example.com'
    )
    expect(player.querySelector('img.zen-media-art')!.getAttribute('src')).toBe(
      'data:image/png;base64,AAAA'
    )
    // Paused, the position stands where the pause left it (no extrapolation), and Play is offered.
    expect([...player.querySelectorAll('.zen-mhub-time')].map((t) => t.textContent)).toEqual([
      '0:47',
      '2:00'
    ])
    const toggle = player.querySelector<HTMLButtonElement>('[data-media-toggle]')!
    expect(toggle.getAttribute('aria-label')).toBe('Play')
    expect(toggle.disabled).toBe(false)
    // The resume: `media.toggle` for the tab, which the core posts to the page as `toggle` and
    // the page shim runs as the page's `play` handler, else the element's `play()`.
    click(toggle)
    expect(commands().at(-1)).toEqual(['media.toggle', { tabId: 't1' }])
  })

  it('an ended track is a paused one: the position at the end, the same Play to replay it', async () => {
    await open(
      stateWith([
        track({ playing: false, position: { duration: 120, position: 120, playbackRate: 1 } })
      ])
    )
    const player = hub()!.querySelector<HTMLElement>('[data-media-player="t1"]')!
    expect([...player.querySelectorAll('.zen-mhub-time')].map((t) => t.textContent)).toEqual([
      '2:00',
      '2:00'
    ])
    click(player.querySelector('[data-media-toggle]'))
    expect(commands().at(-1)).toEqual(['media.toggle', { tabId: 't1' }])
  })

  it('leaves when the core lets the lingering session go: the popover closes and the button leaves the row', async () => {
    await open(stateWith([track({ playing: false })]))
    expect(hub()).not.toBeNull()
    expect(q('[data-zen-media-hub-button]')).not.toBeNull()
    // The linger ran out (or the tab closed, or the element went): the core's list is empty.
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
    expect(uiStore.get().floatingChrome).toBe(0)
  })

  it('folds into the "⋯" menu at narrow widths as any entry does, and has nothing to fold once let go (§9.29)', () => {
    // The row's decision, from its width, is the same for a paused entry as for a playing one:
    // with the button off the row the menu request says folded (the "Media Controls…" row, no dot).
    expect(mediaHubFoldedAt(stateWith([track({ playing: false })]), false)).toBe(true)
    expect(mediaHubFoldedAt(stateWith([track({ playing: false })]), true)).toBe(false)
    expect(mediaHubFoldedAt(stateWith([]), false)).toBe(false)
  })

  it("puts the family's 16 between the row's artwork and its text (the #552 round's N2, from 12)", () => {
    expect(css).toMatch(/\.zen-mhub-now \{[^}]*gap: 16px;/)
    // The title pair's press fill reaches 8 into that 16 (its box `-8px` out, `8px` of padding
    // back), so the ink sits at the 16 and the fill 8 from the tile.
    expect(css).toMatch(/\.zen-mhub-text \{[^}]*margin: -4px -8px;[^}]*padding: 4px 8px;/)
  })

  /*
   * One paused control per session (§9.29 amended, the #552 ruling): the sidebar foot's old
   * mini player (`SidebarBottom`'s `MediaPlayer` card, one per entry of the same list before
   * this) reads the PLAYING set alone, so a session that paused or ended is told by the hub –
   * its button and popover – and nowhere else in the window; the card's retirement into the
   * hub is the follow-up slice. Mounted on the desktop (`Sidebar`) and on Android's tablet
   * layout (`TabletShell` → `Sidebar`), never on the phone, whose chip and sheet are their own.
   */
  function footState(entries: MediaState[]): UIState {
    return {
      ...stateWith(entries),
      capabilities: { windowControls: false, pictureInPicture: true },
      window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
      agents: [],
      settings: { sidebarExpanded: true, sidebarSide: 'left', toolbarLayout: 'single' }
    } as unknown as UIState
  }

  /** The foot's media cards: the panels carrying a Play / Pause and a Mute / Unmute. */
  function footCards(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('.zen-panel')].filter(
      (panel) =>
        panel.querySelector('button[aria-label="Play"], button[aria-label="Pause"]') &&
        panel.querySelector('button[aria-label="Mute"], button[aria-label="Unmute"]')
    )
  }

  function renderFoot(state: UIState): void {
    browserStore.set({ state })
    render(
      <>
        <MediaHubButton state={state} />
        <SidebarBottom state={state} compact={false} isDark={false} />
      </>
    )
  }

  it("a paused session shows in the hub's list and not in the mini player's: the foot reads the playing set alone (§9.29)", () => {
    const paused = footState([track({ playing: false })])
    renderFoot(paused)
    // The hub lists the paused session – its button in the row, bare of the dot, named paused…
    expect(mediaHubEntries(paused).map((m) => m.tabId)).toEqual(['t1'])
    const button = q('[data-zen-media-hub-button]')!
    expect(button).not.toBeNull()
    expect(button.querySelector('.zen-mhub-dot')).toBeNull()
    expect(button.getAttribute('aria-label')).toBe('Media controls · Paused')
    // …and the foot draws no card for it: one paused control per session, the hub's.
    expect(footCards()).toEqual([])

    // Playing, the card is the foot's as before, beside the button with its dot.
    const playing = footState([track()])
    renderFoot(playing)
    expect(footCards()).toHaveLength(1)
    expect(footCards()[0]!.querySelector('button[aria-label="Pause"]')).not.toBeNull()
    expect(footCards()[0]!.querySelector('button.truncate')!.textContent).toBe('Album – Music')
    expect(q('[data-zen-media-hub-button] .zen-mhub-dot')).not.toBeNull()

    // One playing, one paused: the hub lists both (the session first); the foot has the
    // playing tab's card alone.
    const both = footState([
      track({ tabId: 't2', title: 'A film', artist: '', video: true, session: false }),
      track({ playing: false })
    ])
    renderFoot(both)
    expect(mediaHubEntries(both).map((m) => m.tabId)).toEqual(['t1', 't2'])
    expect(footCards().map((card) => card.querySelector('button.truncate')!.textContent)).toEqual([
      'A film'
    ])
    expect(q('[data-zen-media-hub-button]')!.getAttribute('aria-label')).toBe(
      'Media controls, 1 playing'
    )

    // An ended track is a paused one to the foot too: no card, the hub's replay alone.
    const ended = footState([
      track({ playing: false, position: { duration: 120, position: 120, playbackRate: 1 } })
    ])
    renderFoot(ended)
    expect(footCards()).toEqual([])
    expect(q('[data-zen-media-hub-button]')).not.toBeNull()
  })
})

/*
 * The hub folded into the app menu (design language v2 §9.29): at the 240 sidebar the toolbar
 * button gives way to a "Media Controls…" row at the menu's top (the core's, `core/menus.ts`) and
 * the "⋯" menu button carries the hub's accent dot while something plays. The row's pick opens
 * this same popover from the "⋯" button, which then anchors it: placement, light dismiss and
 * the keyboard's return.
 */
describe('the hub from the app menu (§9.29)', () => {
  /** The "⋯" button in a 40 px bar across a 1024 window, in the bar's trailing half. */
  function mountMenuButton(): HTMLButtonElement {
    const bar = document.createElement('div')
    bar.setAttribute('data-bar', '')
    bar.setAttribute('data-mock-bar', '')
    bar.getBoundingClientRect = () =>
      ({ x: 0, y: 0, left: 0, top: 0, right: 1024, bottom: 40, width: 1024, height: 40 }) as DOMRect
    const button = document.createElement('button')
    button.setAttribute('data-zen-app-menu-button', '')
    button.getBoundingClientRect = () =>
      ({
        x: 980,
        y: 6,
        left: 980,
        top: 6,
        right: 1008,
        bottom: 34,
        width: 28,
        height: 28
      }) as DOMRect
    bar.appendChild(button)
    document.body.appendChild(bar)
    return button
  }

  afterEach(() => {
    document.querySelector('[data-mock-bar]')?.remove()
  })

  it('the dot lights while anything plays – the hub button’s own disc – and not otherwise', () => {
    render(<MediaLiveDot state={stateWith([])} />)
    expect(q('.zen-mhub-dot')).toBeNull()
    render(<MediaLiveDot state={stateWith([track({ playing: false })])} />)
    expect(q('.zen-mhub-dot')).toBeNull()
    render(<MediaLiveDot state={stateWith([track()])} />)
    const dot = q('.zen-mhub-dot')!
    expect(dot).not.toBeNull()
    expect(dot.getAttribute('aria-hidden')).toBe('true')
    // Media of a tab that is gone lights nothing.
    render(<MediaLiveDot state={stateWith([track({ tabId: 'closed' })])} />)
    expect(q('.zen-mhub-dot')).toBeNull()
  })

  /** Enough of a snapshot for the whole toolbar row (`NavRow`), the pill and its chips included. */
  function rowState(entries: MediaState[]): UIState {
    return {
      ...stateWith(entries),
      capabilities: { windowControls: false },
      settings: { urlbarBehavior: 'normal' },
      window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
      boosts: [],
      extensions: [],
      bookmarks: [],
      downloads: [],
      downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
      shortcuts: defaultShortcuts('linux', 'chrome'),
      blockedPopups: {},
      permissionRules: [],
      translate: { available: true, tabs: {} },
      securityPrompts: [],
      autofill: { prompts: [], picker: null }
    } as unknown as UIState
  }

  /**
   * A ResizeObserver whose notifications the test delivers (happy-dom lays nothing out): what
   * the row's own width observer (`useElementWidth`) receives as the sidebar is dragged.
   */
  class DeliverableResizeObserver {
    static readonly instances: DeliverableResizeObserver[] = []
    readonly targets = new Set<Element>()
    constructor(readonly callback: ResizeObserverCallback) {
      DeliverableResizeObserver.instances.push(this)
    }
    observe(target: Element): void {
      this.targets.add(target)
    }
    unobserve(target: Element): void {
      this.targets.delete(target)
    }
    disconnect(): void {
      this.targets.clear()
    }
  }

  /** The row's box changes to the sidebar's width less its 8 px gutters: one observer pass. */
  function sidebarDraggedTo(sidebar: number): void {
    const row = q('[data-zen-nav-row]')!
    const width = sidebar - 16
    act(() => {
      for (const observer of DeliverableResizeObserver.instances) {
        if (!observer.targets.has(row)) continue
        observer.callback(
          [{ target: row, contentRect: { width } } as unknown as ResizeObserverEntry],
          observer as unknown as ResizeObserver
        )
      }
    })
  }

  /** Run `fn` with the row's width observer deliverable by hand. */
  function withRowObserver(fn: () => void): void {
    const Native = window.ResizeObserver
    window.ResizeObserver = DeliverableResizeObserver as unknown as typeof ResizeObserver
    try {
      fn()
    } finally {
      window.ResizeObserver = Native
      DeliverableResizeObserver.instances.length = 0
    }
  }

  /** Every `.zen-mhub-dot` in the document and where it is: the hub button's or the ⋯ button's. */
  function dots(): string[] {
    return [...document.querySelectorAll('.zen-mhub-dot')].map((dot) =>
      dot.closest('[data-zen-media-hub-button]')
        ? 'hub'
        : dot.closest('[data-zen-app-menu-button]')
          ? 'menu'
          : '?'
    )
  }

  it('the fold is the row’s width’s to decide, from the same render as the button (§9.29)', () => {
    const state = rowState([track()])
    // The button up: the hub is not folded, whatever the document says.
    expect(mediaHubFoldedAt(state, true)).toBe(false)
    // The button off the row with media to control: folded.
    expect(mediaHubFoldedAt(state, false)).toBe(true)
    // No media at all: nothing has folded – ⋯ has nothing to wear or say.
    expect(mediaHubFoldedAt(rowState([]), false)).toBe(false)
    // Media of a tab that is gone is no media.
    expect(mediaHubFoldedAt(rowState([track({ tabId: 'closed' })]), false)).toBe(false)
  })

  it('the ⋯ button wears the dot and says so only while the hub button has folded: one dot at any width, moving with the row’s width observer (§9.29)', () => {
    withRowObserver(() => {
      const state = rowState([track()])
      render(<NavRow state={state} tab={music} compact={false} />)
      const menu = q('[data-zen-app-menu-button]')!
      // The row observed, the button not (its observer was the loop – see below).
      expect(
        DeliverableResizeObserver.instances.some((o) => o.targets.has(q('[data-zen-nav-row]')!))
      ).toBe(true)
      // The button up (every width until the tier folds it): the button's disc, ⋯ bare, its
      // name the tooltip's (a11y-26: the chord rides in the name, no native `title`).
      expect(dots()).toEqual(['hub'])
      expect(menu.getAttribute('data-tooltip')).toMatch(/^Menu \(.+\)$/)
      expect(menu.getAttribute('aria-label')).toBe(menu.getAttribute('data-tooltip'))
      expect(menu.hasAttribute('title')).toBe(false)
      sidebarDraggedTo(302)
      expect(dots()).toEqual(['hub'])
      // The sidebar dragged under 302: the tier folds the button in the row's observer pass,
      // and in that same commit ⋯ takes the disc and its name keeps the chord.
      sidebarDraggedTo(301)
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      expect(dots()).toEqual(['menu'])
      expect(menu.getAttribute('aria-label')).toBe(
        `${menu.getAttribute('data-tooltip')}, media playing`
      )
      // 270, where the star returns without the button, is still the folded side.
      sidebarDraggedTo(270)
      expect(dots()).toEqual(['menu'])
      sidebarDraggedTo(240)
      expect(dots()).toEqual(['menu'])
      // And back at 302: the button returns with its disc, ⋯ says nothing twice.
      sidebarDraggedTo(302)
      expect(q('[data-zen-media-hub-button]')).not.toBeNull()
      expect(dots()).toEqual(['hub'])
      expect(menu.getAttribute('aria-label')).toBe(menu.getAttribute('data-tooltip'))
    })
    // The dot is the accent of the window the buttons sit on, not the page family's.
    expect(css).toMatch(/\.zen-mhub-dot \{[^}]*background: var\(--zen-accent\);/)
    expect(css).not.toMatch(/\.zen-mhub-dot \{[^}]*--v2-accent/)
  })

  it('an update downloaded and waiting lights the same dot on ⋯ – Chrome’s dot on its ⋮ – and names it, taking the one dot over the hub’s while both would show (shortcuts-menus-101)', () => {
    const at = (state: UIState, phase: 'ready' | 'available'): UIState =>
      ({ ...state, updates: { phase } }) as unknown as UIState
    render(<NavRow state={at(rowState([]), 'ready')} tab={music} compact={false} />)
    const menu = q('[data-zen-app-menu-button]')!
    expect(dots()).toEqual(['menu'])
    expect(menu.querySelector('[data-testid="update-ready-dot"]')).not.toBeNull()
    expect(menu.getAttribute('aria-label')).toBe(
      `${menu.getAttribute('data-tooltip')}, update ready`
    )
    // Found but not downloaded: nothing on the button, as Chrome shows nothing on `available`.
    render(<NavRow state={at(rowState([]), 'available')} tab={music} compact={false} />)
    expect(dots()).toEqual([])
    expect(menu.getAttribute('aria-label')).toBe(menu.getAttribute('data-tooltip'))
    // Media playing with the hub button up: the button keeps its disc, ⋯ wears the update's.
    render(<NavRow state={at(rowState([track()]), 'ready')} tab={music} compact={false} />)
    expect(dots()).toEqual(['hub', 'menu'])
    // Folded (the 240 sidebar), both waiting: one dot on ⋯, the update's, and its name.
    withRowObserver(() => {
      render(
        <NavRow key="folded" state={at(rowState([track()]), 'ready')} tab={music} compact={false} />
      )
      sidebarDraggedTo(240)
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      expect(dots()).toEqual(['menu'])
      expect(q('[data-zen-app-menu-button]')!.getAttribute('aria-label')).toBe(
        `${q('[data-zen-app-menu-button]')!.getAttribute('data-tooltip')}, update ready`
      )
    })
  })

  it('re-reads the fold as the button comes and goes with the media, no resize needed', () => {
    render(<NavRow state={rowState([])} tab={music} compact={false} />)
    const menu = q('[data-zen-app-menu-button]')!
    expect(q('[data-zen-media-hub-button]')).toBeNull()
    expect(menu.querySelector('.zen-mhub-dot')).toBeNull()
    // A track starts: the button mounts in the same commit and takes the dot; ⋯ stays bare.
    render(<NavRow state={rowState([track()])} tab={music} compact={false} />)
    expect(q('[data-zen-media-hub-button] .zen-mhub-dot')).not.toBeNull()
    expect(menu.querySelector('.zen-mhub-dot')).toBeNull()
    // The media goes: the button leaves, and with nothing playing ⋯ has nothing to say.
    render(<NavRow state={rowState([])} tab={music} compact={false} />)
    expect(q('.zen-mhub-dot')).toBeNull()
  })

  it('folded and paused, neither button is lit and ⋯ says nothing of media – the menu’s "Media Controls…" row stands without the dot (§9.29, the #552 ruling); the document read says folded once the button is off the row', () => {
    withRowObserver(() => {
      render(<NavRow state={rowState([track({ playing: false })])} tab={music} compact={false} />)
      const hubButton = q('[data-zen-media-hub-button]')!
      expect(hubButton).not.toBeNull()
      expect(hubButton.getAttribute('aria-label')).toBe('Media controls · Paused')
      expect(mediaHubFolded()).toBe(false)
      sidebarDraggedTo(240)
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      expect(dots()).toEqual([])
      // ⋯ is named by its tooltip alone – no ", media playing": the dot and the words mark
      // playing, and a paused hour has neither. The row the menu carries is the core's
      // (`core/menus.ts`, "Media Controls…" – the button's own name, tested there); the menu
      // request says folded so the core builds it.
      const menu = q<HTMLButtonElement>('[data-zen-app-menu-button]')!
      expect(menu.getAttribute('aria-label')).toBe(menu.getAttribute('data-tooltip'))
      expect(menu.getAttribute('aria-label')).not.toContain('media')
      vi.mocked(run).mockClear()
      click(menu)
      expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
        'app.menu',
        expect.objectContaining({ mediaHubFolded: true })
      ])
      // What the menu request and the anchor read between renders agrees with the row.
      expect(mediaHubFolded()).toBe(true)
    })
    act(() => root!.unmount())
    root = null
    mount?.remove()
    expect(q('[data-zen-media-hub-button]')).toBeNull()
    expect(mediaHubFolded()).toBe(true)
  })

  it('the tier: the row unmounts the hub button at the 240 sidebar – ⋯ takes the dot and the menu request says folded – keeps it folded at 269, 270 and 301, and mounts it again at 302 (§9.29)', () => {
    // The row is the sidebar less its 8 px gutters each side; happy-dom lays nothing out, so the
    // width the row measures before its first paint is set here (the nav row alone – every
    // other box stays 0, as the pill's unmeasured content box shows every chip).
    const widths = { row: 240 - 16 }
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const width = this.hasAttribute('data-zen-nav-row') ? widths.row : 0
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect
    })
    try {
      const state = rowState([track()])
      render(<NavRow key="at-240" state={state} tab={music} compact={false} />)
      const menu = q<HTMLButtonElement>('[data-zen-app-menu-button]')!
      // Unmounted, not hidden: no box in the row for `checkVisibility` to find, so the fold
      // predicate, the dot and the menu's row agree without a stylesheet.
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      expect(mediaHubFolded()).toBe(true)
      expect(menu.querySelector('.zen-mhub-dot')).not.toBeNull()
      expect(menu.getAttribute('aria-label')).toBe(
        `${menu.getAttribute('data-tooltip')}, media playing`
      )
      vi.mocked(run).mockClear()
      click(menu)
      expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
        'app.menu',
        expect.objectContaining({ mediaHubFolded: true })
      ])
      // At 269 the row still has no room for it.
      widths.row = 269 - 16
      render(<NavRow key="at-269" state={state} tab={music} compact={false} />)
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      // At 270 the pill first reaches the star's 126 without the button; a button returning
      // here would take it straight back to 94, so the row keeps it folded and ⋯ keeps the dot.
      widths.row = 270 - 16
      render(<NavRow key="at-270" state={state} tab={music} compact={false} />)
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      expect(q('[data-zen-app-menu-button] .zen-mhub-dot')).not.toBeNull()
      // One pixel under 302 the pill with the button would be 125.
      widths.row = 301 - 16
      render(<NavRow key="at-301" state={state} tab={music} compact={false} />)
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      // At 302 the button returns over a 126 pill – the star up with it – with its own disc,
      // and ⋯ says nothing twice.
      widths.row = 302 - 16
      render(<NavRow key="at-302" state={state} tab={music} compact={false} />)
      const hubButton = q('[data-zen-media-hub-button]')!
      expect(hubButton).not.toBeNull()
      expect(hubButton.querySelector('.zen-mhub-dot')).not.toBeNull()
      const wideMenu = q<HTMLButtonElement>('[data-zen-app-menu-button]')!
      expect(wideMenu.querySelector('.zen-mhub-dot')).toBeNull()
      expect(wideMenu.getAttribute('aria-label')).toBe(wideMenu.getAttribute('data-tooltip'))
      // The compact column has no pill to keep: the button stays whatever the width.
      widths.row = 56
      render(<NavRow key="rail" state={state} tab={music} compact />)
      expect(q('[data-zen-media-hub-button]')).not.toBeNull()
    } finally {
      rects.mockRestore()
    }
  })

  /*
   * The row's width observer (`useElementWidth`) unmounts the hub button inside its own delivery
   * pass when the sidebar crosses 302 → 240; an observer on the button would then fire for the
   * detached node at depth 0, shallower than the pass, and Chromium would report "ResizeObserver
   * loop completed with undelivered notifications" on every crossing with media. The fold is
   * decided from the row's width in the render that moves the button (`mediaHubFoldedAt`).
   */
  it('keeps no ResizeObserver on the hub button: the row measures itself, the pill its content box, and the fold follows the row’s width', () => {
    const observed: Element[] = []
    const Native = window.ResizeObserver
    class RecordingResizeObserver {
      private readonly targets = new Set<Element>()
      observe(target: Element): void {
        this.targets.add(target)
        observed.push(target)
      }
      unobserve(target: Element): void {
        this.targets.delete(target)
      }
      disconnect(): void {
        this.targets.clear()
      }
    }
    window.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver
    try {
      render(<NavRow state={rowState([track()])} tab={music} compact={false} />)
      const hubButton = q('[data-zen-media-hub-button]')!
      expect(hubButton).not.toBeNull()
      expect(observed).not.toContain(hubButton)
      expect(observed.some((el) => el.hasAttribute('data-zen-nav-row'))).toBe(true)
      expect(observed.some((el) => el.hasAttribute('data-address-pill'))).toBe(true)
    } finally {
      window.ResizeObserver = Native
    }
  })

  it('the menu request carries the fold, so the core builds the row only for a folded button', () => {
    const state = rowState([track()])
    render(<NavRow state={state} tab={music} compact={false} />)
    const menu = q<HTMLButtonElement>('[data-zen-app-menu-button]')!
    vi.mocked(run).mockClear()
    click(menu)
    expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
      'app.menu',
      expect.objectContaining({ mediaHubFolded: false })
    ])
    q('[data-zen-media-hub-button]')!.style.display = 'none'
    click(menu)
    expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
      'app.menu',
      expect.objectContaining({ mediaHubFolded: true })
    ])
  })

  it('opens from the row’s pick hanging from the "⋯" button when the toolbar button has folded, with every player', async () => {
    const button = mountMenuButton()
    const state = stateWith([
      track(),
      track({ tabId: 't2', title: 'A film', video: true, session: false })
    ])
    browserStore.set({ state })
    // The folded row: no hub button in it, the layer alone.
    render(<MediaHubLayer />)
    expect(q('[data-zen-media-hub-button]')).toBeNull()
    act(() => openMediaHub({ fromKeyboard: true }))
    await settle()
    const popover = hub()!
    expect(popover).not.toBeNull()
    // Flush under the bar's bottom edge, end-aligned with the button (its trailing half): the
    // 400 popover's right edge on the button's.
    expect(popover.style.top).toBe('40px')
    expect(popover.style.left).toBe('608px')
    expect(popover.style.width).toBe('400px')
    // The whole hub, not one player: both cards and their transports.
    expect(document.querySelectorAll('[data-media-player]').length).toBe(2)
    expect(document.querySelectorAll('[data-media-transport]').length).toBe(2)
    // Escape puts the keyboard on the button the hub hung from.
    act(() => {
      popover.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(mediaHubUi.get().open).toBe(false)
    expect(hub()).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('still hangs from the toolbar button while that is in the row', async () => {
    mountMenuButton()
    const state = stateWith([track()])
    browserStore.set({ state })
    render(
      <>
        <MediaHubButton state={state} />
        <MediaHubLayer />
      </>
    )
    act(() => openMediaHub({ fromKeyboard: true }))
    await settle()
    expect(hub()).not.toBeNull()
    // Not the "⋯" button's box: the toolbar button (unmeasured here) is the anchor.
    expect(hub()!.style.top).not.toBe('40px')
    act(() => {
      hub()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(document.activeElement).toBe(q('[data-zen-media-hub-button]'))
  })

  it('hangs from the "⋯" button when the toolbar button is in the row but a stylesheet has folded it', async () => {
    const button = mountMenuButton()
    const state = stateWith([track()])
    browserStore.set({ state })
    render(
      <>
        <MediaHubButton state={state} />
        <MediaHubLayer />
      </>
    )
    // A width tier's fold from CSS rather than an unmount: the button is there without a box.
    const hubButton = q<HTMLElement>('[data-zen-media-hub-button]')!
    hubButton.style.display = 'none'
    expect(hubButton.checkVisibility()).toBe(false)
    act(() => openMediaHub({ fromKeyboard: true }))
    await settle()
    expect(hub()!.style.top).toBe('40px')
    expect(hub()!.style.left).toBe('608px')
    act(() => {
      hub()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(document.activeElement).toBe(button)
  })

  /*
   * The anchor pressed and saying what it has open for the popover's life (§9.20), whichever
   * control that is: the "⋯" too, while it anchors the folded hub – the toolbar button's own
   * `[aria-expanded='true']` rule is the fill, so the attribute is the whole of it.
   */
  it('the "⋯" says aria-expanded – and so wears the pressed fill – while it anchors the folded hub, and is bare again when the hub leaves (§9.20)', async () => {
    const button = mountMenuButton()
    expect(button.hasAttribute('aria-expanded')).toBe(false)
    browserStore.set({ state: stateWith([track()]) })
    render(<MediaHubLayer />)
    act(() => openMediaHub())
    await settle()
    expect(hub()).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    // The fill is the toolbar button's shared pressed rule, off the attribute alone.
    expect(css).toMatch(
      /\.zen-toolbar-button:active:not\(:disabled\),\s*\.zen-toolbar-button\[aria-expanded='true'\] \{[^}]*background: var\(--v2-window-fill-hover\)/
    )
    act(() => {
      hub()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(hub()).toBeNull()
    // Given back what it said at rest: nothing – the "⋯" carries no `aria-expanded` of its own.
    expect(button.hasAttribute('aria-expanded')).toBe(false)
  })

  it('one truth on the "⋯": expanded while either the app menu or the hub it anchors stands, whichever leaves first', async () => {
    const button = mountMenuButton()
    browserStore.set({ state: stateWith([track()]) })
    render(<MediaHubLayer />)
    // The app menu up (`MenuSheet`'s popover holds the button the same way), its "Media Controls…"
    // row picked: the hub opens as the menu leaves, and the menu's leave must take nothing off
    // the button that the hub still holds.
    const releaseMenu = holdExpanded(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    act(() => openMediaHub())
    await settle()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    releaseMenu()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    act(() => closeMediaHub())
    expect(hub()).toBeNull()
    expect(button.hasAttribute('aria-expanded')).toBe(false)

    // The other order: the menu opens over a standing hub and outlives it.
    act(() => openMediaHub())
    await settle()
    const releaseLater = holdExpanded(button)
    act(() => closeMediaHub())
    expect(hub()).toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    releaseLater()
    expect(button.hasAttribute('aria-expanded')).toBe(false)
    // A release is one release: a second call from the same holder counts for nothing.
    const once = holdExpanded(button)
    holdExpanded(button)
    once()
    once()
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })

  it('the hold moves with the anchor: a push that takes the hub button off the row hands it to the "⋯", which lets go with the hub', async () => {
    const button = mountMenuButton()
    const state = stateWith([track()])
    browserStore.set({ state })
    render(
      <>
        <MediaHubButton state={state} />
        <MediaHubLayer />
      </>
    )
    act(() => openMediaHub())
    await settle()
    const hubButton = q('[data-zen-media-hub-button]')!
    expect(hubButton.getAttribute('aria-expanded')).toBe('true')
    expect(button.hasAttribute('aria-expanded')).toBe(false)
    // The row remounts its buttons with the tab: the same push that folds the hub button moves
    // the anchor, read after that commit as the placement is.
    const next = stateWith([track({ positionAt: Date.now() + 1 })])
    act(() => {
      browserStore.set({ state: next })
      root!.render(
        <>
          {null}
          <MediaHubLayer />
        </>
      )
    })
    expect(q('[data-zen-media-hub-button]')).toBeNull()
    expect(hub()).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    // The button that left was given its rest state back, not left saying "true" for nothing.
    expect(hubButton.getAttribute('aria-expanded')).toBe('false')
    act(() => closeMediaHub())
    expect(button.hasAttribute('aria-expanded')).toBe(false)
  })

  it('the hold follows the row’s fold with no push behind it: the sidebar dragged across 302 with the hub open hands aria-expanded ⋯ → button in the row’s observer pass, and back – never both, never neither (§9.20, §9.29)', async () => {
    const Native = window.ResizeObserver
    window.ResizeObserver = DeliverableResizeObserver as unknown as typeof ResizeObserver
    // The row at the 240 sidebar (happy-dom lays nothing out: the row's first measure is set
    // here, every other box 0 – the pill's unmeasured content box shows every chip).
    const widths = { row: 240 - 16 }
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const width = this.hasAttribute('data-zen-nav-row') ? widths.row : 0
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, width, height: 0 } as DOMRect
    })
    try {
      const state = rowState([track()])
      browserStore.set({ state })
      render(
        <>
          <NavRow state={state} tab={music} compact={false} />
          <MediaHubLayer />
        </>
      )
      const menu = q<HTMLButtonElement>('[data-zen-app-menu-button]')!
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      expect(mediaHubUi.get().buttonUp).toBe(false)
      act(() => openMediaHub())
      await settle()
      expect(hub()).not.toBeNull()
      // Folded: the "⋯" anchors the hub and says so.
      expect(menu.getAttribute('aria-expanded')).toBe('true')
      // Dragged out to 302: the row's observer pass mounts the button, and the row's word on
      // it (`mediaHubUi.buttonUp`, from that commit's layout phase) has the popover read its
      // anchor again in the same act – the button takes the hold, the "⋯" is bare, no push.
      widths.row = 302 - 16
      sidebarDraggedTo(302)
      const hubButton = q<HTMLButtonElement>('[data-zen-media-hub-button]')!
      expect(hubButton).not.toBeNull()
      expect(mediaHubUi.get().buttonUp).toBe(true)
      expect(hubButton.getAttribute('aria-expanded')).toBe('true')
      expect(menu.hasAttribute('aria-expanded')).toBe(false)
      expect(hub()).not.toBeNull()
      // A step wider: nothing folds, so the hold stays where it is.
      widths.row = 320 - 16
      sidebarDraggedTo(320)
      expect(hubButton.getAttribute('aria-expanded')).toBe('true')
      expect(menu.hasAttribute('aria-expanded')).toBe(false)
      // And back under 302: the button leaves with its rest state given back, and the "⋯" takes
      // the hold in the pass that unmounts it.
      widths.row = 301 - 16
      sidebarDraggedTo(301)
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      expect(mediaHubUi.get().buttonUp).toBe(false)
      expect(hubButton.getAttribute('aria-expanded')).toBe('false')
      expect(menu.getAttribute('aria-expanded')).toBe('true')
      expect(hub()).not.toBeNull()
      // The hub leaving lets go of the "⋯".
      act(() => closeMediaHub())
      expect(menu.hasAttribute('aria-expanded')).toBe(false)
    } finally {
      rects.mockRestore()
      window.ResizeObserver = Native
      DeliverableResizeObserver.instances.length = 0
    }
  })
})
