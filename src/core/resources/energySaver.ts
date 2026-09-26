/**
 * Energy Saver's rule (W8-2; Chrome's `BatterySaverModeManager::UpdateBatterySaverModeState`,
 * `chrome/browser/performance_manager/public/user_tuning/battery_saver_mode_manager.cc`): when
 * the mode the user chose (`Settings.energySaver`) is met by the power state the host reads.
 * Pure, so the governor and its tests read one rule:
 *
 * - `on-battery` (Chrome's `kEnabledOnBattery`): on whenever the computer runs on its battery.
 * - `low-battery` (`kEnabledBelowThreshold`): on while on battery AND the charge is at
 *   `ENERGY_SAVER_LOW_BATTERY_PERCENT` (20) or lower – Chrome's `battery_percentage_ <
 *   kLowBatteryThresholdPercent + adjustment` reads "below 20"; its row says "at 20% or
 *   lower", and the row's words are the rule here. A host that cannot read the level
 *   (`percent` null: Windows without a native module, a computer without a battery) never
 *   meets it – the mode waits, as the Settings row says.
 * - `off` (`kDisabled`): never.
 *
 * `disabledForSession` is the leaf bubble's "Turn off now" (Chrome's
 * `SetTemporaryBatterySaverDisabledForSession`): the mode stands but is not on until the
 * charger is plugged in, which clears it (the governor clears the flag on `on-ac`).
 */
import { ENERGY_SAVER_LOW_BATTERY_PERCENT, type EnergySaverMode } from '../../shared/types'

export interface EnergySaverInput {
  mode: EnergySaverMode
  onBattery: boolean
  /** The charge, 0–100, or null where the host cannot read it. */
  percent: number | null
  /** The user pressed Turn off now since the charger was last unplugged. */
  disabledForSession?: boolean
}

export function energySaverActive({
  mode,
  onBattery,
  percent,
  disabledForSession = false
}: EnergySaverInput): boolean {
  if (disabledForSession || !onBattery) return false
  switch (mode) {
    case 'on-battery':
      return true
    case 'low-battery':
      return percent !== null && percent <= ENERGY_SAVER_LOW_BATTERY_PERCENT
    case 'off':
      return false
  }
}

/**
 * Read a battery percentage out of a host's report: an integer 0–100, else null (an absent
 * battery, a sysfs file that reads "unknown", a `pmset` line without a percentage).
 */
export function batteryPercentFrom(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10)
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return Math.round(n)
}
