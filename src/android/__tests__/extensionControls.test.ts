import { describe, expect, it, vi } from 'vitest'
import type { ExtensionControl } from '@shared/types'
import { ExtensionControlsGate, sameControls, sameValue } from '../extensionControls'
import { SettingControls } from '../settingControls'

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function held(value: ExtensionControl['value'], extensionId = A): ExtensionControl {
  return { extensionId, name: extensionId === A ? 'Probe A' : 'Probe B', value }
}

/** The phone's wiring (`AndroidExtensionRuntime`): W6-C6's publisher over the state's sink, the runtime's gate ahead of it. */
function wire(): {
  sink: ReturnType<typeof vi.fn>
  publisher: SettingControls
  gate: ExtensionControlsGate
} {
  const sink = vi.fn()
  const publisher = new SettingControls({ setExtensionControls: sink })
  const gate = new ExtensionControlsGate(publisher)
  return { sink, publisher, gate }
}

describe('ExtensionControlsGate over SettingControls (round 21, R21-8: one publisher on the phone)', () => {
  it("feeds W6-C6's SettingControls, which alone writes the state", () => {
    const { sink, publisher, gate } = wire()
    const theirs = vi.spyOn(publisher, 'publish')

    expect(gate.publish('fontSettings', { 'fonts.size': held(18) })).toBe(true)
    expect(theirs).toHaveBeenCalledWith('fontSettings', { 'fonts.size': held(18) })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0]).toEqual({ 'fonts.size': held(18) })
    // The merged map read back is the publisher's own.
    expect(gate.current).toBe(publisher.current)
  })

  it('republishes a same-extension value change and not the same value again (#525 semantics)', () => {
    const { sink, gate } = wire()

    gate.publish('fontSettings', { 'fonts.size': held(18) })
    expect(sink).toHaveBeenCalledTimes(1)

    // The same holder, a new size: the held row shows the value in effect, so it republishes.
    expect(gate.publish('fontSettings', { 'fonts.size': held(20) })).toBe(true)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink.mock.calls[1][0]).toEqual({ 'fonts.size': held(20) })

    // The same value again, a fresh object: nothing moved, nothing published.
    expect(gate.publish('fontSettings', { 'fonts.size': held(20) })).toBe(false)
    expect(sink).toHaveBeenCalledTimes(2)

    // A list compared by its entries: the same entries in a new array publish nothing (the gate;
    // SettingControls alone would read two arrays as different), a changed entry does, a
    // different length does.
    gate.publish('startup', { 'startup.pages': held(['https://a.test/', 'https://b.test/'], B) })
    expect(sink).toHaveBeenCalledTimes(3)
    expect(
      gate.publish('startup', { 'startup.pages': held(['https://a.test/', 'https://b.test/'], B) })
    ).toBe(false)
    expect(sink).toHaveBeenCalledTimes(3)
    gate.publish('startup', { 'startup.pages': held(['https://a.test/', 'https://c.test/'], B) })
    expect(sink).toHaveBeenCalledTimes(4)
    gate.publish('startup', { 'startup.pages': held(['https://a.test/'], B) })
    expect(sink).toHaveBeenCalledTimes(5)

    // The merge is of every API's map: one API's republish keeps the other's keys.
    expect(gate.current).toEqual({
      'fonts.size': held(20),
      'startup.pages': held(['https://a.test/'], B)
    })

    // A holder change under the same value republishes; a dropped layer republishes once.
    gate.publish('fontSettings', { 'fonts.size': held(20, B) })
    expect(sink).toHaveBeenCalledTimes(6)
    expect(gate.publish('fontSettings', {})).toBe(true)
    expect(sink).toHaveBeenCalledTimes(7)
    expect(sink.mock.calls[6][0]).toEqual({ 'startup.pages': held(['https://a.test/'], B) })
    expect(gate.publish('fontSettings', {})).toBe(false)
    expect(sink).toHaveBeenCalledTimes(7)

    // A layer let go and taken again republishes (the gate forgets a dropped API).
    expect(gate.publish('fontSettings', { 'fonts.size': held(20, B) })).toBe(true)
    expect(sink).toHaveBeenCalledTimes(8)
  })

  it("keeps the fontSettings keys the phone's bridge publishes (all of them, not the six alone)", () => {
    const { sink, gate } = wire()
    const controls: Record<string, ExtensionControl> = {
      'fonts.standard': held('Roboto'),
      'fonts.size': held(20),
      'fonts.fixedSize': held(14),
      'fonts.math': held('STIX Two Math'),
      'fonts.standard.Cyrl': held('Noto Sans')
    }
    gate.publish('fontSettings', controls)
    expect(sink.mock.calls[0][0]).toEqual(controls)
    gate.publish('privacy', { 'privacy.doNotTrack': held(true, B) })
    expect(sink.mock.calls[1][0]).toEqual({ ...controls, 'privacy.doNotTrack': held(true, B) })
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
