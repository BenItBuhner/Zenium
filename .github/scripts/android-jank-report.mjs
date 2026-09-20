#!/usr/bin/env node
// The jank budget gate's report: the frame statistics the emulator drivers record through
// DemoHarness.measureFrames (one JSON line per scene in frames.jsonl, schema v1 – see the
// harness) rendered as the Markdown table of a job summary, in two modes:
//
//   node android-jank-report.mjs summary <findings dir> [--gate soft|hard] [--out <dir>]
//     Every frames.jsonl under the findings (a chained run leaves one per driver directory),
//     as one table: scene, kind, frames, janky share, the 50 / 90 / 95 / 99th percentiles, the
//     stage most often long, the budget and the verdict; each scene's stage table folded under
//     it. Printed to stdout (the workflow appends it to $GITHUB_STEP_SUMMARY); written to
//     <out>/jank-report.md with the frames.jsonl copied beside it when --out is given (the small
//     `jank-report-*` artifact the release reads); and, with $GITHUB_OUTPUT set, the same as one
//     JSON line under `report` (the shared workflow's `jank-report` output: {"v":1,"gate","scenes"
//     [the records as recorded],"over":[scene names over budget],"enforced":[the faults]}).
//
//   node android-jank-report.mjs main [--repo owner/name] [--branch main] [--fallback-branch <b>]
//     The latest table of the given branch (main), for the release dry-run's summary: the
//     `jank-report-*` artifacts of the most recent GREEN runs of the android-*.yml workflows on
//     that branch, read through `gh` (GH_TOKEN with actions: read), the newest measurement of
//     every scene kept, with the run it came from. Reading the artifacts costs seconds; booting
//     an emulator for a scene of its own would cost the release ten minutes and a runner. With
//     nothing on the branch the table says so; --fallback-branch shows that branch's latest
//     instead, labelled (a pull request's dry-run shows its own head's numbers before they are
//     on main). Never fails: an API error is a line in the summary.
//
// The caveat printed under every table: the recipe's emulator has a software GPU (-gpu
// swangle), which inflates the render thread's `commands` and `swap` stages many times over
// against a phone and puts most frames past their deadline; the numbers compare on this one
// recipe alone, and the budgets are relative to it.
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const RECORD = 'frames.jsonl'
const TABLES = 'frames.txt'
const ARTIFACT_PREFIX = 'jank-report-'
/** How long the jank-report artifacts are kept (android-emulator-demo.yml); older runs have none. */
const RETENTION_DAYS = 90
/** How many green android-*.yml runs of a branch are opened for their reports. */
const RUN_LIMIT = 30

const [mode, ...rest] = process.argv.slice(2)
const args = { positional: [] }
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    args[rest[i].slice(2)] = rest[i + 1] ?? ''
    i++
  } else {
    args.positional.push(rest[i])
  }
}

// --- reading -----------------------------------------------------------------------------------

/** Every frames.jsonl under `dir`, each as its records (bad lines skipped and counted). */
function readRecords(dir) {
  const scenes = []
  let bad = 0
  if (!existsSync(dir)) return { scenes, bad }
  const files = statSync(dir).isFile()
    ? [dir]
    : readdirSync(dir, { recursive: true })
        .map((name) => join(dir, String(name)))
        .filter((file) => file.endsWith(RECORD) && statSync(file).isFile())
        .sort()
  for (const file of files) {
    const source = relative(dir, file).replace(/\/?frames\.jsonl$/, '')
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (typeof record.scene !== 'string') throw new Error('no scene')
        scenes.push(source ? { ...record, source } : record)
      } catch {
        bad++
      }
    }
  }
  return { scenes, bad }
}

// --- rendering ---------------------------------------------------------------------------------

const pct = (share) => `${Math.round((share ?? 0) * 100)}%`
const fixed = (value, decimals = 2) =>
  value === undefined || value === null || Number.isNaN(value)
    ? '–'
    : Number(value).toFixed(decimals)
const code = (text) => `\`${String(text).replace(/`/g, '')}\``
/** Inside a raw HTML block (`<summary>`) GFM renders no inline markdown, so code is a tag there. */
const codeTag = (text) => `<code>${String(text).replace(/[<>&`]/g, '')}</code>`

function budgetCell(record) {
  const b = record.budget
  if (!b) return '–'
  return `janky ≤ ${pct(b.jankyShare)}, p95 ≤ ${b.p95} ms${b.provisional ? ' (provisional)' : ''}`
}

function verdictCell(record) {
  if (!record.frames) return '**not measured**'
  if (record.verdict === 'within') return 'within'
  const breaches = (record.breaches ?? []).join('; ')
  return record.enforced
    ? `**FAULT** (${breaches})`
    : `over (${breaches}; reported, gate ${record.gate})`
}

function dominantCell(record) {
  if (!record.dominant) return record.sampled ? 'none long' : '–'
  const stat = record.stageMs?.[record.dominant]
  const long = stat ? `${stat.long} of ${record.long}` : ''
  return `${code(record.dominant)}${long ? ` (${long} long frames)` : ''}`
}

/** One scene's stage table, folded. */
function stages(record) {
  const stageMs = record.stageMs ?? {}
  const names = Object.keys(stageMs)
  if (names.length === 0) return ''
  const lines = [
    `<details><summary>${codeTag(record.scene)}${record.source ? ` (${record.source})` : ''}: ${record.sampled ?? 0} frames sampled (${record.skipped ?? 0} skipped), ${record.long ?? 0} past their deadline</summary>`,
    '',
    '| stage | mean ms | max ms | long frames |',
    '| --- | ---: | ---: | ---: |',
    ...names.map(
      (name) =>
        `| ${code(name)} | ${fixed(stageMs[name].mean)} | ${fixed(stageMs[name].max)} | ${stageMs[name].long ?? 0} |`
    )
  ]
  const reasons = Object.entries(record.reasons ?? {})
  if (reasons.length)
    lines.push('', `HWUI's reasons: ${reasons.map(([k, v]) => `${k} ${v}`).join(', ')}.`)
  lines.push('</details>')
  return lines.join('\n')
}

const CAVEAT =
  "Frames, janky frames and the percentiles (ms) are HWUI's own (`dumpsys gfxinfo framestats`) since the " +
  "scene's reset; the long stage is the stage most often the largest in the sampled frames past their " +
  "deadline (the CSV's last frames). Emulator caveat: the recipe renders on a software GPU (`-gpu swangle`), " +
  'which inflates `commands` and `swap` many times over against a phone – the numbers compare on this one ' +
  'recipe alone, and the budgets are relative to it, not phone frame times.'

/**
 * The table of `scenes` (records; `run` on a record adds its run's column). `gate` labels the
 * heading; `title` is the heading text.
 */
function render(scenes, { title, gate, withRun = false, note = '' }) {
  const lines = [`### ${title}`, '']
  if (note) lines.push(note, '')
  if (scenes.length === 0) {
    lines.push(
      'No scene measured frames: no `frames.jsonl` in the findings (the driver does not call `measureFrames`, or failed before its first scene).'
    )
    return lines.join('\n')
  }
  const over = scenes.filter((s) => s.verdict !== 'within')
  const enforced = scenes.filter((s) => s.enforced)
  lines.push(
    `${scenes.length} scene${scenes.length === 1 ? '' : 's'} measured under a ${code(gate ?? scenes[0].gate ?? 'soft')} gate: ` +
      (over.length === 0
        ? 'every scene within its budget.'
        : `${over.length} over budget (${over.map((s) => code(s.scene)).join(', ')})${enforced.length ? `, ${enforced.length} a fault` : ', reported only'}.`),
    ''
  )
  const head = [
    'scene',
    'kind',
    'frames',
    'janky',
    'p50',
    'p90',
    'p95',
    'p99',
    'long stage',
    'budget',
    'verdict'
  ]
  const align = ['---', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---', '---', '---']
  if (withRun) {
    head.push('run')
    align.push('---')
  }
  lines.push(`| ${head.join(' | ')} |`, `| ${align.join(' | ')} |`)
  for (const s of scenes) {
    const cells = [
      code(s.scene) + (s.source ? ` <sub>${s.source}</sub>` : ''),
      s.kind ?? '–',
      s.frames ?? 0,
      s.frames ? `${s.janky} (${pct(s.jankyShare)})` : '–',
      s.frames ? s.p50 : '–',
      s.frames ? s.p90 : '–',
      s.frames ? s.p95 : '–',
      s.frames ? s.p99 : '–',
      dominantCell(s),
      budgetCell(s),
      verdictCell(s)
    ]
    if (withRun)
      cells.push(
        s.run
          ? `[${s.run.name} #${s.run.number}](${s.run.url}) · ${s.run.sha.slice(0, 7)} · ${s.run.date}`
          : '–'
      )
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('', CAVEAT, '')
  for (const s of scenes) {
    const folded = stages(s)
    if (folded) lines.push(folded, '')
  }
  return lines.join('\n')
}

// --- summary mode --------------------------------------------------------------------------------

function summary() {
  const dir = args.positional[0] ?? args.dir
  if (!dir) {
    console.error(
      'usage: android-jank-report.mjs summary <findings dir> [--gate soft|hard] [--out <dir>]'
    )
    process.exit(2)
  }
  const gate = args.gate || undefined
  const { scenes, bad } = readRecords(dir)
  const note = bad ? `${bad} line${bad === 1 ? '' : 's'} of frames.jsonl could not be read.` : ''
  const markdown = render(scenes, { title: 'Frame statistics: the jank budget gate', gate, note })
  console.log(markdown)
  // A run that measured nothing leaves no report directory: the artifact is then not uploaded.
  if (args.out && scenes.length) {
    mkdirSync(args.out, { recursive: true })
    writeFileSync(join(args.out, 'jank-report.md'), markdown + '\n')
    // The records themselves beside the table, so a reader (the release) needs no other artifact.
    writeFileSync(join(args.out, RECORD), scenes.map((s) => JSON.stringify(s)).join('\n') + '\n')
    const tables =
      existsSync(dir) && !statSync(dir).isFile()
        ? readdirSync(dir, { recursive: true })
            .map((name) => join(dir, String(name)))
            .filter((file) => file.endsWith(TABLES) && statSync(file).isFile())
            .sort()
        : []
    if (tables.length)
      writeFileSync(join(args.out, TABLES), tables.map((f) => readFileSync(f, 'utf8')).join('\n'))
  }
  const report = {
    v: 1,
    gate: gate ?? scenes[0]?.gate ?? 'soft',
    scenes,
    over: scenes.filter((s) => s.verdict !== 'within').map((s) => s.scene),
    enforced: scenes.filter((s) => s.enforced).map((s) => s.scene)
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `report=${JSON.stringify(report)}\n`)
}

// --- main mode -----------------------------------------------------------------------------------

function gh(...ghArgs) {
  return execFileSync('gh', ghArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024
  })
}

/** The green android-*.yml runs of `branch`, newest first, within the artifacts' retention. */
function greenDemoRuns(repo, branch) {
  const since = Date.now() - RETENTION_DAYS * 86_400_000
  const runs = []
  for (let page = 1; page <= 3 && runs.length < RUN_LIMIT; page++) {
    const body = JSON.parse(
      gh(
        'api',
        '-X',
        'GET',
        `repos/${repo}/actions/runs`,
        '-f',
        `branch=${branch}`,
        '-f',
        'status=success',
        '-f',
        'per_page=100',
        '-f',
        `page=${page}`
      )
    )
    const list = body.workflow_runs ?? []
    for (const run of list) {
      if (new Date(run.created_at).getTime() < since) return runs
      if (!/^\.github\/workflows\/android-[^/]+\.ya?ml$/.test(run.path ?? '')) continue
      runs.push(run)
      if (runs.length >= RUN_LIMIT) break
    }
    if (list.length < 100) break
  }
  return runs
}

/** The scenes of `branch`'s latest green runs: for every scene name, the newest record, with its run. */
function latestScenes(repo, branch) {
  const runs = greenDemoRuns(repo, branch)
  const byScene = new Map()
  let opened = 0
  for (const run of runs) {
    const artifacts =
      JSON.parse(
        gh(
          'api',
          '-X',
          'GET',
          `repos/${repo}/actions/runs/${run.id}/artifacts`,
          '-f',
          'per_page=100'
        )
      ).artifacts ?? []
    const reports = artifacts.filter((a) => a.name.startsWith(ARTIFACT_PREFIX) && !a.expired)
    for (const artifact of reports) {
      // A fresh directory every time: `gh run download` refuses to overwrite a file it finds.
      const dir = mkdtempSync(join(tmpdir(), `jank-report-${run.id}-${artifact.id}-`))
      let records
      try {
        gh('run', 'download', String(run.id), '-R', repo, '-n', artifact.name, '-D', dir)
        records = readRecords(dir).scenes
      } catch (error) {
        console.error(`${artifact.name} of run ${run.id}: ${String(error.message).split('\n')[0]}`)
        continue
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      opened++
      for (const record of records) {
        // Runs come newest first: the first record of a scene is its latest.
        if (byScene.has(record.scene)) continue
        byScene.set(record.scene, {
          ...record,
          source: undefined,
          run: {
            name: run.name,
            number: run.run_number,
            url: run.html_url,
            sha: run.head_sha,
            date: run.created_at.slice(0, 10)
          }
        })
      }
    }
  }
  return { scenes: [...byScene.values()], runs: runs.length, opened }
}

function main() {
  const repo = args.repo || process.env.GITHUB_REPOSITORY
  const branch = args.branch || 'main'
  const fallback = args['fallback-branch'] || ''
  if (!repo) {
    console.error('android-jank-report.mjs main: --repo owner/name or GITHUB_REPOSITORY is needed')
    process.exit(2)
  }
  try {
    const onBranch = latestScenes(repo, branch)
    const dispatchNote =
      `The demos run by dispatch: the table is empty until \`Android bar hide on scroll demo\` or \`Android sheet recede demo\` ` +
      `has run green on \`${branch}\` with the frame statistics in its findings (\`jank-report-*\` artifacts, kept ${RETENTION_DAYS} days).`
    if (onBranch.scenes.length > 0) {
      console.log(
        render(onBranch.scenes, {
          title: `Android frame statistics on \`${branch}\` (the jank budget gate)`,
          withRun: true,
          note: `The newest green measurement of every scene among the last ${onBranch.runs} green demo runs on \`${branch}\` (${onBranch.opened} report${onBranch.opened === 1 ? '' : 's'} read).`
        })
      )
      return
    }
    if (fallback && fallback !== branch) {
      const onFallback = latestScenes(repo, fallback)
      if (onFallback.scenes.length > 0) {
        console.log(
          render(onFallback.scenes, {
            title: `Android frame statistics: none on \`${branch}\` yet – the latest on \`${fallback}\``,
            withRun: true,
            note: `${dispatchNote} Shown instead: the newest green measurement of every scene on \`${fallback}\` (${onFallback.runs} green demo runs looked at, ${onFallback.opened} report${onFallback.opened === 1 ? '' : 's'} read).`
          })
        )
        return
      }
    }
    console.log(
      `### Android frame statistics on \`${branch}\` (the jank budget gate)\n\nNo jank record found. ${dispatchNote}${fallback && fallback !== branch ? ` None on \`${fallback}\` either.` : ''}\n`
    )
  } catch (error) {
    console.log(
      `### Android frame statistics on \`${branch}\` (the jank budget gate)\n\nThe record could not be read: ${String(error.message).split('\n')[0]}\n`
    )
  }
}

if (mode === 'summary') summary()
else if (mode === 'main') main()
else {
  console.error(
    'usage: android-jank-report.mjs summary <findings dir> [--gate soft|hard] [--out <dir>] | main [--repo owner/name] [--branch main] [--fallback-branch <branch>]'
  )
  process.exit(2)
}
