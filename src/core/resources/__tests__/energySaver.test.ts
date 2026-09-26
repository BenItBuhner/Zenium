import { describe, expect, it } from 'vitest'
import { ENERGY_SAVER_LOW_BATTERY_PERCENT } from '../../../shared/types'
import { batteryPercentFrom, energySaverActive } from '../energySaver'

/*
 * Energy Saver's rule (W8-2): Chrome's `BatterySaverModeManager::UpdateBatterySaverModeState`
 * over the mode the user chose and the power state the host reads – pure, one rule for the
 * governor's sample and for Settings' status line.
 */

describe('energySaverActive', () => {
  it('is never on while the computer is plugged in, whatever the mode', () => {
    for (const mode of ['off', 'low-battery', 'on-battery'] as const) {
      expect(energySaverActive({ mode, onBattery: false, percent: 5 })).toBe(false)
      expect(energySaverActive({ mode, onBattery: false, percent: null })).toBe(false)
    }
  })

  it('off (Chrome’s kDisabled) is never on', () => {
    expect(energySaverActive({ mode: 'off', onBattery: true, percent: 3 })).toBe(false)
    expect(energySaverActive({ mode: 'off', onBattery: true, percent: null })).toBe(false)
  })

  it('on-battery (kEnabledOnBattery) is on whenever the computer runs on its battery, level or no level', () => {
    expect(energySaverActive({ mode: 'on-battery', onBattery: true, percent: 97 })).toBe(true)
    expect(energySaverActive({ mode: 'on-battery', onBattery: true, percent: null })).toBe(true)
  })

  it('low-battery (kEnabledBelowThreshold) is on at 20% or lower, as its row says, and waits where the level cannot be read', () => {
    expect(ENERGY_SAVER_LOW_BATTERY_PERCENT).toBe(20)
    const at = (percent: number | null): boolean =>
      energySaverActive({ mode: 'low-battery', onBattery: true, percent })
    expect(at(21)).toBe(false)
    expect(at(20)).toBe(true)
    expect(at(19)).toBe(true)
    expect(at(0)).toBe(true)
    expect(at(100)).toBe(false)
    // Windows without a native module, a desktop with no battery: the mode never trips.
    expect(at(null)).toBe(false)
  })

  it('Turn off now (SetTemporaryBatterySaverDisabledForSession) holds the mode off until the caller clears it', () => {
    expect(
      energySaverActive({
        mode: 'on-battery',
        onBattery: true,
        percent: 50,
        disabledForSession: true
      })
    ).toBe(false)
    expect(
      energySaverActive({
        mode: 'low-battery',
        onBattery: true,
        percent: 5,
        disabledForSession: true
      })
    ).toBe(false)
    expect(
      energySaverActive({
        mode: 'on-battery',
        onBattery: true,
        percent: 50,
        disabledForSession: false
      })
    ).toBe(true)
  })
})

describe('batteryPercentFrom', () => {
  it('reads an integer 0–100 out of a number or a host’s text, trimmed', () => {
    expect(batteryPercentFrom(57)).toBe(57)
    expect(batteryPercentFrom('57')).toBe(57)
    expect(batteryPercentFrom('57\n')).toBe(57)
    expect(batteryPercentFrom('  100 ')).toBe(100)
    expect(batteryPercentFrom('0')).toBe(0)
    expect(batteryPercentFrom(57.6)).toBe(58)
  })

  it('is null for nothing, "unknown", a negative, a value past 100 or text with no number', () => {
    expect(batteryPercentFrom(null)).toBeNull()
    expect(batteryPercentFrom(undefined)).toBeNull()
    expect(batteryPercentFrom('')).toBeNull()
    expect(batteryPercentFrom('unknown')).toBeNull()
    expect(batteryPercentFrom(-1)).toBeNull()
    expect(batteryPercentFrom('101')).toBeNull()
    expect(batteryPercentFrom(Number.NaN)).toBeNull()
    expect(batteryPercentFrom(Number.POSITIVE_INFINITY)).toBeNull()
  })
})
