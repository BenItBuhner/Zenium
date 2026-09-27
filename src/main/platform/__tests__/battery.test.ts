import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The computer's battery as the host can read it without a native module (W8-2, Energy Saver):
 * whether one is fitted – the Settings page hides the Energy Saver group without one, as Chrome's
 * `showBatterySettings_` hides its Battery Saver section (pr-584 L5) – and its charge for the
 * low-battery mode. Linux's sysfs `Battery` supplies of the computer's own (not a peripheral's,
 * `scope` Device) and their `capacity`; macOS's `pmset -g batt` InternalBattery line; and no
 * telling on Windows – the stated limit – nor on a Linux without a power-supply class. Chrome's
 * `--force-device-has-battery` stands a battery in for the drives.
 */

const execFile = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: readonly string[],
      options: unknown,
      cb: (error: Error | null, stdout: string) => void
    ) => void
  >()
)
vi.mock('node:child_process', () => ({ execFile }))

const {
  BATTERY_REFRESH_MS,
  BatteryLevel,
  FORCE_DEVICE_HAS_BATTERY_FLAG,
  forceDeviceHasBatteryRequested,
  parsePmsetBattery,
  readSysfsBattery
} = await import('../resources/battery')

const PMSET_ON_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=4653155)\t57%; discharging; 3:12 remaining present: true
`
const PMSET_CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true
`
const PMSET_NO_BATTERY = `Now drawing from 'AC Power'
`

let root: string

function supply(name: string, type: string, capacity?: string, scope?: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'type'), `${type}\n`)
  if (capacity !== undefined) writeFileSync(join(root, name, 'capacity'), `${capacity}\n`)
  if (scope !== undefined) writeFileSync(join(root, name, 'scope'), `${scope}\n`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zen-power-supply-'))
  execFile.mockReset()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('readSysfsBattery (Linux)', () => {
  it('reads a fitted battery and the first Battery supply’s capacity, skipping the mains adapter', () => {
    supply('AC', 'Mains')
    supply('BAT0', 'Battery', '63', 'System')
    expect(readSysfsBattery(root)).toEqual({ hasBattery: true, percent: 63 })
    // Older kernels write no scope file: the computer's own all the same.
    rmSync(join(root, 'BAT0', 'scope'))
    expect(readSysfsBattery(root)).toEqual({ hasBattery: true, percent: 63 })
  })

  it('reads no battery from a power-supply class with the mains alone (a desktop), and cannot tell without the class', () => {
    supply('AC', 'Mains')
    expect(readSysfsBattery(root)).toEqual({ hasBattery: false, percent: null })
    expect(readSysfsBattery(join(root, 'nowhere'))).toEqual({ hasBattery: null, percent: null })
  })

  it('reads a fitted battery whose capacity is not a number as fitted, its level unread', () => {
    supply('BAT0', 'Battery', 'unknown')
    expect(readSysfsBattery(root)).toEqual({ hasBattery: true, percent: null })
  })

  it('passes over a Battery supply without a readable capacity (a UPS, a hot-unplugged pack) to the next', () => {
    supply('BAT0', 'Battery')
    supply('BAT1', 'Battery', '18')
    expect(readSysfsBattery(root)).toEqual({ hasBattery: true, percent: 18 })
  })

  it('does not take a peripheral’s cell (scope Device – a wireless mouse) for the computer’s battery', () => {
    supply('AC', 'Mains')
    supply('hidpp_battery_0', 'Battery', '55', 'Device')
    expect(readSysfsBattery(root)).toEqual({ hasBattery: false, percent: null })
    // A laptop with the same mouse: the laptop's level, not the mouse's (the mouse sorts first).
    supply('BAT0', 'Battery', '27', 'System')
    expect(readSysfsBattery(root)).toEqual({ hasBattery: true, percent: 27 })
  })
})

describe('parsePmsetBattery (macOS)', () => {
  it('reads a battery and its percentage off the InternalBattery line, discharging or charged', () => {
    expect(parsePmsetBattery(PMSET_ON_BATTERY)).toEqual({ hasBattery: true, percent: 57 })
    expect(parsePmsetBattery(PMSET_CHARGING)).toEqual({ hasBattery: true, percent: 100 })
  })

  it('reads no battery from a Mac listing its power source alone, and cannot tell from nothing at all', () => {
    expect(parsePmsetBattery(PMSET_NO_BATTERY)).toEqual({ hasBattery: false, percent: null })
    expect(parsePmsetBattery('')).toEqual({ hasBattery: null, percent: null })
  })
})

describe('forceDeviceHasBatteryRequested', () => {
  it('is Chrome’s switch under Chrome’s name, read off argv', () => {
    expect(FORCE_DEVICE_HAS_BATTERY_FLAG).toBe('--force-device-has-battery')
    expect(forceDeviceHasBatteryRequested(['/usr/bin/zenium', '--force-device-has-battery'])).toBe(
      true
    )
    expect(forceDeviceHasBatteryRequested(['/usr/bin/zenium', '--no-sandbox'])).toBe(false)
  })
})

describe('BatteryLevel', () => {
  it('reads sysfs synchronously on Linux, every sample – the level and whether there is a battery', () => {
    supply('BAT0', 'Battery', '42')
    const level = new BatteryLevel('linux', { sysfsRoot: root })
    // Nothing read yet: the host has not been asked.
    expect(level.hasBattery()).toBeNull()
    expect(level.read(0)).toBe(42)
    expect(level.hasBattery()).toBe(true)
    writeFileSync(join(root, 'BAT0', 'capacity'), '19\n')
    expect(level.read(1)).toBe(19)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('reads no battery on a Linux desktop (the mains alone), and cannot tell without a power-supply class', () => {
    supply('AC', 'Mains')
    const desktop = new BatteryLevel('linux', { sysfsRoot: root })
    expect(desktop.read(0)).toBeNull()
    expect(desktop.hasBattery()).toBe(false)
    const sandbox = new BatteryLevel('linux', { sysfsRoot: join(root, 'nowhere') })
    expect(sandbox.read(0)).toBeNull()
    expect(sandbox.hasBattery()).toBeNull()
  })

  it('asks pmset once on macOS, serves the last answer between refreshes, and asks again once the reading is old', async () => {
    // A subprocess answers later, never within the sample that asked.
    const answer = (stdout: string): void => {
      execFile.mockImplementation((_file, _args, _options, cb) =>
        setImmediate(() => cb(null, stdout))
      )
    }
    answer(PMSET_ON_BATTERY)
    const level = new BatteryLevel('darwin')
    // Nothing read yet: the first sample kicks the subprocess off and reads null on both counts.
    expect(level.read(BATTERY_REFRESH_MS)).toBeNull()
    expect(level.hasBattery()).toBeNull()
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile.mock.calls[0].slice(0, 2)).toEqual(['pmset', ['-g', 'batt']])
    // A second sample while the answer is pending asks nothing more.
    expect(level.read(BATTERY_REFRESH_MS + 1)).toBeNull()
    expect(execFile).toHaveBeenCalledTimes(1)
    await new Promise((r) => setImmediate(r))
    expect(level.read(Date.now())).toBe(57)
    expect(level.hasBattery()).toBe(true)
    // Within the refresh window: no second subprocess.
    expect(execFile).toHaveBeenCalledTimes(1)
    // `refresh` asks now (the governor's start, a power-source change).
    answer(PMSET_CHARGING)
    await expect(level.refresh()).resolves.toBe(100)
    expect(execFile).toHaveBeenCalledTimes(2)
    // A reading older than the window: the next sample asks again and serves the old one.
    answer(PMSET_ON_BATTERY)
    expect(level.read(Date.now() + BATTERY_REFRESH_MS)).toBe(100)
    expect(execFile).toHaveBeenCalledTimes(3)
    await new Promise((r) => setImmediate(r))
    expect(level.read(Date.now())).toBe(57)
  })

  it('reads no battery on a Mac whose pmset lists none', async () => {
    execFile.mockImplementation((_file, _args, _options, cb) => cb(null, PMSET_NO_BATTERY))
    const mac = new BatteryLevel('darwin')
    await expect(mac.refresh()).resolves.toBeNull()
    expect(mac.hasBattery()).toBe(false)
  })

  it('cannot tell when pmset fails, and on Windows never asks anything and never tells', async () => {
    execFile.mockImplementation((_file, _args, _options, cb) =>
      cb(new Error('spawn pmset ENOENT'), '')
    )
    const mac = new BatteryLevel('darwin')
    await expect(mac.refresh()).resolves.toBeNull()
    expect(mac.hasBattery()).toBeNull()
    execFile.mockClear()
    const windows = new BatteryLevel('win32')
    expect(windows.read()).toBeNull()
    await expect(windows.refresh()).resolves.toBeNull()
    expect(windows.hasBattery()).toBeNull()
    expect(execFile).not.toHaveBeenCalled()
  })

  it('takes the computer to have a battery under --force-device-has-battery whatever the host says, the level still the host’s', () => {
    supply('AC', 'Mains')
    const forced = new BatteryLevel('linux', { sysfsRoot: root, forceHasBattery: true })
    expect(forced.hasBattery()).toBe(true)
    expect(forced.read(0)).toBeNull()
    expect(forced.hasBattery()).toBe(true)
    expect(new BatteryLevel('win32', { forceHasBattery: true }).hasBattery()).toBe(true)
  })
})
