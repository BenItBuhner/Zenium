import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POPUP_HEIGHT,
  DEFAULT_POPUP_WIDTH,
  isSizedPopup,
  parseWindowOpenFeatures,
  planWindowOpen
} from '../windowOpen'

describe('parseWindowOpenFeatures', () => {
  it('reads width, height, position and the popup flag', () => {
    const f = parseWindowOpenFeatures('width=500,height=400,left=10,top=20,popup=yes')
    expect(f).toEqual({ width: 500, height: 400, left: 10, top: 20, popup: true })
  })

  it('treats a bare popup token and 1/true as set', () => {
    expect(parseWindowOpenFeatures('popup').popup).toBe(true)
    expect(parseWindowOpenFeatures('popup=1').popup).toBe(true)
    expect(parseWindowOpenFeatures('popup=true').popup).toBe(true)
    expect(parseWindowOpenFeatures('popup=no').popup).toBe(false)
  })

  it('ignores empty features and non-numeric sizes', () => {
    expect(parseWindowOpenFeatures('')).toEqual({
      width: null,
      height: null,
      left: null,
      top: null,
      popup: false
    })
    expect(parseWindowOpenFeatures('width=abc,height=-4').width).toBeNull()
    expect(parseWindowOpenFeatures('height=-4').height).toBeNull()
  })
})

describe('planWindowOpen', () => {
  it('denies javascript and other non-navigable URLs', () => {
    expect(planWindowOpen('javascript:alert(1)', 'new-window').action).toBe('deny')
    expect(planWindowOpen('mailto:a@b.c', 'new-window').action).toBe('deny')
    expect(planWindowOpen('', 'foreground-tab').action).toBe('deny')
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

  it('treats width or height alone as a sized popup', () => {
    expect(isSizedPopup(parseWindowOpenFeatures('width=500'))).toBe(true)
    expect(isSizedPopup(parseWindowOpenFeatures('height=400'))).toBe(true)
    expect(isSizedPopup(parseWindowOpenFeatures(''))).toBe(false)
  })
})
