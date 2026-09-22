#!/usr/bin/env node
// The nightly all-drivers sweep's reader of `.github/nightly-drivers.json` (the manifest: every
// instrumentation driver, its shard and the environment its own workflow gives it), in four modes
// for android-nightly-drivers.yml and android-nightly-drivers.sh:
//
//   node android-nightly-drivers.mjs matrix [--shard all|<shard>]
//     The shards to run as a job matrix (`{"include":[...]}`, one row per shard with the recipe's
//     inputs), for the workflow's `strategy.matrix`; `--shard` narrows it to one.
//
//   node android-nightly-drivers.mjs plan <shard> <dir>
//     The shard's drivers in order, one `NN-<id>.env` file each (NAME=value lines: the runner's
//     NIGHTLY_* keys and the driver's environment, the shard's first, the driver's own last) and
//     `shard.env` (the budget, the display), for the runner script to read.
//
//   node android-nightly-drivers.mjs setup-steps <shard>
//     The named setup steps the shard's drivers need, one per line (the runner does them before
//     the emulator boots).
//
//   node android-nightly-drivers.mjs summary --results <dir> [--shard all|<shard>]
//                                            [--artifact-url <url>] [--artifact-name <name>]
//     The one table of the run from the shards' `results.jsonl` (each shard's artifact downloaded
//     under <dir>/<artifact name>/), the manifest saying which drivers were expected: driver,
//     result, scenes / checks, duration, jank verdict, the artifact link; the failures with their
//     reasons and the skips with theirs under it. Printed to stdout (the workflow appends it to
//     the job summary); exits 1 when any driver failed, left no result or was not run (the
//     shard's budget spent, the emulator gone).
//
//   node android-nightly-drivers.mjs check
//     The manifest against the sources: every concrete *Demo class under androidTest is a driver
//     or a skip with a reason, every driver's class exists, ids unique, shards known, handshake
//     directories as the classes declare them. Exits 1 with the problems listed.
//     (android-nightly-drivers.test.mjs runs the same through vitest.)
//
//   node android-nightly-drivers.mjs estimate
//     The shard plan with the per-driver estimates summed, as Markdown (for a pull request body).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '..', '..')
export const MANIFEST_PATH = join(REPO_ROOT, '.github', 'nightly-drivers.json')
export const DRIVER_SOURCES = join(
  REPO_ROOT,
  'android',
  'app',
  'src',
  'androidTest',
  'kotlin',
  'app',
  'zen',
  'chromium'
)
/** The shared driver script a manifest entry runs through unless it names a wrapper. */
export const SHARED_SCRIPT = '.github/scripts/android-gesture-demo.sh'
/** How long a driver may take before the runner cuts it (seconds), unless the entry says. */
export const DEFAULT_TIMEOUT_S = 720
/** The package prefix of every driver class. */
const PACKAGE = 'app.zen.chromium'

/** @typedef {{ id: string, class?: string, classes?: string[], shard: string, mirrors: string, dir?: string, script?: string, out?: string, env?: Record<string, string>, setup?: string[], needs?: string[], timeout?: number, estimate: number, note?: string }} Driver */
/** @typedef {{ title: string, 'api-level': string, target: string, profile: string, 'emulator-gpu': string, 'emulator-options': string, display: string, 'timeout-minutes': number, 'budget-minutes': number, setup?: string[], env?: Record<string, string>, note?: string }} Shard */
/** @typedef {{ shards: Record<string, Shard>, drivers: Driver[], skip: { class?: string, workflow?: string, reason: string, absent?: boolean }[] }} Manifest */

/** @returns {Manifest} */
export function readManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The *Demo classes a driver entry covers. */
export function classesOf(driver) {
  return driver.classes ?? (driver.class ? [driver.class] : [])
}

/** The concrete `*Demo` classes declared under the driver sources (abstract bases left out). */
export function sourceDriverClasses(dir = DRIVER_SOURCES) {
  const classes = new Map()
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.kt')) continue
    const source = readFileSync(join(dir, name), 'utf8')
    for (const match of source.matchAll(
      /^((?:abstract|open|internal|private|sealed)\s+)*class\s+(\w+Demo)\b/gm
    )) {
      if (/\babstract\b/.test(match[0])) continue
      classes.set(match[2], name)
    }
  }
  return classes
}

/**
 * The handshake directory a class declares through its DemoHarness constructor (the third string
 * argument, or `handshakeDir =`), when the declaration is on one line; null when not read.
 */
export function declaredHandshakeDir(className, dir = DRIVER_SOURCES) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.kt')) continue
    const source = readFileSync(join(dir, name), 'utf8')
    const match = source.match(
      new RegExp(`class\\s+${className}\\b[^{\\n]*?:\\s*\\w+\\(([^)\\n]*)\\)`)
    )
    if (!match) continue
    const args = match[1]
    const named = args.match(/handshakeDir\s*=\s*"([^"]*)"/)
    if (named) return named[1]
    const strings = [...args.matchAll(/"([^"]*)"/g)].map((m) => m[1])
    return strings.length >= 3 ? strings[2] : null
  }
  return null
}

// --- matrix ----------------------------------------------------------------------------------

export function shardNames(manifest) {
  return Object.keys(manifest.shards)
}

/** The rows of the job matrix: every shard, or the one named. */
export function matrix(manifest, shard = 'all') {
  const names = shard && shard !== 'all' ? [shard] : shardNames(manifest)
  for (const name of names) {
    if (!manifest.shards[name])
      throw new Error(`no shard '${name}' in the manifest (${shardNames(manifest).join(', ')})`)
  }
  return {
    include: names.map((name) => {
      const s = manifest.shards[name]
      return {
        shard: name,
        title: s.title,
        'api-level': s['api-level'],
        target: s.target,
        profile: s.profile,
        'emulator-gpu': s['emulator-gpu'],
        'emulator-options': s['emulator-options'],
        'timeout-minutes': s['timeout-minutes']
      }
    })
  }
}

// --- plan --------------------------------------------------------------------------------------

export function driversOf(manifest, shard) {
  if (!manifest.shards[shard]) throw new Error(`no shard '${shard}' in the manifest`)
  return manifest.drivers.filter((d) => d.shard === shard)
}

/** The environment one driver runs under: the shard's, then the entry's own. */
export function environmentOf(manifest, driver) {
  const shard = manifest.shards[driver.shard]
  const env = {
    DEMO_DISPLAY: shard.display,
    DEMO_THEME: 'light',
    JANK_GATE: 'soft',
    ...(shard.env ?? {})
  }
  const classes = classesOf(driver)
  if (classes.length === 1) env.DEMO_CLASS = `${PACKAGE}.${classes[0]}`
  if (driver.dir) env.DEMO_DIR = driver.dir
  env.DEMO_VIDEO = `${driver.id}.mp4`
  Object.assign(env, driver.env ?? {})
  return env
}

/** The runner's own keys for one driver. */
export function runnerKeysOf(driver) {
  return {
    NIGHTLY_ID: driver.id,
    NIGHTLY_CLASSES: classesOf(driver).join(','),
    NIGHTLY_SCRIPT: driver.script ?? SHARED_SCRIPT,
    NIGHTLY_RELOCATE: driver.out ?? '',
    NIGHTLY_NEEDS: (driver.needs ?? []).join(' '),
    NIGHTLY_TIMEOUT: String(driver.timeout ?? DEFAULT_TIMEOUT_S),
    NIGHTLY_ESTIMATE_S: String(Math.round(driver.estimate * 60)),
    NIGHTLY_MIRRORS: driver.mirrors
  }
}

const envLines = (env) =>
  Object.entries(env)
    .map(([k, v]) => {
      if (/[\n\r]/.test(String(v))) throw new Error(`${k}: a value with a line break`)
      return `${k}=${v}`
    })
    .join('\n') + '\n'

export function writePlan(manifest, shard, dir) {
  const shardDef = manifest.shards[shard]
  if (!shardDef) throw new Error(`no shard '${shard}' in the manifest`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'shard.env'),
    envLines({
      NIGHTLY_SHARD: shard,
      NIGHTLY_TITLE: shardDef.title,
      NIGHTLY_BUDGET_S: String(shardDef['budget-minutes'] * 60),
      NIGHTLY_DISPLAY: shardDef.display
    })
  )
  const drivers = driversOf(manifest, shard)
  drivers.forEach((driver, i) => {
    const name = `${String(i + 1).padStart(2, '0')}-${driver.id}.env`
    writeFileSync(
      join(dir, name),
      envLines({ ...runnerKeysOf(driver), ...environmentOf(manifest, driver) })
    )
  })
  return drivers.map((d) => d.id)
}

/** The setup steps a shard needs: its own, then its drivers', each once, in first-seen order. */
export function setupSteps(manifest, shard) {
  const steps = new Set(manifest.shards[shard]?.setup ?? [])
  for (const driver of driversOf(manifest, shard))
    for (const step of driver.setup ?? []) steps.add(step)
  return [...steps]
}

// --- check -------------------------------------------------------------------------------------

/** The problems with the manifest against the sources; an empty list when there are none. */
export function checkManifest(manifest, sources = sourceDriverClasses()) {
  const problems = []
  const ids = new Set()
  const covered = new Map()
  for (const driver of manifest.drivers) {
    if (ids.has(driver.id)) problems.push(`driver id '${driver.id}' is used twice`)
    ids.add(driver.id)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(driver.id))
      problems.push(`driver id '${driver.id}' is not a lowercase kebab-case name`)
    if (!manifest.shards[driver.shard])
      problems.push(`${driver.id}: unknown shard '${driver.shard}'`)
    const classes = classesOf(driver)
    if (classes.length === 0) problems.push(`${driver.id}: names no class`)
    for (const cls of classes) {
      if (!sources.has(cls))
        problems.push(`${driver.id}: class ${cls} is not declared under androidTest`)
      covered.set(cls, [...(covered.get(cls) ?? []), driver.id])
    }
    if (!driver.mirrors) problems.push(`${driver.id}: says not which workflow it mirrors`)
    if (typeof driver.estimate !== 'number' || !(driver.estimate > 0))
      problems.push(`${driver.id}: no estimate in minutes`)
    if (driver.script === undefined && !driver.dir)
      problems.push(`${driver.id}: runs through ${SHARED_SCRIPT} and needs its handshake dir`)
    if (driver.script && !existsSync(join(REPO_ROOT, driver.script)))
      problems.push(`${driver.id}: script ${driver.script} does not exist`)
    if (driver.dir && classes.length === 1 && !driver.script) {
      const declared = declaredHandshakeDir(classes[0])
      if (declared && declared !== driver.dir)
        problems.push(`${driver.id}: dir '${driver.dir}' but ${classes[0]} declares '${declared}'`)
    }
    for (const step of driver.setup ?? [])
      if (!SETUP_STEPS.has(step)) problems.push(`${driver.id}: unknown setup step '${step}'`)
    for (const need of driver.needs ?? [])
      if (!NEEDS.has(need)) problems.push(`${driver.id}: unknown need '${need}'`)
  }
  for (const [name, shard] of Object.entries(manifest.shards)) {
    for (const step of shard.setup ?? [])
      if (!SETUP_STEPS.has(step)) problems.push(`shard ${name}: unknown setup step '${step}'`)
    if (!(shard['budget-minutes'] < shard['timeout-minutes']))
      problems.push(
        `shard ${name}: the budget (${shard['budget-minutes']} min) must be under the job timeout (${shard['timeout-minutes']} min)`
      )
  }
  const skipped = new Map()
  for (const skip of manifest.skip) {
    if (!skip.reason) problems.push(`skip entry ${JSON.stringify(skip)} gives no reason`)
    if (skip.class) {
      skipped.set(skip.class, skip)
      if (covered.has(skip.class))
        problems.push(
          `${skip.class} is both a driver (${covered.get(skip.class).join(', ')}) and skipped`
        )
      if (skip.absent && sources.has(skip.class))
        problems.push(
          `${skip.class} has landed: it is skipped as absent, give it its line on a shard`
        )
      if (!skip.absent && !sources.has(skip.class))
        problems.push(`skipped class ${skip.class} is not declared under androidTest`)
    }
  }
  for (const cls of [...sources.keys()].sort()) {
    if (!covered.has(cls) && !skipped.has(cls))
      problems.push(
        `${cls} (${sources.get(cls)}) is neither a driver in the manifest nor in its skip list with a reason`
      )
  }
  return problems
}

/** The setup steps the runner script knows (android-nightly-drivers.sh `setup`). */
export const SETUP_STEPS = new Set([
  'downloads-server',
  'hardening-server',
  'ublock-zip',
  'ext-crx',
  'webview-snapshot',
  'ffmpeg',
  'perfetto-python'
])
/** The state the runner sets before a driver or puts back after it. */
export const NEEDS = new Set(['pin', 'browser-role', 'navigation'])

// --- summary -----------------------------------------------------------------------------------

/** Every frames.jsonl record under `dir`. */
function framesUnder(dir) {
  const records = []
  if (!existsSync(dir)) return records
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name === 'frames.jsonl') {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            const record = JSON.parse(line)
            if (typeof record.scene === 'string') records.push(record)
          } catch {
            // a half-written line: not a scene
          }
        }
      }
    }
  }
  walk(dir)
  return records
}

/** One driver's jank verdict from its frames records. */
export function jankVerdict(records) {
  if (records.length === 0) return '–'
  const gated = records.filter((r) => (r.gated ?? []).length > 0)
  const over = records.filter((r) => r.verdict && r.verdict !== 'within')
  const faults = records.filter((r) => r.enforced)
  if (faults.length) return `**FAULT** ${faults.map((r) => `\`${r.scene}\``).join(', ')}`
  if (over.length)
    return `over: ${over.map((r) => `\`${r.scene}\``).join(', ')} (soft gate, reported)`
  if (gated.length === 0)
    return `${records.length} scene${records.length === 1 ? '' : 's'} reported only`
  return `within (${gated.length} of ${records.length} gated)`
}

const clock = (seconds) => {
  if (seconds === undefined || seconds === null) return '–'
  const s = Math.round(Number(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const code = (text) => `\`${String(text).replace(/`/g, '')}\``
const cell = (text) =>
  String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')

/**
 * Reads the shards' results under `dir` (one subdirectory per downloaded artifact, each with the
 * shard's `results.jsonl` at its root).
 * @returns {Map<string, { shard: string, root: string, results: Map<string, object>, shardInfo: object|null }>}
 */
export function readResults(dir) {
  const shards = new Map()
  if (!existsSync(dir)) return shards
  const roots = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isDirectory())
  for (const root of roots) {
    const file = join(root, 'results.jsonl')
    if (!existsSync(file)) continue
    const results = new Map()
    let shard = null
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        results.set(record.id, record)
        shard ??= record.shard
      } catch {
        // skipped: a broken line
      }
    }
    const infoFile = join(root, 'shard.json')
    const shardInfo = existsSync(infoFile) ? JSON.parse(readFileSync(infoFile, 'utf8')) : null
    shard ??= shardInfo?.shard ?? relative(dir, root)
    // A re-run leaves the shard's earlier attempt beside the new one: the latest attempt counts.
    const before = shards.get(shard)
    if (before && (before.shardInfo?.attempt ?? 1) > (shardInfo?.attempt ?? 1)) continue
    shards.set(shard, { shard, root, dirName: relative(dir, root), results, shardInfo })
  }
  return shards
}

/**
 * The table and its notes.
 * @returns {{ markdown: string, failed: string[], counts: Record<string, number> }}
 */
export function summarize(
  manifest,
  shardResults,
  { shard = 'all', artifactUrl = '', artifactName = '' } = {}
) {
  const names = shard && shard !== 'all' ? [shard] : shardNames(manifest)
  const rows = []
  const failures = []
  const skips = []
  const notRun = []
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 }
  const link = (path) =>
    artifactUrl
      ? `[${path}](${artifactUrl})`
      : artifactName
        ? `${code(artifactName)} › ${path}`
        : path
  for (const name of names) {
    const found = shardResults.get(name)
    for (const driver of driversOf(manifest, name)) {
      const r = found?.results.get(driver.id)
      const path = `${name}/${driver.id}/`
      if (!r) {
        counts.FAIL++
        const why = found
          ? 'no result: the shard stopped before it'
          : 'no result: the shard job left no results (it never booted, timed out or lost its artifact)'
        failures.push(`${code(driver.id)}: ${why}`)
        rows.push([classesOf(driver).join(', '), '**FAIL**', why, '–', '–', link(path)])
        continue
      }
      const result = r.result
      // A SKIP the shard wrote for a driver it could not run (the emulator gone, the budget spent)
      // is coverage missed, counted apart from a failure and from the manifest's skips.
      const unrun =
        result === 'SKIP' &&
        (r.reason?.startsWith('the emulator') || r.reason?.startsWith('shard budget'))
      counts[unrun ? 'NOT_RUN' : result] = (counts[unrun ? 'NOT_RUN' : result] ?? 0) + 1
      const records = framesUnder(join(found.root, driver.id))
      const checks = []
      if (records.length) checks.push(`${records.length} scene${records.length === 1 ? '' : 's'}`)
      if (r.touches)
        checks.push(
          `${r.touches} touch${r.touches === 1 ? '' : 'es'}${r.touchFaults ? ` (${r.touchFaults} did not take)` : ''}`
        )
      if (r.shots) checks.push(`${r.shots} shot${r.shots === 1 ? '' : 's'}`)
      if (r.videos) checks.push(`${r.videos} video${r.videos === 1 ? '' : 's'}`)
      const resultCell =
        result === 'PASS'
          ? 'PASS'
          : result === 'SKIP'
            ? unrun
              ? '**SKIP**'
              : 'SKIP'
            : `**${result}**`
      rows.push([
        classesOf(driver).join(', '),
        resultCell,
        checks.join(' · ') || (result === 'SKIP' ? cell(r.reason || 'no reason given') : '–'),
        clock(r.seconds),
        jankVerdict(records),
        link(path)
      ])
      if (result === 'FAIL')
        failures.push(
          `${code(driver.id)} (${classesOf(driver).join(', ')}, mirrors ${code(driver.mirrors)}): ${r.reason || 'see its instrument.txt'}`
        )
      else if (result === 'SKIP')
        (unrun ? notRun : skips).push(`${code(driver.id)}: ${r.reason || 'no reason given'}`)
    }
  }
  for (const skip of manifest.skip) {
    counts.SKIP++
    const what = skip.class ?? skip.workflow ?? '?'
    rows.push([what, 'SKIP', cell(skip.reason), '–', '–', '–'])
    skips.push(`${code(what)}: ${skip.reason}`)
  }
  const lines = []
  lines.push(
    `**${counts.PASS} passed, ${counts.FAIL} failed${counts.NOT_RUN ? `, ${counts.NOT_RUN} not run` : ''}, ${counts.SKIP} skipped** across ${names.length} shard${names.length === 1 ? '' : 's'}` +
      (artifactUrl
        ? ` · findings and videos: [${artifactName || 'the artifact'}](${artifactUrl})`
        : '') +
      '.',
    ''
  )
  const shardLines = names.map((name) => {
    const found = shardResults.get(name)
    const info = found?.shardInfo
    const total = driversOf(manifest, name).length
    const done = found ? [...found.results.values()] : []
    const passed = done.filter((r) => r.result === 'PASS').length
    const failed = done.filter((r) => r.result === 'FAIL').length + (total - done.length)
    const took = info?.seconds !== undefined ? ` in ${clock(info.seconds)}` : ''
    const died = info?.emulatorDied ? ' · **the emulator went away**' : ''
    const where = found ? ` · ${code(found.dirName + '/')}` : ' · **no results**'
    return `- ${code(name)} (${manifest.shards[name].title}): ${passed} of ${total} passed, ${failed} failed${took}${died}${where}`
  })
  lines.push(...shardLines, '')
  lines.push(
    '| driver | result | scenes / checks | duration | jank verdict | artifact |',
    '| --- | --- | --- | ---: | --- | --- |'
  )
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`)
  lines.push('')
  if (failures.length) lines.push('### Failed', '', ...failures.map((f) => `- ${f}`), '')
  if (notRun.length)
    lines.push(
      '### Not run',
      '',
      ...notRun.map((f) => `- ${f}`),
      '',
      'A driver not run is coverage missed: the run is red for it like for a failure.',
      ''
    )
  if (skips.length) lines.push('### Skipped', '', ...skips.map((f) => `- ${f}`), '')
  lines.push(
    "Result: PASS is the driver's `OK (…)` (its wrapper's own checks included); FAIL its failure, a timeout or an emulator death; SKIP a listed reason (in bold when the shard could not run the driver). " +
      'Scenes are the frames records (`frames.jsonl`), touches the fingers the harness put on controls (`the touch on … took`), shots the screenshots. ' +
      "The jank verdict is the soft gate's over its scenes (the recipe's software GPU: see android-jank-report.mjs). One artifact holds every driver's directory under its shard."
  )
  return { markdown: lines.join('\n'), failed: failures, notRun, counts }
}

// --- estimate ----------------------------------------------------------------------------------

export function estimate(manifest) {
  const lines = [
    '| shard | image | drivers | estimate (drivers) | job timeout |',
    '| --- | --- | ---: | ---: | ---: |'
  ]
  let total = 0
  for (const [name, shard] of Object.entries(manifest.shards)) {
    const drivers = driversOf(manifest, name)
    const minutes = drivers.reduce((sum, d) => sum + d.estimate, 0)
    total += minutes
    lines.push(
      `| ${code(name)} | ${shard.title} | ${drivers.length} | ${minutes.toFixed(1)} min | ${shard['timeout-minutes']} min (budget ${shard['budget-minutes']}) |`
    )
  }
  lines.push(`| **all** | | ${manifest.drivers.length} | ${total.toFixed(1)} min | |`, '')
  for (const [name] of Object.entries(manifest.shards)) {
    const drivers = driversOf(manifest, name)
    lines.push(`${code(name)}: ${drivers.map((d) => `${d.id} ${d.estimate}`).join(' · ')}`, '')
  }
  return lines.join('\n')
}

// --- command line ------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { positional: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1] ?? ''
      i++
    } else args.positional.push(argv[i])
  }
  return args
}

function main() {
  const [mode, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const manifest = readManifest()
  switch (mode) {
    case 'matrix':
      console.log(JSON.stringify(matrix(manifest, args.shard || 'all')))
      return
    case 'plan': {
      const [shard, dir] = args.positional
      if (!shard || !dir) throw new Error('usage: plan <shard> <dir>')
      const ids = writePlan(manifest, shard, dir)
      console.log(ids.join('\n'))
      return
    }
    case 'setup-steps': {
      const [shard] = args.positional
      if (!shard) throw new Error('usage: setup-steps <shard>')
      console.log(setupSteps(manifest, shard).join('\n'))
      return
    }
    case 'summary': {
      if (!args.results)
        throw new Error(
          'usage: summary --results <dir> [--shard all|<shard>] [--artifact-url <url>] [--artifact-name <name>]'
        )
      const { markdown, failed, notRun } = summarize(manifest, readResults(args.results), {
        shard: args.shard || 'all',
        artifactUrl: args['artifact-url'] || '',
        artifactName: args['artifact-name'] || ''
      })
      console.log(markdown)
      if (failed.length || notRun.length) {
        console.error(
          `${failed.length} driver${failed.length === 1 ? '' : 's'} failed, ${notRun.length} not run`
        )
        process.exitCode = 1
      }
      return
    }
    case 'check': {
      const problems = checkManifest(manifest)
      if (problems.length) {
        console.error(problems.join('\n'))
        process.exitCode = 1
      } else {
        const sources = sourceDriverClasses()
        console.log(
          `${manifest.drivers.length} drivers cover ${sources.size} classes; ${manifest.skip.length} skipped with a reason`
        )
      }
      return
    }
    case 'estimate':
      console.log(estimate(manifest))
      return
    default:
      console.error(
        'usage: android-nightly-drivers.mjs matrix [--shard s] | plan <shard> <dir> | setup-steps <shard> | summary --results <dir> [...] | check | estimate'
      )
      process.exitCode = 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
