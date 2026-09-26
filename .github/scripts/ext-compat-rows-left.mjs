// The rows a compat sweep left ungraded when its emulator went away or its driver did not finish,
// for the second boot the sweep trigger makes (the round's tmp-ext-android-*-sweep.yml,
// `remaining-*` jobs). Reads the results.json the sweep script pulled after every row (argv[2];
// absent when the driver never wrote one) and prints GitHub step outputs:
//   boot=true|false  – whether a second boot is due: rows are left, whatever took the driver
//                      (the emulator died, DIED=true; the app process died under a row – a Java
//                      OOM at an extension's configure – or the driver ran out of time, which
//                      fails the system-WebView job, FAILED=true, and only warns in the
//                      best-effort modern-WebView job; round 13's first run lost its last four
//                      rows on both lanes to the one OOM, and the second lane's job was green)
//   ids=a,b,c        – the rows left, in the sweep's order: `order` minus the rows graded – a
//                      row with a core verdict (it ran to its reading), a row its install settled
//                      short of one (an install F has no core to wait for), or a row the driver
//                      marked not run on the image (`notRun`); NOT a row that merely has a `grade`
//                      string, since the driver's `finally` stamps one ("P/P/?/?") on the row it
//                      was in when the emulator went away and the sweep threw under it, and that
//                      row's core was never read (compat round 19's driver reading); every id of
//                      ALL_IDS when there is no results.json
//   last=a,b         – the rows to run after the others: the row in flight at the death (the
//                      first left) and the sweep's own LAST_IDS that are still left (the rows
//                      the first boot already kept for last – round 14's before run lost them
//                      when a first boot without a results.json handed the second boot an
//                      empty `last`, and the row kept for last took the guest 17 rows in).
//                      Without a results.json (a death in the first row: the sweep script pulls
//                      the file after every row, so none was pulled) the row in flight is read
//                      off the sweep log (argv[3], `sweep-log.txt`, or the `logcat.txt` beside
//                      it): the driver's last `ROW-START <n>/<of> <id> <name>` line, written
//                      before anything of the row runs – round 18's AFTER 113 lost both boots to
//                      one row-bound fault in row 1 for want of this, 0 of 43 read twice
// Environment: DIED (the shared workflow's emulator-died output), FAILED (the sweep job's result
// is failure), ALL_IDS (the sweep's ids), LAST_IDS (the sweep's SWEEP_LAST, optional); the
// first two only name the cause in the log.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ids = (value) =>
  (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
const died = process.env.DIED === 'true'
const failed = process.env.FAILED === 'true'
const all = ids(process.env.ALL_IDS)
const keptForLast = ids(process.env.LAST_IDS)
const file = process.argv[2]
const sweepLog = process.argv[3]

/**
 * The id of the row the driver was in when the log ends: its last `ROW-START` line
 * (`I/CompatSweep( 1234): ROW-START 3/46 <id> <name>` in `logcat -v time`, the same line in the
 * `sweep-log.txt` grep of it), '' when the log is missing or has none.
 */
const inFlightFromLog = (path) => {
  if (!path) return ''
  const candidates = [path, join(dirname(path), 'logcat.txt')]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) return ''
  const lines = readFileSync(found, 'utf8').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /CompatSweep\(\s*\d+\): ROW-START \d+\/\d+ (\S+) /.exec(lines[i])
    if (m) return m[1]
  }
  return ''
}

/** A stage's verdict on a results.json row ("P", "PARTIAL", "F", "n/m", "n/a"), '' when the stage never ran. */
const verdictOf = (row, stage) =>
  row && row[stage] && typeof row[stage].verdict === 'string' ? row[stage].verdict : ''

/**
 * Whether a results.json row is graded: its core stage has a verdict, its install stage settled
 * it short of one (anything but P), or the driver marked it not run on the image. A `grade`
 * string alone is not it: the driver stamps one in its `finally` on the row it was in when the
 * sweep threw (the emulator going away under a stage), with '?' for the stages never read.
 */
const isGraded = (row) =>
  !!row &&
  (verdictOf(row, 'core').length > 0 ||
    typeof row.notRun === 'string' ||
    (verdictOf(row, 'install').length > 0 && verdictOf(row, 'install') !== 'P'))

let left = all
let inFlight = ''
let graded = 0
if (file && existsSync(file)) {
  const results = JSON.parse(readFileSync(file, 'utf8'))
  const order =
    Array.isArray(results.order) && results.order.length > 0 ? results.order.map(String) : all
  const done = new Set(
    (Array.isArray(results.rows) ? results.rows : []).filter(isGraded).map((row) => String(row.id))
  )
  graded = done.size
  left = order.filter((id) => !done.has(id))
  inFlight = left[0] ?? ''
}
// The log's word on the row in flight, when it has one and the row is still left: the only
// word without a results.json, and the same row as `left[0]` with one (rows run in order).
const logged = inFlightFromLog(sweepLog)
if (logged && left.includes(logged)) inFlight = logged
const last = [...new Set([inFlight, ...keptForLast].filter((id) => id && left.includes(id)))]

const boot = left.length > 0
console.error(
  `emulator died: ${died}; driver failed: ${failed}; graded ${graded}; left ${left.length}${inFlight ? ` (in flight when the driver stopped: ${inFlight})` : ''}${keptForLast.length ? ` (kept for last: ${keptForLast.join(',')})` : ''}; second boot: ${boot}`
)
console.log(`boot=${boot}`)
console.log(`ids=${left.join(',')}`)
console.log(`last=${last.join(',')}`)
