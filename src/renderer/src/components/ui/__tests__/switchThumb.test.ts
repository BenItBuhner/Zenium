import { describe, expect, it } from 'vitest'
import {
  SWITCH_THUMB_INSET,
  SWITCH_THUMB_SIZE,
  SWITCH_TRACK_WIDTH,
  switchThumbX
} from '../switchThumb'

describe('switchThumbX', () => {
  it('is the spec geometry: a 44 × 26 track with a 22 thumb inset 2', () => {
    expect(SWITCH_TRACK_WIDTH).toBe(44)
    expect(SWITCH_THUMB_SIZE).toBe(22)
    expect(SWITCH_THUMB_INSET).toBe(2)
  })

  it('rests the thumb 2px in from either end', () => {
    expect(switchThumbX(false)).toBe(2)
    expect(switchThumbX(true)).toBe(20)
    expect(switchThumbX(true) + SWITCH_THUMB_SIZE + SWITCH_THUMB_INSET).toBe(SWITCH_TRACK_WIDTH)
  })
})
