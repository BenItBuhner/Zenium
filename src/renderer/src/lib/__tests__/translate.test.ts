import { describe, expect, it } from 'vitest'
import { errorCaption, pairLabel, placeAtPoint, placePopover } from '../translate'

describe('errorCaption', () => {
  it('is empty when the core gave no reason', () => {
    expect(errorCaption(null)).toBeNull()
    expect(errorCaption(undefined)).toBeNull()
    expect(errorCaption('   ')).toBeNull()
  })

  it("turns the hosts' network plumbing into one sentence", () => {
    for (const reason of [
      'net::ERR_PROXY_CONNECTION_FAILED',
      'net::ERR_NAME_NOT_RESOLVED',
      'TypeError: Failed to fetch',
      'Unable to resolve host "firefox-settings-attachments.cdn.mozilla.net": No address associated with hostname',
      'java.net.UnknownHostException: firefox-settings-attachments.cdn.mozilla.net'
    ]) {
      expect(errorCaption(reason)).toBe('The model server could not be reached.')
    }
  })

  it('shows every other reason as a sentence', () => {
    expect(errorCaption('the model download failed (HTTP 503)')).toBe(
      'The model download failed (HTTP 503).'
    )
    expect(errorCaption('the model file is corrupt (checksum mismatch)')).toBe(
      'The model file is corrupt (checksum mismatch).'
    )
    expect(errorCaption('Zenium has no translation model from es to de.')).toBe(
      'Zenium has no translation model from es to de.'
    )
    expect(errorCaption('This page is already in English.')).toBe(
      'This page is already in English.'
    )
  })
})

describe('pairLabel', () => {
  it('names both sides when both are known', () => {
    expect(pairLabel('es', 'en')).toBe('Spanish to English')
  })

  it('names the side that is known', () => {
    expect(pairLabel(null, 'de')).toBe('German')
    expect(pairLabel('fr', null)).toBe('French')
    expect(pairLabel(null, null)).toBe('')
  })
})

describe('placePopover (v2 draft §9.20)', () => {
  const win = { width: 1440, height: 900 }
  /** A 320 popover of 60 menulist rows wanting 1694 px, showing five rows at the least. */
  const size = { width: 320, wanted: 60 * 28 + 14, minHeight: 5 * 28 + 12 }
  /** The translate bar: 40 tall under the toolbar, its 32 px menulists at 4 px padding. */
  const bar = { left: 172, right: 1016, top: 0, bottom: 40 }

  it('sits flush under the bar, start-aligned with its trigger, at its fixed width', () => {
    const at = placePopover({ left: 366, right: 428, top: 4, bottom: 36 }, bar, win, size)
    expect(at.left).toBe(366)
    expect(at.top).toBe(40)
  })

  it('is at most 60% of the window tall', () => {
    const at = placePopover({ left: 366, right: 428, top: 4, bottom: 36 }, bar, win, size)
    expect(at.maxHeight).toBe(540)
    const short = placePopover({ left: 366, right: 428, top: 4, bottom: 36 }, bar, win, {
      ...size,
      wanted: 200
    })
    expect(short.maxHeight).toBe(200)
  })

  it('end-aligns a trigger in the trailing half of its bar', () => {
    const row = { left: 500, right: 868, top: 100, bottom: 140 }
    const at = placePopover({ left: 720, right: 852, top: 104, bottom: 136 }, row, win, size)
    expect(at.left).toBe(852 - 320)
    expect(at.top).toBe(140)
  })

  it('keeps 8 px inside the window', () => {
    // A bar wider than the window: a start-aligned trigger near the window's right edge.
    const wide = { left: 0, right: 3000, top: 0, bottom: 40 }
    const at = placePopover({ left: 1300, right: 1420, top: 4, bottom: 36 }, wide, win, size)
    expect(at.left).toBe(1440 - 320 - 8)
    const edge = placePopover({ left: 2, right: 60, top: 4, bottom: 36 }, bar, win, size)
    expect(edge.left).toBe(8)
    // An end-aligned trigger in a narrow bar at the window's left edge.
    const narrow = { left: 0, right: 300, top: 0, bottom: 40 }
    const end = placePopover({ left: 200, right: 290, top: 4, bottom: 36 }, narrow, win, size)
    expect(end.left).toBe(8)
  })

  it('goes above a bar near the bottom of the window when five rows do not fit under it', () => {
    const row = { left: 172, right: 1016, top: 820, bottom: 860 }
    const at = placePopover({ left: 200, right: 420, top: 824, bottom: 856 }, row, win, size)
    expect(at.maxHeight).toBe(540)
    expect(at.top).toBe(820 - 540)
  })
})

describe('placeAtPoint (the selection popover)', () => {
  const win = { width: 1440, height: 900 }
  const size = { width: 400, height: 260 }

  it('puts its start edge on the point and hangs under it', () => {
    expect(placeAtPoint(500, 300, win, size)).toEqual({ left: 500, top: 300 })
  })

  it('rises above the point when there is no room under it', () => {
    expect(placeAtPoint(500, 800, win, size)).toEqual({ left: 500, top: 540 })
  })

  it('keeps 8 px inside the window', () => {
    expect(placeAtPoint(1400, 2, win, size)).toEqual({ left: 1440 - 400 - 8, top: 8 })
    expect(placeAtPoint(0, 0, win, size)).toEqual({ left: 8, top: 8 })
  })
})
