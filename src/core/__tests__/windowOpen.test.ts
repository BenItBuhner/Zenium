import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POPUP_HEIGHT,
  DEFAULT_POPUP_WIDTH,
  isPopupRequested,
  openedWindowKind,
  parseWindowOpenFeatures,
  planWindowOpen
} from '../windowOpen'

describe('parseWindowOpenFeatures', () => {
  it('reads width, height, position and the popup flag', () => {
    const f = parseWindowOpenFeatures('width=500,height=400,left=10,top=20,popup=yes')
    expect(f.requested).toBe(true)
    expect([f.width, f.height, f.left, f.top, f.popup]).toEqual([500, 400, 10, 20, true])
  })

  it('tokenises the way Blink does: spaces, = and , separate; names are case-insensitive', () => {
    const f = parseWindowOpenFeatures('Width = 640 , HEIGHT=480 innerWidth=300 screenX=5')
    // `innerWidth` is an alias of width and the later token wins.
    expect([f.width, f.height, f.left]).toEqual([300, 480, 5])
    expect(parseWindowOpenFeatures('toolbar,location').toolbar).toBe(true)
    expect(parseWindowOpenFeatures('toolbar,location').location).toBe(true)
  })

  it('treats a bare popup token, 1, true and yes as set and no / false / 0 as unset', () => {
    expect(parseWindowOpenFeatures('popup').popup).toBe(true)
    expect(parseWindowOpenFeatures('popup=1').popup).toBe(true)
    expect(parseWindowOpenFeatures('popup=true').popup).toBe(true)
    expect(parseWindowOpenFeatures('popup=no').popup).toBe(false)
    expect(parseWindowOpenFeatures('popup=false').popup).toBe(false)
    expect(parseWindowOpenFeatures('popup=0').popup).toBe(false)
  })

  it('ignores empty features and non-numeric sizes', () => {
    const empty = parseWindowOpenFeatures('')
    expect(empty.requested).toBe(false)
    expect([empty.width, empty.height, empty.left, empty.top, empty.popup]).toEqual([
      null,
      null,
      null,
      null,
      null
    ])
    expect(parseWindowOpenFeatures('width=abc,height=-4').width).toBeNull()
    expect(parseWindowOpenFeatures('height=-4').height).toBeNull()
  })
})

describe('isPopupRequested', () => {
  it('follows the HTML specification: no features is not a popup, popup= decides', () => {
    expect(isPopupRequested(parseWindowOpenFeatures(''))).toBe(false)
    expect(isPopupRequested(parseWindowOpenFeatures('popup'))).toBe(true)
    expect(isPopupRequested(parseWindowOpenFeatures('popup=0,width=500'))).toBe(false)
  })

  it('treats a sized window that leaves the browser UI out as a popup', () => {
    expect(isPopupRequested(parseWindowOpenFeatures('width=500,height=400'))).toBe(true)
    expect(isPopupRequested(parseWindowOpenFeatures('width=500'))).toBe(true)
    expect(isPopupRequested(parseWindowOpenFeatures('noopener'))).toBe(true)
  })

  it('is not a popup when every piece of browser UI is asked for', () => {
    expect(
      isPopupRequested(
        parseWindowOpenFeatures('location,toolbar,menubar,resizable,scrollbars,status')
      )
    ).toBe(false)
    expect(
      isPopupRequested(parseWindowOpenFeatures('location,menubar,resizable,scrollbars,status'))
    ).toBe(false)
    expect(
      isPopupRequested(parseWindowOpenFeatures('toolbar,menubar,resizable=no,scrollbars,status'))
    ).toBe(true)
  })
})

describe('planWindowOpen', () => {
  it('denies javascript and other non-navigable URLs', () => {
    expect(planWindowOpen('javascript:alert(1)', 'new-window').action).toBe('deny')
    expect(planWindowOpen('about:config', 'new-window').action).toBe('deny')
    expect(planWindowOpen('', 'foreground-tab').action).toBe('deny')
  })

  it('denies the browser’s own pages and documents, as Chrome denies chrome:// to a page', () => {
    expect(planWindowOpen('zen://settings', 'foreground-tab').action).toBe('deny')
    expect(planWindowOpen('zenium://settings/privacy', 'new-window').action).toBe('deny')
    expect(planWindowOpen('ZENIUM://settings', 'background-tab').action).toBe('deny')
    expect(planWindowOpen('zen://blank', 'foreground-tab').action).toBe('deny')
    expect(planWindowOpen('zen://error?code=-105', 'foreground-tab').action).toBe('deny')
    // The user's ways in are not this gate's: a typed address goes through inputToUrl.
    expect(
      planWindowOpen('https://example.com/?next=zen://settings', 'foreground-tab').action
    ).toBe('tab')
  })

  it('lets mailto: through for the external-app prompt, as a tab or a window', () => {
    expect(planWindowOpen('mailto:a@b.c', 'foreground-tab').action).toBe('tab')
    expect(planWindowOpen('mailto:a@b.c', 'new-window').action).toBe('window')
  })

  it('opens a sized window.open as a toolbar-only Zenium window', () => {
    const plan = planWindowOpen(
      'https://example.com/',
      'new-window',
      'width=500,height=400,popup=yes'
    )
    expect(plan.action).toBe('window')
    expect(plan.chrome).toBe('popup')
    expect(plan.bounds).toEqual({ x: 80, y: 80, width: 500, height: 400 })
  })

  it('opens Shift+click / target=_blank new-window as a full Zenium window', () => {
    const plan = planWindowOpen('https://example.com/', 'new-window', '')
    expect(plan.action).toBe('window')
    expect(plan.chrome).toBe('full')
    expect(plan.bounds).toBeNull()
  })

  it('opens a window.open that asks for the whole browser UI as a full window', () => {
    const plan = planWindowOpen(
      'https://example.com/',
      'new-window',
      'location,toolbar,menubar,resizable,scrollbars,status'
    )
    expect(plan.chrome).toBe('full')
  })

  it('uses the default popup size when only the popup token is set', () => {
    const plan = planWindowOpen('https://example.com/', 'new-window', 'popup=yes')
    expect(plan.chrome).toBe('popup')
    expect(plan.bounds).toEqual({
      x: 80,
      y: 80,
      width: DEFAULT_POPUP_WIDTH,
      height: DEFAULT_POPUP_HEIGHT
    })
  })

  it('honours left/top when the page asked for them', () => {
    const plan = planWindowOpen('https://example.com/', 'new-window', 'width=320,left=40,top=12')
    expect(plan.bounds).toEqual({
      x: 40,
      y: 12,
      width: 320,
      height: DEFAULT_POPUP_HEIGHT
    })
  })

  it('keeps Ctrl+click as a background tab and a plain target=_blank as a foreground tab', () => {
    expect(planWindowOpen('https://example.com/', 'background-tab')).toEqual({
      action: 'tab',
      chrome: 'full',
      bounds: null,
      active: false
    })
    expect(planWindowOpen('https://example.com/', 'foreground-tab').active).toBe(true)
    expect(planWindowOpen('https://example.com/', 'default').action).toBe('tab')
  })
})

describe('openedWindowKind', () => {
  it('keeps private openers private and makes popups temporary windows', () => {
    expect(openedWindowKind('private', 'popup')).toBe('private')
    expect(openedWindowKind('private', 'full')).toBe('private')
    expect(openedWindowKind('synced', 'popup')).toBe('unsynced')
    expect(openedWindowKind('unsynced', 'full')).toBe('unsynced')
  })

  it('opens Shift+click from a normal window as another synced window', () => {
    expect(openedWindowKind('synced', 'full')).toBe('synced')
  })
})
