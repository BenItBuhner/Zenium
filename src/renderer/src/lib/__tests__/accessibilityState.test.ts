import { afterEach, describe, expect, it } from 'vitest'
import {
  accessibilityStateOf,
  accessibilityStore,
  applyAccessibilityState,
  DEFAULT_ACCESSIBILITY_STATE,
  LARGE_TEXT_FONT_SCALE,
  largeText,
  menuAsList,
  resetAccessibilityState
} from '../accessibilityState'

/**
 * The device's accessibility state as the host reports it (A11Y-04): touch exploration and the
 * font scale, read at boot and on every `accessibility` event, and the one question the phone
 * menu asks of it – does the icon row pose as a list.
 */
afterEach(() => resetAccessibilityState())

describe('accessibilityStateOf', () => {
  it('reads the host’s payload as it comes', () => {
    expect(accessibilityStateOf({ touchExploration: true, fontScale: 1.3 })).toEqual({
      touchExploration: true,
      fontScale: 1.3
    })
    expect(accessibilityStateOf({ touchExploration: false, fontScale: 1 })).toEqual(
      DEFAULT_ACCESSIBILITY_STATE
    )
  })

  it('keeps what a partial or malformed payload leaves out: a flag that is not a boolean, a scale that is not a finite positive number', () => {
    const was = { touchExploration: true, fontScale: 1.15 }
    expect(accessibilityStateOf({ fontScale: 2 }, was)).toEqual({
      touchExploration: true,
      fontScale: 2
    })
    expect(accessibilityStateOf({ touchExploration: false }, was)).toEqual({
      touchExploration: false,
      fontScale: 1.15
    })
    expect(accessibilityStateOf({ touchExploration: 'yes', fontScale: 0 }, was)).toEqual(was)
    expect(accessibilityStateOf({ fontScale: Number.NaN }, was)).toEqual(was)
    expect(accessibilityStateOf({ fontScale: -1 }, was)).toEqual(was)
    expect(accessibilityStateOf(null, was)).toEqual(was)
    expect(accessibilityStateOf(undefined)).toEqual(DEFAULT_ACCESSIBILITY_STATE)
  })

  it('an older host’s boot payload reads through the flag and the environment’s scale, either absent', () => {
    // `boot.ts` builds this from `boot.touchExploration` and `boot.environment?.fontScale`.
    expect(accessibilityStateOf({ touchExploration: undefined, fontScale: undefined })).toEqual(
      DEFAULT_ACCESSIBILITY_STATE
    )
    expect(accessibilityStateOf({ touchExploration: true, fontScale: undefined })).toEqual({
      touchExploration: true,
      fontScale: 1
    })
  })
})

describe('largeText', () => {
  it('is Android’s own line, 1.3 (“Large text” in Accessibility settings; the harness’s first fixture)', () => {
    expect(LARGE_TEXT_FONT_SCALE).toBe(1.3)
    expect(largeText(1)).toBe(false)
    expect(largeText(1.15)).toBe(false)
    expect(largeText(1.3)).toBe(true)
    expect(largeText(1.5)).toBe(true)
    expect(largeText(2)).toBe(true)
    expect(largeText(0.85)).toBe(false)
  })

  it('reads the number the user set, not a float’s remainder: 1.3f widened to a double is large text', () => {
    // `Configuration.fontScale` is a float; a host that widens it without rounding sends this.
    expect(largeText(1.2999999523162842)).toBe(true)
    expect(largeText(1.29)).toBe(false)
  })
})

describe('menuAsList', () => {
  it('under touch exploration, or at large text, else the icon row', () => {
    expect(menuAsList({ touchExploration: false, fontScale: 1 })).toBe(false)
    expect(menuAsList({ touchExploration: true, fontScale: 1 })).toBe(true)
    expect(menuAsList({ touchExploration: false, fontScale: 1.3 })).toBe(true)
    expect(menuAsList({ touchExploration: true, fontScale: 1.3 })).toBe(true)
    expect(menuAsList({ touchExploration: false, fontScale: 1.15 })).toBe(false)
  })
})

describe('applyAccessibilityState', () => {
  it('writes the host’s word to the store, field by field, and tells the subscribers once per change', () => {
    let told = 0
    const off = accessibilityStore.subscribe(() => told++)
    applyAccessibilityState({ touchExploration: true, fontScale: 1 })
    expect(accessibilityStore.get()).toEqual({ touchExploration: true, fontScale: 1 })
    expect(told).toBe(1)
    // The same state again is not a change.
    applyAccessibilityState({ touchExploration: true, fontScale: 1 })
    expect(told).toBe(1)
    applyAccessibilityState({ fontScale: 1.3 })
    expect(accessibilityStore.get()).toEqual({ touchExploration: true, fontScale: 1.3 })
    expect(told).toBe(2)
    applyAccessibilityState(undefined)
    expect(accessibilityStore.get()).toEqual({ touchExploration: true, fontScale: 1.3 })
    expect(told).toBe(2)
    off()
  })
})
