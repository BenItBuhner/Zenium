/**
 * The computer's battery as the host can read it (W8-2, Energy Saver): whether one is fitted,
 * and its charge for the `low-battery` mode. Electron's `powerMonitor` says whether the computer
 * runs on its battery (`isOnBatteryPower`, `on-battery` / `on-ac`) and nothing of the level or
 * of there being one – Chrome reads both through `base::BatteryStateSampler`, a platform layer
 * Electron does not expose (and one Chrome builds for Windows and macOS alone:
 * `_has_battery_provider_impl = is_win || is_mac` in `base/BUILD.gn`, so Chrome on Linux never
 * learns of a battery and never shows its Battery Saver section). Where Node can read it without
 * a native module:
 *
 * - Linux: `/sys/class/power_supply/<supply>/` – a supply whose `type` is `Battery` and whose
 *   `scope` is not `Device` (a wireless mouse's or a headset's cell is a `Battery` supply too,
 *   scoped `Device`; the computer's own reads `System`, or has no scope file on older kernels) –
 *   `BAT0`, `BAT1`, a `CMB0`; its `capacity` (0–100); read synchronously (a sysfs read is
 *   microseconds). A power-supply class with no such supply is a computer without a battery;
 *   no power-supply class at all (a sandbox, a kernel without it) is a host that cannot tell.
 * - macOS: `pmset -g batt`, whose second line reads
 *   ` -InternalBattery-0 (id=…)	57%; discharging; 3:12 remaining present: true` – one short
 *   subprocess, asynchronous, at most every `REFRESH_MS`; the sample reads the last answer. A
 *   Mac without a battery prints the first line alone (`Now drawing from 'AC Power'`).
 * - Windows: `GetSystemPowerStatus` (or WMI's `Win32_Battery`) needs a native module or a
 *   PowerShell child per read, neither of which this slice takes: null on both counts, the stated
 *   limit – the Settings row says the level cannot be read, the `low-battery` mode waits, and
 *   the Energy Saver group stays (a host that cannot tell shows it).
 *
 * Chrome's `--force-device-has-battery` (`BatterySaverModeManager::kForceDeviceHasBatterySwitch`)
 * is honoured under the same name: the computer is taken to have a battery whatever the host
 * says – the drives' switch on a machine without one, never set in a normal launch.
 */
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { batteryPercentFrom } from '../../../core/resources/energySaver'

/** How old a macOS reading may be before the next sample asks `pmset` again. */
export const BATTERY_REFRESH_MS = 15_000

const SYSFS_POWER_SUPPLY = '/sys/class/power_supply'

/** Chrome's switch, under Chrome's name: the host is taken to have a battery. */
export const FORCE_DEVICE_HAS_BATTERY_FLAG = '--force-device-has-battery'

/** Whether `argv` (the process's) carries {@link FORCE_DEVICE_HAS_BATTERY_FLAG}. */
export function forceDeviceHasBatteryRequested(argv: readonly string[]): boolean {
  return argv.includes(FORCE_DEVICE_HAS_BATTERY_FLAG)
}

/** What the host says of the computer's battery. */
export interface HostBattery {
  /** true / false where the host can tell whether a battery is fitted; null where it cannot. */
  hasBattery: boolean | null
  /** Its charge, 0–100, where the host can read it; null where it cannot or there is none. */
  percent: number | null
}

const CANNOT_TELL = (): HostBattery => ({ hasBattery: null, percent: null })

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

/**
 * Linux: the computer's own `Battery` supplies – whether there is one, and the first readable
 * `capacity` among them (a supply without one – a UPS, a hot-unplugged pack – still counts as
 * fitted; the next supply may carry the level).
 */
export function readSysfsBattery(root = SYSFS_POWER_SUPPLY): HostBattery {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return CANNOT_TELL()
  }
  let hasBattery = false
  let percent: number | null = null
  for (const name of entries.sort()) {
    const supply = join(root, name)
    if (readText(join(supply, 'type')) !== 'Battery') continue
    if (readText(join(supply, 'scope')) === 'Device') continue
    hasBattery = true
    if (percent === null) percent = batteryPercentFrom(readText(join(supply, 'capacity')))
  }
  return { hasBattery, percent }
}

/**
 * macOS: `pmset -g batt`'s reading – a battery where an InternalBattery line is listed, none
 * where the output has only its power-source line, and no telling from nothing at all.
 */
export function parsePmsetBattery(output: string): HostBattery {
  if (output.trim() === '') return CANNOT_TELL()
  const line = output.split('\n').find((l) => l.includes('InternalBattery'))
  if (line === undefined) return { hasBattery: false, percent: null }
  const match = line.match(/(\d{1,3})%/)
  return { hasBattery: true, percent: match ? batteryPercentFrom(match[1]) : null }
}

export interface BatteryLevelOptions {
  /** Linux's power-supply class (the tests hand in a scratch directory). */
  sysfsRoot?: string
  /** `--force-device-has-battery` was on the command line. */
  forceHasBattery?: boolean
}

export class BatteryLevel {
  private state: HostBattery = CANNOT_TELL()
  private readAt = 0
  private pending = false
  private readonly sysfsRoot: string
  private readonly forceHasBattery: boolean

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    options: BatteryLevelOptions = {}
  ) {
    this.sysfsRoot = options.sysfsRoot ?? SYSFS_POWER_SUPPLY
    this.forceHasBattery = options.forceHasBattery ?? false
  }

  /**
   * Whether the computer has a battery, as last read: null where the host cannot tell (Windows;
   * macOS before `pmset` has answered, or when it failed; Linux without a power-supply class).
   * Forced true by {@link FORCE_DEVICE_HAS_BATTERY_FLAG}, as Chrome's provider is.
   */
  hasBattery(): boolean | null {
    return this.forceHasBattery ? true : this.state.hasBattery
  }

  /**
   * The charge as last read, refreshing where the read is a subprocess (macOS) once it is
   * older than `BATTERY_REFRESH_MS` – the fresh value lands in the next sample.
   */
  read(now = Date.now()): number | null {
    if (this.platform === 'linux') {
      this.state = readSysfsBattery(this.sysfsRoot)
      this.readAt = now
      return this.state.percent
    }
    if (this.platform === 'darwin') {
      if (!this.pending && now - this.readAt >= BATTERY_REFRESH_MS) void this.refresh(now)
      return this.state.percent
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
        this.state = error ? CANNOT_TELL() : parsePmsetBattery(String(stdout))
        resolve(this.state.percent)
      })
    })
  }
}
