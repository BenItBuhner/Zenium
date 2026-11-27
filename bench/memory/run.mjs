#!/usr/bin/env node
// Many-tabs memory benchmark. One invocation = one run of one browser at one preset.
//
//   node bench/memory/run.mjs --browser zenium --preset 200 [--cap 512] [--label name]
//        [--zenium-state '{"settings":{...}}'] [--args "--flag --flag2"] [--out dir]
//
// Phases: open N tabs from sites.txt in the background (one every OPEN_GAP_MS), let them settle,
// then cycle through M "active" tabs (spread evenly over the list) — switch to it, scroll it a
// few times — so each active tab is in front several times; then measure how long K background
// tabs take to paint again when switched to. Memory of the whole process tree is sampled every
// second throughout. See README.md for what every number means.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { makeBrowser } from './lib/browsers.mjs'
import { sampleTree, median, breakdown } from './lib/sample.mjs'

const PRESETS = {
  10: { tabs: 10, active: 2 },
  50: { tabs: 50, active: 5 },
  100: { tabs: 100, active: 10 },
  200: { tabs: 200, active: 20 }
}
const OPEN_GAP_MS = 300
const QUICK = process.env.BENCH_QUICK === '1' // smoke-testing the harness only
const SETTLE_MS = QUICK ? 5_000 : 30_000
const DWELL_MS = 2_500
const SCROLLS_PER_DWELL = 3
const CYCLES = 3
const MIN_ACTIVE_MS = QUICK ? 15_000 : 90_000
const STEADY_WINDOW_MS = 60_000
const RESTORE_SAMPLES = QUICK ? 2 : 5
const RESTORE_TIMEOUT_MS = 30_000
const SAMPLE_EVERY_MS = 1_000

const here = new URL('.', import.meta.url).pathname
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const [k, v] = a.includes('=')
      ? [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]
      : [a.slice(2), argv[i + 1]?.startsWith('--') ? 'true' : argv[++i]]
    out[k] = v ?? 'true'
  }
  return out
}

function ensureDisplay() {
  if (process.env.DISPLAY) return
  process.env.DISPLAY = ':99'
  if (!existsSync('/tmp/.X11-unix/X99')) {
    spawn('Xvfb', [':99', '-screen', '0', '1280x800x24'], {
      stdio: 'ignore',
      detached: true
    }).unref()
  }
}

function cgroupSetup(name, capMb) {
  const dir = `/sys/fs/cgroup/memory/${name}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'memory.limit_in_bytes'), String(capMb * 1024 * 1024))
  // No swap in the cloud box; set the swap+memory limit too where the kernel offers it.
  try {
    writeFileSync(join(dir, 'memory.memsw.limit_in_bytes'), String(capMb * 1024 * 1024))
  } catch {
    /* no swap accounting */
  }
  try {
    writeFileSync(join(dir, 'memory.max_usage_in_bytes'), '0')
  } catch {
    /* reset unsupported */
  }
  return {
    oomKills: () =>
      Number(
        /oom_kill (\d+)/.exec(readFileSync(join(dir, 'memory.oom_control'), 'utf8'))?.[1] ?? 0
      ),
    usageMb: () => Number(readFileSync(join(dir, 'memory.usage_in_bytes'), 'utf8')) / 1048576,
    maxUsageMb: () =>
      Number(readFileSync(join(dir, 'memory.max_usage_in_bytes'), 'utf8')) / 1048576,
    remove: () => {
      try {
        rmSync(dir, { recursive: false })
      } catch {
        /* still has tasks; left for the next run, which reuses it */
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const kind = args.browser ?? 'zenium'
  const preset = PRESETS[args.preset ?? '50']
  if (!preset) throw new Error('--preset must be 50, 100 or 200')
  const capMb = args.cap ? Number(args.cap) : null
  const label = args.label ?? kind
  const outDir = args.out ?? join(here, 'results')
  mkdirSync(outDir, { recursive: true })
  ensureDisplay()

  const sites = readFileSync(join(here, 'sites.txt'), 'utf8')
    .trim()
    .split('\n')
    .slice(0, preset.tabs)
  const step = preset.tabs / preset.active
  const activeIdx = Array.from({ length: preset.active }, (_, i) => Math.floor(i * step))
  // The background tabs restored at the end: the oldest ones that were never active.
  const restoreIdx = sites
    .map((_, i) => i)
    .filter((i) => !activeIdx.includes(i))
    .slice(0, RESTORE_SAMPLES)

  const profileDir = `/tmp/zbench-profile-${kind}-${process.pid}`
  rmSync(profileDir, { recursive: true, force: true })
  const cg = capMb ? cgroupSetup(`zbench-${process.pid}`, capMb) : null
  const logLines = []
  const browser = makeBrowser(kind, {
    profileDir,
    port: args.port ? Number(args.port) : undefined,
    cgroup: cg ? `zbench-${process.pid}` : null,
    extraArgs: args['args-json']
      ? JSON.parse(args['args-json'])
      : args.args
        ? args.args.split(' ').filter(Boolean)
        : [],
    zeniumState: args['zenium-state'] ? JSON.parse(args['zenium-state']) : {},
    env: args.env ? Object.fromEntries(args.env.split(',').map((kv) => kv.split('='))) : {},
    memorySaver: args['no-memory-saver'] ? false : true,
    log: (t) => logLines.push(t)
  })

  const t0 = Date.now()
  const result = {
    browser: kind,
    label,
    preset: `${preset.tabs}/${preset.active}`,
    capMb,
    args: args['args-json'] ?? args.args ?? '',
    zeniumState: args['zenium-state'] ?? null,
    startedAt: new Date(t0).toISOString(),
    phases: {},
    samples: [],
    restores: [],
    errors: [],
    browserExited: null
  }
  const mark = (name) => (result.phases[name] = Date.now() - t0)
  let exitInfo = null

  // A user is at the machine: real X input every 2 s (a one-pixel pointer nudge), so browsers
  // that watch the system's idle time (Zenium freezes everything after 10 idle minutes; Xvfb
  // otherwise reports hours idle) see someone there, as on a desktop in use.
  let nudge = 1
  const presence = setInterval(() => {
    nudge = -nudge
    spawn('xdotool', ['mousemove_relative', '--', String(nudge), '0'], {
      stdio: 'ignore',
      env: process.env
    }).on('error', () => clearInterval(presence))
  }, 2_000)

  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      if (browser.rootPid) {
        const s = sampleTree([browser.rootPid])
        result.samples.push({
          t: Date.now() - t0,
          pssMb: Math.round(s.pssMb),
          rssMb: Math.round(s.rssMb),
          procs: s.processes,
          cgMb: cg ? Math.round(cg.usageMb()) : undefined
        })
      }
      await sleep(SAMPLE_EVERY_MS)
    }
  })()

  const note = (where, e) => {
    result.errors.push({
      t: Date.now() - t0,
      where,
      message: String(e?.message ?? e).slice(0, 300)
    })
  }

  try {
    await browser.launch()
    browser.child.once('exit', (code, signal) => (exitInfo = { t: Date.now() - t0, code, signal }))
    mark('launched')
    await sleep(3_000)

    // 1. open every tab in the background
    const tabs = []
    for (const url of sites) {
      if (exitInfo) break
      try {
        tabs.push(await browser.openTab(url))
      } catch (e) {
        note('open', e)
        tabs.push(null)
      }
      await sleep(OPEN_GAP_MS)
    }
    mark('opened')
    await sleep(SETTLE_MS)
    mark('settled')

    // 2. cycle the active tabs
    const activeMs = Math.max(MIN_ACTIVE_MS, preset.active * DWELL_MS * CYCLES)
    const activeEnd = Date.now() + activeMs
    let k = 0
    while (Date.now() < activeEnd && !exitInfo) {
      const tab = tabs[activeIdx[k % activeIdx.length]]
      k++
      const dwellEnd = Date.now() + DWELL_MS
      if (tab) {
        try {
          await browser.activate(tab)
          for (let i = 0; i < SCROLLS_PER_DWELL && Date.now() < dwellEnd; i++) {
            await sleep(DWELL_MS / (SCROLLS_PER_DWELL + 1))
            await browser.scroll(tab, i === SCROLLS_PER_DWELL - 1 ? -800 : 400)
          }
        } catch (e) {
          note('active', e)
        }
      }
      const rest = dwellEnd - Date.now()
      if (rest > 0) await sleep(rest)
    }
    mark('active')
    if (browser.rootPid) result.breakdown = breakdown([browser.rootPid])
    if (args['inspect-main'] && browser.mainMemory)
      result.mainMemory = await browser
        .mainMemory(Number(args['inspect-main']), args['heap-snapshot'])
        .catch((e) => String(e.message))
    result.activeSwitches = k

    // 3. restore latency of background tabs
    for (const i of restoreIdx) {
      if (exitInfo) break
      const tab = tabs[i]
      if (!tab) continue
      const since = Date.now()
      try {
        await browser.activate(tab)
        const r = await browser.waitPainted(tab, since, RESTORE_TIMEOUT_MS)
        result.restores.push({ url: tab.url, ms: Date.now() - since, reloaded: r.reloaded })
      } catch (e) {
        result.restores.push({ url: tab.url, ms: null, failed: String(e.message).slice(0, 200) })
      }
      await sleep(2_000)
    }
    mark('restored')
  } catch (e) {
    note('run', e)
  } finally {
    sampling = false
    clearInterval(presence)
    await sampler
    result.browserExited = exitInfo
    if (cg) {
      result.oomKills = cg.oomKills()
      result.cgroupMaxMb = Math.round(cg.maxUsageMb())
    }
    await browser.close().catch((e) => note('close', e))
    cg?.remove()
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }

  // summary
  const s = result.samples
  const activeStart = result.phases.settled ?? 0
  const activeEndT = result.phases.active ?? s.at(-1)?.t ?? 0
  const steady = s.filter(
    (x) => x.t >= activeEndT - STEADY_WINDOW_MS && x.t <= activeEndT && x.t >= activeStart
  )
  const ok = result.restores.filter((r) => r.ms !== null)
  result.summary = {
    peakPssMb: Math.max(0, ...s.map((x) => x.pssMb)),
    peakRssMb: Math.max(0, ...s.map((x) => x.rssMb)),
    steadyPssMb: median(steady.map((x) => x.pssMb)),
    steadyRssMb: median(steady.map((x) => x.rssMb)),
    steadyProcs: median(steady.map((x) => x.procs)),
    restoreMedianMs: median(ok.map((r) => r.ms)),
    restoreReloaded: ok.filter((r) => r.reloaded).length,
    restoreFailed: result.restores.length - ok.length,
    errors: result.errors.length,
    oomKills: result.oomKills ?? 0,
    crashed: Boolean(result.browserExited)
  }
  const file = join(outDir, `${label}-${preset.tabs}${capMb ? `-cap${capMb}` : ''}-${t0}.json`)
  writeFileSync(file, JSON.stringify(result, null, 1))
  if (args.log) writeFileSync(file.replace(/\.json$/, '.log'), logLines.join(''))
  console.log(JSON.stringify({ file, ...result.summary }))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
