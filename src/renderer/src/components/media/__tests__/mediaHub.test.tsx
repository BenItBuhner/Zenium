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
import { mediaHubFolded, mediaHubUi, openMediaHub } from '@renderer/lib/mediaHub'
import { closeAllPopovers } from '@renderer/lib/portals'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { MediaHubButton, MediaLiveDot } from '../MediaHubButton'
import { MediaHubLayer } from '../MediaHubPopover'
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
 * The hub folded into the app menu (design language v2 §9.29): at the 240 sidebar the toolbar
 * button gives way to a "Now Playing" row at the menu's top (the core's, `core/menus.ts`) and
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
      translate: { available: true, tabs: {} },
      securityPrompts: [],
      autofill: { prompts: [], picker: null }
    } as unknown as UIState
  }

  /** The row re-reads the fold as the window does on a resize (the tier's box change). */
  function resized(): void {
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
  }

  it('the ⋯ button wears the dot and says so only while the hub button has folded: one dot at any width (§9.29)', () => {
    const state = rowState([track()])
    render(<NavRow state={state} tab={music} compact={false} />)
    const hubButton = q('[data-zen-media-hub-button]')!
    const menu = q('[data-zen-app-menu-button]')!
    // The button up (every width until the tier folds it): the button's disc, ⋯ bare, its name
    // the title's.
    expect(hubButton.querySelector('.zen-mhub-dot')).not.toBeNull()
    expect(menu.querySelector('.zen-mhub-dot')).toBeNull()
    expect(menu.getAttribute('aria-label')).toBeNull()
    expect(menu.getAttribute('title')).toMatch(/^Menu \(.+\)$/)
    // The tier folds the button by stylesheet: the disc moves to ⋯, whose name keeps the chord.
    hubButton.style.display = 'none'
    resized()
    expect(menu.querySelector('.zen-mhub-dot')).not.toBeNull()
    expect(menu.getAttribute('aria-label')).toBe(`${menu.getAttribute('title')}, media playing`)
    // And back at 270.
    hubButton.style.display = ''
    resized()
    expect(menu.querySelector('.zen-mhub-dot')).toBeNull()
    expect(menu.getAttribute('aria-label')).toBeNull()
    // The dot is the accent of the window the buttons sit on, not the page family's.
    expect(css).toMatch(/\.zen-mhub-dot \{[^}]*background: var\(--zen-accent\);/)
    expect(css).not.toMatch(/\.zen-mhub-dot \{[^}]*--v2-accent/)
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

  it('folded and paused, neither button is lit; folded by an unmount, ⋯ takes the dot too', () => {
    render(<NavRow state={rowState([track({ playing: false })])} tab={music} compact={false} />)
    q('[data-zen-media-hub-button]')!.style.display = 'none'
    resized()
    expect(q('.zen-mhub-dot')).toBeNull()
    // The tier may take the button out of the row altogether: a row without it is folded.
    expect(mediaHubFolded()).toBe(true)
    act(() => root!.unmount())
    root = null
    mount?.remove()
    expect(q('[data-zen-media-hub-button]')).toBeNull()
    expect(mediaHubFolded()).toBe(true)
  })

  it('the tier: the row unmounts the hub button at the 240 sidebar – ⋯ takes the dot and the menu request says folded – and mounts it again at 270 (§9.29)', () => {
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
      expect(menu.getAttribute('aria-label')).toBe(`${menu.getAttribute('title')}, media playing`)
      vi.mocked(run).mockClear()
      click(menu)
      expect(vi.mocked(run).mock.calls.at(-1)).toEqual([
        'app.menu',
        expect.objectContaining({ mediaHubFolded: true })
      ])
      // One pixel under 270 the row still has no room for it.
      widths.row = 269 - 16
      render(<NavRow key="at-269" state={state} tab={music} compact={false} />)
      expect(q('[data-zen-media-hub-button]')).toBeNull()
      // At 270 the button returns with its own disc, and ⋯ says nothing twice.
      widths.row = 270 - 16
      render(<NavRow key="at-270" state={state} tab={music} compact={false} />)
      const hubButton = q('[data-zen-media-hub-button]')!
      expect(hubButton).not.toBeNull()
      expect(hubButton.querySelector('.zen-mhub-dot')).not.toBeNull()
      const wideMenu = q<HTMLButtonElement>('[data-zen-app-menu-button]')!
      expect(wideMenu.querySelector('.zen-mhub-dot')).toBeNull()
      expect(wideMenu.getAttribute('aria-label')).toBeNull()
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
   * pass when the sidebar crosses 270 → 240; an observer on the button would then fire for the
   * detached node at depth 0, shallower than the pass, and Chromium would report "ResizeObserver
   * loop completed with undelivered notifications" on every crossing with media. The fold is
   * re-read from the DOM after each commit and on the window's resize instead.
   */
  it('keeps no ResizeObserver on the hub button: the row measures itself, the pill its content box, and the fold is read from the DOM', () => {
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
})
