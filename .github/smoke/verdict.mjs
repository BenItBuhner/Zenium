// Aggregates the result.json files the smoke harness wrote for every launched build, prints a
// compact table, appends it to $GITHUB_STEP_SUMMARY when set, and exits 1 when any build has an
// unexpected failure or an expected result is missing.
//
//   node verdict.mjs --out <dir> [--expect unpacked,installed] [--title "windows-x64"]

import fs from 'node:fs'
import path from 'node:path'
import { formatFailure } from './known-failures.mjs'

const opts = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const next = process.argv[i + 1]
  if (next !== undefined && !next.startsWith('--')) {
    opts[a.slice(2)] = next
    i++
  } else opts[a.slice(2)] = true
}
if (!opts.out) {
  console.error('usage: node verdict.mjs --out <dir> [--expect a,b] [--title <text>]')
  process.exit(2)
}
const outDir = path.resolve(opts.out)
const expected = String(opts.expect ?? '')
  .split(',')
  .filter(Boolean)
const title = opts.title ? String(opts.title) : path.basename(outDir)

const results = []
const labels = fs.existsSync(outDir)
  ? fs
      .readdirSync(outDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : []
for (const label of labels) {
  const file = path.join(outDir, label, 'result.json')
  if (!fs.existsSync(file)) continue
  try {
    results.push(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (e) {
    results.push({
      label,
      verdict: {
        ok: false,
        unexpected: [{ kind: 'harness', message: `unreadable result.json: ${e.message}` }],
        known: []
      }
    })
  }
}
const missing = expected.filter((l) => !results.some((r) => r.label === l))

const lines = []
const md = []
const row = (cells) => `| ${cells.join(' | ')} |`
md.push(`### Desktop smoke: ${title}`)
md.push('')
md.push(
  row([
    'Build',
    'Scenario',
    'Steps',
    'Failed steps',
    'Chrome rendered',
    'Exit',
    'Known',
    'Unexpected'
  ])
)
md.push(row(['---', '---', '---', '---', '---', '---', '---', '---']))
let ok = missing.length === 0
for (const r of results) {
  const verdict = r.verdict ?? {
    ok: false,
    unexpected: [{ kind: 'harness', message: 'no verdict (harness did not finish)' }],
    known: []
  }
  if (!verdict.ok) ok = false
  const scenarios = Object.entries(r.scenarios ?? {})
  if (!scenarios.length) scenarios.push(['-', {}])
  for (const [name, sc] of scenarios) {
    const steps = sc.session?.steps ?? []
    const failed = steps.filter((s) => !s.ok).map((s) => s.name)
    const known = verdict.known.filter(
      (k) => k.scenario === name || (!k.scenario && name === 'install')
    ).length
    const unexpected = verdict.unexpected.filter(
      (f) => f.scenario === name || (!f.scenario && name === 'install')
    ).length
    const chrome = sc.session?.timings?.chromeRenderedMs
    const exit = sc.session?.exit
      ? String(sc.session.exit.code ?? sc.session.exit.signal)
      : sc.fatal
        ? 'fatal'
        : '-'
    const cells = [
      r.label,
      name,
      // A scenario the harness did not run because boot left no profile for it (scenario-deps.mjs).
      sc.skipped ? `skipped: ${sc.skipped}` : String(steps.length),
      failed.length ? failed.join(', ') : '-',
      chrome !== undefined ? `${chrome} ms` : '-',
      exit,
      String(known),
      String(unexpected)
    ]
    md.push(row(cells))
    lines.push(cells.join('  '))
  }
  for (const k of verdict.known) {
    const text = `known ${k.id}: ${formatFailure(k)}`
    md.push(`- ${text}`)
    lines.push(text)
  }
  for (const f of verdict.unexpected) {
    const text = `UNEXPECTED (${r.label}): ${formatFailure(f)}`
    md.push(`- **${text}**`)
    lines.push(text)
  }
  if (verdict.unusedAllowlist?.length) {
    const text = `allowlist entries nothing matched (${r.label}): ${verdict.unusedAllowlist.join(', ')}`
    md.push(`- ${text}`)
    lines.push(text)
  }
  const shots = (r.screenshots ?? []).filter((s) => s.ok).length
  lines.push(
    `${r.label}: ${shots} screenshots, ${r.verdict?.informational?.length ?? 0} informational page console errors`
  )
}
for (const l of missing) {
  const text = `UNEXPECTED: no result for build "${l}" (the smoke step did not run or crashed)`
  md.push(`- **${text}**`)
  lines.push(text)
}
md.push('')
md.push(
  `**Verdict: ${ok ? 'PASS' : 'FAIL'}** (${results.length} build${results.length === 1 ? '' : 's'}; artifacts carry screenshots, logs and result.json)`
)
md.push('')

console.log(lines.join('\n'))
console.log(`verdict: ${ok ? 'PASS' : 'FAIL'}`)
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n')
}
process.exit(ok ? 0 : 1)
