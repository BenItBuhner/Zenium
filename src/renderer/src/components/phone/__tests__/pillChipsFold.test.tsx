// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MediaState, Space, Tab, UIState } from '@shared/types'

/*
 * The phone pill's chip fold as the pill draws it (design language v2 §9.29, OMN-02; the pure
 * model is `lib/__tests__/pillChips.test.ts`): the chips as data with what TalkBack hears and
 * what their sheet rows do; the pill folding from a real measure (the row's width and the
 * ruler's, stubbed here since happy-dom lays nothing out) with the folded states spoken at the
 * address and published for the site-information sheet; the run's cross-fade on a set change
 * (§11.4): a ghost of the run it showed, in place, gone after 120 ms, never a slide.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PillContent } = await import('../PhoneShell')
const { CHIP_FOLD_FADE_MS, ChipRun, foldedChipRows, phonePillChips, pillChipsStore } =
  await import('../pillChips')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { siteInfoStore } = await import('@renderer/lib/siteInfo')
const { defaultShortcuts } = await import('@shared/shortcuts')

function tab(url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id: 't1',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'Example',
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
    blockedCount: 0,
    ...patch
  } as Tab
}

const space: Space = {
  id: 'space',
  name: 'Work',
  icon: '',
  containerId: 'default',
  theme: null,
  tabIds: ['t1'],
  activeTabId: 't1',
  pinnedCollapsed: false
}

/** The state of a phone with the request engine: the shield is on every web page. */
function state(t: Tab, patch: Partial<UIState> = {}): UIState {
  return {
    platform: 'android',
    capabilities: { windowControls: false, requestBlocking: true, translate: true },
    tabs: { [t.id]: t },
    spaces: [space],
    activeSpaceId: 'space',
    settings: {
      urlbarBehavior: 'normal',
      blocking: { level: 'balanced' },
      phoneBarPosition: 'bottom'
    },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {},
    blocking: { enabled: true, siteExceptions: [] },
    translate: { available: true, tabs: {} },
    media: [],
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    ...patch
  } as unknown as UIState
}

const page = tab('https://example.com/some/path')

/** The page offered for translation (the bar dismissed: the chip still offers). */
function offered(s: UIState): UIState {
  return {
    ...s,
    translate: {
      ...s.translate,
      tabs: {
        t1: {
          tabId: 't1',
          status: 'offered',
          source: 'de',
          confidence: 0.9,
          target: 'en',
          progress: null,
          download: null,
          error: null,
          auto: true,
          dismissed: true
        }
      }
    }
  }
}

/** The page holding the media session, playing. */
function playing(s: UIState): UIState {
  const session: MediaState = {
    tabId: 't1',
    session: true,
    playing: true,
    playbackState: 'playing',
    title: 'Nocturne',
    artist: 'Chopin',
    album: null,
    artwork: null,
    video: false,
    duration: null,
    position: null,
    seekable: false,
    actions: [],
    updatedAt: 0
  } as unknown as MediaState
  return { ...s, media: [session] }
}

const ctx = { siteInfoOpen: false, mediaSheetOpen: false, activeTabId: 't1' }

let root: Root | null = null
let host: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host
}

/**
 * happy-dom lays nothing out: every width reads 0 and the pill folds nothing. Stand in for the
 * layout the way the pill reads it – the content row's `clientWidth` is the room, a ruler
 * wrapper's `offsetWidth` its item's flow (`data-chip`) – with the widths the preview host
 * measured at 412: room 226; the glyph 18, the shield 36 (61 with a count), the lock,
 * translate and media chips 20.
 */
const FLOWS: Record<string, number> = {
  'site-info': 18,
  blocked: 36,
  lock: 20,
  translate: 20,
  media: 20
}
function layout(room: number, flows: Record<string, number> = FLOWS): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('relative') && this.classList.contains('flex') ? room : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      const id = this.getAttribute('data-chip')
      return id && this.parentElement?.classList.contains('zen-pill-ruler') ? (flows[id] ?? 0) : 0
    }
  })
}

const shown = (el: ParentNode): string[] =>
  Array.from(el.querySelectorAll<HTMLElement>('[data-testid="pill-chips"] > [data-chip]')).map(
    (c) => c.getAttribute('data-chip')!
  )
const addressLabel = (el: ParentNode): string | null =>
  el.querySelector('[data-testid="pill-address"]')?.getAttribute('aria-label') ?? null

beforeEach(() => {
  uiStore.set({ siteInfoOpen: false, mediaSheet: null })
  siteInfoStore.set({ tabId: null, anchor: null })
  pillChipsStore.set({ tabId: null, folded: [] })
  invoke.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  browserStore.set({ state: null })
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth
  vi.useRealTimers()
})

describe('phonePillChips: the chips as data', () => {
  it('lists the chips in the pill’s order with what TalkBack hears once each folds', () => {
    const chips = phonePillChips(
      playing(offered(state(page, { tabs: { t1: { ...page, blockedCount: 12 } } }))),
      { ...page, blockedCount: 12 },
      ctx
    )
    expect(chips.map((c) => c.id)).toEqual(['blocked', 'lock', 'translate', 'media'])
    expect(chips.map((c) => c.spoken)).toEqual([
      '12 requests blocked',
      'Connection is secure',
      'Translation offered',
      'Now playing'
    ])
  })

  it('gives every chip but the lock a row for the sheet, with the chip’s name and state', () => {
    const chips = phonePillChips(playing(offered(state(page))), page, ctx)
    const rows = Object.fromEntries(chips.map((c) => [c.id, c.row]))
    expect(rows.lock).toBeNull()
    expect(rows.blocked?.label).toBe('Nothing blocked on this page yet')
    expect(rows.translate?.label).toBe('Translate this page')
    expect(rows.media?.label).toBe('Now playing')
    expect(rows.media?.value).toBe('Nocturne')
  })

  it('has no chips for an internal page, an http page has no lock, no tab nothing', () => {
    expect(phonePillChips(state(tab('zen://settings')), tab('zen://settings'), ctx)).toEqual([])
    const plain = tab('http://example.com/')
    expect(phonePillChips(state(plain), plain, ctx).map((c) => c.id)).toEqual(['blocked'])
    expect(phonePillChips(state(page), null, ctx)).toEqual([])
  })

  it('a folded translate offer still offers from its row, and the sheet goes for the bar', async () => {
    const s = offered(state(page))
    const [translate] = phonePillChips(s, page, ctx).filter((c) => c.id === 'translate')
    uiStore.set({ siteInfoOpen: true })
    siteInfoStore.set({ tabId: 't1', anchor: null })
    translate!.row!.activate()
    await vi.waitFor(() =>
      expect(invoke.mock.calls.map(([name]) => name)).toContain('translate.offer')
    )
    expect(uiStore.get().siteInfoOpen).toBe(false)
  })
})

describe('foldedChipRows: what the sheet lists', () => {
  it('is the folded chips of this tab that have a row, in the pill’s order', () => {
    const s = playing(offered(state(page)))
    const rows = foldedChipRows(
      s,
      page,
      { tabId: 't1', folded: ['lock', 'translate', 'blocked'] },
      ctx
    )
    expect(rows.map((r) => r.id)).toEqual(['blocked', 'translate'])
  })

  it('is empty for another tab’s fold or when nothing folded', () => {
    const s = offered(state(page))
    expect(foldedChipRows(s, page, { tabId: 't2', folded: ['translate'] }, ctx)).toEqual([])
    expect(foldedChipRows(s, page, { tabId: 't1', folded: [] }, ctx)).toEqual([])
  })
})

describe('PillContent folds from the measure', () => {
  it('keeps every chip while the host has its 120 px, and speaks nothing extra', () => {
    layout(226)
    const el = render(<PillContent state={state(page)} tab={page} space={space} interactive />)
    // Glyph 26 + shield 44 + lock 28 = 98 of 226: the host keeps 128.
    expect(shown(el)).toEqual(['blocked', 'lock'])
    expect(addressLabel(el)).toBe('Address, example.com')
    expect(pillChipsStore.get()).toEqual({ tabId: 't1', folded: [] })
  })

  it('folds the lock first when the translate offer arrives, and says so at the address', () => {
    layout(226)
    const el = render(
      <PillContent state={offered(state(page))} tab={page} space={space} interactive />
    )
    // + translate 28 = 126: the host would have 100; the lock (informational) folds -> 128.
    expect(shown(el)).toEqual(['blocked', 'translate'])
    expect(addressLabel(el)).toBe('Address, example.com, Connection is secure')
    expect(pillChipsStore.get()).toEqual({ tabId: 't1', folded: ['lock'] })
  })

  it('folds the count before the media chip once the informational ones are gone', () => {
    const counted = { ...page, blockedCount: 12 }
    layout(226, { ...FLOWS, blocked: 61 })
    const el = render(
      <PillContent
        state={playing(offered(state(counted)))}
        tab={counted}
        space={space}
        interactive
      />
    )
    // 26 + 69 + 28 + 28 + 28 = 179: lock, translate, then the count fold; media stays at 172.
    expect(shown(el)).toEqual(['media'])
    expect(addressLabel(el)).toBe(
      'Address, example.com, 12 requests blocked, Connection is secure, Translation offered'
    )
    expect(pillChipsStore.get()).toEqual({ tabId: 't1', folded: ['lock', 'translate', 'blocked'] })
  })

  it('never folds the site-information glyph, and folds nothing on an unmeasured pill', () => {
    layout(60)
    const el = render(
      <PillContent state={playing(offered(state(page)))} tab={page} space={space} interactive />
    )
    // Room for nothing: every chip folds, the glyph stays.
    expect(shown(el)).toEqual([])
    expect(el.querySelector('button[aria-label="Site information"]')).not.toBeNull()
    act(() => root!.unmount())
    host!.remove()
    layout(0)
    const flat = render(
      <PillContent state={playing(offered(state(page)))} tab={page} space={space} interactive />
    )
    expect(shown(flat)).toEqual(['blocked', 'lock', 'translate', 'media'])
  })

  it('the carried pill (a picture of the docked one) publishes nothing', () => {
    layout(226)
    render(
      <PillContent state={offered(state(page))} tab={page} space={space} interactive={false} />
    )
    expect(pillChipsStore.get()).toEqual({ tabId: null, folded: [] })
  })
})

describe('ChipRun cross-fades a set change in place (§11.4)', () => {
  interface Fade {
    el: HTMLElement
    from: number
    to: number
    duration: number
  }
  /** happy-dom has no Web Animations: record what the run asks of them. */
  let fades: Fade[] = []
  const animate = HTMLElement.prototype.animate
  beforeEach(() => {
    fades = []
    HTMLElement.prototype.animate = function (this: HTMLElement, keyframes, options) {
      const [a, b] = keyframes as Array<{ opacity: number }>
      const duration = typeof options === 'number' ? options : Number(options?.duration)
      fades.push({ el: this, from: a!.opacity, to: b!.opacity, duration })
      return { finished: Promise.resolve(), cancel: () => undefined } as unknown as Animation
    }
  })
  afterEach(() => {
    if (animate) HTMLElement.prototype.animate = animate
    else delete (HTMLElement.prototype as Partial<HTMLElement>).animate
  })
  const ghostOf = (el: ParentNode): HTMLElement | null =>
    el.querySelector<HTMLElement>('.zen-pill-run-ghost')
  const liveChip = (el: ParentNode, id: string): Element | null =>
    el.querySelector(`[data-testid="pill-chips"] > [data-chip="${id}"] > *`)

  it('keeps a ghost of the run it showed over the new one, gone after 120 ms, never a slide', () => {
    vi.useFakeTimers()
    const s = playing(offered(state(page)))
    const [blocked, lock, translate, media] = phonePillChips(s, page, ctx)
    const el = render(<ChipRun chips={[blocked!, lock!, translate!]} interactive />)
    expect(ghostOf(el)).toBeNull()
    expect(fades).toEqual([])
    // The lock folds and media arrives: one commit, one ghost of [blocked, lock, translate]
    // over the new [blocked, translate, media], both runs anchored at their end.
    act(() => root!.render(<ChipRun chips={[blocked!, translate!, media!]} interactive />))
    const ghost = ghostOf(el)
    expect(ghost).not.toBeNull()
    expect(ghost!.getAttribute('aria-hidden')).toBe('true')
    expect(ghost!.querySelectorAll('button').length).toBe(0)
    const copies = Array.from(ghost!.children) as HTMLElement[]
    expect(copies.length).toBe(3)
    // Blocked keeps its slot (third from the end in both runs): its copy is hidden, so it neither
    // moves nor flickers. The lock's copy fades out where it stood; the translate copy fades out
    // in the last slot while the live translate fades in one slot up; media fades in at the end.
    expect(copies.map((c) => c.style.visibility)).toEqual(['hidden', '', ''])
    expect(fades.map((f) => [f.from, f.to, f.duration])).toEqual([
      [1, 0, CHIP_FOLD_FADE_MS],
      [1, 0, CHIP_FOLD_FADE_MS],
      [0, 1, CHIP_FOLD_FADE_MS],
      [0, 1, CHIP_FOLD_FADE_MS]
    ])
    expect(fades.map((f) => f.el)).toEqual([
      copies[1],
      copies[2],
      liveChip(el, 'translate'),
      liveChip(el, 'media')
    ])
    // Nothing on a chip that stayed put: opacity is the only property that moves, at 120 ms.
    expect(fades.some((f) => f.el === liveChip(el, 'blocked'))).toBe(false)
    act(() => {
      vi.advanceTimersByTime(CHIP_FOLD_FADE_MS)
    })
    expect(ghostOf(el)).toBeNull()
    expect(shown(el)).toEqual(['blocked', 'translate', 'media'])
  })

  it('hides the ghost copies of the chips that keep their slot from the run’s end', () => {
    vi.useFakeTimers()
    const s = playing(offered(state(page)))
    const [blocked, lock, translate, media] = phonePillChips(s, page, ctx)
    const el = render(<ChipRun chips={[blocked!, lock!, media!]} interactive />)
    // The lock leaves and translate takes its slot: blocked and media stand where they stood.
    act(() => root!.render(<ChipRun chips={[blocked!, translate!, media!]} interactive />))
    const copies = Array.from(ghostOf(el)!.children) as HTMLElement[]
    expect(copies.map((c) => c.style.visibility)).toEqual(['hidden', '', 'hidden'])
    expect(fades.map((f) => [f.el, f.to])).toEqual([
      [copies[1], 0],
      [liveChip(el, 'translate'), 1]
    ])
  })

  it('does not start the fade over when the pill re-renders during it', () => {
    vi.useFakeTimers()
    const s = playing(offered(state(page)))
    const [blocked, lock, translate] = phonePillChips(s, page, ctx)
    render(<ChipRun chips={[blocked!, lock!]} interactive />)
    act(() => root!.render(<ChipRun chips={[blocked!, translate!]} interactive />))
    expect(fades.length).toBe(2)
    // The same set again as new objects (a blocked count ticked): the run keeps its ghost and
    // its running fades, and the ghost still goes at the 120 ms mark, not later.
    act(() => {
      vi.advanceTimersByTime(CHIP_FOLD_FADE_MS / 2)
    })
    const again = phonePillChips(s, page, ctx)
    act(() => root!.render(<ChipRun chips={[again[0]!, again[2]!]} interactive />))
    expect(fades.length).toBe(2)
    expect(ghostOf(host!)).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(CHIP_FOLD_FADE_MS / 2)
    })
    expect(ghostOf(host!)).toBeNull()
  })

  it('draws the carried pill’s run plain: no ghost on a change', () => {
    vi.useFakeTimers()
    const s = playing(offered(state(page)))
    const [blocked, lock, translate] = phonePillChips(s, page, ctx)
    const el = render(<ChipRun chips={[blocked!, lock!]} interactive={false} />)
    act(() => root!.render(<ChipRun chips={[blocked!, translate!]} interactive={false} />))
    expect(ghostOf(el)).toBeNull()
    expect(fades).toEqual([])
  })
})
