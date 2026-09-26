import { describe, expect, it, vi } from 'vitest'
import type { ExtensionControl } from '@shared/types'
import { ExtensionControlsMerge, sameControls, sameValue } from '../extensionControls'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function held(value: ExtensionControl['value'], extensionId = A): ExtensionControl {
  return { extensionId, name: extensionId === A ? 'Probe A' : 'Probe B', value }
}

describe('ExtensionControlsMerge', () => {
  it('republishes a same-extension value change and not the same value again (#525 semantics)', () => {
    const sink = vi.fn()
    const merge = new ExtensionControlsMerge(sink)

    merge.publish('fontSettings', { 'fonts.size': held(18) })
    expect(sink).toHaveBeenCalledTimes(1)

    // The same holder, a new size: the held row shows the value in effect, so it republishes.
    merge.publish('fontSettings', { 'fonts.size': held(20) })
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink.mock.calls[1][0]).toEqual({ 'fonts.size': held(20) })

    // The same value again, a fresh object: nothing moved, nothing published.
    merge.publish('fontSettings', { 'fonts.size': held(20) })
    expect(sink).toHaveBeenCalledTimes(2)

    // A list compared by its entries: the same entries in a new array publish nothing, a
    // changed entry does, a different length does.
    merge.publish('startup', { 'startup.pages': held(['https://a.test/', 'https://b.test/'], B) })
    expect(sink).toHaveBeenCalledTimes(3)
    merge.publish('startup', { 'startup.pages': held(['https://a.test/', 'https://b.test/'], B) })
    expect(sink).toHaveBeenCalledTimes(3)
    merge.publish('startup', { 'startup.pages': held(['https://a.test/', 'https://c.test/'], B) })
    expect(sink).toHaveBeenCalledTimes(4)
    merge.publish('startup', { 'startup.pages': held(['https://a.test/'], B) })
    expect(sink).toHaveBeenCalledTimes(5)

    // The merge is of every API's map: one API's republish keeps the other's keys.
    expect(merge.current).toEqual({
      'fonts.size': held(20),
      'startup.pages': held(['https://a.test/'], B)
    })

    // A holder change under the same value republishes; a dropped layer republishes once.
    merge.publish('fontSettings', { 'fonts.size': held(20, B) })
    expect(sink).toHaveBeenCalledTimes(6)
    merge.publish('fontSettings', {})
    expect(sink).toHaveBeenCalledTimes(7)
    expect(sink.mock.calls[6][0]).toEqual({ 'startup.pages': held(['https://a.test/'], B) })
    merge.publish('fontSettings', {})
    expect(sink).toHaveBeenCalledTimes(7)
  })

  it('compares values as #525 does: scalars by ===, lists by length and entries, a list never equal to a scalar', () => {
    expect(sameValue(18, 18)).toBe(true)
    expect(sameValue(18, '18')).toBe(false)
    expect(sameValue(undefined, undefined)).toBe(true)
    expect(sameValue(undefined, false)).toBe(false)
    expect(sameValue(['x'], ['x'])).toBe(true)
    expect(sameValue(['x', 'y'], ['y', 'x'])).toBe(false)
    expect(sameValue(['x'], ['x', 'x'])).toBe(false)
    expect(sameValue(['x'], 'x')).toBe(false)
    expect(sameValue([], undefined)).toBe(false)
    expect(sameControls({ k: held(['x']) }, { k: held(['x']) })).toBe(true)
    expect(sameControls({ k: held(['x']) }, { k: held(['x'], B) })).toBe(false)
    expect(sameControls({ k: held(1) }, { k: held(1), j: held(2) })).toBe(false)
  })
})
