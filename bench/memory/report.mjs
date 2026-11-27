#!/usr/bin/env node
// Summarise results/*.json into markdown tables: one row per label x preset (x cap), each
// number the median over that group's runs.
//   node bench/memory/report.mjs [resultsDir] [--labels a,b,c]
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { median } from './lib/sample.mjs'

const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--')) ?? new URL('./results', import.meta.url).pathname
const labelsArg = args.find((a) => a.startsWith('--labels='))?.slice(9)
const wanted = labelsArg ? labelsArg.split(',') : null

const groups = new Map()
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  if (wanted && !wanted.includes(r.label)) continue
  const key = `${r.label}|${r.preset}|${r.capMb ?? ''}`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}

const fmt = (v, unit = '') => (v === null || v === undefined ? '–' : `${Math.round(v)}${unit}`)
const order = wanted ?? ['zenium', 'chromium', 'firefox', 'edge']
const rank = (label) => {
  const i = order.indexOf(label)
  return i < 0 ? order.length : i
}
const rows = [...groups.entries()].sort(([a], [b]) => {
  const [la, pa, ca] = a.split('|')
  const [lb, pb, cb] = b.split('|')
  return (
    ca.localeCompare(cb) ||
    Number(pa.split('/')[0]) - Number(pb.split('/')[0]) ||
    rank(la) - rank(lb) ||
    la.localeCompare(lb)
  )
})

let lastSection = null
for (const [key, runs] of rows) {
  const [label, preset, cap] = key.split('|')
  const section = cap ? `Capped at ${cap} MB (cgroup memory limit)` : 'Uncapped'
  if (section !== lastSection) {
    console.log(`\n### ${section}\n`)
    console.log(
      '| Browser | Tabs / active | Runs | Steady PSS | Peak PSS | Steady RSS sum | Peak RSS sum | Processes | Restore (median) | Restores that reloaded | Restore failures | OOM kills | Browser died |'
    )
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    lastSection = section
  }
  const m = (f) => median(runs.map((r) => f(r.summary)))
  const sum = (f) => runs.reduce((a, r) => a + f(r.summary), 0)
  console.log(
    `| ${label} | ${preset} | ${runs.length} | ${fmt(
      m((s) => s.steadyPssMb),
      ' MB'
    )} | ${fmt(
      m((s) => s.peakPssMb),
      ' MB'
    )} | ${fmt(
      m((s) => s.steadyRssMb),
      ' MB'
    )} | ${fmt(
      m((s) => s.peakRssMb),
      ' MB'
    )} | ${fmt(m((s) => s.steadyProcs))} | ${fmt(
      m((s) => s.restoreMedianMs),
      ' ms'
    )} | ${sum((s) => s.restoreReloaded)}/${runs.reduce((a, r) => a + r.restores.length, 0)} | ${sum((s) => s.restoreFailed)} | ${sum((s) => s.oomKills)} | ${runs.filter((r) => r.summary.crashed).length}/${runs.length} |`
  )
}
