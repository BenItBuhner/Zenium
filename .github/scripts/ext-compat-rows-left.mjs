// The rows a compat sweep left ungraded when its emulator went away, for the second boot the
// sweep trigger makes (tmp-ext-android-13-sweep.yml, `remaining-*` jobs). Reads the results.json
// the sweep script pulled after every row (argv[2]; absent when the driver never wrote one) and
// prints GitHub step outputs:
//   boot=true|false  – whether a second boot is due: the emulator died (DIED=true) and rows are left
//   ids=a,b,c        – the rows left, in the sweep's order: `order` minus the rows with a grade;
//                      every id of ALL_IDS when there is no results.json
//   last=a           – the row in flight at the death (the first left), to run after the others
// Environment: DIED (the shared workflow's emulator-died output), ALL_IDS (the sweep's ids).
import { existsSync, readFileSync } from 'node:fs'

const died = process.env.DIED === 'true'
const all = (process.env.ALL_IDS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
const file = process.argv[2]

let left = all
let last = ''
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
  last = left[0] ?? ''
}

const boot = died && left.length > 0
console.error(
  `emulator died: ${died}; graded ${graded}; left ${left.length}${last ? ` (in flight at the death: ${last})` : ''}; second boot: ${boot}`
)
console.log(`boot=${boot}`)
console.log(`ids=${left.join(',')}`)
console.log(`last=${last}`)
