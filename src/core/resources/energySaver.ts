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
import {
  ENERGY_SAVER_LOW_BATTERY_PERCENT,
  type EnergySaverMode,
  type Platform,
  type Settings
} from '../../shared/types'

/**
 * The condition a desktop host starts Energy Saver on (pr-584 §D (2)(3)): Chrome's default
 * `kEnabledBelowThreshold` (`performance_manager/public/user_tuning/prefs.cc` registers
 * `battery_saver_mode.state` at it; `battery_page.ts`'s toggle lands there) – the mode whose
 * condition reads the battery level. Where the host cannot read one – Windows, without a native
 * module yet (`batteryPercent` stays null; the row's clause says so) – that default would wait
 * for ever, so Windows starts on `kEnabledOnBattery`, the condition its host can meet. Read by
 * the fresh profile's defaults below and by the Settings row's switch, whose turning on lands
 * on the same condition (and shows it, unchecked-in-waiting, while off).
 */
export function defaultEnergySaverMode(platform: Platform): EnergySaverMode {
  return platform === 'win32' ? 'on-battery' : 'low-battery'
}

/** Chrome's Memory Saver default, `kMedium`: a hidden tab is discarded after 4 hours inactive. */
export const MEMORY_SAVER_DEFAULT_MINUTES = 240

/**
 * Chrome's Performance defaults for a FRESH desktop profile (pr-584 §D (2)(3)), applied where
 * the profile is first written (`BrowserState.load`'s no-file branch) and nowhere else, so an
 * EXISTING profile keeps what it had: its timer as stored (the shipped 20 minutes, which the
 * page lists in its place as "Custom – 20 minutes"), and for a profile from before the mode's
 * key `DEFAULT_SETTINGS.energySaver` – on-battery, the condition the budgets tightened on
 * before the mode had a name. `DEFAULT_SETTINGS` itself is unchanged, so the phone – whose
 * Chrome has no Energy Saver, whose governor is the no-op stub and whose sleeping-tabs ladder
 * is Edge's – reads what it read (null here).
 */
export function freshPerformanceDefaults(
  platform: Platform
): Pick<Settings, 'unloadTimeoutMinutes' | 'energySaver'> | null {
  if (platform === 'android') return null
  return {
    unloadTimeoutMinutes: MEMORY_SAVER_DEFAULT_MINUTES,
    energySaver: defaultEnergySaverMode(platform)
  }
}

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
