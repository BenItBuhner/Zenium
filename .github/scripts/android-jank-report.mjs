#!/usr/bin/env node
// The jank budget gate's report: the frame statistics the emulator drivers record through
// DemoHarness.measureFrames / traceFrames (one JSON line per scene in frames.jsonl, schema v2 –
// see the harness and internal/android-parity/perf-jank-gate-helper.md) rendered as the Markdown
// tables of a job summary, in two modes:
//
//   node android-jank-report.mjs summary <findings dir> [--gate soft|hard] [--out <dir>]
//     Every frames.jsonl under the findings (a chained run leaves one per driver directory), as
//     TWO tables: (1) HWUI's frames per scene – frames, janky share, the 50 / 90 / 95 / 99th
//     percentiles, the stage most often long – REPORTED, never gated (on the recipe's software
//     GPU every frame is late whatever the chrome does); (2) the GATE's columns per scene – the
//     chrome WebView renderer main thread's time per frame (mean / p95 / max), layouts and paints
//     and style recalculations per frame, long tasks, from the scene's Blink trace; the ratios
//     against the scene's same-run baseline (p95 / baseline p95, janky share less the baseline's)
//     – and the verdict. The budgets per scene kind under them; each scene's stage table and
//     trace line folded under that. Printed to stdout (the workflow appends it to
//     $GITHUB_STEP_SUMMARY); written to <out>/jank-report.md with the frames.jsonl copied beside
//     it when --out is given (the small `jank-report-*` artifact the release reads); and, with
//     $GITHUB_OUTPUT set, the same as one JSON line under `report` (the shared workflow's
//     `jank-report` output: {"v":2,"gate","scenes":[the records as recorded],"over":[scene names
//     over budget],"enforced":[the faults]}).
//
//   node android-jank-report.mjs main [--repo owner/name] [--branch main] [--fallback-branch <b>]
//     The latest tables of the given branch (main), for the release dry-run's summary: the
//     `jank-report-*` artifacts of the most recent GREEN runs of the android-*.yml workflows on
//     that branch – and of its stand-ins, the temporary `cursor/main-jank-<hex>` branches cut
//     from its tip with the demos' push triggers on (no token of the program's can dispatch a
//     workflow, so a run "on main" is pushed that way and the branch deleted once read); a
//     stand-in's run counts when its head is one commit past the branch and that commit touched
//     nothing outside `.github/workflows/`, and the table names the branch's own commit –
//     read through `gh` (GH_TOKEN with actions: read), the newest measurement of every scene
//     kept, with the run it came from. Reading the artifacts costs seconds; booting an emulator
//     for a scene of its own would cost the release ten minutes and a runner. With nothing on
//     the branch the table says so; --fallback-branch shows that branch's latest instead,
//     labelled (a pull request's dry-run shows its own head's numbers before they are on main).
//     Never fails: an API error is a line in the summary.
//
// The caveat printed under every table: HWUI's numbers are the Android UI thread's and render
// thread's on a software GPU (-gpu swangle) – 100 percent janky, frame times in the hundreds of
// ms, by construction – and are not device performance; the defensible before / after numbers
// are the main-thread ms and the layouts / paints per frame, and the ratios against a baseline
// measured on the same recipe minutes apart.
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

/** A number with at most two decimals, trailing zeros dropped (the budgets' way). */
const short = (value) =>
  value === undefined || value === null || Number.isNaN(value)
    ? '–'
    : String(Number(Number(value).toFixed(2)))
const plus = (points) => `${points >= 0 ? '+' : '-'}${short(Math.abs(points) * 100)} pt`

/** A budget in words: the v2 shape (ratios and trace columns), or a v1 record's (share and p95). */
function describeBudget(b) {
  if (!b) return '–'
  const text =
    b.p95Ratio !== undefined
      ? `vs baseline p95 ≤ ${short(b.p95Ratio)}x, janky ≤ +${short(b.sharePoints * 100)} pt; trace layouts ≤ ${short(b.layoutsPerFrame)}/frame, ` +
        `paints ≤ ${short(b.paintsPerFrame)}/frame, main-thread p95 ≤ ${short(b.mainThreadP95Ms)} ms, long tasks ≤ ${b.longTasks}`
      : `janky ≤ ${pct(b.jankyShare)}, p95 ≤ ${b.p95} ms (schema v1)`
  return b.provisional ? `${text} (provisional)` : text
}

function verdictCell(record) {
  if (!record.frames) return '**not measured**'
  const gated = record.gated ?? []
  if (record.verdict === 'within') {
    if (gated.length === 0)
      return record.v >= 2 ? 'reported only (no baseline, no trace)' : 'within (schema v1)'
    return `within (gated on ${gated.join(' + ')})`
  }
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

/** The trace's main-thread time per frame: mean / p95 / max. */
function mainThreadCell(record) {
  const t = record.trace
  if (!t) return record.traceMissing ? 'no trace' : '–'
  if (!t.found) return 'no main thread'
  const ms = t.mainThreadMs
  if (!ms) return t.frames ? `${t.frames} frames, no times` : 'no frames'
  return `${fixed(ms.mean, 1)} / ${fixed(ms.p95, 1)} / ${fixed(ms.max, 1)}`
}

function perFrameCell(record, key, decimals = 2) {
  const t = record.trace
  if (!t || !t.found) return '–'
  return fixed(t.perFrame?.[key], decimals)
}

function longTasksCell(record) {
  const t = record.trace
  if (!t || !t.found) return '–'
  return t.longTasks ? `${t.longTasks} (longest ${fixed(t.longestTaskMs, 0)} ms${cpuNote(t)})` : '0'
}

/** The longest task's time on the CPU beside its wall time, when the trace carried thread times: the gap is time off the CPU, not the chrome's work. */
function cpuNote(t) {
  return typeof t.longestTaskCpuMs === 'number'
    ? `, ${fixed(t.longestTaskCpuMs, 0)} on the CPU`
    : ''
}

function baselineCell(record) {
  if (!record.baseline) return '–'
  const r = record.ratio
  if (!r) return `${code(record.baseline)}: not measured`
  return `${code(record.baseline)}: p95 ${r.p95 === null || r.p95 === undefined ? '–' : `${short(r.p95)}x`}, janky ${plus(r.sharePoints)}`
}

/** One scene's stage table and trace line, folded. */
function folded(record) {
  const stageMs = record.stageMs ?? {}
  const names = Object.keys(stageMs)
  const t = record.trace
  if (names.length === 0 && !t && !record.traceMissing) return ''
  const lines = [
    `<details><summary>${codeTag(record.scene)}${record.source ? ` (${record.source})` : ''}: ${record.sampled ?? 0} frames sampled (${record.skipped ?? 0} skipped), ${record.long ?? 0} past their deadline${t?.found ? `; trace: ${t.frames} main-thread frames` : ''}</summary>`,
    ''
  ]
  if (names.length) {
    lines.push(
      '| stage | mean ms | max ms | long frames |',
      '| --- | ---: | ---: | ---: |',
      ...names.map(
        (name) =>
          `| ${code(name)} | ${fixed(stageMs[name].mean)} | ${fixed(stageMs[name].max)} | ${stageMs[name].long ?? 0} |`
      ),
      ''
    )
  }
  if (t?.found) {
    lines.push(
      `Trace (renderer main thread ${code(t.thread)}, ${t.events} events, ${fixed(t.windowMs, 0)} ms${t.whole ? ', the whole trace' : ''}): ` +
        `${t.frames} frames; busy ${fixed(t.busyMs, 0)} ms (${fixed(t.busyPerFrameMs, 1)} ms/frame), script ${fixed(t.scriptMs, 0)} ms` +
        `${t.workMs?.compile >= 0.5 ? ` (compiling ${fixed(t.workMs.compile, 0)} ms)` : ''}` +
        `${t.workMs ? ` (style ${fixed(t.workMs.styleRecalc, 0)}, layout ${fixed(t.workMs.layout, 0)}, paint ${fixed(t.workMs.paint, 0)} ms)` : ''}; ` +
        `layouts ${t.layoutCount}, paints ${t.paintCount}, style recalcs ${t.styleRecalcCount} (${fixed(t.perFrame?.styleRecalc, 2)}/frame), ` +
        `layer updates ${t.layerChurn} (${fixed(t.perFrame?.layerChurn, 1)}/frame); long tasks ${t.longTasks}, longest ${fixed(t.longestTaskMs, 0)} ms${t.longTasks ? cpuNote(t) : ''}.`,
      ''
    )
  } else if (t) {
    lines.push(
      `Trace: no renderer main thread among its ${t.threads} threads (${t.events} events).`,
      ''
    )
  } else if (record.traceMissing) {
    lines.push(`Trace: none read – ${record.traceMissing}.`, '')
  }
  const reasons = Object.entries(record.reasons ?? {})
  if (reasons.length)
    lines.push(`HWUI's reasons: ${reasons.map(([k, v]) => `${k} ${v}`).join(', ')}.`, '')
  const notes = record.notes ?? []
  if (notes.length) lines.push(`Notes: ${notes.join('; ')}.`, '')
  lines.push('</details>')
  return lines.join('\n')
}

const CAVEAT_HWUI =
  "Frames, janky frames and the percentiles (ms) are HWUI's own (`dumpsys gfxinfo framestats`) since the " +
  "scene's reset – the Android UI thread's and render thread's – and the long stage is the stage most often " +
  'the largest in the sampled frames past their deadline. REPORTED, NEVER GATED: the recipe renders on a software ' +
  "GPU (`-gpu swangle`), so every frame misses its deadline and the frame times are the recipe's, not the " +
  "chrome's and not device performance (100 % janky, p50 in the hundreds of ms, by construction)."

const CAVEAT_GATE =
  "The gate reads what the software GPU does not dominate: the chrome WebView renderer main thread's work in " +
  'the scene from its Blink trace (`android.webkit.TracingController`: main-thread ms per frame as mean / p95 / ' +
  'max, `Layout` / `Paint` / `UpdateLayoutTree` per `BeginMainFrame`, top-level tasks over 50 ms), and the RATIOS ' +
  "against a same-run baseline scene (the same motion with the chrome's part removed), which cancel the recipe. " +
  'Main-thread ms and layouts / paints per frame are the defensible before / after numbers; swangle frame times ' +
  'are not to be quoted as device performance. A scene with neither trace nor baseline is reported only.'

/**
 * The tables of `scenes` (records; `run` on a record adds its run's column). `gate` labels the
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
  const gatedScenes = scenes.filter((s) => (s.gated ?? []).length > 0)
  const traced = scenes.filter((s) => s.trace?.found)
  lines.push(
    `${scenes.length} scene${scenes.length === 1 ? '' : 's'} measured under a ${code(gate ?? scenes[0].gate ?? 'soft')} gate: ` +
      `${gatedScenes.length} gated (${traced.length} with a trace, ${scenes.filter((s) => s.baseline).length} against a baseline), ` +
      `${scenes.length - gatedScenes.length} reported only. ` +
      (over.length === 0
        ? 'Every gated scene is within its budget.'
        : `${over.length} over budget (${over.map((s) => code(s.scene)).join(', ')})${enforced.length ? ` – ${enforced.length} a fault` : ' – reported, not enforced'}.`),
    ''
  )
  const runCell = (s) =>
    s.run
      ? `[${s.run.name} #${s.run.number}](${s.run.url}) · ${s.run.sha.slice(0, 7)} · ${s.run.date}` +
        (s.run.via ? ` <sub>via ${code(s.run.via)}</sub>` : '')
      : '–'
  const sceneCell = (s) => code(s.scene) + (s.source ? ` <sub>${s.source}</sub>` : '')

  // (1) HWUI's frames: reported.
  lines.push('#### HWUI frames (reported, never gated)', '')
  const head1 = ['scene', 'kind', 'frames', 'janky', 'p50', 'p90', 'p95', 'p99', 'long stage']
  const align1 = ['---', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---']
  if (withRun) {
    head1.push('run')
    align1.push('---')
  }
  lines.push(`| ${head1.join(' | ')} |`, `| ${align1.join(' | ')} |`)
  for (const s of scenes) {
    const cells = [
      sceneCell(s),
      s.kind ?? '–',
      s.frames ?? 0,
      s.frames ? `${s.janky} (${pct(s.jankyShare)})` : '–',
      s.frames ? s.p50 : '–',
      s.frames ? s.p90 : '–',
      s.frames ? s.p95 : '–',
      s.frames ? s.p99 : '–',
      dominantCell(s)
    ]
    if (withRun) cells.push(runCell(s))
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('', CAVEAT_HWUI, '')

  // (2) The gate: the Blink main thread's columns and the ratios.
  lines.push('#### The gate: Blink main thread (per frame) and ratios against the baseline', '')
  const head2 = [
    'scene',
    'main-thread ms/frame (mean / p95 / max)',
    'layouts/frame',
    'paints/frame',
    'style recalcs/frame',
    'long tasks',
    'vs baseline',
    'verdict'
  ]
  const align2 = ['---', '---:', '---:', '---:', '---:', '---', '---', '---']
  lines.push(`| ${head2.join(' | ')} |`, `| ${align2.join(' | ')} |`)
  for (const s of scenes) {
    lines.push(
      `| ${[
        sceneCell(s),
        mainThreadCell(s),
        perFrameCell(s, 'layout'),
        perFrameCell(s, 'paint'),
        perFrameCell(s, 'styleRecalc'),
        longTasksCell(s),
        baselineCell(s),
        verdictCell(s)
      ].join(' | ')} |`
    )
  }
  lines.push('')
  const budgets = new Map()
  for (const s of scenes) if (s.budget && !budgets.has(s.kind)) budgets.set(s.kind, s.budget)
  if (budgets.size)
    lines.push(
      'Budgets: ' +
        [...budgets.entries()]
          .map(([kind, b]) => `**${kind}** – ${describeBudget(b)}`)
          .join(' · ') +
        '.',
      ''
    )
  lines.push(CAVEAT_GATE, '')
  for (const s of scenes) {
    const fold = folded(s)
    if (fold) lines.push(fold, '')
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
    v: 2,
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

/**
 * The temporary branches a run of `branch`'s code is pushed on: `cursor/main-jank-<hex>`, cut
 * from the branch's tip with the demos' push triggers on, since no token of the program's can
 * dispatch a workflow, and deleted once the run is read (`run.head_branch` keeps the name).
 */
const STAND_IN_BRANCH = /^cursor\/main-jank-[0-9a-f]+$/
const DEMO_WORKFLOW = /^\.github\/workflows\/android-[^/]+\.ya?ml$/

/** The green android-*.yml runs the API lists for `params`, newest first, within the artifacts' retention. */
function listGreenDemoRuns(repo, params, keep) {
  const since = Date.now() - RETENTION_DAYS * 86_400_000
  const runs = []
  for (let page = 1; page <= 3 && runs.length < RUN_LIMIT; page++) {
    const body = JSON.parse(
      gh(
        'api',
        '-X',
        'GET',
        `repos/${repo}/actions/runs`,
        ...params.flatMap((p) => ['-f', p]),
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
      if (!DEMO_WORKFLOW.test(run.path ?? '')) continue
      if (!keep(run)) continue
      runs.push(run)
      if (runs.length >= RUN_LIMIT) break
    }
    if (list.length < 100) break
  }
  return runs
}

/**
 * Whether a stand-in branch's run measured `branch`'s own code: its head is exactly one commit
 * past `branch` (the trigger commit over the tip as it was) and that commit changed nothing
 * outside `.github/workflows/`. Returns the branch's commit the run stands in for, or null.
 */
function standsInFor(repo, branch, run) {
  try {
    const compare = JSON.parse(
      gh('api', '-X', 'GET', `repos/${repo}/compare/${branch}...${run.head_sha}`)
    )
    if (compare.ahead_by !== 1) return null
    const files = compare.files ?? []
    if (files.some((f) => !String(f.filename).startsWith('.github/workflows/'))) return null
    return compare.merge_base_commit?.sha ?? null
  } catch (error) {
    console.error(
      `${run.head_branch} ${run.head_sha.slice(0, 7)}: ${String(error.message).split('\n')[0]}`
    )
    return null
  }
}

/**
 * The green android-*.yml runs of `branch`, newest first, within the artifacts' retention: the
 * runs on the branch itself, and the pushed runs of its stand-in branches whose head is the
 * branch's tip plus the trigger (`standsInFor`), each of those marked with the commit it measured.
 */
function greenDemoRuns(repo, branch) {
  const own = listGreenDemoRuns(repo, [`branch=${branch}`], () => true)
  const standIns = listGreenDemoRuns(repo, ['event=push'], (run) =>
    STAND_IN_BRANCH.test(run.head_branch ?? '')
  )
    .map((run) => ({ ...run, standsInFor: standsInFor(repo, branch, run) }))
    .filter((run) => run.standsInFor)
  return [...own, ...standIns]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, RUN_LIMIT)
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
            // A stand-in's run names the branch's commit it measured, and the branch it was pushed on.
            sha: run.standsInFor ?? run.head_sha,
            via: run.standsInFor ? run.head_branch : undefined,
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
      `has run green on \`${branch}\` – or on a \`cursor/main-jank-<hex>\` branch cut from its tip with the push trigger on – ` +
      `with the frame statistics in its findings (\`jank-report-*\` artifacts, kept ${RETENTION_DAYS} days).`
    if (onBranch.scenes.length > 0) {
      console.log(
        render(onBranch.scenes, {
          title: `Android frame statistics on \`${branch}\` (the jank budget gate)`,
          withRun: true,
          note:
            `The newest green measurement of every scene among the last ${onBranch.runs} green demo runs on \`${branch}\` ` +
            `(${onBranch.opened} report${onBranch.opened === 1 ? '' : 's'} read; a run pushed on a \`cursor/main-jank-*\` stand-in ` +
            `names the \`${branch}\` commit it measured).`
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
