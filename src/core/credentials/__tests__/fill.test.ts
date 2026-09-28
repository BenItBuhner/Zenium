import { describe, expect, it } from 'vitest'
import {
  PICKER_SURFACE_PAD,
  PICKER_WIDTH,
  anchorInChrome,
  clearsInLabel,
  decideSave,
  estimatePickerHeight,
  orderLoginsForPicker,
  placePickerSurface,
  type LoginCandidate,
  type SaveContext
} from '../fill'
import { credential } from './fakes'

function candidate(overrides: Partial<LoginCandidate> = {}): LoginCandidate {
  return {
    origin: 'https://example.com',
    url: 'https://example.com/login',
    username: 'ada',
    password: 'pw-new',
    newPassword: false,
    ...overrides
  }
}

function context(overrides: Partial<SaveContext> = {}): SaveContext {
  return { offerToSave: true, isPrivate: false, neverSave: false, matches: [], ...overrides }
}

describe('decideSave', () => {
  it('offers to save an unknown login and stays quiet without a password', () => {
    expect(decideSave(candidate(), context())).toEqual({ kind: 'save' })
    expect(decideSave(candidate({ password: '' }), context())).toEqual({
      kind: 'none',
      reason: 'empty'
    })
  })

  it('never prompts in private tabs, on never-save sites, or with the setting off', () => {
    expect(decideSave(candidate(), context({ isPrivate: true }))).toEqual({
      kind: 'none',
      reason: 'private'
    })
    expect(decideSave(candidate(), context({ neverSave: true }))).toEqual({
      kind: 'none',
      reason: 'never'
    })
    expect(decideSave(candidate(), context({ offerToSave: false }))).toEqual({
      kind: 'none',
      reason: 'disabled'
    })
  })

  it('treats the same username with another password as an update, ignoring case and spaces', () => {
    const saved = credential({ username: 'Ada', password: 'pw-old' })
    const decision = decideSave(candidate({ username: ' ada ' }), context({ matches: [saved] }))
    expect(decision).toEqual({ kind: 'update', existing: saved })
  })

  it('recognises credentials that are already saved and points at the login to mark used', () => {
    const saved = credential({ username: 'ada', password: 'pw-new' })
    expect(decideSave(candidate(), context({ matches: [saved] }))).toEqual({
      kind: 'none',
      reason: 'saved',
      existing: saved
    })
  })

  it('prefers the login of the exact origin, then the most recently used, for an update', () => {
    const sibling = credential({
      origin: 'https://login.example.com',
      username: 'ada',
      password: 'a',
      lastUsedAt: 9_000
    })
    const exact = credential({
      origin: 'https://example.com',
      username: 'ada',
      password: 'b',
      lastUsedAt: 1_000
    })
    expect(decideSave(candidate(), context({ matches: [sibling, exact] }))).toEqual({
      kind: 'update',
      existing: exact
    })

    const older = credential({
      origin: 'https://a.example.com',
      username: 'ada',
      password: 'a',
      lastUsedAt: 1_000
    })
    const newer = credential({
      origin: 'https://b.example.com',
      username: 'ada',
      password: 'b',
      lastUsedAt: 2_000
    })
    expect(decideSave(candidate(), context({ matches: [older, newer] }))).toEqual({
      kind: 'update',
      existing: newer
    })
  })

  it('handles change-password forms without a username field', () => {
    const only = credential({ username: 'ada', password: 'pw-old' })
    expect(decideSave(candidate({ username: '' }), context({ matches: [only] }))).toEqual({
      kind: 'update',
      existing: only
    })
    // The same password again is nothing new.
    expect(
      decideSave(candidate({ username: '', password: 'pw-old' }), context({ matches: [only] }))
    ).toEqual({
      kind: 'none',
      reason: 'saved',
      existing: only
    })
    // Several saved logins: there is no telling which one changed.
    const other = credential({ username: 'bob', password: 'x' })
    expect(decideSave(candidate({ username: '' }), context({ matches: [only, other] }))).toEqual({
      kind: 'none',
      reason: 'saved'
    })
    // Nothing saved at all: a login without a username is still worth keeping.
    expect(decideSave(candidate({ username: '' }), context())).toEqual({ kind: 'save' })
  })
})

describe('orderLoginsForPicker', () => {
  it('lists the page origin first, then siblings by recency, with the sibling host as subtitle', () => {
    const sibling = credential({
      origin: 'https://accounts.example.com',
      username: 'sib',
      lastUsedAt: 5_000
    })
    const exactOld = credential({
      origin: 'https://example.com',
      username: 'old',
      lastUsedAt: 1_000
    })
    const exactNew = credential({
      origin: 'https://example.com',
      username: 'new',
      lastUsedAt: 2_000
    })
    const rows = orderLoginsForPicker([sibling, exactOld, exactNew], 'https://example.com')
    expect(rows.map((r) => r.credential.username)).toEqual(['new', 'old', 'sib'])
    expect(rows.map((r) => r.subtitle)).toEqual(['', '', 'accounts.example.com'])
  })

  it('falls back to the update time for logins never used', () => {
    const a = credential({ updatedAt: 1_000, lastUsedAt: null })
    const b = credential({ updatedAt: 2_000, lastUsedAt: null })
    expect(orderLoginsForPicker([a, b], 'https://example.com').map((r) => r.credential.id)).toEqual(
      [b.id, a.id]
    )
  })
})

describe('anchorInChrome', () => {
  const view = { x: 0, y: 84, width: 1200, height: 700 }

  it('offsets the field by the view position and scales it by the zoom', () => {
    expect(anchorInChrome({ x: 100, y: 50, width: 200, height: 32 }, view, 1)).toEqual({
      x: 100,
      y: 134,
      width: 200,
      height: 32
    })
    expect(anchorInChrome({ x: 100, y: 50, width: 200, height: 32 }, view, 1.5)).toEqual({
      x: 150,
      y: 159,
      width: 300,
      height: 48
    })
  })

  it('clips a field that is partly off the view and rounds to whole pixels', () => {
    expect(anchorInChrome({ x: 1150, y: -10, width: 200, height: 30.4 }, view, 1)).toEqual({
      x: 1150,
      y: 84,
      width: 50,
      height: 20
    })
    expect(anchorInChrome({ x: 5000, y: 5000, width: 10, height: 10 }, view, 1)).toEqual({
      x: 1200,
      y: 784,
      width: 0,
      height: 0
    })
  })

  it('treats a missing or bogus zoom as 1', () => {
    expect(anchorInChrome({ x: 10, y: 10, width: 10, height: 10 }, view, 0)).toEqual({
      x: 10,
      y: 94,
      width: 10,
      height: 10
    })
  })
})

describe('placePickerSurface', () => {
  const viewport = { width: 1280, height: 800 }
  const field = { x: 300, y: 200, width: 240, height: 32 }

  it('hangs the panel from the field, start edges aligned, with the shadow margin around it', () => {
    expect(placePickerSurface(field, viewport, 120)).toEqual({
      x: 300 - PICKER_SURFACE_PAD,
      y: 232 - PICKER_SURFACE_PAD,
      width: PICKER_WIDTH + PICKER_SURFACE_PAD * 2,
      height: 120 + PICKER_SURFACE_PAD * 2
    })
  })

  it('keeps the panel inside the window sideways', () => {
    expect(placePickerSurface({ ...field, x: 1200 }, viewport, 120).x).toBe(
      1280 - PICKER_WIDTH - 8 - PICKER_SURFACE_PAD
    )
    expect(placePickerSurface({ ...field, x: -40 }, viewport, 120).x).toBe(8 - PICKER_SURFACE_PAD)
  })

  it('flips above a field near the bottom when there is more room above', () => {
    const low = { ...field, y: 740 }
    const placed = placePickerSurface(low, viewport, 200)
    expect(placed.y + PICKER_SURFACE_PAD).toBe(740 - 200)
    expect(placed.height).toBe(200 + PICKER_SURFACE_PAD * 2)
  })

  it('clamps a tall panel to 60% of the window and to the room on its side', () => {
    expect(placePickerSurface(field, viewport, 2000).height).toBe(480 + PICKER_SURFACE_PAD * 2)
    const short = { width: 1280, height: 300 }
    // Below: 300 - 232 - 8 = 60 of room; above: 192. A 150 panel flips and fits above.
    expect(placePickerSurface(field, short, 150)).toMatchObject({
      y: 200 - 150 - PICKER_SURFACE_PAD,
      height: 150 + PICKER_SURFACE_PAD * 2
    })
    // Above is the larger side but still too small: the panel takes what there is.
    expect(placePickerSurface(field, short, 190).height).toBe(180 + PICKER_SURFACE_PAD * 2)
  })

  it('estimates a panel from its rows until the document has measured itself', () => {
    expect(estimatePickerHeight(1, false)).toBe(32 + 32 + 41)
    expect(estimatePickerHeight(3, true)).toBe(32 + 3 * 52 + 41)
    expect(estimatePickerHeight(0, false)).toBe(estimatePickerHeight(1, false))
  })

  // The room a tooltip's moment asks beyond the panel's box (§9.31, W8-F18; the pill's
  // `placeMiniMenuSurface` tail): the surface reaches under the box and widens around it; the
  // panel's own pixels – the box's top-left, and its width and height – stand where they stood.
  describe('with a tooltip room', () => {
    const box = placePickerSurface(field, viewport, 120)

    it('reaches the room under the box, the panel unmoved, and no room is the box itself', () => {
      expect(placePickerSurface(field, viewport, 120, { below: 29, width: 200 })).toEqual({
        ...box,
        height: box.height + 29
      })
      expect(placePickerSurface(field, viewport, 120, null)).toEqual(box)
      expect(placePickerSurface(field, viewport, 120, { below: 0, width: 0 })).toEqual(box)
    })

    it('takes a fractional room up to whole pixels', () => {
      expect(placePickerSurface(field, viewport, 120, { below: 28.2, width: 0 }).height).toBe(
        box.height + 29
      )
    })

    it('reaches no further than the window’s bottom', () => {
      // The box ends at 232 - 8 + 136 = 360; 800 - 360 = 440 of window under it.
      expect(placePickerSurface(field, viewport, 120, { below: 1000, width: 0 }).height).toBe(
        box.height + 440
      )
      // A panel that flipped above a low field: the box ends on the field's top edge, and the
      // room under it runs down over the field to the window's bottom, no further.
      const low = { ...field, y: 740 }
      const flipped = placePickerSurface(low, viewport, 200)
      expect(placePickerSurface(low, viewport, 200, { below: 1000, width: 0 })).toEqual({
        ...flipped,
        height: 800 - flipped.y
      })
    })

    it('widens evenly around the panel toward the least width, as far as the window’s sides allow', () => {
      // 336 wide at rest; 400 asked: 64 more, 32 each side.
      expect(placePickerSurface(field, viewport, 120, { below: 0, width: 400 })).toEqual({
        ...box,
        x: box.x - 32,
        width: 400
      })
      // An odd extra is rounded up to even so the split is whole pixels each side.
      expect(placePickerSurface(field, viewport, 120, { below: 0, width: 401 })).toEqual({
        ...box,
        x: box.x - 33,
        width: 402
      })
      // A width the box already has, or less, changes nothing.
      expect(placePickerSurface(field, viewport, 120, { below: 0, width: 336 })).toEqual(box)
      expect(placePickerSurface(field, viewport, 120, { below: 0, width: 100 })).toEqual(box)
      // At the window's edge the widening is capped by the nearer side, evenly.
      const edge = placePickerSurface({ ...field, x: -40 }, viewport, 120)
      expect(edge.x).toBe(0)
      expect(
        placePickerSurface({ ...field, x: -40 }, viewport, 120, { below: 0, width: 400 })
      ).toEqual(edge)
      const near = placePickerSurface({ ...field, x: 10 }, viewport, 120)
      expect(near.x).toBe(2)
      expect(
        placePickerSurface({ ...field, x: 10 }, viewport, 120, { below: 0, width: 400 })
      ).toEqual({
        ...near,
        x: 0,
        width: near.width + 4
      })
    })

    it('grows both ways at once', () => {
      expect(placePickerSurface(field, viewport, 120, { below: 29, width: 400 })).toEqual({
        x: box.x - 32,
        y: box.y,
        width: 400,
        height: box.height + 29
      })
    })
  })
})

describe('clearsInLabel', () => {
  it('says seconds, minutes or hours', () => {
    expect(clearsInLabel(30)).toBe('30 s')
    expect(clearsInLabel(60)).toBe('1 min')
    expect(clearsInLabel(150)).toBe('3 min')
    expect(clearsInLabel(3600)).toBe('1 h')
  })
})
