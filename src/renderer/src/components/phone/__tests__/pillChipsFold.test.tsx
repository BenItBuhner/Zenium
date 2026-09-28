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
const counted: Tab = {
  ...page,
  blockedCount: 5,
  // The tracker report behind the count (PS-33), in the order the engine met the sites.
  blockedSites: [
    { domain: 'example-cdn.com', category: 'user', count: 2 },
    { domain: 'doubleclick.net', category: 'tracker', count: 3 }
  ]
}

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
    expect(rows.blocked?.label).toBe('Trackers blocked')
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

  it('the shield’s row opens Settings › Privacy asked for the page’s site, and the sheet leaves for the tab', () => {
    // A phone with page tabs: Settings is a tab, so the sheet is dismissed before it opens
    // (N3 from #260's review: the site's own group is one screen down – the address names the
    // site, and the page opens with "Block on github.com" on screen).
    const s = state(counted, { folders: {}, essentialTabIds: [] })
    s.capabilities = { ...s.capabilities, pageTabs: true }
    browserStore.set({ state: s })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    const [blocked] = phonePillChips(s, counted, ctx).filter((c) => c.id === 'blocked')
    uiStore.set({ siteInfoOpen: true })
    siteInfoStore.set({ tabId: 't1', anchor: null })
    blocked!.row!.activate()
    expect(uiStore.get().siteInfoOpen).toBe(false)
    expect(invoke).toHaveBeenCalledWith('page.open', {
      id: 'settings',
      section: 'privacy',
      query: { site: 'https://github.com' }
    })
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

  it('has no chips for an internal page, the Not secure glyph on an http page, nothing without a tab', () => {
    expect(phonePillChips(state(tab('zen://settings')), tab('zen://settings'), ctx)).toEqual([])
    const plain = tab('http://example.com/')
    const chips = phonePillChips(state(plain), plain, ctx)
    expect(chips.map((c) => [c.id, c.fold])).toEqual([
      ['not-secure', 'glyph'],
      ['blocked', 'sheet']
    ])
    // The glyph says nothing of its own at the address: the address already speaks "Not secure".
    expect(chips[0]!.spoken).toBe('')
    expect(chips[0]!.row).toBeUndefined()
    expect(phonePillChips(state(page), null, ctx)).toEqual([])
  })

  it('draws the danger triangle, not a lock, over a certificate that failed verification, proceeded past or not; the shield keeps its row', () => {
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
      expect(chips.map((c) => c.id)).toEqual(['certificate-error', 'blocked'])
      expect(chips[1]!.row?.label).toBe('Trackers blocked')
      expect(pillChipsDrawn(chips).map((c) => c.id)).toEqual(['certificate-error'])
    }
    // A certificate error the core reports by its net error code alone reads the same.
    const coded = tab('https://expired.badssl.com/', { errorCode: -201 })
    expect(pillChipsDrawn(phonePillChips(state(coded), coded, ctx)).map((c) => c.id)).toEqual([
      'certificate-error'
    ])
  })

  it('the interstitials carry the verdict the address speaks; a plain error page, the private lock, nothing', () => {
    // The Safe Browsing and HTTPS-only interstitials stand at the address they block (the pill
    // shows that host): the shield in the danger ink, the open lock in the warn ink, as Chrome's
    // omnibox marks its interstitials.
    const blocked = tab('zen://error?kind=safebrowsing&url=https%3A%2F%2Fevil.example%2F')
    expect(phonePillChips(state(blocked), blocked, ctx).map((c) => c.id)).toEqual(['dangerous'])
    const upgrade = tab('zen://error?kind=https-only&url=http%3A%2F%2Fexample.com%2F')
    expect(phonePillChips(state(upgrade), upgrade, ctx).map((c) => c.id)).toEqual(['not-secure'])
    // A page that did not load is an internal page: no site, no verdict.
    const failed = tab('zen://error?code=-105&url=http%3A%2F%2Fexample.com%2F', { errorCode: -105 })
    expect(phonePillChips(state(failed), failed, ctx)).toEqual([])
    // Under the private lock nothing of the page is said (INC-05).
    const plain = tab('http://example.com/')
    expect(phonePillChips(state(plain), plain, { ...ctx, locked: true })).toEqual([])
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

  /*
   * PUI-14 (§9.29's reader chip; the design gate for #491) as CT-37's phone half amends it: on
   * an article page – the reader probe's verdict on the tab, the same predicate the §9.33 offer
   * stands on – the sheet lists a Reader View row after the translate offer, and the pill draws
   * the chip in the glyph slot while the slot is quiet (the readerable indicator), the lock
   * giving way; its own stop speaks it, so the address does not. Not on a page the probe did
   * not read as an article, not in Reader View itself, not on an internal page.
   */
  it('lists the Reader View row on an article page, after the offer, and draws the chip in the quiet slot (CT-37)', () => {
    const article = tab('https://news.example.com/story', { readerable: true, blockedCount: 5 })
    const chips = phonePillChips(offered(state(article)), article, ctx)
    expect(chips.map((c) => [c.id, c.fold])).toEqual([
      ['lock', 'glyph'],
      ['blocked', 'sheet'],
      ['translate', 'sheet'],
      ['reader', 'offer']
    ])
    const reader = chips.find((c) => c.id === 'reader')!
    expect(reader.render).toBeDefined()
    expect(reader.row?.label).toBe('Reader View')
    expect(reader.row?.value).toBeUndefined()
    expect(pillChipsDrawn(chips).map((c) => c.id)).toEqual(['reader'])
    // Spoken at its own stop, not at the address (it would be heard twice).
    expect(pillChipsSpoken(chips)).toEqual(['5 requests blocked', 'Translation offered'])
    expect(pillChipRows(offered(state(article)), article, ctx).map((r) => r.id)).toEqual([
      'blocked',
      'translate',
      'reader'
    ])
  })

  it('has no Reader View row on a page that is no article or on an internal page; in Reader View itself the row is the exit’s', () => {
    const ids = (t: Tab): string[] => phonePillChips(state(t), t, ctx).map((c) => c.id)
    expect(ids(page)).toEqual(['lock', 'blocked'])
    expect(
      ids(tab('https://news.example.com/story', { readerable: true, discarded: true }))
    ).toEqual(['lock', 'blocked'])
    const reader = tab('zen://reader?id=article_1&url=https%3A%2F%2Fnews.example.com%2Fstory', {
      readerable: true
    })
    // Reader View's own pill reads the article's identity (the lock) and lists the row as the
    // exit, its value the state it reports (§9.29 as amended: the lit exit's row under every state).
    // (No shield: the reader page has no site of its own to block for, as before.)
    expect(ids(reader)).toEqual(['lock', 'reader'])
    const rows = pillChipRows(state(reader), reader, ctx)
    expect(rows.map((r) => [r.id, r.row.label, r.row.value])).toEqual([
      ['reader', 'Reader View', 'On']
    ])
    expect(ids(tab('zen://settings', { readerable: true }))).toEqual([])
  })

  it('the Reader View row opens Reader View for the tab by the offer’s door, and the sheet leaves', async () => {
    // Off the chassis whose chrome lies under the pages the crossing is the core's plain toggle
    // (the rendered sheet below runs it on the phone).
    const article = tab('https://news.example.com/story', { readerable: true })
    const [reader] = phonePillChips(state(article), article, ctx).filter((c) => c.id === 'reader')
    uiStore.set({ siteInfoOpen: true })
    siteInfoStore.set({ tabId: 't1', anchor: null })
    reader!.row!.activate()
    expect(uiStore.get().siteInfoOpen).toBe(false)
    await vi.waitFor(() =>
      expect(invoke.mock.calls.map(([name]) => name)).toContain('reader.toggle')
    )
    const [, args] = invoke.mock.calls.find(([name]) => name === 'reader.toggle')!
    expect(args).toEqual({ tabId: 't1' })
  })
})

describe('the quiet notification ask in the pill (NOT-03)', () => {
  /** The page's quiet notification prompt in the core's queue (`webNotifications.ts`). */
  function quiet(s: UIState, tabId = 't1'): UIState {
    return {
      ...s,
      permissionPrompts: [
        {
          id: 'perm-q1',
          tabId,
          origin: 'https://github.com',
          permission: 'notifications',
          message: 'Notifications blocked',
          detail: 'You usually block notifications. To let github.com notify you, choose Allow.',
          allowLabel: 'Allow',
          blockLabel: 'Keep blocking',
          allowOnce: false,
          requestedAt: 0,
          quiet: true
        }
      ]
    }
  }

  it('is the quiet state chip named as Chrome names it, in the glyph’s slot at rest: the lock gives way', () => {
    const chips = phonePillChips(quiet(offered(state(counted))), counted, ctx)
    expect(chips.map((c) => [c.id, c.fold])).toEqual([
      ['lock', 'glyph'],
      ['notifications-blocked', 'quiet'],
      ['blocked', 'sheet'],
      ['translate', 'sheet']
    ])
    const fold = foldPhonePillChips(chips)
    expect(fold.shown.map((c) => c.id)).toEqual(['notifications-blocked'])
    expect(fold.yielded.map((c) => c.id)).toEqual(['lock'])
    const bell = chips.find((c) => c.id === 'notifications-blocked')!
    expect(bell.spoken).toBe('Notifications blocked')
    expect(bell.row?.label).toBe('Notifications blocked')
    // Answered or withdrawn, the bell is gone and the lock is back.
    const after = foldPhonePillChips(phonePillChips(offered(state(counted)), counted, ctx))
    expect(after.shown.map((c) => c.id)).toEqual(['lock'])
  })

  it('draws the bell in the slot’s rest ink – 69 %, the secure lock’s and a stored block’s – not the full ink (the design gate on §9.29)', () => {
    const chips = phonePillChips(quiet(state(page)), page, ctx)
    const bell = chips.find((c) => c.id === 'notifications-blocked')!
    const el = render(<>{bell.render!(true)}</>)
    const button = el.querySelector<HTMLButtonElement>('[data-testid="quiet-bell"]')!
    expect(button.classList.contains('zen-pill-quiet')).toBe(true)
    // The same rest class the lock wears on a secure page: one ink for what rests in the slot.
    const lock = chips.find((c) => c.id === 'lock')!
    act(() => root!.render(<>{lock.render!(true)}</>))
    expect(el.querySelector('[data-site-info]')?.classList.contains('zen-pill-quiet')).toBe(true)
  })

  it('a tap on the bell opens the quiet prompt’s sheet, from the pill and from its sheet row', () => {
    const chips = phonePillChips(quiet(state(page)), page, ctx)
    const bell = chips.find((c) => c.id === 'notifications-blocked')!
    uiStore.set({ siteInfoOpen: true, quietPromptId: null })
    siteInfoStore.set({ tabId: 't1', anchor: null })
    bell.row!.activate()
    expect(uiStore.get().quietPromptId).toBe('perm-q1')
    expect(uiStore.get().siteInfoOpen).toBe(false)
    uiStore.set({ quietPromptId: null })
    const el = render(<>{bell.render!(true)}</>)
    const button = el.querySelector<HTMLButtonElement>('[data-testid="quiet-bell"]')!
    expect(button.getAttribute('aria-label')).toBe('Notifications blocked')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    const open = phonePillChips(quiet(state(page)), page, { ...ctx, quietPromptOpen: true }).find(
      (c) => c.id === 'notifications-blocked'
    )!.render!(true)
    act(() => root!.render(<>{open}</>))
    expect(el.querySelector('[data-testid="quiet-bell"]')?.getAttribute('aria-expanded')).toBe(
      'true'
    )
  })

  it('under the danger glyph the bell is the sheet’s row (§9.29: the identity in question keeps the slot)', () => {
    const failed = tab('https://expired.badssl.com/', {
      certificateError: {
        code: -201,
        url: 'https://expired.badssl.com/',
        certificate: null,
        bypassed: true
      }
    })
    const chips = phonePillChips(quiet(state(failed)), failed, ctx)
    expect(chips.map((c) => [c.id, c.fold])).toEqual([
      ['certificate-error', 'glyph'],
      ['notifications-blocked', 'sheet'],
      ['blocked', 'sheet']
    ])
    const fold = foldPhonePillChips(chips)
    expect(fold.shown.map((c) => c.id)).toEqual(['certificate-error'])
    expect(fold.folded.map((c) => c.id)).toEqual(['notifications-blocked', 'blocked'])
  })

  it('behind a newer state the bell waits in the sheet as a row; another tab’s ask is not this pill’s', () => {
    // The bell first, then the media session: the newer state has the slot, the bell its row.
    foldPhonePillChips(phonePillChips(quiet(state(page)), page, ctx))
    const fold = foldPhonePillChips(phonePillChips(playing(quiet(state(page))), page, ctx))
    expect(fold.shown.map((c) => c.id)).toEqual(['media'])
    expect(fold.folded.map((c) => c.id)).toEqual(['notifications-blocked', 'blocked'])
    expect(
      pillChipsSpoken(phonePillChips(playing(quiet(state(page))), page, ctx)).filter(Boolean)
    ).toEqual(['Notifications blocked'])
    expect(
      phonePillChips(quiet(state(page), 't2'), page, ctx).some(
        (c) => c.id === 'notifications-blocked'
      )
    ).toBe(false)
  })

  it('PillContent draws the bell in the lock’s room, its own stop; the address label speaks nothing of it', () => {
    const s = quiet(state(page))
    const el = render(<PillContent state={s} tab={page} space={space} interactive />)
    expect(shown(el)).toEqual(['notifications-blocked'])
    expect(labels(el)).toEqual([
      'Address, github.com, Connection is secure',
      'Site information',
      'Notifications blocked'
    ])
    expect(addressLabel(el)).not.toContain('Notifications blocked')
  })
})

describe('the readerable indicator in the pill (CT-37; Chrome’s adaptive Reader mode button)', () => {
  const article = tab('https://news.example.com/story', { readerable: true })
  const readerChip = (el: ParentNode): HTMLButtonElement | null =>
    el.querySelector<HTMLButtonElement>('[data-reader-chip]')

  it('appears when the probe reads the page as an article: the one offer, in the glyph slot, the lock giving way; the row stays', () => {
    const chips = phonePillChips(state(article), article, ctx)
    expect(chips.map((c) => [c.id, c.fold])).toEqual([
      ['lock', 'glyph'],
      ['blocked', 'sheet'],
      ['reader', 'offer']
    ])
    const fold = foldPhonePillChips(chips)
    expect(fold.shown.map((c) => c.id)).toEqual(['reader'])
    expect(fold.yielded.map((c) => c.id)).toEqual(['lock'])
    // Mutant M1 (the chip built without `render`): the slot would draw nothing for the offer.
    expect(fold.shown[0]!.render).toBeDefined()
    // Mutant M2 (the offer dropped from `folded` while drawn): #491's sheet row would go.
    expect(pillChipRows(state(article), article, ctx).map((r) => r.id)).toEqual([
      'blocked',
      'reader'
    ])
  })

  it('disappears when the verdict flips back – a navigation resets `readerable` – and the lock returns', () => {
    const plain = { ...article, readerable: false }
    const fold = foldPhonePillChips(phonePillChips(state(plain), plain, ctx))
    expect(fold.shown.map((c) => c.id)).toEqual(['lock'])
    expect(fold.yielded).toEqual([])
    expect(pillChipRows(state(plain), plain, ctx).map((r) => r.id)).toEqual(['blocked'])
  })

  it('is drawn with the book glyph in the slot’s rest ink, named Reader View, described in the desktop chip’s words, its own stop', () => {
    const el = render(
      <PillContent state={state(article)} tab={article} space={space} interactive />
    )
    expect(shown(el)).toEqual(['reader'])
    const chip = readerChip(el)!
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.getAttribute('aria-label')).toBe('Reader View')
    expect(chip.getAttribute('aria-description')).toBe('Enter Reader View')
    expect(chip.getAttribute('data-tooltip')).toBe('Enter Reader View')
    expect(chip.getAttribute('aria-haspopup')).toBeNull()
    expect(chip.classList.contains('zen-pill-quiet')).toBe(true)
    expect(chip.querySelector('svg.lucide-book-open-text')).not.toBeNull()
    expect(labels(el)).toEqual([
      'Address, news.example.com, Connection is secure',
      'Site information',
      'Reader View'
    ])
    // Mutant M3 (`pillChipsSpoken` speaking every folded chip): "Reader View available" twice.
    expect(addressLabel(el)).not.toContain('Reader View')
    // No lock beside it: the run is the one glyph slot (§9.29).
    expect(el.querySelector('[data-site-info][data-verdict]')).toBeNull()
  })

  it('the carried pill draws it inert, a picture of the docked one', () => {
    const el = render(
      <PillContent state={state(article)} tab={article} space={space} interactive={false} />
    )
    expect(shown(el)).toEqual(['reader'])
    expect(readerChip(el)).toBeNull()
    expect(el.querySelector('[data-testid="pill-chips"] [aria-hidden="true"]')).not.toBeNull()
  })

  it('a tap opens Reader View by the same door as the sheet’s row and the app menu (the crossing’s toggle)', async () => {
    const chips = phonePillChips(state(article), article, ctx)
    const reader = chips.find((c) => c.id === 'reader')!
    reader.row!.activate()
    await vi.waitFor(() =>
      expect(invoke.mock.calls.map(([name]) => name)).toContain('reader.toggle')
    )
    expect(invoke.mock.calls.find(([name]) => name === 'reader.toggle')![1]).toEqual({
      tabId: 't1'
    })
    // The pill's own route (`PhoneShell`'s tap): the same helper, no sheet to close first.
    invoke.mockClear()
    const { enterReaderView } = await import('../pillChips')
    enterReaderView('t1')
    await vi.waitFor(() =>
      expect(invoke.mock.calls.map(([name]) => name)).toContain('reader.toggle')
    )
    expect(uiStore.get().siteInfoOpen).toBe(false)
  })

  it('never displaces a status glyph: on a plain http article the open lock keeps the slot and the chip is the sheet’s row (Mutant M4: the tone check dropped)', () => {
    const http = tab('http://news.example.com/story', { readerable: true })
    const chips = phonePillChips(state(http), http, ctx)
    expect(chips.map((c) => [c.id, c.fold])).toEqual([
      ['not-secure', 'glyph'],
      ['blocked', 'sheet'],
      ['reader', 'sheet']
    ])
    expect(pillChipsDrawn(chips).map((c) => c.id)).toEqual(['not-secure'])
    expect(pillChipRows(state(http), http, ctx).map((r) => r.id)).toEqual(['blocked', 'reader'])
    // Spoken at the address while it is the sheet's alone.
    expect(pillChipsSpoken(chips)).toEqual(['', 'Reader View available'])
    // Over a failed certificate the same: the identity in question beats an offer.
    const failed = tab('https://news.example.com/story', { readerable: true, errorCode: -201 })
    expect(pillChipsDrawn(phonePillChips(state(failed), failed, ctx)).map((c) => c.id)).toEqual([
      'certificate-error'
    ])
  })

  it('is not on an error page, an internal page or an extension’s, whatever a stale flag says (Reader View’s own page has the exit, below)', () => {
    const ids = (t: Tab): string[] =>
      pillChipsDrawn(phonePillChips(state(t), t, ctx)).map((c) => c.id)
    const failed = tab('zen://error?code=-105&url=https%3A%2F%2Fnews.example.com%2Fstory', {
      readerable: true,
      errorCode: -105
    })
    expect(phonePillChips(state(failed), failed, ctx)).toEqual([])
    expect(
      phonePillChips(
        state(tab('zen://settings', { readerable: true })),
        tab('zen://settings', { readerable: true }),
        ctx
      )
    ).toEqual([])
    // A discarded tab's verdict is stale (the predicate's rule).
    const discarded = tab('https://news.example.com/story', { readerable: true, discarded: true })
    expect(ids(discarded)).toEqual(['lock'])
  })

  it('says nothing of the article under the private lock (INC-05), and the lock’s passing brings it', () => {
    expect(phonePillChips(state(article), article, { ...ctx, locked: true })).toEqual([])
    expect(pillChipsDrawn(phonePillChips(state(article), article, ctx)).map((c) => c.id)).toEqual([
      'reader'
    ])
  })

  it('waits in the sheet while the §9.33 strip asks the same question, and takes the slot as the strip leaves (Mutant M5: `readerOfferUp` ignored)', () => {
    const up = phonePillChips(state(article), article, { ...ctx, readerOfferUp: true })
    expect(up.find((c) => c.id === 'reader')!.fold).toBe('sheet')
    expect(pillChipsDrawn(up).map((c) => c.id)).toEqual(['lock'])
    expect(
      pillChipRows(state(article), article, { ...ctx, readerOfferUp: true }).map((r) => r.id)
    ).toEqual(['blocked', 'reader'])
    const down = phonePillChips(state(article), article, { ...ctx, readerOfferUp: false })
    expect(pillChipsDrawn(down).map((c) => c.id)).toEqual(['reader'])
  })

  it('PillContent reads the strip off the banner stack: the reader banner standing folds the chip, a leaving one frees the slot', () => {
    uiStore.set({
      banners: [
        { id: 1, title: 'Show Reader View?', key: 'reader', duration: 10_000 }
      ] as unknown as ReturnType<typeof uiStore.get>['banners']
    })
    const el = render(
      <PillContent state={state(article)} tab={article} space={space} interactive />
    )
    expect(shown(el)).toEqual(['lock'])
    expect(addressLabel(el)).toContain('Reader View available')
    act(() =>
      uiStore.set({
        banners: [
          { id: 1, title: 'Show Reader View?', key: 'reader', duration: 10_000, leaving: true }
        ] as unknown as ReturnType<typeof uiStore.get>['banners']
      })
    )
    expect(shown(el)).toEqual(['reader'])
    expect(addressLabel(el)).not.toContain('Reader View')
    // Another banner under another key is not the strip.
    act(() =>
      uiStore.set({
        banners: [
          { id: 2, title: 'You are offline', key: 'offline', duration: null }
        ] as unknown as ReturnType<typeof uiStore.get>['banners']
      })
    )
    expect(shown(el)).toEqual(['reader'])
    uiStore.set({ banners: [] })
  })

  it('folds to the sheet under a live state and a quiet one, and is the slot’s again when they end (the fold’s precedence)', () => {
    const during = foldPhonePillChips(phonePillChips(playing(state(article)), article, ctx))
    expect(during.shown.map((c) => c.id)).toEqual(['media'])
    expect(during.folded.map((c) => c.id)).toEqual(['blocked', 'reader'])
    const after = foldPhonePillChips(phonePillChips(state(article), article, ctx))
    expect(after.shown.map((c) => c.id)).toEqual(['reader'])
  })

  it('arrives and leaves on the run’s 120 ms cross-fade, in place (§11.4; the same under reduced motion)', () => {
    vi.useFakeTimers()
    const plain = { ...article, readerable: false }
    const el = render(<PillContent state={state(plain)} tab={plain} space={space} interactive />)
    expect(shown(el)).toEqual(['lock'])
    act(() =>
      root!.render(<PillContent state={state(article)} tab={article} space={space} interactive />)
    )
    expect(shown(el)).toEqual(['reader'])
    // The lock's ghost over the new run, where the lock stood; gone after the fade.
    const ghost = el.querySelector('.zen-pill-run-ghost')
    expect(ghost).not.toBeNull()
    expect(ghost!.querySelector('svg.lucide-lock')).not.toBeNull()
    expect(ghost!.querySelector('svg.lucide-book-open-text')).toBeNull()
    act(() => vi.advanceTimersByTime(CHIP_FOLD_FADE_MS))
    expect(el.querySelector('.zen-pill-run-ghost')).toBeNull()
    // And the way back: the book's ghost as the lock returns.
    act(() =>
      root!.render(<PillContent state={state(plain)} tab={plain} space={space} interactive />)
    )
    expect(shown(el)).toEqual(['lock'])
    expect(el.querySelector('.zen-pill-run-ghost svg.lucide-book-open-text')).not.toBeNull()
  })

  describe('the lit exit on zen://reader (§9.29 as amended; the design lead’s fold (e))', () => {
    const readerUrl = 'zen://reader?id=article_1&url=https%3A%2F%2Fnews.example.com%2Fstory'
    const reader = tab(readerUrl, { readerable: true })

    it('stays in the slot on the reader tab, lit in the accent with aria-pressed, the lock giving way (Mutant M7: the reader-tab branch dropped; M8: `pressed` dropped)', () => {
      const chips = phonePillChips(state(reader), reader, ctx)
      expect(chips.map((c) => [c.id, c.fold])).toEqual([
        ['lock', 'glyph'],
        ['reader', 'offer']
      ])
      const fold = foldPhonePillChips(chips)
      expect(fold.shown.map((c) => c.id)).toEqual(['reader'])
      expect(fold.yielded.map((c) => c.id)).toEqual(['lock'])
      const el = render(
        <PillContent state={state(reader)} tab={reader} space={space} interactive />
      )
      expect(shown(el)).toEqual(['reader'])
      const chip = readerChip(el)!
      expect(chip.tagName).toBe('BUTTON')
      expect(chip.getAttribute('aria-pressed')).toBe('true')
      expect(chip.getAttribute('aria-label')).toBe('Reader View')
      // The desktop's lit exit's words (`SidebarTop`), Chrome's "Hide Reading mode".
      expect(chip.getAttribute('aria-description')).toBe('Exit Reader View')
      expect(chip.getAttribute('data-tooltip')).toBe('Exit Reader View')
      expect(chip.getAttribute('aria-haspopup')).toBeNull()
      // Lit: the window family's accent (the Now playing chip's while it plays), not the rest ink.
      expect(chip.classList.contains('text-[var(--zen-accent)]')).toBe(true)
      expect(chip.classList.contains('zen-pill-quiet')).toBe(false)
      expect(chip.querySelector('svg.lucide-book-open-text')).not.toBeNull()
      expect(labels(el)).toEqual([
        'Address, news.example.com, Connection is secure',
        'Site information',
        'Reader View'
      ])
      // Its own stop: the address does not speak it while the pill draws it.
      expect(addressLabel(el)).not.toContain('Reader View')
      expect(el.querySelector('[data-site-info][data-verdict]')).toBeNull()
    })

    it('its tap runs the crossing’s toggle back to the page – the one door the sheet’s row, the app menu’s row and Back share (Mutant M9: the tap wired to an entry alone)', async () => {
      const { enterReaderView, readerChipTab } = await import('../pillChips')
      // The pill's route (`PhoneShell`'s tap) asks the one question the builder asks, and the
      // reader tab answers it; an internal page and no tab do not.
      expect(readerChipTab(reader)).toBe(true)
      expect(readerChipTab(article)).toBe(true)
      expect(readerChipTab(tab('zen://settings', { readerable: true }))).toBe(false)
      expect(readerChipTab(null)).toBe(false)
      enterReaderView('t1')
      await vi.waitFor(() =>
        expect(invoke.mock.calls.map(([name]) => name)).toContain('reader.toggle')
      )
      expect(invoke.mock.calls.find(([name]) => name === 'reader.toggle')![1]).toEqual({
        tabId: 't1'
      })
      expect(invoke.mock.calls.map(([name]) => name)).not.toContain('reader.open')
      // The sheet's row on the reader tab is the same exit, its value the state it reports.
      invoke.mockClear()
      uiStore.set({ siteInfoOpen: true })
      siteInfoStore.set({ tabId: 't1', anchor: null })
      const rows = pillChipRows(state(reader), reader, ctx)
      const row = rows.find((r) => r.id === 'reader')!
      expect(row.row.label).toBe('Reader View')
      expect(row.row.value).toBe('On')
      row.row.activate()
      expect(uiStore.get().siteInfoOpen).toBe(false)
      await vi.waitFor(() =>
        expect(invoke.mock.calls.map(([name]) => name)).toContain('reader.toggle')
      )
      expect(invoke.mock.calls.find(([name]) => name === 'reader.toggle')![1]).toEqual({
        tabId: 't1'
      })
    })

    it('a second tap while the tab’s crossing runs asks nothing more of the core: no second toggle, no second extraction (the first line’s nit 3 on #658)', async () => {
      const { enterReaderView } = await import('../pillChips')
      const { readerCrossingStore } = await import('@renderer/lib/readerTransition')
      // The strip's Show (or a first tap) began the crossing; the chip is under the finger again
      // as the strip leaves.
      readerCrossingStore.set({
        crossing: {
          tabId: 't1',
          crossing: 'enter',
          phase: 'covering',
          picture: null,
          surface: '#fff'
        }
      })
      uiStore.set({ siteInfoOpen: true })
      siteInfoStore.set({ tabId: 't1', anchor: null })
      try {
        enterReaderView('t1')
        // The sheet, if up, still leaves – the finger meant the reader, which is on its way.
        expect(uiStore.get().siteInfoOpen).toBe(false)
        await new Promise((r) => setTimeout(r, 30))
        expect(invoke.mock.calls.map(([name]) => name)).not.toContain('reader.toggle')
        // Another tab's crossing is not this tab's: the door stays open for this one.
        readerCrossingStore.set({
          crossing: {
            tabId: 't2',
            crossing: 'enter',
            phase: 'covering',
            picture: null,
            surface: '#fff'
          }
        })
        enterReaderView('t1')
        await vi.waitFor(() =>
          expect(invoke.mock.calls.map(([name]) => name)).toContain('reader.toggle')
        )
        expect(invoke.mock.calls.filter(([name]) => name === 'reader.toggle')).toHaveLength(1)
      } finally {
        readerCrossingStore.set({ crossing: null })
      }
    })

    it('off the reader tab the chip carries no aria-pressed: the offer is no toggle, its words the entry’s', () => {
      const el = render(
        <PillContent state={state(article)} tab={article} space={space} interactive />
      )
      const chip = readerChip(el)!
      expect(chip.hasAttribute('aria-pressed')).toBe(false)
      expect(chip.getAttribute('aria-description')).toBe('Enter Reader View')
      expect(chip.classList.contains('text-[var(--zen-accent)]')).toBe(false)
      const [offer] = phonePillChips(state(article), article, ctx).filter((c) => c.id === 'reader')
      expect(offer!.spoken).toBe('Reader View available')
      expect(offer!.row?.value).toBeUndefined()
    })

    it('the reader URL alone decides: the probe’s flag is the article’s, stale either way', () => {
      const unflagged = tab(readerUrl, { readerable: false })
      const chips = phonePillChips(state(unflagged), unflagged, ctx)
      expect(pillChipsDrawn(chips).map((c) => c.id)).toEqual(['reader'])
      expect(chips.find((c) => c.id === 'reader')!.spoken).toBe('Reader View on')
      // The §9.33 strip is the article page's; on the reader page its flag folds nothing.
      const up = phonePillChips(state(reader), reader, { ...ctx, readerOfferUp: true })
      expect(pillChipsDrawn(up).map((c) => c.id)).toEqual(['reader'])
    })

    it('keeps the fold’s precedence on the reader tab: the identity’s warn or danger glyph holds the slot, a live state folds the exit to the sheet’s row, spoken at the address', () => {
      const http = tab('zen://reader?id=article_1&url=http%3A%2F%2Fnews.example.com%2Fstory', {
        readerable: true
      })
      const chips = phonePillChips(state(http), http, ctx)
      expect(chips.map((c) => [c.id, c.fold])).toEqual([
        ['not-secure', 'glyph'],
        ['reader', 'sheet']
      ])
      expect(pillChipsDrawn(chips).map((c) => c.id)).toEqual(['not-secure'])
      expect(pillChipRows(state(http), http, ctx).map((r) => [r.id, r.row.value])).toEqual([
        ['reader', 'On']
      ])
      const failed = tab(readerUrl, { readerable: true, errorCode: -201 })
      expect(pillChipsDrawn(phonePillChips(state(failed), failed, ctx)).map((c) => c.id)).toEqual([
        'certificate-error'
      ])
      // A live state takes the slot; the exit waits as the sheet's row and the address says it.
      const live = phonePillChips(playing(state(reader)), reader, ctx)
      expect(pillChipsDrawn(live).map((c) => c.id)).toEqual(['media'])
      expect(pillChipsSpoken(live)).toEqual(['Reader View on'])
      expect(foldPhonePillChips(live).folded.map((c) => c.id)).toEqual(['reader'])
      // And nothing under the private lock (INC-05).
      expect(phonePillChips(state(reader), reader, { ...ctx, locked: true })).toEqual([])
    })
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

  it('is form-factor-blind: under the tablet viewport it lists the Reader View row once, as on the phone', () => {
    // The sheet that reads the rows is the phone's (`SiteInfoSheet` mounts the desktop layer for
    // every other form factor); the rows themselves never ask, so whichever finger layout lists
    // them lists the same.
    const article = tab('https://news.example.com/story', { readerable: true })
    const initial = viewportStore.get()
    viewportStore.set({ ...initial, formFactor: 'tablet' })
    try {
      const rows = pillChipRows(state(article), article, ctx)
      expect(rows.map((r) => r.id)).toEqual(['blocked', 'reader'])
      expect(rows.filter((r) => r.id === 'reader')).toHaveLength(1)
      expect(rows.find((r) => r.id === 'reader')!.row.label).toBe('Reader View')
    } finally {
      viewportStore.set(initial)
    }
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

  it('draws the open lock in the warn ink on an http page, named Not secure, in the lock’s own room (ERR-09)', () => {
    const plain = tab('http://example.com/')
    const el = render(<PillContent state={state(plain)} tab={plain} space={space} interactive />)
    expect(shown(el)).toEqual(['not-secure'])
    // The address speaks the state once (A11Y-01); the chip is its own stop under the same word.
    expect(labels(el)).toEqual([
      'Address, example.com, Not secure',
      'Site information',
      'Not secure'
    ])
    const chip = el.querySelector<HTMLElement>('[data-chip="not-secure"] > [data-pill-chip]')!
    expect(chip.getAttribute('data-verdict')).toBe('warn')
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip.hasAttribute('data-site-info')).toBe(true)
    expect(chip.querySelector('svg.lucide-lock-open')).not.toBeNull()
    // Status ink only, no fill (§9.19, §1): the warn ink where the lock has the quiet ink.
    expect(chip.classList.contains('text-[var(--v2-warn)]')).toBe(true)
    expect(chip.classList.contains('zen-pill-quiet')).toBe(false)
    // The lock's chassis exactly – the same 44 box over the 28 pitch (Bennett's OMN-02 ruling on the room).
    const box = (c: HTMLElement): string[] =>
      Array.from(c.classList).filter((k) => k !== 'zen-pill-quiet' && !k.startsWith('text-['))
    const chipBox = box(chip)
    act(() =>
      root!.render(<PillContent state={state(page)} tab={page} space={space} interactive />)
    )
    const lock = el.querySelector<HTMLElement>('[data-chip="lock"] > [data-pill-chip]')!
    expect(box(lock)).toEqual(chipBox)
    expect(lock.querySelector('svg.lucide-lock')).not.toBeNull()
    expect(lock.classList.contains('zen-pill-quiet')).toBe(true)
    expect(lock.getAttribute('data-verdict')).toBe('neutral')
  })

  it('draws the triangle in the danger ink over a failed certificate; the secure lock stays quiet and wordless', () => {
    const failed = tab('https://expired.badssl.com/', {
      certificateError: {
        code: -201,
        url: 'https://expired.badssl.com/',
        certificate: null,
        bypassed: true
      }
    })
    const el = render(<PillContent state={state(failed)} tab={failed} space={space} interactive />)
    expect(shown(el)).toEqual(['certificate-error'])
    const chip = el.querySelector<HTMLElement>(
      '[data-chip="certificate-error"] > [data-pill-chip]'
    )!
    expect(chip.getAttribute('aria-label')).toBe('Not secure')
    expect(chip.getAttribute('data-verdict')).toBe('danger')
    expect(chip.classList.contains('text-[var(--v2-danger)]')).toBe(true)
    expect(chip.querySelector('svg.lucide-triangle-alert')).not.toBeNull()
    expect(addressLabel(el)).toBe('Address, expired.badssl.com, Not secure')
  })

  it('a navigation from http to https swaps the glyph in place: the open lock out, the lock in, on the run’s 120 ms cross-fade', () => {
    const plain = tab('http://example.com/')
    const el = render(<PillContent state={state(plain)} tab={plain} space={space} interactive />)
    expect(shown(el)).toEqual(['not-secure'])
    const secure = tab('https://example.com/')
    act(() =>
      root!.render(<PillContent state={state(secure)} tab={secure} space={space} interactive />)
    )
    expect(shown(el)).toEqual(['lock'])
    // The ghost of the run it showed – the open lock – over the new one, for the fade (§11.4).
    const ghost = el.querySelector<HTMLElement>('.zen-pill-run-ghost')
    expect(ghost).not.toBeNull()
    expect(ghost!.querySelector('svg.lucide-lock-open')).not.toBeNull()
    expect(labels(el)).toEqual([
      'Address, example.com, Connection is secure',
      'Site information',
      'Connection is secure'
    ])
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
 * TalkBack will read them ("Trackers blocked, 5") and as a finger will take them.
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
      'Trackers blocked, 5',
      'Translate this page, German to English'
    ])
    // The chip's own words and formatting on the row: the count as the value, the pair on offer
    // in the bar's words.
    expect(row('Trackers blocked')!.querySelector('.zen-sheet-item-value')?.textContent).toBe('5')
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
    expect(items.indexOf(row('Trackers blocked')!)).toBeLessThan(connection)
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

  it('the shield’s row is a detail row: it opens the tracker report one level down, whose footer leads on to Settings › Privacy and security (PS-33)', async () => {
    await open(offered(state(counted)))
    const pane = document.querySelector<HTMLElement>('[data-level="trackers"]')!
    expect(pane.hidden).toBe(true)
    act(() => row('Trackers blocked')!.click())
    await vi.waitFor(() => expect(pane.hidden).toBe(false))
    expect(document.querySelector('.zen-sheet-title')?.textContent).toBe('Trackers blocked')
    // The rows are the record's sites, most blocked first: the domain, the count as the chassis's
    // tabular value, and the kind of rule under the domain only when it says something – the
    // list match is the default kind and its row is the one-line 44 (§10.1), the user's own
    // filter names itself on a two-line row (§9.2 lets the heights mix).
    const report = pane.querySelector<HTMLElement>('[data-testid="tracker-report"]')!
    const items = Array.from(report.querySelectorAll<HTMLElement>('.zen-sheet-item'))
    expect(items.map((el) => el.textContent)).toEqual([
      'doubleclick.net3',
      'example-cdn.comYour filter2',
      'Tracking prevention settings…'
    ])
    expect(items.map((el) => el.classList.contains('zen-sheet-item-two-line'))).toEqual([
      false,
      true,
      false
    ])
    expect(report.querySelector('.zen-sheet-empty')).toBeNull()
    expect(report.querySelector('.zen-sheet-sep')).not.toBeNull()
    // One level and no deeper (§9.24): the report's rows open nothing.
    expect(items.slice(0, 2).every((el) => el.tagName === 'DIV')).toBe(true)
    act(() => (items[2] as HTMLButtonElement).click())
    await vi.waitFor(() => expect(commands()).toContain('page.open'))
    const [, args] = invoke.mock.calls.find(([name]) => name === 'page.open')!
    expect(args).toMatchObject({ id: 'settings', section: 'privacy' })
  })

  it('the tracker report says when nothing was blocked, in one sentence (§9.17)', async () => {
    await open(state(page))
    act(() => row('Trackers blocked')!.click())
    const pane = document.querySelector<HTMLElement>('[data-level="trackers"]')!
    await vi.waitFor(() => expect(pane.hidden).toBe(false))
    const report = pane.querySelector<HTMLElement>('[data-testid="tracker-report"]')!
    expect(report.querySelector('.zen-sheet-empty')?.textContent).toBe(
      'No trackers blocked on this page'
    )
    expect(report.querySelectorAll('.zen-sheet-item').length).toBe(1)
  })

  it('lists the shield alone on a quiet page with no offer, its count 0; nothing on an internal page', async () => {
    await open(state(page))
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual(['Trackers blocked, 0'])
    act(() => root?.unmount())
    host?.remove()
    const settings = tab('zen://settings')
    await open(state(settings))
    expect(group()).toBeNull()
  })

  it('does not list the media chip while it has the pill’s slot: the shield and the offer alone (its waiting row is the model’s case above)', async () => {
    await open(playing(offered(state(counted))))
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Trackers blocked, 5',
      'Translate this page, German to English'
    ])
  })

  /*
   * PUI-14: the Reader View row on an article page (§9.29 names the reader chip among the
   * sheet's rows), named for TalkBack by the app menu's word for the same door, after the
   * translate offer; its tap begins the reader crossing (MOT-36) on the picture the sheet
   * holds of the page, in the same turn – the menu row's way – and the sheet leaves. Absent on
   * a page the probe did not read as an article.
   */
  it('lists Reader View after the offer on an article page, named plainly, with the book glyph; not on a plain page', async () => {
    const article = { ...counted, url: 'https://news.example.com/story', readerable: true }
    await open(offered(state(article)))
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Trackers blocked, 5',
      'Translate this page, German to English',
      'Reader View'
    ])
    const reader = row('Reader View')!
    expect(reader.querySelector('svg.lucide-book-open-text')).not.toBeNull()
    expect(reader.querySelector('.zen-sheet-item-value')).toBeNull()
    act(() => root?.unmount())
    host?.remove()
    await open(offered(state(counted)))
    expect(rows().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Trackers blocked, 5',
      'Translate this page, German to English'
    ])
  })

  it('the Reader View row begins the crossing on the sheet’s picture of the page, and the sheet leaves for the reader', async () => {
    const { readerCrossingStore } = await import('@renderer/lib/readerTransition')
    const { applyDrawn, applyLayout, pageViewStore } = await import('@renderer/lib/pageView')
    const article = { ...page, url: 'https://news.example.com/story', readerable: true }
    const s = state(article)
    s.settings = { ...s.settings, reader: { theme: 'light' } } as UIState['settings']
    await open(s)
    // The sheet holds the page's picture (the page is under it, off the screen).
    uiStore.set({ snapshot: 'data:sheet-picture', snapshotTabId: 't1' })
    pageViewStore.set(
      applyDrawn(
        applyLayout(pageViewStore.get(), { contentHidden: true, hid: ['t1'], shown: [] }),
        't1',
        false
      )
    )
    try {
      act(() => row('Reader View')!.click())
      // Synchronously, on the held picture: the page never comes back between the sheet's going
      // and the surface's coming.
      expect(readerCrossingStore.get().crossing).toMatchObject({
        tabId: 't1',
        crossing: 'enter',
        phase: 'covering',
        picture: 'data:sheet-picture'
      })
      expect(commands()).not.toContain('reader.toggle')
      await vi.waitFor(() => expect(uiStore.get().siteInfoOpen).toBe(false))
      // Covered already: the core is asked to cross – the offer's and the menu row's door – and
      // nothing else was asked of it.
      await vi.waitFor(() => expect(commands()).toContain('reader.toggle'))
      expect(readerCrossingStore.get().crossing?.phase).toBe('loading')
      const [, args] = invoke.mock.calls.find(([name]) => name === 'reader.toggle')!
      expect(args).toEqual({ tabId: 't1' })
    } finally {
      readerCrossingStore.set({ crossing: null })
      pageViewStore.set({ phases: new Map(), lastApplied: null })
      uiStore.set({ snapshot: null, snapshotTabId: null })
    }
  })

  /*
   * ERR-09: the sheet explains the verdict the pill's glyph gave. On an http page its title
   * block carries the same open lock in the warn ink under "Not secure", the Connection row
   * reads the state, and the Connection level says what it means and what not to enter – two
   * lines at 13, Chrome's page-info advice in Zenium's words.
   */
  it('explains Not secure on an http page: the open lock in the title block, the Connection row, the level’s two lines', async () => {
    const plain = tab('http://example.com/')
    await open(state(plain))
    const block = document.querySelector<HTMLElement>('.zen-sheet-title-block')!
    expect(block.textContent).toContain('Not secure')
    const glyph = block.querySelector<SVGElement>('p svg')!
    expect(glyph.classList.contains('lucide-lock-open')).toBe(true)
    expect(glyph.classList.contains('text-[var(--v2-warn)]')).toBe(true)
    const items = (): HTMLElement[] =>
      Array.from(document.querySelectorAll<HTMLElement>('.zen-sheet .zen-sheet-item'))
    const connection = items().find((el) =>
      el.getAttribute('aria-label')?.startsWith('Connection')
    )!
    expect(connection.getAttribute('aria-label')).toBe('Connection, Not secure')
    act(() => connection.click())
    await vi.waitFor(() => {
      // The level's state row is static (no action): its two lines are its text.
      const level = items().find((el) => el.textContent?.startsWith('Connection is not secure'))
      expect(level).not.toBeUndefined()
      expect(level!.querySelector('.zen-sheet-item-secondary')?.textContent).toBe(
        "Anyone on the way can read what you send to this site. Don't enter passwords or card details here."
      )
      expect(level!.querySelector('svg.lucide-lock-open')).not.toBeNull()
      expect(level!.querySelector('.zen-sheet-item-glyph')?.getAttribute('data-tone')).toBe('warn')
    })
  })

  it('draws the triangle for a failed certificate in the title block and on the Connection level, the same glyph as the pill’s', async () => {
    const failed = tab('https://expired.badssl.com/', {
      certificateError: {
        code: -201,
        url: 'https://expired.badssl.com/',
        certificate: null,
        bypassed: true
      }
    })
    await open(state(failed))
    const block = document.querySelector<HTMLElement>('.zen-sheet-title-block')!
    const glyph = block.querySelector<SVGElement>('p svg')!
    expect(glyph.classList.contains('lucide-triangle-alert')).toBe(true)
    expect(glyph.classList.contains('text-[var(--v2-danger)]')).toBe(true)
    expect(block.textContent).toContain('Not secure')
  })

  /*
   * The title block's line under the host names what is wrong with a failed certificate, never
   * its issuer: an invalid certificate's issuer offered like a credential says nothing true. The
   * issuer stays where the certificate is described – the Connection level's detail.
   */
  it('names the certificate’s fault under the host, not its issuer, which the Connection level’s detail keeps', async () => {
    const issuer = 'COMODO RSA Domain Validation Secure Server CA'
    const failed = tab('https://expired.badssl.com/', {
      certificateError: {
        code: -201,
        url: 'https://expired.badssl.com/',
        certificate: {
          subjectName: '*.badssl.com',
          issuerName: issuer,
          validStart: 1_427_846_400_000,
          validExpiry: 1_428_883_200_000,
          fingerprint: 'sha256/abc'
        },
        bypassed: true
      }
    })
    await open(state(failed))
    const block = document.querySelector<HTMLElement>('.zen-sheet-title-block')!
    expect(block.querySelector('p')!.textContent).toBe('Not secure · Certificate expired')
    expect(block.textContent).not.toContain(issuer)
    const items = (): HTMLElement[] =>
      Array.from(document.querySelectorAll<HTMLElement>('.zen-sheet .zen-sheet-item'))
    const connection = items().find((el) =>
      el.getAttribute('aria-label')?.startsWith('Connection')
    )!
    act(() => connection.click())
    await vi.waitFor(() => {
      const issued = Array.from(document.querySelectorAll<HTMLElement>('.zen-sheet *')).find(
        (el) => el.children.length === 0 && el.textContent === issuer
      )
      expect(issued).not.toBeUndefined()
    })
  })

  it('the fault follows the code: the wrong site for a name mismatch', async () => {
    const mismatch = tab('https://wrong.host.badssl.com/', {
      certificateError: {
        code: -200,
        url: 'https://wrong.host.badssl.com/',
        certificate: null,
        bypassed: false
      }
    })
    await open(state(mismatch))
    expect(document.querySelector('.zen-sheet-title-block p')!.textContent).toBe(
      'Not secure · Certificate not valid for this site'
    )
  })

  it('the fault reads off the failed load’s code alone when the core reports no more: not trusted for an unknown authority', async () => {
    const untrusted = tab('https://self-signed.badssl.com/', { errorCode: -202 })
    await open(state(untrusted))
    expect(document.querySelector('.zen-sheet-title-block p')!.textContent).toBe(
      'Not secure · Certificate not trusted'
    )
  })
})
