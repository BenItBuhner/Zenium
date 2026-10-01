// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Globe, WifiOff } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import type { UiState } from '@renderer/lib/ui'
import { BLANK_URL } from '@shared/url'

/*
 * The desktop's host for the page-edge band (motion spec §3.2, §3.4; content/PageBandHost.tsx):
 * what it tells the model of the frame – the tab in front and its scene, whether a band may
 * stand on it (not the empty frame, the blank page, a chrome page, a page shown in another
 * window, a fullscreen; no offers on a private tab), what covers the page (a chrome overlay, a
 * frame dialog, the URL bar, Web capture, the gesture stage: a new band waits, a standing one
 * stays) – how it fills the band's seam: the page's offset to the core per frame
 * (`layout.pageOffset`), the seat for the layout reporter at the lesser of the seat and the
 * destination on a departure and at the height at the rest (`lib/pageBand.ts`), and a cut – no
 * travel – when the frame's page changes; and what the tabs tell the model (a tab closing, a
 * document changing). Its default-browser tenant: the state stands while the OS names another
 * browser.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: vi.fn(async () => null),
  onEvent: () => () => undefined
}))

const { PageBandHost } = await import('../PageBandHost')
const { BAND_HEIGHT_ONE_LINE, BAND_HEIGHT_TWO_LINE } = await import('@renderer/lib/motion/band')
const { framesPending } = await import('@renderer/lib/motion/clock')
const { bandStore, chooseBand, resetBands, showBand } = await import('@renderer/lib/band')
type BandDismissReason = import('@renderer/lib/band').BandDismissReason
const { bandSeat, resetPageBand } = await import('@renderer/lib/pageBand')
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
  settings: tab('settings', 'zen://settings'),
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('PageBandHost – what the frame shows (motion spec §3.2)', () => {
  it('a page tab in front welcomes a band; the empty frame, the blank page, a chrome page, a page shown in another window and a fullscreen do not – each a scene of its own', () => {
    render(state())
    expect(model()).toEqual({
      front: 'page',
      scene: 'page:::',
      ok: true,
      offers: true,
      covered: false
    })
    render(state({ front: null }))
    expect(model()).toMatchObject({ front: null, scene: ':::', ok: false })
    render(state({ front: 'blank' }))
    expect(model()).toMatchObject({ front: 'blank', ok: false })
    render(state({ front: 'settings' }))
    expect(model()).toMatchObject({ front: 'settings', ok: false })
    render(state({ foreign: ['page'] }))
    expect(model()).toMatchObject({ scene: 'page:::foreign', ok: false })
    render(state({ fullscreen: true }))
    expect(model()).toMatchObject({ scene: 'page::fullscreen:', ok: false })
    render(state({ htmlFullscreenTabId: 'page' }))
    expect(model()).toMatchObject({ scene: 'page:page-fullscreen::', ok: false })
    render(state())
    expect(model()).toMatchObject({ scene: 'page:::', ok: true })
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
  it('a tab closing takes its bands; a document changing dismisses them on "navigation"; a fragment’s move and another tab’s change do not', () => {
    const heard: Array<[string, BandDismissReason]> = []
    render(state())
    offer('page', (r) => heard.push(['page', r]))
    offer('other', (r) => heard.push(['other', r]))
    offline()
    expect(standing()).toBe('connectivity')
    // The fragment moves: the same document.
    render(state({ tabs: { ...TABS, page: tab('page', 'https://example.com/#section') } }))
    expect(heard).toEqual([])
    // The other tab's progress and title change under the same URL: nothing.
    render(state({ tabs: { ...TABS, other: { ...TABS.other, loading: true, title: 'Other' } } }))
    expect(heard).toEqual([])
    // The page navigates to another document: its offer goes; the window-wide state stands.
    render(state({ tabs: { ...TABS, page: tab('page', 'https://example.com/next') } }))
    expect(heard).toEqual([['page', 'navigation']])
    expect(standing()).toBe('connectivity')
    // The other tab closes: its band goes with it, not the user's doing.
    const rest = Object.fromEntries(Object.entries(TABS).filter(([id]) => id !== 'other'))
    render(state({ tabs: rest }))
    expect(heard).toEqual([
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
    expect(band()!.querySelector('.zen-band-close')!.getAttribute('aria-label')).toBe('Not now')
    settle()
    expect(bandSeat()).toBe(BAND_HEIGHT_ONE_LINE)
    render({ ...asking, defaultBrowser: { isDefault: true, prompt: null } } as UIState)
    expect(chooseBand(bandStore.get())).toBeNull()
    settle()
    expect(band()).toBeNull()
    expect(bandSeat()).toBe(0)
  })
})
