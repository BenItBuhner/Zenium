import { afterEach, describe, expect, it } from 'vitest'
import { PRIVATE_CONTAINER_ID, type UIState } from '@shared/types'
import { KEYBOARD_INSET_MIN } from '@renderer/lib/barHide'
import type { PullState } from '@renderer/lib/pull'
import { uiStore, type UiState } from '@renderer/lib/ui'
import { bandMayShow, readBandSignals, type BandSignals } from '../signals'

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
    expect(readBandSignals(stateWith(WEB), ui(), IDLE)).toEqual<BandSignals>({
      tabId: 't1',
      webPage: true,
      privateTab: false,
      covered: false,
      keyboardUp: false,
      pulling: false
    })
  })

  it('no state or no tab in front means no page', () => {
    expect(readBandSignals(null, ui(), IDLE).tabId).toBeNull()
    const noTab = {
      activeSpaceId: 's1',
      spaces: [{ id: 's1', activeTabId: null }],
      tabs: {}
    } as unknown as UIState
    const signals = readBandSignals(noTab, ui(), IDLE)
    expect(signals.tabId).toBeNull()
    expect(signals.webPage).toBe(false)
  })

  it('the new tab page and zen:// pages are not web pages', () => {
    expect(readBandSignals(stateWith(''), ui(), IDLE).webPage).toBe(false)
    expect(readBandSignals(stateWith('about:blank'), ui(), IDLE).webPage).toBe(false)
    expect(readBandSignals(stateWith('zen://newtab'), ui(), IDLE).webPage).toBe(false)
    expect(readBandSignals(stateWith('zen://settings/privacy'), ui(), IDLE).webPage).toBe(false)
    expect(readBandSignals(stateWith('http://news.example/'), ui(), IDLE).webPage).toBe(true)
  })

  it('a private tab is told apart by its container', () => {
    expect(readBandSignals(stateWith(WEB, PRIVATE_CONTAINER_ID), ui(), IDLE).privateTab).toBe(true)
    expect(readBandSignals(stateWith(WEB), ui(), IDLE).privateTab).toBe(false)
  })

  it('a sheet, a menu, a frame dialog or a dialog cover covers the page', () => {
    expect(readBandSignals(stateWith(WEB), ui({ menu: {} as UiState['menu'] }), IDLE).covered).toBe(
      true
    )
    expect(readBandSignals(stateWith(WEB), ui({ siteInfoOpen: true }), IDLE).covered).toBe(true)
    expect(readBandSignals(stateWith(WEB), ui({ frameDialogsOpen: 1 }), IDLE).covered).toBe(true)
    expect(readBandSignals(stateWith(WEB), ui({ frameDialogCover: 1 }), IDLE).covered).toBe(true)
    expect(readBandSignals(stateWith(WEB), ui(), IDLE).covered).toBe(false)
  })

  it("the keyboard is up at the bar-hide gate's inset", () => {
    const insets = { top: 0, right: 0, bottom: KEYBOARD_INSET_MIN, left: 0 }
    expect(readBandSignals(stateWith(WEB), ui({ insets }), IDLE).keyboardUp).toBe(true)
    const low = { ...insets, bottom: KEYBOARD_INSET_MIN - 1 }
    expect(readBandSignals(stateWith(WEB), ui({ insets: low }), IDLE).keyboardUp).toBe(false)
  })

  it('a pull in any phase has the page', () => {
    for (const phase of ['pulling', 'settling', 'refreshing', 'finishing'] as const) {
      const pull: PullState = { tabId: 't1', phase, armed: false }
      expect(readBandSignals(stateWith(WEB), ui(), pull).pulling).toBe(true)
    }
  })
})

describe('bandMayShow', () => {
  const free: BandSignals = {
    tabId: 't1',
    webPage: true,
    privateTab: false,
    covered: false,
    keyboardUp: false,
    pulling: false
  }

  it('a web page in front and free shows both forms', () => {
    expect(bandMayShow(free, 'offer')).toBe(true)
    expect(bandMayShow(free, 'state')).toBe(true)
  })

  it('never on the new tab page or a chrome page, never without a page', () => {
    expect(bandMayShow({ ...free, webPage: false }, 'offer')).toBe(false)
    expect(bandMayShow({ ...free, webPage: false }, 'state')).toBe(false)
    expect(bandMayShow({ ...free, tabId: null }, 'state')).toBe(false)
  })

  it('waits while a sheet stands, the keyboard is up over the page, or a pull has it', () => {
    expect(bandMayShow({ ...free, covered: true }, 'state')).toBe(false)
    expect(bandMayShow({ ...free, keyboardUp: true }, 'offer')).toBe(false)
    expect(bandMayShow({ ...free, pulling: true }, 'offer')).toBe(false)
  })

  it("a private tab's offers are withheld; its states still show", () => {
    expect(bandMayShow({ ...free, privateTab: true }, 'offer')).toBe(false)
    expect(bandMayShow({ ...free, privateTab: true }, 'state')).toBe(true)
  })
})
