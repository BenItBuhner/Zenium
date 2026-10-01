// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Globe, WifiOff } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import type { UiState } from '@renderer/lib/ui'
import { BLANK_URL } from '@shared/url'

/*
 * The desktop's host for the page-edge band (motion spec §3.2, §3.4, §10; content/PageBandHost.tsx):
 * what it tells the model of the frame – the tab in front and its scene, whether a band may
 * stand on it at all (a tab's page: not the empty frame, a page shown in another window, a
 * fullscreen), whether offers may (a page of the web alone: not the new tab page, the blank page
 * or a chrome page – `isBandPageUrl`'s allow-list – and not a private tab; a STATE stands on all
 * of those), what covers the page (a chrome overlay, a frame dialog, the URL bar, Web capture,
 * the gesture stage: a new band waits, a standing one stays) – how it fills the band's seam: the
 * page's offset to the core per frame (`layout.pageOffset`), the seat for the layout reporter at
 * the lesser of the seat and the destination on a departure and at the height at the rest
 * (`lib/pageBand.ts`), unseated at a drag's first frame below it (no departure announced – the
 * page keeps covering the frame under it, as Android's host keeps its layer; W8-M2b), and a cut
 * – no travel – when the frame's page changes; and what the tabs
 * tell the model (a tab closing, a document changing). Its tenants: the default-browser state
 * stands while the OS names another browser; the crash-restore state while the session holds the
 * last run's pages for an answer. With the band it mounts the two corner masks that ride the
 * page's offset (`PageBandCorners`; W8-M2c): the frame's radius at the top corners of a page
 * the chrome draws under the band, hidden at home, taking no pointer.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: vi.fn(async () => null),
  onEvent: () => () => undefined
}))

const { PageBandHost } = await import('../PageBandHost')
const { PageBandLayer } = await import('../PageBandLayer')
const { BAND_HEIGHT_ONE_LINE, BAND_HEIGHT_TWO_LINE } = await import('@renderer/lib/motion/band')
const { framesPending } = await import('@renderer/lib/motion/clock')
const { bandStore, chooseBand, dismissBandByKey, resetBands, showBand } =
  await import('@renderer/lib/band')
type BandDismissReason = import('@renderer/lib/band').BandDismissReason
const {
  bandOffset,
  bandSeat,
  bandSeatStore,
  layoutBand,
  moveChromePage,
  movePage,
  resetChromePageBand,
  resetPageBand,
  seatBand,
  seatChromePage
} = await import('@renderer/lib/pageBand')
const { uiStore } = await import('@renderer/lib/ui')

const FRAME_MS = 16

/** The host's animation frame with a clock: `tick()` fires the frames in flight 16 ms later. */
function clockedFrames(): { tick: (n?: number) => void } {
  const pending = new Map<number, FrameRequestCallback>()
  let id = 0
  let now = 1000
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending.set(++id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (n: number) => pending.delete(n))
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  return {
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) {
        now += FRAME_MS
        const batch = [...pending.values()]
        pending.clear()
        act(() => {
          for (const cb of batch) cb(now)
        })
      }
    }
  }
}

function tab(id: string, url: string, containerId = 'default'): Tab {
  return { id, spaceId: 'space', containerId, url, title: id, loading: false } as unknown as Tab
}

const TABS: Record<string, Tab> = {
  page: tab('page', 'https://example.com/'),
  other: tab('other', 'https://other.example/'),
  blank: tab('blank', BLANK_URL),
  // The new tab page as a load leaves it, and the blank page as Chromium reports it loaded.
  ntp: tab('ntp', 'zen://newtab/'),
  loadedBlank: tab('loadedBlank', `${BLANK_URL}/`),
  settings: tab('settings', 'zen://settings'),
  // The documents the chrome serves in the frame: chrome pages to the band all the same.
  version: tab('version', 'zen://version'),
  game: tab('game', 'zen://game'),
  secret: tab('secret', 'https://secret.example/', 'private')
}

interface Scene {
  front?: string | null
  fullscreen?: boolean
  htmlFullscreenTabId?: string | null
  foreign?: string[]
  tabs?: Record<string, Tab>
}

/** A desktop window on a page tab; the state tenants quiet unless a scene asks for one. */
function state({
  front = 'page',
  fullscreen = false,
  htmlFullscreenTabId = null,
  foreign = [],
  tabs = TABS
}: Scene = {}): UIState {
  return {
    platform: 'linux',
    version: '0.3.77',
    crashRestore: null,
    tabs,
    spaces: [
      {
        id: 'space',
        name: 'Work',
        containerId: 'default',
        tabIds: Object.keys(tabs),
        activeTabId: front
      }
    ],
    activeSpaceId: 'space',
    essentialTabIds: [],
    foreignTabIds: foreign,
    settings: { defaultBrowserPromptDismissed: null, onboardingDone: true },
    capabilities: { defaultBrowser: true },
    defaultBrowser: { isDefault: true, prompt: null },
    window: { kind: 'normal', fullscreen, htmlFullscreenTabId }
  } as unknown as UIState
}

/** The chrome's UI state with nothing over the page, then what a scene puts over it. */
function ui(patch: Partial<UiState> = {}): UiState {
  return { ...uiStore.get(), ...patch }
}

let root: Root | null = null
let mount: HTMLDivElement | null = null
let frames: ReturnType<typeof clockedFrames>

function render(s: UIState, u: UiState = ui()): void {
  act(() => {
    root!.render(<PageBandHost state={s} ui={u} />)
  })
}

/**
 * The host with the layer a chrome page rides on, as `ContentArea` mounts them on a chrome page
 * (`InternalPageHost` inside `PageBandLayer`, where the band is hosted; a page of the web has a
 * view the core moves, and no layer).
 */
function renderWithLayer(s: UIState): void {
  act(() => {
    root!.render(
      <>
        <PageBandHost state={s} ui={ui()} />
        <PageBandLayer>
          <div data-testid="chrome-page" />
        </PageBandLayer>
      </>
    )
  })
}
const layer = (): HTMLElement => mount!.querySelector<HTMLElement>('[data-band-layer]')!
/** The two corner masks the host mounts with the band (`PageBandCorners`), or null without the host. */
const corners = (): HTMLElement | null => mount!.querySelector<HTMLElement>('[data-band-corners]')

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')
/** The first rule at `selector` in main.css, comments and runs of whitespace gone. */
const rule = (selector: string): string => {
  const at = bare.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return bare.slice(at, bare.indexOf('}', at))
}

/** Run the clock until it goes idle (the spring rested) or `limit` frames pass. */
function settle(limit = 200): void {
  let n = 0
  while (framesPending() > 0 && n < limit) {
    frames.tick()
    n++
  }
}

const band = (): HTMLElement | null => mount!.querySelector('.zen-band')
/** The host's word in the model: the frame, and whether a band may stand on it. */
const model = (): {
  front: string | null
  scene: string | null
  ok: boolean
  offers: boolean
  covered: boolean
} => {
  const { front, scene, ok, offers, covered } = bandStore.get()
  return { front, scene, ok, offers, covered }
}
const standing = (): string | null => chooseBand(bandStore.get())?.key ?? null
/** The page offsets the core heard (`layout.pageOffset`), in order. */
const offsets = (): number[] =>
  run.mock.calls
    .filter(([c]) => c === 'layout.pageOffset')
    .map(([, a]) => (a as { offset: number }).offset)

/**
 * The seats written from here on, in order – each one a layout of the page under the band
 * (the layout reporter lays out on the seat store's every change).
 */
function seats(): { written: number[]; off: () => void } {
  const written: number[] = []
  const off = bandSeatStore.subscribe(() => written.push(bandSeat()))
  return { written, off }
}

const MOUSE = 7
const HOLD = { x: 200, y: 30 }

/**
 * A mouse on the band, as `useSwipeDismiss` hears it: `down` takes hold where the band is,
 * `move(dy)` is the pointer `dy` px (negative up) from there, `up` lets go. happy-dom has no
 * pointer capture, so the band's take and release of it are stubbed not to throw.
 */
function mouse(): { down: () => void; move: (dy: number) => void; up: (dy: number) => void } {
  const captured = new Set<number>()
  const at = (type: string, dy: number): void => {
    const el = band()!
    el.setPointerCapture = (id: number) => {
      captured.add(id)
    }
    el.releasePointerCapture = (id: number) => {
      captured.delete(id)
    }
    el.hasPointerCapture = (id: number) => captured.has(id)
    act(() => {
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: MOUSE,
          pointerType: 'mouse',
          button: 0,
          clientX: HOLD.x,
          clientY: HOLD.y + dy
        })
      )
    })
  }
  return {
    down: () => at('pointerdown', 0),
    move: (dy) => at('pointermove', dy),
    up: (dy) => at('pointerup', dy)
  }
}

const offline = (tabId: string | null = null): number =>
  showBand({
    key: 'connectivity',
    form: 'state',
    tone: 'warn',
    icon: WifiOff,
    tabId,
    title: 'You are offline',
    detail: 'Pages you open may be out of date'
  })

const offer = (tabId: string | null = 'page', onDismiss?: (r: BandDismissReason) => void): number =>
  showBand({
    key: `install:${tabId ?? 'window'}`,
    form: 'offer',
    icon: Globe,
    tabId,
    title: 'Install Example',
    onDismiss
  })

beforeEach(() => {
  vi.useFakeTimers()
  frames = clockedFrames()
  run.mockClear()
  resetBands()
  resetPageBand()
  resetChromePageBand()
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  resetBands()
  resetPageBand()
  resetChromePageBand()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('PageBandHost – what the frame shows (motion spec §3.2, §10)', () => {
  it('a page tab in front welcomes a band and its offers; the empty frame, a page shown in another window and a fullscreen take none; the blank page, the new tab page and the chrome pages – every zen:// page, the version page and the game included – take a state and withhold offers (the Design Lead’s §10 change) – each a scene of its own', () => {
    render(state())
    expect(model()).toEqual({
      front: 'page',
      scene: 'page:::',
      ok: true,
      offers: true,
      covered: false
    })
    // The empty frame is chrome: no tab, no band at all.
    render(state({ front: null }))
    expect(model()).toMatchObject({ front: null, scene: ':::', ok: false, offers: false })
    // The blank page and the new tab page – `zen://newtab/` once loaded, the blank page with
    // the slash a load adds – are chrome pages: a state stands on them (the strip the band
    // retired stood on the new tab page), an offer never does.
    render(state({ front: 'blank' }))
    expect(model()).toMatchObject({ front: 'blank', ok: true, offers: false })
    render(state({ front: 'ntp' }))
    expect(model()).toMatchObject({ front: 'ntp', ok: true, offers: false })
    render(state({ front: 'loadedBlank' }))
    expect(model()).toMatchObject({ front: 'loadedBlank', ok: true, offers: false })
    render(state({ front: 'settings' }))
    expect(model()).toMatchObject({ front: 'settings', ok: true, offers: false })
    // Every `zen://` page is a chrome page to the band (the Design Lead's ruling on #740): the
    // version page and the game are documents the chrome serves in the frame, and offers stand
    // on neither – states do.
    render(state({ front: 'version' }))
    expect(model()).toMatchObject({ front: 'version', ok: true, offers: false })
    render(state({ front: 'game' }))
    expect(model()).toMatchObject({ front: 'game', ok: true, offers: false })
    // What stands around the page withholds the band whole: another window showing the page,
    // the window's fullscreen, a page's.
    render(state({ foreign: ['page'] }))
    expect(model()).toMatchObject({ scene: 'page:::foreign', ok: false })
    render(state({ fullscreen: true }))
    expect(model()).toMatchObject({ scene: 'page::fullscreen:', ok: false })
    render(state({ htmlFullscreenTabId: 'page' }))
    expect(model()).toMatchObject({ scene: 'page:page-fullscreen::', ok: false })
    render(state())
    expect(model()).toMatchObject({ scene: 'page:::', ok: true, offers: true })
  })

  it('on the new tab page and on zen://version a state stands and an offer is withheld – the offer waits, and stands when a page of the web is in front (§10)', () => {
    // A window-wide state and a tab-scoped offer on each chrome page.
    offline()
    offer('ntp')
    offer('version')
    render(state({ front: 'ntp' }))
    expect(model()).toMatchObject({ front: 'ntp', ok: true, offers: false })
    expect(standing()).toBe('connectivity')
    expect(band()!.querySelector('.zen-band-title')!.textContent).toBe('You are offline')
    settle()
    expect(bandSeat()).toBe(BAND_HEIGHT_TWO_LINE)
    // The state gone, the offer does not take its place on a chrome page: the band leaves.
    act(() => dismissBandByKey('connectivity'))
    expect(standing()).toBeNull()
    settle()
    expect(band()).toBeNull()
    expect(bandSeat()).toBe(0)
    // The version page the same: the offer about it waits, a state shows.
    render(state({ front: 'version' }))
    expect(model()).toMatchObject({ front: 'version', ok: true, offers: false })
    expect(standing()).toBeNull()
    offline()
    expect(standing()).toBe('connectivity')
    // A page of the web in front: offers may stand – the state still first (§3.2).
    offer('page')
    render(state())
    expect(model()).toMatchObject({ front: 'page', ok: true, offers: true })
    expect(standing()).toBe('connectivity')
    act(() => dismissBandByKey('connectivity'))
    expect(standing()).toBe('install:page')
    // Back on the new tab page the page's offer is not the frame's, and no offer stands there.
    render(state({ front: 'ntp' }))
    expect(standing()).toBeNull()
    expect(bandStore.get().entries.map((e) => e.key)).toEqual([
      'install:page',
      'install:version',
      'install:ntp'
    ])
  })

  it('a private tab takes states and withholds offers (§3.2)', () => {
    offline()
    offer('secret')
    render(state({ front: 'secret' }))
    expect(model()).toMatchObject({ front: 'secret', ok: true, offers: false })
    expect(standing()).toBe('connectivity')
    expect(band()!.querySelector('.zen-band-title')!.textContent).toBe('You are offline')
  })

  it('the new tab page takes a state and withholds an offer, which waits for a page (item 8)', () => {
    offer('ntp')
    render(state({ front: 'ntp' }))
    expect(standing()).toBeNull()
    expect(band()).toBeNull()
    act(() => {
      offline()
    })
    expect(standing()).toBe('connectivity')
    expect(band()!.querySelector('.zen-band-title')!.textContent).toBe('You are offline')
  })

  it('a chrome overlay, a frame dialog, the URL bar, Web capture and the gesture stage cover the page: a new band waits, a standing one stays', () => {
    const covers: Array<Partial<UiState>> = [
      { overlay: 'settings' as UiState['overlay'] },
      { frameDialogsOpen: 1 },
      { urlbar: { ...uiStore.get().urlbar, open: true } },
      { capture: { tabId: 'page', viewport: null, seq: 1 } },
      { stageActive: true }
    ]
    for (const cover of covers) {
      resetBands()
      render(state(), ui(cover))
      expect(model().covered, JSON.stringify(cover)).toBe(true)
      offline()
      expect(standing(), JSON.stringify(cover)).toBeNull()
      expect(band(), JSON.stringify(cover)).toBeNull()
      // The cover goes: the band that waited comes.
      render(state(), ui())
      expect(model().covered).toBe(false)
      expect(band()).not.toBeNull()
      // Standing, it stays under the cover coming back over it – no stacking, no leave.
      render(state(), ui(cover))
      expect(standing(), JSON.stringify(cover)).toBe('connectivity')
      expect(band(), JSON.stringify(cover)).not.toBeNull()
      settle()
      act(() => root!.render(null))
    }
  })
})

describe('PageBandHost – what the tabs tell the model (motion spec §3.2)', () => {
  it('a tab closing takes its bands; a new document committing dismisses them on "navigation"; a same-document navigation – a pushState to another path, a hash change – and another tab’s change do not (the Design Lead’s ruling on #740)', () => {
    const heard: Array<[string, BandDismissReason]> = []
    /** The page tab as the core shows it after `generation` documents committed, at `url`. */
    const pageAt = (url: string, generation: number): Tab => ({
      ...tab('page', url),
      documentGeneration: generation
    })
    const tabs = { ...TABS, page: pageAt('https://example.com/', 1) }
    render(state({ tabs }))
    offer('page', (r) => heard.push(['page', r]))
    offer('other', (r) => heard.push(['other', r]))
    offline()
    expect(standing()).toBe('connectivity')
    // The fragment moves: the same document.
    render(state({ tabs: { ...tabs, page: pageAt('https://example.com/#section', 1) } }))
    expect(heard).toEqual([])
    // A `pushState` to another path: the address is another, the document the same – the host
    // reported a same-document commit, and the core left the generation where it was. The band
    // stands (a feed rewriting its address as it scrolls is the very case).
    render(state({ tabs: { ...tabs, page: pageAt('https://example.com/feed/page-2', 1) } }))
    expect(heard).toEqual([])
    // The other tab's progress and title change under the same URL: nothing.
    render(state({ tabs: { ...tabs, other: { ...TABS.other, loading: true, title: 'Other' } } }))
    expect(heard).toEqual([])
    // A new document commits – the page reloaded at its own address, as the host reports it:
    // the offer goes on `navigation`; the window-wide state stands.
    render(state({ tabs: { ...tabs, page: pageAt('https://example.com/feed/page-2', 2) } }))
    expect(heard).toEqual([['page', 'navigation']])
    expect(standing()).toBe('connectivity')
    // And a new document at another address, the plain navigation, the same way.
    offer('page', (r) => heard.push(['page', r]))
    render(state({ tabs: { ...tabs, page: pageAt('https://example.com/next', 3) } }))
    expect(heard).toEqual([
      ['page', 'navigation'],
      ['page', 'navigation']
    ])
    // The other tab closes: its band goes with it, not the user's doing.
    const rest = Object.fromEntries(Object.entries(tabs).filter(([id]) => id !== 'other'))
    render(state({ tabs: rest }))
    expect(heard).toEqual([
      ['page', 'navigation'],
      ['page', 'navigation'],
      ['other', 'program']
    ])
    expect(bandStore.get().entries.map((e) => e.key)).toEqual(['connectivity'])
  })
})

describe('PageBandHost – the seam to the page (motion spec §3.4, §6)', () => {
  it('an open: nothing seated while the page travels at full height, the offset to the core per frame, the seat at the rest', () => {
    offline()
    render(state())
    expect(bandSeat()).toBe(0)
    expect(offsets()).toEqual([])
    frames.tick(3)
    expect(offsets()).toHaveLength(3)
    expect(bandSeat()).toBe(0)
    settle()
    expect(offsets().at(-1)).toBe(BAND_HEIGHT_TWO_LINE)
    expect(bandSeat()).toBe(BAND_HEIGHT_TWO_LINE)
    expect(band()!.style.getPropertyValue('--zen-band-height')).toBe(`${BAND_HEIGHT_TWO_LINE}px`)
  })

  it('a leave: the seat goes to 0 as the travel begins, the page comes home per frame, and the band is gone at the rest', () => {
    const id = offline()
    render(state())
    settle()
    run.mockClear()
    act(() => {
      bandStore.set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }))
    })
    expect(bandSeat()).toBe(0)
    expect(band()).not.toBeNull()
    settle()
    expect(offsets().at(-1)).toBe(0)
    expect(band()).toBeNull()
  })

  it('a tenant swap re-targets the height: growing keeps the seat until the rest, shrinking seats the lesser height at once', () => {
    const id = showBand({ key: 'k1', form: 'state', icon: Globe, title: 'One line' })
    render(state())
    settle()
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    offline()
    render(state())
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    settle()
    expect(bandSeat()).toBe(BAND_HEIGHT_TWO_LINE)
    act(() => {
      bandStore.set((s) => ({ entries: s.entries.filter((e) => e.key !== 'connectivity') }))
    })
    render(state())
    expect(chooseBand(bandStore.get())!.id).toBe(id)
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    settle()
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    expect(offsets().at(-1)).toBe(BAND_HEIGHT_ONE_LINE)
  })

  it('the frame’s page changing is a cut: the band of one tab goes at once as another comes to the front, and stands again at once on the return', () => {
    offline('page')
    render(state())
    settle()
    run.mockClear()
    // Another tab in front: the connectivity band is the page tab's, so it goes – no travel.
    render(state({ front: 'other' }))
    expect(band()).toBeNull()
    expect(bandSeat()).toBe(0)
    expect(offsets()).toEqual([0])
    expect(framesPending()).toBe(0)
    // Back: it stands again where it stood, the page under it at once.
    run.mockClear()
    render(state())
    expect(band()).not.toBeNull()
    expect(bandSeat()).toBe(BAND_HEIGHT_TWO_LINE)
    expect(offsets()).toEqual([BAND_HEIGHT_TWO_LINE])
    expect(framesPending()).toBe(0)
  })

  it('a page going fullscreen under a window-wide band cuts the band away, and its exit brings the band back without a travel', () => {
    offline()
    render(state())
    settle()
    run.mockClear()
    render(state({ htmlFullscreenTabId: 'page' }))
    expect(band()).toBeNull()
    expect(bandSeat()).toBe(0)
    expect(offsets()).toEqual([0])
    render(state())
    expect(band()).not.toBeNull()
    expect(bandSeat()).toBe(BAND_HEIGHT_TWO_LINE)
    expect(framesPending()).toBe(0)
  })
})

describe('PageBandHost – a drag on the seated band (motion spec §3.4; W8-M2b)', () => {
  const H = BAND_HEIGHT_TWO_LINE

  it("a drag's first frame below the seat unseats the band – seat 0, the offset the frame's, the report { seat: 0, offset } – one relayout at the drag's start and none per frame after; the page the chrome draws rides full-frame, translated by the offset, never a bare strip under it", () => {
    offline()
    renderWithLayer(state({ front: 'settings' }))
    settle()
    const el = layer()
    expect(layoutBand()).toEqual({ seat: H, offset: H })
    expect(el.style.top).toBe(`${H}px`)
    expect(el.style.transform).toBe('')
    run.mockClear()
    const { written, off } = seats()
    const m = mouse()
    // Taking hold moves nothing: the pointer has not left the slop circle.
    m.down()
    expect(written).toEqual([])
    expect(offsets()).toEqual([])
    // The first frame below the seat, no departure announced: the band is unseated before the
    // page is moved – the seat 0, the offset the frame's own – and the layout reporter's word
    // is the same pair. The layer's box is the whole frame again, translated by the offset: the
    // page covers the frame under it to its bottom.
    m.move(-20)
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(H - 20)
    expect(offsets()).toEqual([H - 20])
    expect(layoutBand()).toEqual({ seat: 0, offset: H - 20 })
    expect(written).toEqual([0])
    expect(el.style.top).toBe('')
    expect(el.style.transform).toBe(`translateY(${H - 20}px)`)
    // The frames after it move the page alone: no seat written, no layout.
    m.move(-30)
    m.move(-35)
    expect(offsets()).toEqual([H - 20, H - 30, H - 35])
    expect(layoutBand()).toEqual({ seat: 0, offset: H - 35 })
    expect(written).toEqual([0])
    expect(el.style.transform).toBe(`translateY(${H - 35}px)`)
    off()
  })

  it('a travel is as it was: the departure seats the lesser of the seat and the destination, its frames – below the seat too – write no seat, the rest seats the height; one layout per travel', () => {
    offline()
    render(state())
    settle()
    const { written, off } = seats()
    // 76 → 56, the two-line state giving way to a one-line one: the departure seats 56 – the
    // one layout – and the frames down to it (a travel's, whatever their place against the
    // seat) leave it; the rest holds it.
    const id = showBand({ key: 'k1', form: 'state', icon: Globe, title: 'One line' })
    act(() => {
      bandStore.set((s) => ({ entries: s.entries.filter((e) => e.key !== 'connectivity') }))
    })
    render(state())
    expect(chooseBand(bandStore.get())!.id).toBe(id)
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    expect(written).toEqual([BAND_HEIGHT_ONE_LINE])
    while (framesPending() > 0) {
      frames.tick()
      expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    }
    expect(bandOffset()).toBe(BAND_HEIGHT_ONE_LINE)
    expect(written).toEqual([BAND_HEIGHT_ONE_LINE])
    // 56 → 76: the seat stays the lesser through the travel, the rest seats 76.
    act(() => {
      offline()
    })
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    frames.tick(3)
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    expect(bandOffset()).toBeGreaterThan(BAND_HEIGHT_ONE_LINE)
    settle()
    expect(bandSeat()).toBe(H)
    expect(bandOffset()).toBe(H)
    expect(written).toEqual([BAND_HEIGHT_ONE_LINE, H])
    // The leave: 0 at the departure, the frames home, 0 at the rest – nothing written twice.
    act(() => {
      resetBands()
    })
    expect(bandSeat()).toBe(0)
    expect(written).toEqual([BAND_HEIGHT_ONE_LINE, H, 0])
    settle()
    expect(band()).toBeNull()
    expect(layoutBand()).toBeUndefined()
    expect(written).toEqual([BAND_HEIGHT_ONE_LINE, H, 0])
    off()
  })

  it('let go short of half, the band springs back: the return is a travel whose departure keeps the drag’s 0, and the rest re-seats at the height; let go past half, it leaves: the departure keeps 0, the rest at 0 is home', () => {
    offline()
    render(state())
    settle()
    const { written, off } = seats()
    const m = mouse()
    m.down()
    m.move(-20)
    expect(bandSeat()).toBe(0)
    // 56 of 76 is short of half: a return toward 76 – the departure's lesser is the 0 the drag
    // left, so the page rides down unseated and is laid out under the band once, at the rest.
    m.up(-20)
    expect(standing()).toBe('connectivity')
    expect(bandSeat()).toBe(0)
    expect(written).toEqual([0])
    frames.tick(2)
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBeGreaterThan(H - 20)
    settle()
    expect(bandSeat()).toBe(H)
    expect(bandOffset()).toBe(H)
    expect(layoutBand()).toEqual({ seat: H, offset: H })
    expect(written).toEqual([0, H])
    // Past half: the release dismisses – the leave's departure keeps the 0 the drag left, the
    // frames bring the page home and the band is gone at the rest, nothing laid out twice.
    run.mockClear()
    m.down()
    m.move(-50)
    expect(bandSeat()).toBe(0)
    expect(offsets()).toEqual([H - 50])
    expect(written).toEqual([0, H, 0])
    m.up(-50)
    expect(standing()).toBeNull()
    expect(band()).not.toBeNull()
    settle()
    expect(band()).toBeNull()
    expect(bandOffset()).toBe(0)
    expect(bandSeat()).toBe(0)
    expect(layoutBand()).toBeUndefined()
    expect(written).toEqual([0, H, 0])
    off()
  })

  it('a drag frame at the seat – the band pulled down past its rest, where the page can go no lower than the height – or above it – a taller tenant arriving under the pointer – leaves the seat; the first frame below it unseats', () => {
    const id = showBand({ key: 'k1', form: 'state', icon: Globe, title: 'One line' })
    render(state())
    settle()
    expect(chooseBand(bandStore.get())!.id).toBe(id)
    expect(layoutBand()).toEqual({ seat: BAND_HEIGHT_ONE_LINE, offset: BAND_HEIGHT_ONE_LINE })
    run.mockClear()
    const { written, off } = seats()
    const m = mouse()
    m.down()
    // Down: the page is already at the band's height, so the frame is at the seat – nothing is
    // unseated, nothing moves, nothing is laid out.
    m.move(20)
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    expect(bandOffset()).toBe(BAND_HEIGHT_ONE_LINE)
    expect(offsets()).toEqual([])
    expect(written).toEqual([])
    // The two-line state arrives under the pointer: the band's height is 76 now (the content
    // swaps; the travel waits for the release), and the next frame down puts the page at 76 –
    // above the seat of 56. Nothing bared: the page is laid out under 56 and stands 20 below
    // that; the seat is left where it is.
    act(() => {
      offline()
    })
    m.move(30)
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    expect(bandOffset()).toBe(H)
    expect(offsets()).toEqual([H])
    expect(layoutBand()).toEqual({ seat: BAND_HEIGHT_ONE_LINE, offset: H })
    expect(written).toEqual([])
    // Up, but still above the seat (66 of 76): the seat is left. Under it (46): the drag's
    // unseat, as on any band.
    m.move(-10)
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    expect(bandOffset()).toBe(H - 10)
    expect(written).toEqual([])
    m.move(-30)
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(H - 30)
    expect(written).toEqual([0])
    m.up(-30)
    settle()
    expect(standing()).toBe('connectivity')
    expect(layoutBand()).toEqual({ seat: H, offset: H })
    expect(written).toEqual([0, H])
    off()
  })
})

describe('PageBandHost – the layer a chrome page rides on (motion spec §3.4, §10)', () => {
  it('a chrome-drawn page is moved through the page seam: its layer is translated per frame by the very offset the core hears, laid out under the seat at the rest – offset − seat, as the views’ bounds move – and comes home the same way on a leave; at home it is a plain box', () => {
    offline()
    renderWithLayer(state({ front: 'settings' }))
    expect(model()).toMatchObject({ front: 'settings', ok: true, offers: false })
    expect(standing()).toBe('connectivity')
    const el = layer()
    expect(el.querySelector('[data-testid="chrome-page"]')).not.toBeNull()
    // Before the first frame: home, no transform, the whole frame.
    expect(el.style.transform).toBe('')
    expect(el.style.top).toBe('')
    frames.tick(3)
    const travelling = offsets()
    expect(travelling).toHaveLength(3)
    // Nothing seated while the page travels at full height: the layer's translate is the offset
    // itself – the one number the core heard this frame – and its box is still the whole frame.
    expect(bandSeat()).toBe(0)
    expect(el.style.transform).toBe(`translateY(${travelling.at(-1)}px)`)
    expect(el.style.top).toBe('')
    settle()
    // At the rest the page is laid out under the seat (`top`) and the translate is gone: the
    // offset against the seat is 0, as the core's shift of the views is.
    expect(bandSeat()).toBe(BAND_HEIGHT_TWO_LINE)
    expect(offsets().at(-1)).toBe(BAND_HEIGHT_TWO_LINE)
    expect(el.style.top).toBe(`${BAND_HEIGHT_TWO_LINE}px`)
    expect(el.style.transform).toBe('')
    // A leave: the seat goes to 0 as the travel begins – the box is the whole frame again with
    // the page still down by the offset, no jump – and the page comes home per frame.
    run.mockClear()
    act(() => dismissBandByKey('connectivity'))
    expect(bandSeat()).toBe(0)
    expect(el.style.top).toBe('')
    expect(el.style.transform).toBe(`translateY(${BAND_HEIGHT_TWO_LINE}px)`)
    frames.tick(2)
    const leaving = offsets()
    expect(leaving).toHaveLength(2)
    expect(leaving[1]).toBeLessThan(leaving[0])
    expect(el.style.transform).toBe(`translateY(${leaving.at(-1)}px)`)
    settle()
    expect(offsets().at(-1)).toBe(0)
    expect(band()).toBeNull()
    expect(el.style.transform).toBe('')
    expect(el.style.top).toBe('')
  })

  it('a cut lands the layer where the band stands at once, no travel; a page of the web is moved by the core alone – the same offsets go to layout.pageOffset with no layer in the frame', () => {
    offline()
    renderWithLayer(state({ front: 'settings' }))
    settle()
    const el = layer()
    expect(el.style.top).toBe(`${BAND_HEIGHT_TWO_LINE}px`)
    run.mockClear()
    // The page's fullscreen under the window-wide band: a cut – the band goes and the page is
    // home at once, the layer with it.
    renderWithLayer(state({ front: 'settings', htmlFullscreenTabId: 'settings' }))
    expect(offsets()).toEqual([0])
    expect(el.style.top).toBe('')
    expect(el.style.transform).toBe('')
    expect(framesPending()).toBe(0)
    // Its exit: the band stands again at once, the page laid out under it, no translate.
    renderWithLayer(state({ front: 'settings' }))
    expect(offsets()).toEqual([0, BAND_HEIGHT_TWO_LINE])
    expect(el.style.top).toBe(`${BAND_HEIGHT_TWO_LINE}px`)
    expect(el.style.transform).toBe('')
    expect(framesPending()).toBe(0)
    // A page of the web in front: `ContentArea` mounts no layer for it – its view is the
    // core's to move – and the band's travel reaches the core as it did before the layer.
    act(() => root!.render(null))
    resetBands()
    resetPageBand()
    run.mockClear()
    offline()
    render(state())
    expect(mount!.querySelector('[data-band-layer]')).toBeNull()
    frames.tick(3)
    expect(offsets()).toHaveLength(3)
    settle()
    expect(offsets().at(-1)).toBe(BAND_HEIGHT_TWO_LINE)
    expect(bandSeat()).toBe(BAND_HEIGHT_TWO_LINE)
  })

  it("the layer's source: mounted with source=\"chrome-page\" (Android, `ContentArea`) it rides on the chrome page's pair alone – seated by `seatChromePage`, translated by `moveChromePage` against that seat – deaf to the desktop's pair, and the layout report hears nothing of it; the default rides on the page's pair, deaf to the chrome page's", () => {
    act(() => {
      root!.render(
        <PageBandLayer source="chrome-page">
          <div data-testid="chrome-page" />
        </PageBandLayer>
      )
    })
    const el = layer()
    expect(el.style.transform).toBe('')
    expect(el.style.top).toBe('')
    // The travel: the frames translate the layer at seat 0 (Android's host writes them per
    // frame, no React in the way); the desktop's pair and the report stay silent.
    act(() => {
      moveChromePage(24)
    })
    expect(el.style.transform).toBe('translateY(24px)')
    expect(el.style.top).toBe('')
    act(() => {
      moveChromePage(BAND_HEIGHT_ONE_LINE)
    })
    expect(el.style.transform).toBe(`translateY(${BAND_HEIGHT_ONE_LINE}px)`)
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(0)
    expect(layoutBand()).toBeUndefined()
    // The rest: seated – the box inset by the band's height, no transform (offset − seat = 0).
    act(() => {
      seatChromePage(BAND_HEIGHT_ONE_LINE)
    })
    expect(el.style.top).toBe(`${BAND_HEIGHT_ONE_LINE}px`)
    expect(el.style.transform).toBe('')
    expect(layoutBand()).toBeUndefined()
    expect(offsets()).toEqual([])
    // The desktop's pair written beside it moves this layer not at all.
    act(() => {
      seatBand(BAND_HEIGHT_TWO_LINE)
      movePage(BAND_HEIGHT_TWO_LINE)
    })
    expect(el.style.top).toBe(`${BAND_HEIGHT_ONE_LINE}px`)
    expect(el.style.transform).toBe('')
    // The leave: unseated at the departure (the box full-frame, translated by the offset – the
    // same place), the frames home, a plain box at the rest.
    act(() => {
      seatChromePage(0)
    })
    expect(el.style.top).toBe('')
    expect(el.style.transform).toBe(`translateY(${BAND_HEIGHT_ONE_LINE}px)`)
    act(() => {
      moveChromePage(0)
    })
    expect(el.style.transform).toBe('')
    expect(el.style.top).toBe('')
    // The default source – the desktop's layer – is deaf to the chrome page's pair.
    act(() => root!.render(null))
    resetPageBand()
    resetChromePageBand()
    act(() => {
      root!.render(
        <PageBandLayer>
          <div data-testid="chrome-page" />
        </PageBandLayer>
      )
    })
    const desktop = layer()
    act(() => {
      moveChromePage(40)
      seatChromePage(40)
    })
    expect(desktop.style.transform).toBe('')
    expect(desktop.style.top).toBe('')
    act(() => {
      seatBand(BAND_HEIGHT_TWO_LINE)
      movePage(30)
    })
    expect(desktop.style.top).toBe(`${BAND_HEIGHT_TWO_LINE}px`)
    expect(desktop.style.transform).toBe(`translateY(${30 - BAND_HEIGHT_TWO_LINE}px)`)
    expect(layoutBand()).toEqual({ seat: BAND_HEIGHT_TWO_LINE, offset: 30 })
  })
})

describe('PageBandHost – the corner masks under the band (motion spec §3.1, §3.4; W8-M2c)', () => {
  const H = BAND_HEIGHT_TWO_LINE

  it("the masks follow the offset store: translated per frame to the very offset the core hears and the layer rides on – the page's top edge, whatever the seat – at the rest the seat itself, and home again as the page comes home; a frame of the travel re-renders nothing", () => {
    offline()
    renderWithLayer(state({ front: 'settings' }))
    const el = corners()!
    expect(el).not.toBeNull()
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.querySelectorAll('.zen-band-corner')).toHaveLength(2)
    expect(el.querySelector('.zen-band-corner[data-side="left"]')).not.toBeNull()
    expect(el.querySelector('.zen-band-corner[data-side="right"]')).not.toBeNull()
    // Before the first frame: home, hidden, no transform.
    expect(el.hasAttribute('data-home')).toBe(true)
    expect(el.style.transform).toBe('')
    frames.tick(3)
    const travelling = offsets()
    expect(travelling).toHaveLength(3)
    // Unseated while the page travels: the masks stand at the offset – the layer's translate
    // against a seat of 0 is the same number.
    expect(bandSeat()).toBe(0)
    expect(el.hasAttribute('data-home')).toBe(false)
    expect(el.style.transform).toBe(`translateY(${travelling.at(-1)}px)`)
    expect(layer().style.transform).toBe(`translateY(${travelling.at(-1)}px)`)
    settle()
    // At the rest the page is laid out under the seat and the masks stand at it: the page's
    // top edge, where the layer's box begins.
    expect(bandSeat()).toBe(H)
    expect(bandOffset()).toBe(H)
    expect(el.style.transform).toBe(`translateY(${H}px)`)
    expect(el.hasAttribute('data-home')).toBe(false)
    expect(layer().style.top).toBe(`${H}px`)
    // The leave: the page comes home per frame and the masks with it; home, they hide.
    run.mockClear()
    act(() => dismissBandByKey('connectivity'))
    frames.tick(2)
    const leaving = offsets()
    expect(leaving).toHaveLength(2)
    expect(el.style.transform).toBe(`translateY(${leaving.at(-1)}px)`)
    expect(el.hasAttribute('data-home')).toBe(false)
    settle()
    expect(bandOffset()).toBe(0)
    expect(band()).toBeNull()
    expect(el.style.transform).toBe('')
    expect(el.hasAttribute('data-home')).toBe(true)
    // The same element throughout: written to, never re-rendered into another.
    expect(corners()).toBe(el)
  })

  it('a drag moves them as it moves the page: at the offset of every frame, the seat gone; a cut lands them where the band stands at once', () => {
    offline()
    render(state())
    settle()
    const el = corners()!
    expect(el.style.transform).toBe(`translateY(${H}px)`)
    const m = mouse()
    m.down()
    m.move(-20)
    expect(bandSeat()).toBe(0)
    expect(bandOffset()).toBe(H - 20)
    expect(el.style.transform).toBe(`translateY(${H - 20}px)`)
    m.move(-35)
    expect(el.style.transform).toBe(`translateY(${H - 35}px)`)
    // Let go short of half-way: the band travels back to its rest and the masks to the seat.
    m.up(-35)
    settle()
    expect(bandSeat()).toBe(H)
    expect(el.style.transform).toBe(`translateY(${H}px)`)
    // A cut: the page's fullscreen takes the band at once – the masks home at once, no travel.
    render(state({ htmlFullscreenTabId: 'page' }))
    expect(framesPending()).toBe(0)
    expect(bandOffset()).toBe(0)
    expect(el.hasAttribute('data-home')).toBe(true)
    expect(el.style.transform).toBe('')
    // Its exit: the band stands again at once, the masks at the seat.
    render(state())
    expect(framesPending()).toBe(0)
    expect(bandOffset()).toBe(H)
    expect(el.style.transform).toBe(`translateY(${H}px)`)
    expect(el.hasAttribute('data-home')).toBe(false)
  })

  it('home where no band stands – the empty frame, a fullscreen, a page shown in another window – and absent where the host is not mounted: the layer alone, as Android mounts it, carries none', () => {
    offline()
    render(state({ front: null }))
    expect(standing()).toBeNull()
    expect(corners()!.hasAttribute('data-home')).toBe(true)
    expect(corners()!.style.transform).toBe('')
    render(state({ fullscreen: true }))
    expect(model()).toMatchObject({ ok: false })
    expect(corners()!.hasAttribute('data-home')).toBe(true)
    render(state({ foreign: ['page'] }))
    expect(model()).toMatchObject({ ok: false })
    expect(corners()!.hasAttribute('data-home')).toBe(true)
    expect(bandOffset()).toBe(0)
    // The chrome page's layer without the desktop's host: no masks, and the chrome page's pair
    // moves none.
    act(() => root!.render(null))
    resetBands()
    resetPageBand()
    act(() => {
      root!.render(
        <PageBandLayer source="chrome-page">
          <div data-testid="chrome-page" />
        </PageBandLayer>
      )
    })
    expect(corners()).toBeNull()
    act(() => {
      moveChromePage(24)
      seatChromePage(BAND_HEIGHT_ONE_LINE)
    })
    expect(corners()).toBeNull()
    expect(layer().style.top).toBe(`${BAND_HEIGHT_ONE_LINE}px`)
  })

  it("the masks' chrome (main.css): a strip the frame's radius tall over the band's layer and the page's picture, under the band, taking no pointer, hidden at home; each box the inverse of the frame's corner – rounded at the outer top corner alone, the frame's ground in its spread shadow", () => {
    const strip = rule('.zen-band-corners')
    expect(strip).toContain('position: absolute;')
    expect(strip).toContain('inset: 0 0 auto 0;')
    expect(strip).toContain('height: var(--zen-content-radius);')
    expect(strip).toContain('pointer-events: none;')
    // Over the layer and the cover (no `z-index` of their own), under the band's 6.
    expect(strip).toContain('z-index: 5;')
    expect(rule('.zen-band')).toContain('z-index: 6;')
    expect(rule('.zen-band-corners[data-home]')).toContain('display: none;')
    const box = rule('.zen-band-corner')
    expect(box).toContain('width: var(--zen-content-radius);')
    expect(box).toContain('height: var(--zen-content-radius);')
    expect(box).toContain('overflow: hidden;')
    expect(rule(".zen-band-corner[data-side='left']")).toContain('left: 0;')
    expect(rule(".zen-band-corner[data-side='right']")).toContain('right: 0;')
    // The ground outside the arc: the frame's own background, light and dark alike.
    expect(rule('.zen-band-corner::before')).toContain(
      'box-shadow: 0 0 0 var(--zen-content-radius) var(--zen-bg-solid);'
    )
    expect(rule('.zen-content-frame')).toContain('background: var(--zen-bg-solid);')
    expect(rule(".zen-band-corner[data-side='left']::before")).toContain(
      'border-radius: var(--zen-content-radius) 0 0 0;'
    )
    expect(rule(".zen-band-corner[data-side='right']::before")).toContain(
      'border-radius: 0 var(--zen-content-radius) 0 0;'
    )
  })
})

describe('PageBandHost – the default-browser tenant', () => {
  it('stands the state while the OS names another browser, and ends it with the answer', () => {
    const asking = {
      ...state(),
      defaultBrowser: { isDefault: false, prompt: null }
    } as UIState
    render(asking)
    expect(chooseBand(bandStore.get())!.key).toBe('default-browser')
    expect(band()!.querySelector('.zen-band-title')!.textContent).toBe(
      'Make Zenium your default browser'
    )
    expect(band()!.querySelector('.zen-band-button')!.textContent).toBe('Set as default')
    expect(band()!.querySelector('.zen-band-close')!.getAttribute('aria-label')).toBe('Dismiss')
    settle()
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    render({ ...asking, defaultBrowser: { isDefault: true, prompt: null } } as UIState)
    expect(chooseBand(bandStore.get())).toBeNull()
    settle()
    expect(band()).toBeNull()
    expect(bandSeat()).toBe(0)
  })

  it('the × ALONE is the refusal remembered for this release (the Design Lead’s ruling, §3.2 / §9.6): a swipe, Escape, the clock, a navigation, a replacement, the tab closing and Android’s Back put the band away for now, remember nothing, and the band stands again at the next eligible moment', () => {
    const asking = {
      ...state(),
      defaultBrowser: { isDefault: false, prompt: null }
    } as UIState
    /** What the tenant wrote to the settings: the refusal remembered, if any. */
    const remembered = (): unknown[][] => run.mock.calls.filter(([c]) => c === 'settings.update')
    /**
     * The next eligible moment on the desktop: the host mounting again on the same window state
     * (the next window, the next launch) – the tenant's effect stands the band once per mount
     * while nothing is remembered against it.
     */
    const remount = (): void => {
      act(() => root!.render(null))
      render(asking)
    }
    const putAways = [
      'swipe',
      'escape',
      'timeout',
      'navigation',
      'replaced',
      'program',
      'back'
    ] as const
    for (const reason of putAways) {
      render(asking)
      expect(chooseBand(bandStore.get())?.key, reason).toBe('default-browser')
      // What the swipe's release, Escape, the clock, `useBandTabs` and a replacing `showBand`
      // each do: take the entry down under its reason. The tenant hears it and keeps nothing.
      act(() => dismissBandByKey('default-browser', reason))
      expect(chooseBand(bandStore.get()), reason).toBeNull()
      expect(remembered(), reason).toEqual([])
      remount()
      expect(chooseBand(bandStore.get())?.key, reason).toBe('default-browser')
      act(() => root!.render(null))
      resetBands()
    }
    // Escape as the keyboard reaches it – with focus in the band: the same put-away.
    render(asking)
    act(() => {
      const close = band()!.querySelector<HTMLButtonElement>('.zen-band-close')!
      close.focus()
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(chooseBand(bandStore.get())).toBeNull()
    expect(remembered()).toEqual([])
    remount()
    expect(chooseBand(bandStore.get())?.key).toBe('default-browser')
    // The ×: the refusal, remembered once for this release; the answer coming back through the
    // settings ends the state, so no remount stands it again until the next feature release.
    act(() => band()!.querySelector<HTMLButtonElement>('.zen-band-close')!.click())
    expect(remembered()).toEqual([['settings.update', { defaultBrowserPromptDismissed: '0.3.77' }]])
    expect(chooseBand(bandStore.get())).toBeNull()
    const answered = {
      ...asking,
      settings: { ...asking.settings, defaultBrowserPromptDismissed: '0.3.77' }
    } as UIState
    act(() => root!.render(null))
    render(answered)
    expect(chooseBand(bandStore.get())).toBeNull()
    settle()
    expect(band()).toBeNull()
    expect(remembered()).toHaveLength(1)
  })
})

describe('PageBandHost – the crash-restore tenant', () => {
  it('stands the two-line state while the session holds the last run’s pages, before the default-browser state (the newest state shows), and ends it with the answer', () => {
    const held = { ...state(), crashRestore: { tabCount: 2, windowCount: 1 } } as UIState
    render(held)
    expect(chooseBand(bandStore.get())!.key).toBe('crash-restore')
    expect(band()!.dataset.key).toBe('crash-restore')
    expect(band()!.querySelector('.zen-band-title')!.textContent).toBe('Restore 2 pages?')
    expect(band()!.querySelector('.zen-band-detail')!.textContent).toBe(
      'Zenium did not shut down correctly.'
    )
    expect(band()!.querySelector('.zen-band-button')!.textContent).toBe('Restore')
    expect(band()!.querySelector('.zen-band-close')!.getAttribute('aria-label')).toBe('Dismiss')
    settle()
    expect(bandSeat()).toBe(BAND_HEIGHT_TWO_LINE)
    // Restore answers the core; the offer clears with the answer and the band is gone at the rest.
    act(() => band()!.querySelector<HTMLButtonElement>('.zen-band-button')!.click())
    expect(run).toHaveBeenCalledWith('session.crashRestore', { restore: true })
    render({ ...held, crashRestore: null } as UIState)
    expect(chooseBand(bandStore.get())).toBeNull()
    settle()
    expect(band()).toBeNull()
    expect(bandSeat()).toBe(0)
  })

  it('stands on the new tab page too – where a window that lost its pages opens (item 8)', () => {
    const held = {
      ...state({ front: 'ntp' }),
      crashRestore: { tabCount: 1, windowCount: 1 }
    } as UIState
    render(held)
    expect(chooseBand(bandStore.get())!.key).toBe('crash-restore')
    expect(band()!.querySelector('.zen-band-title')!.textContent).toBe('Restore 1 page?')
    settle()
    expect(bandSeat()).toBe(BAND_HEIGHT_TWO_LINE)
  })
})
