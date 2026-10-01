import { afterEach, describe, expect, it } from 'vitest'
import { PRIVATE_CONTAINER_ID, type UIState } from '@shared/types'
import { KEYBOARD_INSET_MIN } from '@renderer/lib/barHide'
import { stageStore } from '@renderer/lib/gestures/stage'
import type { PullState } from '@renderer/lib/pull'
import { uiStore, type UiState } from '@renderer/lib/ui'
import {
  bandFrameOf,
  bandSignals,
  readBandSignals,
  subscribeBandSignals,
  type BandSignals
} from '../signals'

const IDLE: PullState = { tabId: null, phase: 'idle', armed: false }

function stateWith(url: string, containerId = 'default'): UIState {
  return {
    activeSpaceId: 's1',
    spaces: [{ id: 's1', activeTabId: 't1' }],
    tabs: { t1: { id: 't1', url, containerId } }
  } as unknown as UIState
}

function ui(patch: Partial<UiState> = {}): UiState {
  return { ...uiStore.get(), ...patch }
}

const WEB = 'https://example.com/article'

describe('readBandSignals', () => {
  afterEach(() => {
    uiStore.set({ frameDialogsOpen: 0, frameDialogCover: 0 })
  })

  it('a web page in front, under nothing, with the keyboard down and no pull', () => {
    expect(readBandSignals(stateWith(WEB), ui(), IDLE, false, false)).toEqual<BandSignals>({
      tabId: 't1',
      page: true,
      document: true,
      privateTab: false,
      covered: false,
      keyboardUp: false,
      pulling: false
    })
  })

  it('no state or no tab in front means no page', () => {
    expect(readBandSignals(null, ui(), IDLE, false, false).tabId).toBeNull()
    const noTab = {
      activeSpaceId: 's1',
      spaces: [{ id: 's1', activeTabId: null }],
      tabs: {}
    } as unknown as UIState
    const signals = readBandSignals(noTab, ui(), IDLE, false, false)
    expect(signals.tabId).toBeNull()
    expect(signals.page).toBe(false)
    expect(signals.document).toBe(false)
  })

  it('the new tab page and zen:// pages are not pages to the band (no offer there, §10)', () => {
    expect(readBandSignals(stateWith(''), ui(), IDLE, false, false).page).toBe(false)
    expect(readBandSignals(stateWith('about:blank'), ui(), IDLE, false, false).page).toBe(false)
    expect(readBandSignals(stateWith('zen://newtab'), ui(), IDLE, false, false).page).toBe(false)
    expect(
      readBandSignals(stateWith('zen://settings/privacy'), ui(), IDLE, false, false).page
    ).toBe(false)
    expect(readBandSignals(stateWith('http://news.example/'), ui(), IDLE, false, false).page).toBe(
      true
    )
  })

  it("a served zen:// document is a document in the tab's own view – a state stands on it (§10); a chrome-drawn page is not – the band waits there (the Lead's (B) on question (8))", () => {
    const doc = (url: string, phone = false): boolean =>
      readBandSignals(stateWith(url), ui(), IDLE, false, phone).document
    expect(doc('https://example.com/')).toBe(true)
    expect(doc('zen://newtab')).toBe(true)
    expect(doc('zen://error?code=-2')).toBe(true)
    expect(doc('zen://version')).toBe(true)
    for (const url of ['zen://settings', 'zen://history', 'zen://downloads/', 'zen://bookmarks']) {
      expect(doc(url), url).toBe(false)
    }
    expect(doc('')).toBe(false)
  })

  it("the phone draws its new tab page in the chrome over zen://blank: no document under it, so the band waits (BandDemo scene 6's verdict, the §9.33 pin); the tablet's zen://blank is the view's own", () => {
    expect(readBandSignals(stateWith('zen://blank'), ui(), IDLE, false, true).document).toBe(false)
    expect(readBandSignals(stateWith('zen://blank'), ui(), IDLE, false, false).document).toBe(true)
    expect(
      bandFrameOf(readBandSignals(stateWith('zen://blank'), ui(), IDLE, false, true))
    ).toMatchObject({ ok: false, offers: false })
    expect(
      bandFrameOf(readBandSignals(stateWith('zen://newtab'), ui(), IDLE, false, false))
    ).toMatchObject({
      ok: true,
      offers: false
    })
  })

  it("every zen:// page is a chrome page (the Design Lead's ruling: not the new tab page and settings alone) – history, downloads, a page the chrome adds later, with a query or a fragment", () => {
    for (const url of [
      'zen://history',
      'zen://downloads/',
      'zen://bookmarks?folder=3',
      'zen://reader#top',
      'zen://some-page-not-yet-written',
      'chrome://flags',
      'about:about'
    ]) {
      expect(readBandSignals(stateWith(url), ui(), IDLE, false, false).page, url).toBe(false)
    }
  })

  it("an open omnibox covers the page – the phone's field and the tablet's URL-bar popup are one `urlbar` state – so an arriving band waits rather than leaves (the Design Lead's ruling); the desktop split's empty-pane field alone, which never opens on a touch host, covers none", () => {
    const base = ui().urlbar
    const phone = { ...base, open: true, mode: 'edit' as const, tabId: 't1' }
    expect(readBandSignals(stateWith(WEB), ui({ urlbar: phone }), IDLE, false, false).covered).toBe(
      true
    )
    const tabletPopup = {
      ...base,
      open: true,
      mode: 'new-tab' as const,
      tabId: null,
      attached: true
    }
    expect(
      readBandSignals(stateWith(WEB), ui({ urlbar: tabletPopup }), IDLE, false, false).covered
    ).toBe(true)
    const search = { ...base, open: true, mode: 'search' as const, tabId: 't1' }
    expect(
      readBandSignals(stateWith(WEB), ui({ urlbar: search }), IDLE, false, false).covered
    ).toBe(true)
    expect(
      readBandSignals(stateWith(WEB), ui({ urlbar: { ...phone, pane: true } }), IDLE, false, false)
        .covered
    ).toBe(false)
    expect(
      bandFrameOf(readBandSignals(stateWith(WEB), ui({ urlbar: phone }), IDLE, false, false))
    ).toMatchObject({
      ok: true,
      covered: true
    })
  })

  it('a private tab is told apart by its container', () => {
    expect(
      readBandSignals(stateWith(WEB, PRIVATE_CONTAINER_ID), ui(), IDLE, false, false).privateTab
    ).toBe(true)
    expect(readBandSignals(stateWith(WEB), ui(), IDLE, false, false).privateTab).toBe(false)
  })

  it('a sheet, a menu, a frame dialog or a dialog cover covers the page', () => {
    expect(
      readBandSignals(stateWith(WEB), ui({ menu: {} as UiState['menu'] }), IDLE, false, false)
        .covered
    ).toBe(true)
    expect(
      readBandSignals(stateWith(WEB), ui({ siteInfoOpen: true }), IDLE, false, false).covered
    ).toBe(true)
    expect(
      readBandSignals(stateWith(WEB), ui({ frameDialogsOpen: 1 }), IDLE, false, false).covered
    ).toBe(true)
    expect(
      readBandSignals(stateWith(WEB), ui({ frameDialogCover: 1 }), IDLE, false, false).covered
    ).toBe(true)
    expect(readBandSignals(stateWith(WEB), ui(), IDLE, false, false).covered).toBe(false)
  })

  it("the keyboard is up at the bar-hide gate's inset", () => {
    const insets = { top: 0, right: 0, bottom: KEYBOARD_INSET_MIN, left: 0 }
    expect(readBandSignals(stateWith(WEB), ui({ insets }), IDLE, false, false).keyboardUp).toBe(
      true
    )
    const low = { ...insets, bottom: KEYBOARD_INSET_MIN - 1 }
    expect(
      readBandSignals(stateWith(WEB), ui({ insets: low }), IDLE, false, false).keyboardUp
    ).toBe(false)
  })

  it('a pull in any phase has the page', () => {
    for (const phase of ['pulling', 'settling', 'refreshing', 'finishing'] as const) {
      const pull: PullState = { tabId: 't1', phase, armed: false }
      expect(readBandSignals(stateWith(WEB), ui(), pull, false, false).pulling).toBe(true)
    }
  })

  it("the open tab overview covers the page (the Design Lead's ruling on #731's still 09 – a banner over the overview's header): an arriving band waits rather than leaves, from the overview's first dragging frame, before `ui.stageActive` joins with the hero card's capture", () => {
    expect(readBandSignals(stateWith(WEB), ui(), IDLE, true, false).covered).toBe(true)
    expect(bandFrameOf(readBandSignals(stateWith(WEB), ui(), IDLE, true, false))).toMatchObject({
      ok: true,
      covered: true
    })
    expect(
      readBandSignals(stateWith(WEB), ui({ stageActive: true }), IDLE, false, false).covered
    ).toBe(true)
  })
})

describe('bandSignals and subscribeBandSignals read the stage', () => {
  const closed = { phase: 'closed' as const, progress: 0, heroTabId: null, target: 0 as const }
  afterEach(() => {
    stageStore.set({ overview: closed })
  })

  it('the overview is a cover in every phase but closed – dragging, settling, open', () => {
    expect(bandSignals().covered).toBe(false)
    for (const phase of ['dragging', 'settling', 'open'] as const) {
      stageStore.set({ overview: { phase, progress: 0.4, heroTabId: 't1', target: 1 } })
      expect(bandSignals().covered, phase).toBe(true)
    }
    stageStore.set({ overview: closed })
    expect(bandSignals().covered).toBe(false)
  })

  it('the listener hears the overview open and close once each – not every frame of its drag and settle (the stage publishes per frame; the band does no per-frame work)', () => {
    const heard: boolean[] = []
    const off = subscribeBandSignals((signals) => heard.push(signals.covered))
    expect(heard).toEqual([false])
    stageStore.set({ overview: { phase: 'dragging', progress: 0, heroTabId: 't1', target: 1 } })
    for (const progress of [0.2, 0.5, 0.8]) {
      stageStore.set({ overview: { phase: 'dragging', progress, heroTabId: 't1', target: 1 } })
    }
    stageStore.set({ overview: { phase: 'settling', progress: 0.9, heroTabId: 't1', target: 1 } })
    stageStore.set({ overview: { phase: 'open', progress: 1, heroTabId: 't1', target: 1 } })
    expect(heard).toEqual([false, true])
    stageStore.set({ overview: { phase: 'settling', progress: 0.5, heroTabId: 't1', target: 0 } })
    stageStore.set({ overview: closed })
    expect(heard).toEqual([false, true, false])
    off()
    stageStore.set({ overview: { phase: 'open', progress: 1, heroTabId: 't1', target: 1 } })
    expect(heard).toEqual([false, true, false])
  })
})

describe('bandFrameOf', () => {
  const free: BandSignals = {
    tabId: 't1',
    page: true,
    document: true,
    privateTab: false,
    covered: false,
    keyboardUp: false,
    pulling: false
  }

  it('a web page in front and free: the frame is ok, offers may, nothing covers it', () => {
    expect(bandFrameOf(free)).toEqual({ front: 't1', ok: true, offers: true, covered: false })
  })

  it('a state stands on a document that is not a page (a served zen:// document): ok, no offers (§10)', () => {
    expect(bandFrameOf({ ...free, page: false })).toMatchObject({ ok: true, offers: false })
  })

  it('never on a chrome-drawn page (no document under the band), never without a page', () => {
    expect(bandFrameOf({ ...free, document: false }).ok).toBe(false)
    expect(bandFrameOf({ ...free, tabId: null })).toMatchObject({ front: null, ok: false })
  })

  it('a pull on the page withholds the band (one source of the offset at a time)', () => {
    expect(bandFrameOf({ ...free, pulling: true }).ok).toBe(false)
  })

  it('a sheet over the page, or the keyboard over its field, is a cover: an arriving prompt waits', () => {
    expect(bandFrameOf({ ...free, covered: true })).toMatchObject({ ok: true, covered: true })
    expect(bandFrameOf({ ...free, keyboardUp: true })).toMatchObject({ ok: true, covered: true })
  })

  it("a private tab's offers are withheld; the frame is still ok for its states", () => {
    expect(bandFrameOf({ ...free, privateTab: true })).toMatchObject({ ok: true, offers: false })
  })
})
