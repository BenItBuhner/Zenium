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
//   ids=a,b,c        – the rows left, in the sweep's order: `order` minus the rows with a grade;
//                      every id of ALL_IDS when there is no results.json
//   last=a,b         – the rows to run after the others: the row in flight at the death (the
//                      first left) and the sweep's own LAST_IDS that are still left (the rows
//                      the first boot already kept for last – round 14's before run lost them
//                      when a first boot without a results.json handed the second boot an
//                      empty `last`, and the row kept for last took the guest 17 rows in)
// Environment: DIED (the shared workflow's emulator-died output), FAILED (the sweep job's result
// is failure), ALL_IDS (the sweep's ids), LAST_IDS (the sweep's SWEEP_LAST, optional); the
// first two only name the cause in the log.
import { existsSync, readFileSync } from 'node:fs'

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

let left = all
let inFlight = ''
let graded = 0
if (file && existsSync(file)) {
  const results = JSON.parse(readFileSync(file, 'utf8'))
  const order =
    Array.isArray(results.order) && results.order.length > 0 ? results.order.map(String) : all
  const done = new Set(
    (Array.isArray(results.rows) ? results.rows : [])
      .filter((row) => row && typeof row.grade === 'string' && row.grade.length > 0)
      .map((row) => String(row.id))
  )
  graded = done.size
  left = order.filter((id) => !done.has(id))
  inFlight = left[0] ?? ''
}
const last = [...new Set([inFlight, ...keptForLast].filter((id) => id && left.includes(id)))]

const boot = left.length > 0
console.error(
  `emulator died: ${died}; driver failed: ${failed}; graded ${graded}; left ${left.length}${inFlight ? ` (in flight when the driver stopped: ${inFlight})` : ''}${keptForLast.length ? ` (kept for last: ${keptForLast.join(',')})` : ''}; second boot: ${boot}`
)
console.log(`boot=${boot}`)
console.log(`ids=${left.join(',')}`)
console.log(`last=${last.join(',')}`)
