// @vitest-environment happy-dom
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
 * (`lib/pageBand.ts`), and a cut – no travel – when the frame's page changes; and what the tabs
 * tell the model (a tab closing, a document changing). Its default-browser tenant: the state
 * stands while the OS names another browser.
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

/** A desktop window on a page tab; the default-browser tenant quiet unless a scene asks for it. */
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
