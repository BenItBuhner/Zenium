// The rows-left hand-off of the compat sweep's second boot (`ext-compat-rows-left.mjs`), run as
// the workflow step runs it: a results.json (or none) and the sweep log in a temp directory, the
// ids in the environment, the GitHub step outputs read back.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./ext-compat-rows-left.mjs', import.meta.url))
const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const C = 'cccccccccccccccccccccccccccccccc'
const D = 'dddddddddddddddddddddddddddddddd'

const dirs = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rows-left-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Runs the script and parses its `key=value` step outputs. */
const run = (dir, env = {}) => {
  const out = execFileSync(
    process.execPath,
    [script, join(dir, 'results.json'), join(dir, 'sweep-log.txt')],
    {
      env: { ...process.env, ALL_IDS: [A, B, C, D].join(','), LAST_IDS: '', ...env },
      stdio: ['ignore', 'pipe', 'ignore']
    }
  )
  return Object.fromEntries(
    out
      .toString()
      .trim()
      .split('\n')
      .map((line) => line.split(/=(.*)/s).slice(0, 2))
  )
}

const row = (id, stages = {}, more = {}) => ({
  id,
  name: id.slice(0, 4),
  ...Object.fromEntries(
    Object.entries(stages).map(([stage, verdict]) => [stage, { verdict, note: '' }])
  ),
  ...more
})

const logLine = (n, id) =>
  `09-25 13:33:10.123 I/CompatSweep( 4321): ROW-START ${n}/4 ${id} Row ${n}`

describe('ext-compat-rows-left', () => {
  it('counts a row graded by its core verdict, not by a grade string the finally stamped', () => {
    const dir = scratch()
    writeFileSync(
      join(dir, 'results.json'),
      JSON.stringify({
        order: [A, B, C, D],
        rows: [
          row(
            A,
            { install: 'P', background: 'P', popup: 'P', options: 'n/a', core: 'F' },
            { grade: 'P/P/n-a/F' }
          ),
          // The row the driver was in when the emulator went away: its finally stamped a grade with the core unread.
          row(B, { install: 'P', background: 'P' }, { grade: 'P/?/?/?', crash: 'the sweep threw' })
        ]
      })
    )
    const outputs = run(dir)
    expect(outputs.boot).toBe('true')
    expect(outputs.ids).toBe([B, C, D].join(','))
    expect(outputs.last).toBe(B)
  })

  it('counts a row its install settled (F) and a row not run on the image as graded', () => {
    const dir = scratch()
    writeFileSync(
      join(dir, 'results.json'),
      JSON.stringify({
        order: [A, B, C, D],
        rows: [
          row(A, { install: 'F' }, { grade: '?/?/?/?' }),
          row(
            B,
            { install: 'n/a', core: 'n/a' },
            { notRun: 'not run on the Google image', grade: 'n/a/n/a/n/a/n/a' }
          ),
          row(
            C,
            { install: 'P', background: 'P', popup: 'P', options: 'P', core: 'P' },
            { grade: 'P/P/P/P' }
          )
        ]
      })
    )
    const outputs = run(dir)
    expect(outputs.boot).toBe('true')
    expect(outputs.ids).toBe(D)
    expect(outputs.last).toBe(D)
  })

  it('reads the row in flight off the sweep log when no results.json was pulled', () => {
    const dir = scratch()
    writeFileSync(
      join(dir, 'sweep-log.txt'),
      [
        logLine(1, C),
        '09-25 13:33:11.000 I/CompatSweep( 4321): PREFLIGHT Row 1: loading a page'
      ].join('\n')
    )
    const outputs = run(dir)
    expect(outputs.boot).toBe('true')
    expect(outputs.ids).toBe([A, B, C, D].join(','))
    expect(outputs.last).toBe(C)
  })

  it("falls back to logcat.txt beside a missing sweep-log.txt, and keeps the sweep's own last rows", () => {
    const dir = scratch()
    writeFileSync(join(dir, 'logcat.txt'), [logLine(1, A), logLine(2, B)].join('\n'))
    const outputs = run(dir, { LAST_IDS: D })
    expect(outputs.ids).toBe([A, B, C, D].join(','))
    expect(outputs.last).toBe([B, D].join(','))
  })

  it('reports nothing left and no second boot when every row has a core verdict', () => {
    const dir = scratch()
    writeFileSync(
      join(dir, 'results.json'),
      JSON.stringify({
        order: [A, B],
        rows: [row(A, { install: 'P', core: 'P' }), row(B, { install: 'P', core: 'n/m' })]
      })
    )
    const outputs = run(dir, { ALL_IDS: [A, B].join(',') })
    expect(outputs).toEqual({ boot: 'false', ids: '', last: '' })
  })
})
