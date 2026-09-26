/**
 * The battery's charge as the host can read it (W8-2, Energy Saver's `low-battery` mode).
 * Electron's `powerMonitor` says whether the computer runs on its battery (`isOnBatteryPower`,
 * `on-battery` / `on-ac`) and nothing of the level – Chrome reads it through
 * `base::BatteryStateSampler`, a platform layer Electron does not expose. Where Node can read
 * it without a native module:
 *
 * - Linux: `/sys/class/power_supply/<supply>/capacity` (0–100) of a supply whose `type` is
 *   `Battery` – `BAT0`, `BAT1`, a `CMB0`; read synchronously (a sysfs read is microseconds).
 * - macOS: `pmset -g batt`, whose second line reads
 *   ` -InternalBattery-0 (id=…)	57%; discharging; 3:12 remaining present: true` – one short
 *   subprocess, asynchronous, at most every `REFRESH_MS`; the sample reads the last answer.
 * - Windows: `GetSystemPowerStatus` (or WMI's `Win32_Battery`) needs a native module or a
 *   PowerShell child per read, neither of which this slice takes: `null`, the stated limit –
 *   the Settings row says the level cannot be read, and the `low-battery` mode waits.
 *
 * A computer without a battery reads `null` on every platform (no `Battery` supply, no
 * `InternalBattery` line).
 */
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { batteryPercentFrom } from '../../../core/resources/energySaver'

/** How old a macOS reading may be before the next sample asks `pmset` again. */
export const BATTERY_REFRESH_MS = 15_000

const SYSFS_POWER_SUPPLY = '/sys/class/power_supply'

/** Linux: the first `Battery` supply's `capacity`, else null. */
export function readSysfsBatteryPercent(root = SYSFS_POWER_SUPPLY): number | null {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  for (const name of entries.sort()) {
    try {
      const type = readFileSync(join(root, name, 'type'), 'utf8').trim()
      if (type !== 'Battery') continue
      const percent = batteryPercentFrom(readFileSync(join(root, name, 'capacity'), 'utf8'))
      if (percent !== null) return percent
    } catch {
      // A supply without a readable capacity (a UPS, a hot-unplugged pack): the next one.
    }
  }
  return null
}

/** macOS: the percentage in `pmset -g batt`'s InternalBattery line, else null. */
export function parsePmsetBatteryPercent(output: string): number | null {
  const line = output.split('\n').find((l) => l.includes('InternalBattery'))
  const match = line?.match(/(\d{1,3})%/)
  return match ? batteryPercentFrom(match[1]) : null
}

export class BatteryLevel {
  private percent: number | null = null
  private readAt = 0
  private pending = false

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly sysfsRoot = SYSFS_POWER_SUPPLY
  ) {}

  /**
   * The charge as last read, refreshing where the read is a subprocess (macOS) once it is
   * older than `BATTERY_REFRESH_MS` – the fresh value lands in the next sample.
   */
  read(now = Date.now()): number | null {
    if (this.platform === 'linux') {
      this.percent = readSysfsBatteryPercent(this.sysfsRoot)
      this.readAt = now
      return this.percent
    }
    if (this.platform === 'darwin') {
      if (!this.pending && now - this.readAt >= BATTERY_REFRESH_MS) void this.refresh(now)
      return this.percent
    }
    return null
  }

  /** Ask the host now (the governor's start, a power-source change); resolves to the reading. */
  refresh(now = Date.now()): Promise<number | null> {
    if (this.platform === 'linux') return Promise.resolve(this.read(now))
    if (this.platform !== 'darwin') return Promise.resolve(null)
    this.pending = true
    return new Promise((resolve) => {
      execFile('pmset', ['-g', 'batt'], { timeout: 2_000 }, (error, stdout) => {
        this.pending = false
        this.readAt = Date.now()
        this.percent = error ? null : parsePmsetBatteryPercent(String(stdout))
        resolve(this.percent)
      })
    })
  }
}
