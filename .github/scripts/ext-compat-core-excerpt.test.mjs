// The emulator-death file's coredump excerpt (`ext-compat-core-excerpt.sh`), run as
// android-ext-compat-sweep.sh's note_emulator_death runs it: a `coredumpctl info` text in a temp
// directory, the excerpt read back.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./ext-compat-core-excerpt.sh', import.meta.url))

const dirs = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-excerpt-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Runs the script on the given info text and returns the excerpt's lines. */
const run = (path) =>
  execFileSync('bash', [script, path], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trimEnd()
    .split('\n')

const header = [
  '           PID: 3405 (qemu-system-x86)',
  '           UID: 1001 (runner)',
  '        Signal: 11 (SEGV)',
  '     Timestamp: Fri 2026-09-25 13:33:07 UTC (2min ago)',
  '  Command Line: /opt/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless -avd test',
  '    Executable: /opt/sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless',
  '       Storage: /var/lib/systemd/coredump/core.qemu-system-x86.1001.zst (present)',
  '  Size on Disk: 1.2G'
]

/** A `coredumpctl info` text as systemd writes it: modules, then one trace per thread. */
const info = (threads) =>
  [
    ...header,
    '       Message: Process 3405 (qemu-system-x86) of user 1001 dumped core.',
    '                ',
    '                Module libz.so.1 without build-id.',
    '                Module libpthread.so.0 with build-id 0123456789abcdef',
    '                Found module linux-vdso.so.1 with build-id: fedcba9876543210',
    '                Found module qemu-system-x86_64-headless with build-id: 00ff00ff',
    ...threads.flatMap((frames, i) => [
      `                Stack trace of thread ${3444 + i}:`,
      ...frames.map((frame, n) => `                #${n}  ${frame}`),
      '                '
    ]),
    '                ELF object binary architecture: AMD x86-64'
  ].join('\n')

describe('ext-compat-core-excerpt.sh', () => {
  it("keeps the dump's account and the first thread's trace whole, the module lines and the other threads out", () => {
    const dir = scratch()
    const path = join(dir, 'host-emulator-core-info.txt')
    const crashing = Array.from(
      { length: 64 },
      (_, n) =>
        `0x00007f2c6b3e${String(n).padStart(4, '0')} frame_${n} (qemu-system-x86_64-headless + 0x${n.toString(16)})`
    )
    writeFileSync(
      path,
      info([
        crashing,
        ['0x00007f2c6b395a08 poll (libc.so.6 + 0x3fa08)'],
        ['0x00007f2c6b395a08 poll (libc.so.6 + 0x3fa08)']
      ])
    )
    const lines = run(path)
    expect(lines).toContain('           PID: 3405 (qemu-system-x86)')
    expect(lines).toContain('        Signal: 11 (SEGV)')
    expect(lines).toContain(
      '       Storage: /var/lib/systemd/coredump/core.qemu-system-x86.1001.zst (present)'
    )
    expect(lines).not.toContain('           UID: 1001 (runner)')
    expect(lines).toContain(
      "-- 3 threads' traces in host-emulator-core-info.txt; the first, the crashing thread's:"
    )
    expect(lines).toContain(
      '       Message: Process 3405 (qemu-system-x86) of user 1001 dumped core.'
    )
    expect(lines).toContain('                Stack trace of thread 3444:')
    expect(lines.filter((line) => /^ +#\d+ /.test(line))).toHaveLength(64)
    expect(lines.at(-1)).toMatch(/^ {16}#63 {2}0x00007f2c6b3e0063 frame_63 /)
    expect(lines.some((line) => /Stack trace of thread 344[56]:/.test(line))).toBe(false)
    expect(lines.some((line) => /(Found module|Module) /.test(line))).toBe(false)
    expect(lines.some((line) => /ELF object/.test(line))).toBe(false)
  })

  it('says so when systemd wrote the message alone', () => {
    const dir = scratch()
    const path = join(dir, 'host-emulator-core-info.txt')
    writeFileSync(path, info([]))
    const lines = run(path)
    expect(lines).toContain(
      "-- no thread's trace in host-emulator-core-info.txt (systemd wrote the message alone)"
    )
    expect(lines).toContain(
      '       Message: Process 3405 (qemu-system-x86) of user 1001 dumped core.'
    )
    expect(lines.some((line) => /Module /.test(line))).toBe(false)
  })

  it('reads a single thread through to the end', () => {
    const dir = scratch()
    const path = join(dir, 'host-emulator-core-info.txt')
    writeFileSync(path, info([['0x0000000000401136 main (single + 0x1136)']]))
    const lines = run(path)
    expect(lines).toContain("-- one thread's trace in host-emulator-core-info.txt:")
    expect(lines).toContain('                #0  0x0000000000401136 main (single + 0x1136)')
    expect(lines.at(-1)).toBe('                ELF object binary architecture: AMD x86-64')
  })

  it('names a missing or empty text and still exits 0', () => {
    const dir = scratch()
    const missing = join(dir, 'host-emulator-core-info.txt')
    expect(run(missing)).toEqual([`(no coredumpctl info text at ${missing})`])
    writeFileSync(missing, '')
    expect(run(missing)).toEqual([`(no coredumpctl info text at ${missing})`])
  })
})
