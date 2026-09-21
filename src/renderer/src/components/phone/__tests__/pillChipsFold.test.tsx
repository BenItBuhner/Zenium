// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MediaState, Space, Tab, UIState } from '@shared/types'

/*
 * The phone pill at rest as the pill draws it (OMN-02; v2 §9.29 as amended on Bennett's ruling;
 * the pure rule is `lib/__tests__/pillChips.test.ts`): the chips as data with what TalkBack
 * hears and what their sheet rows say and do; the pill drawing the favicon, the host and the
 * lock alone, the shield and the translate offer the sheet's, the states of those spoken at the
 * address; a live media chip taking the lock's slot and giving it back, a second state never
 * stacking; the run's cross-fade on a set change (§11.4): a ghost of the run it showed, in
 * place, gone after 120 ms, never a slide.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PillContent } = await import('../PhoneShell')
const {
  CHIP_FOLD_FADE_MS,
  ChipRun,
  foldPhonePillChips,
  phonePillChips,
  pillChipRows,
  pillChipsDrawn,
  pillChipsSpoken,
  resetLiveArrival
} = await import('../pillChips')
type PillChipModel = ReturnType<typeof phonePillChips>[number]
const { SiteInfoLayer } = await import('../../siteinfo/SiteInfoSheet')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { siteInfoStore } = await import('@renderer/lib/siteInfo')
const { privateLockStore, resetPrivateLock } = await import('@renderer/lib/privateLock')
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

const page = tab('https://github.com/BenItBuhner/Zenium')
/** Bennett's page: five requests blocked, the translation offered. */
const counted = { ...page, blockedCount: 5 }

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

const shown = (el: ParentNode): string[] =>
  Array.from(el.querySelectorAll<HTMLElement>('[data-testid="pill-chips"] > [data-chip]')).map(
    (c) => c.getAttribute('data-chip')!
  )
const addressLabel = (el: ParentNode): string | null =>
  el.querySelector('[data-testid="pill-address"]')?.getAttribute('aria-label') ?? null
const labels = (el: ParentNode): string[] =>
  Array.from(el.querySelectorAll<HTMLElement>('button')).map((b) => b.getAttribute('aria-label')!)

/** §9.29's other state chip, as the phone will build it: a save-password key, live, with a row for when it waits. */
const savePrompt: PillChipModel = {
  id: 'save-prompt',
  fold: 'live',
  spoken: 'Save password',
  render: () => <span data-chip-render="save-prompt" />,
  row: { glyph: null, label: 'Save password', activate: () => undefined }
}

beforeEach(() => {
  uiStore.set({ siteInfoOpen: false, mediaSheet: null })
  siteInfoStore.set({ tabId: null, anchor: null })
  invoke.mockClear()
  resetLiveArrival()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  browserStore.set({ state: null })
  resetPrivateLock()
  vi.useRealTimers()
})

describe('phonePillChips: the chips as data', () => {
  it('lists the chips in the pill’s order, each with its fold and what TalkBack hears of it in the sheet', () => {
    const chips = phonePillChips(
      playing(offered(state(counted, { tabs: { t1: counted } }))),
      counted,
      ctx
    )
    expect(chips.map((c) => [c.id, c.fold])).toEqual([
      ['lock', 'glyph'],
      ['blocked', 'sheet'],
      ['translate', 'sheet'],
      ['media', 'live']
    ])
    expect(chips.map((c) => c.spoken)).toEqual([
      '',
      '5 requests blocked',
      'Translation offered',
      'Now playing'
    ])
  })

  it('draws the lock and the media chip, gives the shield and the offer their rows, and the media chip both', () => {
    const chips = phonePillChips(playing(offered(state(counted))), counted, ctx)
    expect(chips.filter((c) => c.render).map((c) => c.id)).toEqual(['lock', 'media'])
    expect(chips.filter((c) => c.row).map((c) => c.id)).toEqual(['blocked', 'translate', 'media'])
    const rows = Object.fromEntries(chips.map((c) => [c.id, c.row]))
    expect(rows.blocked?.label).toBe('Requests blocked')
    expect(rows.blocked?.value).toBe('5')
    expect(rows.translate?.label).toBe('Translate this page')
    expect(rows.translate?.value).toBe('German to English')
    expect(rows.media?.label).toBe('Now playing')
    expect(rows.media?.value).toBe('Nocturne')
  })

  it('the media row masks a locked private tab’s title (INC-05, §9.19) and says the state', () => {
    // A private tab holds the session (`MediaState.private`, the core's flag, #279 – the core
    // blanks the title too; a title stands in here to show the rule's two sides); the regular
    // page's pill carries the chip.
    const privateTab = tab('https://music.example.com/', { id: 'p1', containerId: 'private' })
    const s = playing(state(page, { tabs: { t1: page, p1: privateTab } }))
    s.media = [{ ...s.media![0]!, tabId: 'p1', private: true }]
    const row = (): PillChipModel['row'] =>
      phonePillChips(s, page, ctx).find((c) => c.id === 'media')?.row
    expect(row()?.value).toBe('Nocturne')
    privateLockStore.set({ locked: true })
    expect(row()?.label).toBe('Now playing')
    expect(row()?.value).toBe('Private tab')
    // The cover still over the page as the lock lifts: masked until it lands.
    privateLockStore.set({ locked: false, lifting: true })
    expect(row()?.value).toBe('Private tab')
    privateLockStore.set({ lifting: false })
    expect(row()?.value).toBe('Nocturne')
    // A regular tab's session (no flag) is never masked.
    privateLockStore.set({ locked: true })
    expect(
      phonePillChips(playing(state(page)), page, ctx).find((c) => c.id === 'media')?.row?.value
    ).toBe('Nocturne')
  })

  it('the media row opens the player for the session’s tab, and the sheet leaves for it', async () => {
    const [media] = phonePillChips(playing(state(page)), page, ctx).filter((c) => c.id === 'media')
    uiStore.set({ siteInfoOpen: true })
    siteInfoStore.set({ tabId: 't1', anchor: null })
    media!.row!.activate()
    expect(uiStore.get().siteInfoOpen).toBe(false)
    await vi.waitFor(() => expect(uiStore.get().mediaSheet).toBe('t1'))
  })

  it('says on the shield’s row when nothing is blocked here, and speaks nothing of it on a quiet page', () => {
    const quiet = phonePillChips(state(page), page, ctx)
    expect(quiet.find((c) => c.id === 'blocked')?.row?.value).toBe('0')
    expect(quiet.find((c) => c.id === 'blocked')?.spoken).toBe('')
    const excepted = phonePillChips(
      state(page, { blocking: { enabled: true, siteExceptions: ['https://github.com'] } } as never),
      page,
      ctx
    )
    expect(excepted.find((c) => c.id === 'blocked')?.row?.value).toBe('Off for this site')
    expect(excepted.find((c) => c.id === 'blocked')?.spoken).toBe('Blocking off for this site')
    const off = phonePillChips(
      state(page, { blocking: { enabled: false, siteExceptions: [] } } as never),
      page,
      ctx
    )
    expect(off.find((c) => c.id === 'blocked')?.row?.value).toBe('Blocking off')
  })

  it('has no chips for an internal page, no lock on an http page, nothing without a tab', () => {
    expect(phonePillChips(state(tab('zen://settings')), tab('zen://settings'), ctx)).toEqual([])
    const plain = tab('http://example.com/')
    expect(phonePillChips(state(plain), plain, ctx).map((c) => c.id)).toEqual(['blocked'])
    expect(phonePillChips(state(page), null, ctx)).toEqual([])
  })

  it('draws no lock over a certificate that failed verification, proceeded past or not; the shield keeps its row', () => {
    const failed = {
      code: -201,
      url: 'https://expired.badssl.com/',
      certificate: null,
      bypassed: false
    }
    for (const bypassed of [false, true]) {
      const t = tab('https://expired.badssl.com/', {
        blockedCount: 2,
        certificateError: { ...failed, bypassed }
      })
      const chips = phonePillChips(state(t), t, ctx)
      expect(chips.map((c) => c.id)).toEqual(['blocked'])
      expect(chips[0].row?.label).toBe('Requests blocked')
      expect(pillChipsDrawn(chips)).toEqual([])
    }
  })

  it('the translate row still offers, and the sheet goes for the bar', async () => {
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

  it('the shield’s row leads to the blocking settings, and the sheet leaves for them', async () => {
    const [blocked] = phonePillChips(state(counted), counted, ctx).filter((c) => c.id === 'blocked')
    uiStore.set({ siteInfoOpen: true })
    siteInfoStore.set({ tabId: 't1', anchor: null })
    blocked!.row!.activate()
    await vi.waitFor(() => expect(invoke.mock.calls.map(([name]) => name)).toContain('page.open'))
    const [, args] = invoke.mock.calls.find(([name]) => name === 'page.open')!
    expect(args).toMatchObject({ id: 'settings', section: 'privacy' })
  })
})

describe('pillChipRows: what the sheet lists', () => {
  it('is the shield and the translate offer of this tab, in the pill’s order, whatever else is up', () => {
    const rows = pillChipRows(playing(offered(state(counted))), counted, ctx)
    expect(rows.map((r) => r.id)).toEqual(['blocked', 'translate'])
    expect(rows.map((r) => r.row.value)).toEqual(['5', 'German to English'])
  })

  it('is the shield alone without an offer, and empty for an internal page', () => {
    expect(pillChipRows(state(page), page, ctx).map((r) => r.id)).toEqual(['blocked'])
    expect(pillChipRows(state(tab('zen://settings')), tab('zen://settings'), ctx)).toEqual([])
  })

  it('pillChipsDrawn is the pill’s side of the same rule: the media chip in the lock’s slot while it plays', () => {
    const chips = phonePillChips(playing(offered(state(counted))), counted, ctx)
    expect(pillChipsDrawn(chips).map((c) => c.id)).toEqual(['media'])
    expect(foldPhonePillChips(chips).yielded.map((c) => c.id)).toEqual(['lock'])
    expect(pillChipsSpoken(chips)).toEqual(['5 requests blocked', 'Translation offered'])
  })
})

describe('the glyph slot: one live state at a time (§9.29)', () => {
  const s = offered(state(counted))

  it('the lock gives way to the media chip and returns when the media stops', () => {
    expect(pillChipsDrawn(phonePillChips(s, counted, ctx)).map((c) => c.id)).toEqual(['lock'])
    expect(pillChipsDrawn(phonePillChips(playing(s), counted, ctx)).map((c) => c.id)).toEqual([
      'media'
    ])
    expect(pillChipsDrawn(phonePillChips(s, counted, ctx)).map((c) => c.id)).toEqual(['lock'])
  })

  it('a second state never stacks: the newer shows, the older waits in the sheet as a row and is spoken at the address', () => {
    const media = phonePillChips(playing(s), counted, ctx)
    expect(pillChipsDrawn(media).map((c) => c.id)).toEqual(['media'])
    // A save prompt arrives while the media plays: the key takes the slot, the media chip is a
    // row under the shield and the offer, and the address says it is playing.
    const both = [...media, savePrompt]
    const fold = foldPhonePillChips(both)
    expect(fold.shown.map((c) => c.id)).toEqual(['save-prompt'])
    expect(fold.folded.map((c) => c.id)).toEqual(['blocked', 'translate', 'media'])
    expect(fold.folded.every((c) => c.row !== undefined)).toBe(true)
    expect(pillChipsSpoken(both)).toEqual([
      '5 requests blocked',
      'Translation offered',
      'Now playing'
    ])
    // The prompt is answered: the media chip has the slot again.
    expect(pillChipsDrawn(media).map((c) => c.id)).toEqual(['media'])
  })

  it('order of arrival decides: a media session starting under a live key takes the slot from it', () => {
    const chips = phonePillChips(s, counted, ctx)
    expect(pillChipsDrawn([...chips, savePrompt]).map((c) => c.id)).toEqual(['save-prompt'])
    const media = phonePillChips(playing(s), counted, ctx)
    expect(pillChipsDrawn([...media, savePrompt]).map((c) => c.id)).toEqual(['media'])
    expect(foldPhonePillChips([...media, savePrompt]).folded.map((c) => c.id)).toEqual([
      'blocked',
      'translate',
      'save-prompt'
    ])
  })

  it('the pill and the sheet fold by one record, so they agree on which state waits', () => {
    const pill = foldPhonePillChips([...phonePillChips(playing(s), counted, ctx), savePrompt])
    const sheet = foldPhonePillChips([...phonePillChips(playing(s), counted, ctx), savePrompt])
    expect(pill.shown.map((c) => c.id)).toEqual(['save-prompt'])
    expect(sheet.folded.map((c) => c.id)).toEqual(['blocked', 'translate', 'media'])
    // Both states end: the sheet lists the shield and the offer alone and the record is empty.
    expect(pillChipRows(s, counted, ctx).map((r) => r.id)).toEqual(['blocked', 'translate'])
    expect(pillChipsDrawn(phonePillChips(s, counted, ctx)).map((c) => c.id)).toEqual(['lock'])
  })
})

describe('PillContent at rest', () => {
  it('shows the favicon, the host and the lock alone on Bennett’s page: the shield and the offer are the sheet’s', () => {
    const el = render(
      <PillContent state={offered(state(counted))} tab={counted} space={space} interactive />
    )
    expect(shown(el)).toEqual(['lock'])
    // The address speaks #237's connection state first, then the sheet chips' states (A11Y-01).
    expect(labels(el)).toEqual([
      'Address, github.com, Connection is secure, 5 requests blocked, Translation offered',
      'Site information',
      'Connection is secure'
    ])
    expect(el.querySelector('.zen-v2-badge')).toBeNull()
    expect(el.querySelector('[data-translate]')).toBeNull()
    expect(el.querySelector('.zen-v2-blocked-chip')).toBeNull()
  })

  it('keeps the address label #237’s alone on a quiet page', () => {
    const el = render(<PillContent state={state(page)} tab={page} space={space} interactive />)
    expect(shown(el)).toEqual(['lock'])
    expect(addressLabel(el)).toBe('Address, github.com, Connection is secure')
  })

  it('a live Now playing chip takes the lock’s slot: the lock gives way, the chip is its own stop, the address says nothing of it', () => {
    const el = render(
      <PillContent
        state={playing(offered(state(counted)))}
        tab={counted}
        space={space}
        interactive
      />
    )
    expect(shown(el)).toEqual(['media'])
    // The lock gave way, but the address still speaks the connection's state (#237, A11Y-01).
    expect(labels(el)).toEqual([
      'Address, github.com, Connection is secure, 5 requests blocked, Translation offered',
      'Site information',
      'Now playing'
    ])
    expect(el.querySelector('[data-media]')?.getAttribute('aria-label')).toBe('Now playing')
    expect(el.querySelector('[data-site-info]')).not.toBeNull()
  })

  it('the lock returns when the media stops', () => {
    const el = render(
      <PillContent state={playing(state(page))} tab={page} space={space} interactive />
    )
    expect(shown(el)).toEqual(['media'])
    act(() =>
      root!.render(<PillContent state={state(page)} tab={page} space={space} interactive />)
    )
    expect(shown(el)).toEqual(['lock'])
    expect(labels(el)).toEqual([
      'Address, github.com, Connection is secure',
      'Site information',
      'Connection is secure'
    ])
  })

  it('has no chip run at all on an http page: the shield went to the sheet and there is no lock', () => {
    const plain = tab('http://example.com/')
    const el = render(<PillContent state={state(plain)} tab={plain} space={space} interactive />)
    expect(shown(el)).toEqual([])
    expect(el.querySelector('[data-testid="pill-chips"]')).toBeNull()
    expect(labels(el)).toEqual(['Address, example.com, Not secure', 'Site information'])
  })

  it('the carried pill draws the same run inert', () => {
    const el = render(
      <PillContent
        state={playing(offered(state(counted)))}
        tab={counted}
        space={space}
        interactive={false}
      />
    )
    expect(shown(el)).toEqual(['media'])
    expect(el.querySelectorAll('button').length).toBe(0)
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
  const drawn = (s: UIState, t: Tab): ReturnType<typeof phonePillChips> =>
    pillChipsDrawn(phonePillChips(s, t, ctx))

  it('swaps the lock for the media chip in the one slot: a ghost of the lock fades out where it stood, the chip fades in there, gone after 120 ms, never a slide', () => {
    vi.useFakeTimers()
    const [lock] = drawn(state(page), page)
    const [media] = drawn(playing(state(page)), page)
    expect([lock!.id, media!.id]).toEqual(['lock', 'media'])
    const el = render(<ChipRun chips={[lock!]} interactive />)
    expect(ghostOf(el)).toBeNull()
    expect(fades).toEqual([])
    // The media starts: one commit, one ghost of [lock] over the new [media], both runs
    // anchored at their end – the same slot.
    act(() => root!.render(<ChipRun chips={[media!]} interactive />))
    const ghost = ghostOf(el)
    expect(ghost).not.toBeNull()
    expect(ghost!.getAttribute('aria-hidden')).toBe('true')
    expect(ghost!.querySelectorAll('button').length).toBe(0)
    const copies = Array.from(ghost!.children) as HTMLElement[]
    expect(copies.length).toBe(1)
    // Opacity is all that moves, at 120 ms: the lock's copy out, the live media chip in.
    expect(copies.map((c) => c.style.visibility)).toEqual([''])
    expect(fades.map((f) => [f.from, f.to, f.duration])).toEqual([
      [1, 0, CHIP_FOLD_FADE_MS],
      [0, 1, CHIP_FOLD_FADE_MS]
    ])
    expect(fades.map((f) => f.el)).toEqual([copies[0], liveChip(el, 'media')])
    act(() => {
      vi.advanceTimersByTime(CHIP_FOLD_FADE_MS)
    })
    expect(ghostOf(el)).toBeNull()
    expect(shown(el)).toEqual(['media'])
    // The media stops: the lock returns the same way.
    act(() => root!.render(<ChipRun chips={[lock!]} interactive />))
    expect(fades.slice(2).map((f) => [f.to, f.el])).toEqual([
      [0, ghostOf(el)!.children[0]],
      [1, liveChip(el, 'lock')]
    ])
  })

  it('hides the ghost copy of a chip that keeps its slot from the run’s end (a run of more than one)', () => {
    vi.useFakeTimers()
    const [lock] = drawn(state(page), page)
    const [media] = drawn(playing(state(page)), page)
    const el = render(<ChipRun chips={[lock!, media!]} interactive />)
    // The first chip leaves alone: the last stands where it stood, at the end, and neither
    // moves nor flickers.
    act(() => root!.render(<ChipRun chips={[media!]} interactive />))
    const copies = Array.from(ghostOf(el)!.children) as HTMLElement[]
    expect(copies.map((c) => c.style.visibility)).toEqual(['', 'hidden'])
    expect(fades.map((f) => [f.el, f.to])).toEqual([[copies[0], 0]])
    expect(fades.some((f) => f.el === liveChip(el, 'media'))).toBe(false)
  })

  it('does not start the fade over when the pill re-renders during it', () => {
    vi.useFakeTimers()
    const [lock] = drawn(state(page), page)
    const [media] = drawn(playing(state(page)), page)
    render(<ChipRun chips={[lock!]} interactive />)
    act(() => root!.render(<ChipRun chips={[media!]} interactive />))
    expect(fades.length).toBe(2)
    // The same set again as new objects (a store change): the run keeps its ghost and its
    // running fades, and the ghost still goes at the 120 ms mark, not later.
    act(() => {
      vi.advanceTimersByTime(CHIP_FOLD_FADE_MS / 2)
    })
    const again = drawn(playing(state(page)), page)
    expect(again.map((c) => c.id)).toEqual(['media'])
    act(() => root!.render(<ChipRun chips={again} interactive />))
    expect(fades.length).toBe(2)
    expect(ghostOf(host!)).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(CHIP_FOLD_FADE_MS / 2)
    })
    expect(ghostOf(host!)).toBeNull()
  })

  it('leaves nothing behind when the last chip goes', () => {
    vi.useFakeTimers()
    const [lock] = drawn(state(page), page)
    const el = render(<ChipRun chips={[lock!]} interactive />)
    act(() => root!.render(<ChipRun chips={[]} interactive />))
    // The run stays up for the ghost's 120 ms, then is gone altogether.
    expect(ghostOf(el)).not.toBeNull()
    expect(fades.map((f) => f.to)).toEqual([0])
    act(() => {
      vi.advanceTimersByTime(CHIP_FOLD_FADE_MS)
    })
    expect(el.querySelector('[data-testid="pill-chips"]')).toBeNull()
  })

  it('draws the carried pill’s run plain: no ghost on a change', () => {
    vi.useFakeTimers()
    const [lock] = drawn(state(page), page)
    const [media] = drawn(playing(state(page)), page)
    const el = render(<ChipRun chips={[lock!]} interactive={false} />)
    act(() => root!.render(<ChipRun chips={[media!]} interactive={false} />))
    expect(ghostOf(el)).toBeNull()
    expect(fades).toEqual([])
  })
})

/*
 * The other half, rendered for real: the site-information sheet on the chassis, the chips'
 * rows at the top of its root level – the same names, states and actions the chips had, as
 * TalkBack will read them ("Requests blocked, 5") and as a finger will take them.
 */
describe('the site-information sheet lists the chips as rows', () => {
  const initialViewport = viewportStore.get()
  const heights = {
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  }
  beforeEach(() => {
    // happy-dom lays nothing out: the layer 800 tall, the sheet's content 300, as the media
    // sheet's test has it – the chassis measures its detents from these.
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
  })
  afterEach(() => {
    viewportStore.set(initialViewport)
    for (const [name, descriptor] of Object.entries(heights)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    }
    uiStore.set({ siteInfoOpen: false, mediaSheet: null, overlay: 'none' })
    siteInfoStore.set({ tabId: null, anchor: null })
  })

  /** The sheet up for `t1` on a phone, its first reading of the site answered (with nothing). */
  async function open(s: UIState): Promise<HTMLElement> {
    // The store's other readers (the back gesture's root action) want the sidebar's collections too.
    browserStore.set({ state: { ...s, folders: {}, essentialTabIds: [], glance: null } as UIState })
    // A phone, set after the browser state: the viewport re-derives itself from the window on
    // every snapshot, and happy-dom's window is a desktop's.
    viewportStore.set({ ...viewportStore.get(), coarse: true, hover: false, formFactor: 'phone' })
    uiStore.set({ siteInfoOpen: true })
    siteInfoStore.set({ tabId: 't1', anchor: null, revision: 0 })
    const el = render(<SiteInfoLayer />)
    await act(async () => {
      await Promise.resolve()
    })
    return el
  }
  const group = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-testid="siteinfo-pill-chips"]')
  const rows = (): HTMLButtonElement[] =>
    Array.from(group()?.querySelectorAll<HTMLButtonElement>('button.zen-sheet-item') ?? [])
  const row = (label: string): HTMLButtonElement | undefined =>
    rows().find((r) => r.getAttribute('aria-label')?.startsWith(label))
  const commands = (): string[] => invoke.mock.calls.map(([name]) => name)

  it('puts the shield with its count and the translate offer first on the root level, over a hairline, each a chassis row named by its state', async () => {
    await open(offered(state(counted)))
    expect(group()).not.toBeNull()
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Requests blocked, 5',
      'Translate this page, German to English'
    ])
    // The chip's own words and formatting on the row: the count as the value, the pair on offer
    // in the bar's words.
    expect(row('Requests blocked')!.querySelector('.zen-sheet-item-value')?.textContent).toBe('5')
    expect(row('Translate this page')!.querySelector('.zen-sheet-item-value')?.textContent).toBe(
      'German to English'
    )
    expect(group()!.querySelector('.zen-sheet-sep')).not.toBeNull()
    // Above the sheet's own rows: Connection is the first of those.
    const items = Array.from(document.querySelectorAll<HTMLElement>('.zen-sheet .zen-sheet-item'))
    const connection = items.findIndex((el) =>
      el.getAttribute('aria-label')?.startsWith('Connection')
    )
    expect(connection).toBeGreaterThan(-1)
    expect(items.indexOf(row('Requests blocked')!)).toBeLessThan(connection)
    expect(items.indexOf(row('Translate this page')!)).toBeLessThan(connection)
    // No heading over them: the rows name themselves.
    expect(group()!.querySelector('.zen-sheet-heading')).toBeNull()
  })

  it('the translate row still offers – the bar is raised and the sheet leaves for it', async () => {
    await open(offered(state(counted)))
    act(() => row('Translate this page')!.click())
    await vi.waitFor(() => expect(commands()).toContain('translate.offer'))
    const [, args] = invoke.mock.calls.find(([name]) => name === 'translate.offer')!
    expect(args).toMatchObject({ tabId: 't1' })
    await vi.waitFor(() => expect(uiStore.get().siteInfoOpen).toBe(false))
  })

  it('the shield’s row leads on to Settings › Privacy and security, where the lists and the site exceptions are', async () => {
    await open(offered(state(counted)))
    act(() => row('Requests blocked')!.click())
    await vi.waitFor(() => expect(commands()).toContain('page.open'))
    const [, args] = invoke.mock.calls.find(([name]) => name === 'page.open')!
    expect(args).toMatchObject({ id: 'settings', section: 'privacy' })
  })

  it('lists the shield alone on a quiet page with no offer, its count 0; nothing on an internal page', async () => {
    await open(state(page))
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual(['Requests blocked, 0'])
    act(() => root?.unmount())
    host?.remove()
    const settings = tab('zen://settings')
    await open(state(settings))
    expect(group()).toBeNull()
  })

  it('does not list the media chip while it has the pill’s slot: the shield and the offer alone (its waiting row is the model’s case above)', async () => {
    await open(playing(offered(state(counted))))
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Requests blocked, 5',
      'Translate this page, German to English'
    ])
  })
})
