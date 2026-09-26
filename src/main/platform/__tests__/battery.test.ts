import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The battery's charge as the host can read it without a native module (W8-2, Energy Saver's
 * low-battery mode): Linux's sysfs `capacity` of a `Battery` supply, macOS's `pmset -g batt`
 * line, and null on Windows – the stated limit – and on a computer with no battery.
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

const { BATTERY_REFRESH_MS, BatteryLevel, parsePmsetBatteryPercent, readSysfsBatteryPercent } =
  await import('../resources/battery')

const PMSET_ON_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=4653155)\t57%; discharging; 3:12 remaining present: true
`
const PMSET_CHARGING = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true
`
const PMSET_NO_BATTERY = `Now drawing from 'AC Power'
`

let root: string

function supply(name: string, type: string, capacity?: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'type'), `${type}\n`)
  if (capacity !== undefined) writeFileSync(join(root, name, 'capacity'), `${capacity}\n`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zen-power-supply-'))
  execFile.mockReset()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('readSysfsBatteryPercent (Linux)', () => {
  it('reads the first Battery supply’s capacity, skipping the mains adapter', () => {
    supply('AC', 'Mains')
    supply('BAT0', 'Battery', '63')
    expect(readSysfsBatteryPercent(root)).toBe(63)
  })

  it('is null with no Battery supply, a missing directory, or a capacity that is not a number', () => {
    supply('AC', 'Mains')
    expect(readSysfsBatteryPercent(root)).toBeNull()
    expect(readSysfsBatteryPercent(join(root, 'nowhere'))).toBeNull()
    supply('BAT0', 'Battery', 'unknown')
    expect(readSysfsBatteryPercent(root)).toBeNull()
  })

  it('passes over a Battery supply without a readable capacity (a UPS, a hot-unplugged pack) to the next', () => {
    supply('BAT0', 'Battery')
    supply('BAT1', 'Battery', '18')
    expect(readSysfsBatteryPercent(root)).toBe(18)
  })
})

describe('parsePmsetBatteryPercent (macOS)', () => {
  it('reads the percentage of the InternalBattery line, discharging or charged', () => {
    expect(parsePmsetBatteryPercent(PMSET_ON_BATTERY)).toBe(57)
    expect(parsePmsetBatteryPercent(PMSET_CHARGING)).toBe(100)
  })

  it('is null for a Mac with no battery and for nothing at all', () => {
    expect(parsePmsetBatteryPercent(PMSET_NO_BATTERY)).toBeNull()
    expect(parsePmsetBatteryPercent('')).toBeNull()
  })
})

describe('BatteryLevel', () => {
  it('reads sysfs synchronously on Linux, every sample', () => {
    supply('BAT0', 'Battery', '42')
    const level = new BatteryLevel('linux', root)
    expect(level.read(0)).toBe(42)
    writeFileSync(join(root, 'BAT0', 'capacity'), '19\n')
    expect(level.read(1)).toBe(19)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('asks pmset once on macOS, serves the last answer between refreshes, and asks again once the reading is old', async () => {
    // A subprocess answers later, never within the sample that asked.
    const answer = (stdout: string): void =>
      execFile.mockImplementation((_file, _args, _options, cb) =>
        setImmediate(() => cb(null, stdout))
      )
    answer(PMSET_ON_BATTERY)
    const level = new BatteryLevel('darwin')
    // Nothing read yet: the first sample kicks the subprocess off and reads null.
    expect(level.read(BATTERY_REFRESH_MS)).toBeNull()
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile.mock.calls[0].slice(0, 2)).toEqual(['pmset', ['-g', 'batt']])
    // A second sample while the answer is pending asks nothing more.
    expect(level.read(BATTERY_REFRESH_MS + 1)).toBeNull()
    expect(execFile).toHaveBeenCalledTimes(1)
    await new Promise((r) => setImmediate(r))
    expect(level.read(Date.now())).toBe(57)
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

  it('reads null when pmset fails, and on Windows never asks anything', async () => {
    execFile.mockImplementation((_file, _args, _options, cb) =>
      cb(new Error('spawn pmset ENOENT'), '')
    )
    const mac = new BatteryLevel('darwin')
    await expect(mac.refresh()).resolves.toBeNull()
    execFile.mockClear()
    const windows = new BatteryLevel('win32')
    expect(windows.read()).toBeNull()
    await expect(windows.refresh()).resolves.toBeNull()
    expect(execFile).not.toHaveBeenCalled()
  })
})
