// In-app update proof: an OLDER packaged build, installed like a user, is driven through
// Settings › Updates – check, download, Restart to update / Install – over the renderer's own
// command bridge (`window.zen.invoke('updates.check' | 'updates.download' | 'updates.install')`,
// the same calls the Settings page's buttons make), and the process that comes back afterwards
// must be the NEWER version. Playwright for Electron attaches to the old build the way
// .github/smoke/smoke.mjs does; nothing in the app is told it is being tested, and no test hook
// is needed in the build under test – which is what lets this run against builds published
// months ago. Used by .github/workflows/desktop-update-proof.yml.
//
//   node update-proof.mjs drive --exe <executable> --out <dir> --label <name> --expect <version>
//        [--extra-args "--no-sandbox --disable-gpu"] [--env KEY=VALUE]... [--app-names a,b]
//        [--verify-exe <path>] [--install-timeout <s>] [--relaunch-timeout <s>] [--keep-relaunched]
//        [--quit-answer-delay <s>] [--profile-dir <dir>]
//      Writes <out>/<label>/result.json (the facts and the verdict), drive.log, app-stdio.log,
//      toasts.json and OS screenshots at each stage. Exit 0 when the relaunched process runs
//      <version>; 1 otherwise, with the exact refusal text (the toast's, the state's error) in
//      result.json and the log.
//   node update-proof.mjs version --exe <executable>
//      Prints the version the executable carries (its resources/app.asar package.json).
//   node update-proof.mjs processes
//      Lists the app's main processes the way `drive` sees them (debugging the runner).
//   node update-proof.mjs serve --dir <dir> --port <n> [--detach --pid-file <file> --log <file>]
//      A static HTTP server with byte ranges over <dir>, for a build-to-build proof that points
//      the app at a local release folder through ZEN_UPDATE_BASE_URL (main process only).
//
// Linux .deb: dpkg runs through pkexec on a desktop, which has no authentication agent on a
// headless runner – the workflow runs the deb leg as root (electron-updater then runs dpkg
// directly), and says so. The AppImage leg runs as the runner's user with APPIMAGE_EXTRACT_AND_RUN=1
// (no FUSE on GitHub's runners).

import { _electron as electron } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  QUIT_ANSWER_DELAY_MS,
  bareVersion,
  binaryVersion,
  defaultUserDataDir,
  isAppMainProcess,
  judge,
  newAppProcesses,
  parseArgs,
  parsePsArgs,
  parsePsComm,
  parseRange,
  parseWin32Processes,
  updateErrorToast
} from './update-proof-lib.mjs'
import { isWindowChromeUrl } from './views.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const IS_LINUX = process.platform === 'linux'
const DEFAULT_APP_NAMES = ['zenium', 'zenium.exe', 'Zenium']

const argv = parseArgs(process.argv.slice(2))
const command = argv._[0]

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout(promise, ms, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------------------------
// Processes, screenshots
// ---------------------------------------------------------------------------------------------

function sh(cmd, args, timeout = 30000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 })
}

/** Every process as `{ pid, ppid, exe, cmdline }`, as far as the OS lets this user read them. */
function listProcesses() {
  if (IS_LINUX) {
    const out = []
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const pid = Number(name)
      let exe = ''
      let cmdline = ''
      try {
        exe = fs.readlinkSync(`/proc/${pid}/exe`)
      } catch {
        continue
      }
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      } catch {
        cmdline = []
      }
      let ppid = null
      try {
        const m = /^PPid:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))
        if (m) ppid = Number(m[1])
      } catch {
        /* gone */
      }
      out.push({ pid, ppid, exe: exe.replace(/ \(deleted\)$/, ''), cmdline })
    }
    return out
  }
  if (IS_MAC) {
    const comm = sh('ps', ['-axo', 'pid=,ppid=,comm='])
    const args = parsePsArgs(sh('ps', ['-axo', 'pid=,args=']).stdout)
    return parsePsComm(comm.stdout).map((p) => ({ ...p, cmdline: args.get(p.pid) ?? '' }))
  }
  if (IS_WIN) {
    const res = sh(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress -Depth 2'
      ],
      60000
    )
    return parseWin32Processes(res.stdout)
  }
  return []
}

/** The environment of a Linux process (own, or any as root): a name → value map; null elsewhere. */
function processEnviron(pid) {
  if (!IS_LINUX) return null
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
    const env = {}
    for (const entry of raw.split('\0')) {
      const i = entry.indexOf('=')
      if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1)
    }
    return env
  } catch {
    return null
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

async function terminate(pid, log) {
  if (!alive(pid)) return 'already gone'
  if (IS_WIN) {
    const res = sh('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 30000)
    log(
      `taskkill ${pid}: exit ${res.status} ${String(res.stdout).trim()} ${String(res.stderr).trim()}`
    )
    return `taskkill exit ${res.status}`
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (e) {
    return `SIGTERM failed: ${e.message}`
  }
  for (let i = 0; i < 100 && alive(pid); i++) await delay(100)
  if (!alive(pid)) return 'SIGTERM'
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* raced */
  }
  for (let i = 0; i < 50 && alive(pid); i++) await delay(100)
  return alive(pid) ? 'still alive after SIGKILL' : 'SIGKILL'
}

function linuxDisplaySize() {
  const res = sh('xdpyinfo', [], 10000)
  const m = /dimensions:\s+(\d+)x(\d+)/.exec(String(res.stdout ?? ''))
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1600, height: 1000 }
}

function osScreenshot(file) {
  try {
    if (IS_LINUX) {
      const { width, height } = linuxDisplaySize()
      // prettier-ignore
      return sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', `${width}x${height}`, '-i', process.env.DISPLAY || ':0', '-frames:v', '1', file], 30000)
    }
    if (IS_WIN)
      return sh(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(HERE, 'win-screenshot.ps1'),
          '-Path',
          file
        ],
        45000
      )
    if (IS_MAC) return sh('screencapture', ['-x', file], 45000)
  } catch (e) {
    return { status: 1, stderr: String(e) }
  }
  return { status: 1, stderr: 'unsupported platform' }
}

// ---------------------------------------------------------------------------------------------
// drive
// ---------------------------------------------------------------------------------------------

async function drive() {
  const exe = argv.exe
  const expected = bareVersion(argv.expect)
  if (!exe || !argv.out || !argv.label || !expected) {
    console.error(
      'usage: update-proof.mjs drive --exe <exe> --out <dir> --label <name> --expect <version>'
    )
    process.exit(2)
  }
  const outDir = path.resolve(argv.out, argv.label)
  fs.mkdirSync(outDir, { recursive: true })
  const logFile = path.join(outDir, 'drive.log')
  const stdioFile = path.join(outDir, 'app-stdio.log')
  fs.writeFileSync(logFile, '')
  fs.writeFileSync(stdioFile, '')
  const t0 = Date.now()
  const log = (msg) => {
    const line = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`
    console.log(line)
    fs.appendFileSync(logFile, `${line}\n`)
  }
  const shot = (name) => {
    const file = path.join(outDir, `${name}.png`)
    const res = osScreenshot(file)
    if (res.status !== 0) log(`screenshot ${name}: failed (${String(res.stderr ?? '').trim()})`)
    else log(`screenshot ${name}: ${file}`)
  }
  const appNames =
    typeof argv['app-names'] === 'string' ? argv['app-names'].split(',') : DEFAULT_APP_NAMES
  const extraArgs =
    typeof argv['extra-args'] === 'string' ? argv['extra-args'].split(' ').filter(Boolean) : []
  const envPairs = Array.isArray(argv.env) ? argv.env : argv.env ? [argv.env] : []
  const extraEnv = {}
  for (const pair of envPairs) {
    const i = String(pair).indexOf('=')
    if (i > 0) extraEnv[String(pair).slice(0, i)] = String(pair).slice(i + 1)
  }
  const installTimeoutMs = Number(argv['install-timeout'] ?? 180) * 1000
  const relaunchTimeoutMs = Number(argv['relaunch-timeout'] ?? 300) * 1000
  const downloadTimeoutMs = Number(argv['download-timeout'] ?? 900) * 1000
  // How long a person takes to read "Quit Zenium?" and press Quit. Long enough for the new
  // version to have started beside the old one where the install spawns it at once.
  const quitAnswerDelayMs = Number(argv['quit-answer-delay'] ?? QUIT_ANSWER_DELAY_MS / 1000) * 1000

  // A fresh profile past onboarding, with automatic checks off so the drive is the only actor.
  // It lives where the app keeps its profile by default (Linux: under an XDG_CONFIG_HOME of
  // the drive's own), not behind `--user-data-dir`: the process that comes back after the
  // install is started by the installer, the helper or the app itself, and must find the same
  // profile a user's would – a second instance over one profile dies on the single-instance
  // lock, which is part of what is being proved. `--profile-dir <dir>` opts out for a local run.
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), `zenium-update-proof-${argv.label}-`))
  const isolationEnv = IS_LINUX
    ? {
        XDG_CONFIG_HOME: path.join(profileRoot, 'xdg-config'),
        XDG_CACHE_HOME: path.join(profileRoot, 'xdg-cache'),
        XDG_DATA_HOME: path.join(profileRoot, 'xdg-data')
      }
    : {}
  for (const dir of Object.values(isolationEnv)) fs.mkdirSync(dir, { recursive: true })
  const explicitProfile = typeof argv['profile-dir'] === 'string' ? argv['profile-dir'] : null
  const profile = explicitProfile ?? defaultUserDataDir({ ...process.env, ...isolationEnv })
  if (!explicitProfile) fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(path.join(profile, 'zen'), { recursive: true })
  fs.writeFileSync(
    path.join(profile, 'zen', 'state.json'),
    JSON.stringify({
      version: 2,
      settings: {
        onboardingDone: true,
        updates: { autoCheck: false, autoDownload: false, channel: 'stable' },
        shortcutPreset: 'chrome'
      }
    })
  )
  const facts = {
    platform: process.platform,
    arch: process.arch,
    label: argv.label,
    exe,
    expected,
    profile,
    env: Object.keys(extraEnv),
    startedAt: new Date().toISOString()
  }
  const result = { facts, timeline: [], toasts: [] }
  const mark = (stage, data = {}) => {
    result.timeline.push({ at: Date.now() - t0, stage, ...data })
    log(`${stage} ${JSON.stringify(data)}`)
  }
  const finish = (verdict) => {
    result.verdict = verdict
    fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    fs.writeFileSync(
      path.join(outDir, 'toasts.json'),
      `${JSON.stringify(result.toasts, null, 2)}\n`
    )
    log(`VERDICT ${verdict.ok ? 'PASS' : 'FAIL'} at ${verdict.stage}: ${verdict.reason}`)
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `| ${argv.label} | ${facts.oldVersion ?? '?'} → ${expected} | ${verdict.ok ? 'pass' : 'FAIL'} | ${verdict.stage} | ${verdict.reason.replace(/\|/g, '\\|')} |\n`
      )
    }
    process.exitCode = verdict.ok ? 0 : 1
  }

  const launchArgs = explicitProfile ? [...extraArgs, `--user-data-dir=${profile}`] : [...extraArgs]
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ...isolationEnv, ...extraEnv }
  log(`launching ${exe} ${launchArgs.join(' ')}`)
  let app
  try {
    app = await electron.launch({
      executablePath: exe,
      args: launchArgs,
      env,
      chromiumSandbox: true,
      colorScheme: null,
      timeout: 120000
    })
  } catch (e) {
    mark('launch-failed', { error: String(e && e.message ? e.message : e) })
    return finish({
      ok: false,
      stage: 'launch',
      reason: `the old build did not start: ${e.message}`
    })
  }
  const proc = app.process()
  const onData = (d) => fs.appendFileSync(stdioFile, d.toString())
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  let exit = null
  const exitPromise = new Promise((resolve) => {
    proc.on('exit', (code, signal) => {
      exit = { code, signal, at: Date.now() - t0 }
      resolve(exit)
    })
  })
  const evaluate = (fn, arg) => withTimeout(app.evaluate(fn, arg), 60000, 'app.evaluate')

  let info
  try {
    info = await evaluate(({ app }) => ({
      pid: process.pid,
      version: app.getVersion(),
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      appimage: process.env.APPIMAGE ?? null,
      platform: process.platform,
      arch: process.arch
    }))
  } catch (e) {
    mark('launch-failed', { error: e.message })
    return finish({
      ok: false,
      stage: 'launch',
      reason: `the main process did not answer: ${e.message}`
    })
  }
  facts.oldVersion = info.version
  facts.app = info
  mark('launched', info)

  // The window's chrome page: the renderer that owns the command bridge.
  const deadline = Date.now() + 90000
  let page = null
  while (Date.now() < deadline && !page) {
    page = app.windows().find((p) => isWindowChromeUrl(p.url())) ?? null
    if (!page) await app.waitForEvent('window', { timeout: 2000 }).catch(() => undefined)
  }
  if (!page) {
    mark('no-chrome-page', { pages: app.windows().map((p) => p.url()) })
    return finish({ ok: false, stage: 'launch', reason: 'no chrome page came up' })
  }
  await page.locator('[data-testid="chrome-root"]').waitFor({ state: 'attached', timeout: 90000 })
  await page.evaluate(() => {
    window.__proofToasts = []
    window.zen.on('toast', (p) => window.__proofToasts.push({ at: Date.now(), ...p }))
  })
  const invoke = (name, args, timeoutMs = 60000) =>
    withTimeout(
      page.evaluate(([n, a]) => window.zen.invoke(n, a), [name, args]),
      timeoutMs,
      `invoke ${name}`
    )
  const updateState = async () => (await invoke('app.getState', undefined)).updates
  const readToasts = async () => {
    try {
      const toasts = await withTimeout(
        page.evaluate(() => window.__proofToasts),
        5000,
        'toasts'
      )
      result.toasts = toasts
      return toasts
    } catch {
      return result.toasts
    }
  }

  const initial = await updateState()
  mark('state', {
    phase: initial.phase,
    mode: initial.mode,
    target: initial.target,
    currentVersion: initial.currentVersion
  })
  facts.target = initial.target
  facts.mode = initial.mode
  // Settings › Updates on screen, so the screenshots show what the user sees (best effort: the
  // page command's shape may differ in older builds).
  try {
    await invoke('page.open', { id: 'settings', section: 'updates' }, 15000)
    await delay(1500)
  } catch (e) {
    log(`page.open settings/updates: ${e.message}`)
  }
  shot('01-before-check')

  // 1. Check.
  let check
  try {
    await invoke('updates.check', undefined, 120000)
    const s = await updateState()
    check = {
      phase: s.phase,
      error: s.error,
      mode: s.mode,
      kind: s.target?.kind,
      assetName: s.release?.asset?.name ?? null,
      assetUrl: s.release?.asset?.url ?? null,
      release: s.release?.version ?? null,
      signature: s.signature
    }
  } catch (e) {
    check = { phase: 'harness-error', error: e.message }
  }
  result.check = check
  mark('checked', check)
  await readToasts()
  shot('02-after-check')
  if (check.phase !== 'available' || check.mode === 'manual' || !check.assetName) {
    await gracefulQuit()
    return finish(judge({ expected, oldVersion: info.version, check }))
  }
  if (check.release !== expected)
    log(`note: the check offers ${check.release}; the proof expects ${expected}`)

  // 2. Download.
  let download
  const progressTimer = setInterval(() => {
    updateState()
      .then((s) => {
        if (s.phase === 'downloading' && s.progress)
          log(
            `downloading ${s.progress.percent.toFixed(1)}% (${s.progress.transferred}/${s.progress.total})`
          )
      })
      .catch(() => undefined)
  }, 5000)
  try {
    await invoke('updates.download', undefined, downloadTimeoutMs)
    const s = await updateState()
    download = { phase: s.phase, error: s.error, downloadedPath: s.downloadedPath }
  } catch (e) {
    download = { phase: 'harness-error', error: e.message }
  } finally {
    clearInterval(progressTimer)
  }
  result.download = download
  mark('downloaded', download)
  await readToasts()
  shot('03-after-download')
  if (download.phase !== 'ready') {
    await gracefulQuit()
    return finish(judge({ expected, oldVersion: info.version, check, download }))
  }

  // 3. Install / Restart to update.
  const before = listProcesses()
  const knownPids = before.filter((p) => isAppMainProcess(p, appNames)).map((p) => p.pid)
  knownPids.push(info.pid)
  mark('install-requested', { knownPids })
  const installCall = invoke('updates.install', undefined, installTimeoutMs).then(
    () => 'returned',
    (e) => `rejected: ${e.message}`
  )
  const installDeadline = Date.now() + installTimeoutMs
  let errorToast = null
  let installOutcome = null
  let windowPrompt = null
  let besideOld = null
  let lastProcessScan = 0
  const scanBeside = () => {
    lastProcessScan = Date.now()
    const fresh = newAppProcesses(listProcesses(), knownPids, appNames)
    if (fresh.length > 0 && !besideOld) {
      const p = fresh[0]
      besideOld = {
        pid: p.pid,
        exe: p.exe,
        version: binaryVersion(p.exe, process.platform, fs).version,
        at: Date.now() - t0
      }
      log(`a second app process came up beside the running one: ${JSON.stringify(besideOld)}`)
    }
  }
  while (Date.now() < installDeadline) {
    if (exit) break
    const toasts = await readToasts()
    errorToast = updateErrorToast(toasts)
    if (errorToast) break
    // A window question ("Quit Zenium?" over the open tabs) holding the quit, and any second
    // instance of the app that came up while this one is still running.
    const whole = await invoke('app.getState', undefined, 10000).catch(() => null)
    if (whole?.window?.prompt && !windowPrompt) {
      windowPrompt = { ...whole.window.prompt, at: Date.now() - t0, answered: false }
      log(`window prompt up: ${JSON.stringify(windowPrompt)}`)
      shot('03b-quit-question')
      // A user who asked to restart reads the question and answers "Quit" (the same command the
      // button sends) – after the time that takes, with an eye on what starts meanwhile.
      if (windowPrompt.kind === 'quit') {
        const answerAt = Date.now() + quitAnswerDelayMs
        while (Date.now() < answerAt && !exit) {
          await delay(Math.min(500, answerAt - Date.now()))
          if (Date.now() - lastProcessScan > (IS_WIN ? 2500 : 1000)) scanBeside()
        }
        await invoke('window.respondPrompt', { id: windowPrompt.id, accepted: true }, 10000)
          .then(() => {
            windowPrompt.answered = true
            windowPrompt.answeredAt = Date.now() - t0
            log(`answered the quit question: yes (${Math.round(quitAnswerDelayMs / 1000)} s in)`)
          })
          .catch((e) => log(`could not answer the quit question: ${e.message}`))
      }
    }
    if (Date.now() - lastProcessScan > (IS_WIN ? 5000 : 2000)) scanBeside()
    const outcome = await Promise.race([installCall, delay(1000).then(() => null)])
    if (outcome && !installOutcome) {
      installOutcome = outcome
      log(`updates.install ${outcome}`)
    }
    if (installOutcome && installOutcome.startsWith('rejected')) break
  }
  if (!exit && !errorToast) {
    // The command came back without the app quitting: give the state a moment to say why.
    await delay(3000)
    const s = await updateState().catch(() => null)
    if (s?.phase === 'error' && s.error) errorToast = `Could not install the update: ${s.error}`
  }
  const install = {
    exited: Boolean(exit),
    exit,
    errorToast,
    windowPrompt,
    besideOld,
    commandOutcome: installOutcome,
    stateAfter: exit ? null : await updateState().catch((e) => ({ error: e.message }))
  }
  result.install = install
  mark('install-settled', install)
  if (!exit) {
    shot('04-install-did-not-quit')
    if (besideOld && alive(besideOld.pid)) {
      log(`terminating the second instance ${besideOld.pid}`)
      await terminate(besideOld.pid, log)
    }
    await gracefulQuit()
    return finish(judge({ expected, oldVersion: info.version, check, download, install }))
  }

  // 4. The process that comes back.
  const relaunchDeadline = Date.now() + relaunchTimeoutMs
  let relaunched = { found: false }
  while (Date.now() < relaunchDeadline) {
    if (besideOld && !besideOld.gone && !alive(besideOld.pid)) {
      // The instance that started beside the old app did not outlive it: one profile, one
      // single-instance lock. Noted for the verdict, and the scan goes on for anything else.
      besideOld.gone = true
      besideOld.goneAt = Date.now() - t0
      log(`the second instance ${besideOld.pid} is gone`)
    }
    const fresh = newAppProcesses(listProcesses(), knownPids, appNames)
    if (fresh.length > 0) {
      const p = fresh[0]
      const v = binaryVersion(p.exe, process.platform, fs)
      const environ = processEnviron(p.pid)
      relaunched = {
        found: true,
        pid: p.pid,
        exe: p.exe,
        cmdline: p.cmdline,
        version: v.version,
        versionSource: v.source ?? null,
        versionError: v.error ?? null,
        appimage: environ?.APPIMAGE ?? null,
        afterMs: Date.now() - t0
      }
      break
    }
    await delay(1000)
  }
  result.relaunched = relaunched
  mark('relaunched', relaunched)
  if (relaunched.found) {
    // Still up a while later (not a start-and-crash), then on screen.
    await delay(12000)
    relaunched.aliveAfter12s = alive(relaunched.pid)
    shot('05-after-relaunch')
    if (!argv['keep-relaunched']) {
      relaunched.terminated = await terminate(relaunched.pid, log)
      // The relaunched app's own helpers go with it; any main process it left is the leg's noise.
      for (const p of newAppProcesses(listProcesses(), knownPids, appNames)) {
        log(`extra app process ${p.pid} ${p.exe}: terminating`)
        await terminate(p.pid, log)
      }
    }
  } else {
    shot('05-no-relaunch')
  }

  // 5. The installed build, launched again with the proof's profile: what it reports itself.
  let verified = null
  const verifyExe = resolveVerifyExe(info, relaunched, expected, log)
  if (verifyExe) {
    try {
      verified = await verifyBuild(verifyExe, launchArgs, env, stdioFile, log)
      verified.exe = verifyExe
    } catch (e) {
      verified = { exe: verifyExe, version: null, error: e.message }
    }
    result.verified = verified
    mark('verified', verified)
    shot('06-after-verify')
  } else log('no executable to verify (none found for the new version)')

  return finish(
    judge({
      expected,
      oldVersion: info.version,
      check,
      download,
      install,
      relaunched,
      verified: verified && verified.version ? verified : null
    })
  )

  async function gracefulQuit() {
    if (exit) return
    try {
      await invoke('app.quit', undefined, 10000).catch(() => undefined)
      await withTimeout(exitPromise, 30000, 'quit')
    } catch {
      log('graceful quit timed out; killing')
      await terminate(info.pid, log)
    }
  }
}

/**
 * The executable to launch for the verify step: `--verify-exe` when given, else the AppImage
 * now in the old one's directory (new name or the same), else the relaunched process's own path
 * (the deb's /opt binary, the NSIS install directory, the .app in /Applications).
 */
function resolveVerifyExe(info, relaunched, expected, log) {
  if (typeof argv['verify-exe'] === 'string') return argv['verify-exe']
  if (info.appimage) {
    const dir = path.dirname(info.appimage)
    const candidates = fs
      .readdirSync(dir)
      .filter((n) => /\.AppImage$/i.test(n))
      .map((n) => path.join(dir, n))
    log(`AppImages in ${dir}: ${candidates.map((c) => path.basename(c)).join(', ') || 'none'}`)
    const named = candidates.find((c) => path.basename(c).includes(expected))
    return named ?? candidates[0] ?? null
  }
  if (relaunched.found && relaunched.exe) return relaunched.exe
  return null
}

async function verifyBuild(exe, launchArgs, env, stdioFile, log) {
  log(`verify: launching ${exe}`)
  const app = await electron.launch({
    executablePath: exe,
    args: launchArgs,
    env,
    chromiumSandbox: true,
    colorScheme: null,
    timeout: 120000
  })
  const proc = app.process()
  const onData = (d) => fs.appendFileSync(stdioFile, `[verify] ${d.toString()}`)
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  const exited = new Promise((resolve) =>
    proc.on('exit', (code, signal) => resolve({ code, signal }))
  )
  const pid = await withTimeout(
    app.evaluate(() => process.pid),
    60000,
    'pid'
  )
  const out = await withTimeout(
    app.evaluate(({ app }) => ({ version: app.getVersion(), execPath: process.execPath })),
    60000,
    'version'
  )
  log(`verify: ${exe} reports ${out.version} (pid ${pid})`)
  try {
    let page = null
    const deadline = Date.now() + 60000
    while (Date.now() < deadline && !page) {
      page = app.windows().find((p) => isWindowChromeUrl(p.url())) ?? null
      if (!page) await app.waitForEvent('window', { timeout: 2000 }).catch(() => undefined)
    }
    if (page) {
      await page
        .locator('[data-testid="chrome-root"]')
        .waitFor({ state: 'attached', timeout: 60000 })
      const state = await withTimeout(
        page.evaluate(() => window.zen.invoke('app.getState', undefined).then((s) => s.updates)),
        30000,
        'state'
      )
      out.currentVersion = state.currentVersion
      out.target = state.target
      // One more check from the new build: against the same source it just updated from.
      await withTimeout(
        page.evaluate(() => window.zen.invoke('updates.check', undefined)),
        120000,
        'check'
      ).catch((e) => log(`verify: check ${e.message}`))
      const after = await withTimeout(
        page.evaluate(() => window.zen.invoke('app.getState', undefined).then((s) => s.updates)),
        30000,
        'state'
      )
      out.postCheck = {
        phase: after.phase,
        error: after.error,
        release: after.release?.version ?? null
      }
      log(`verify: post-check ${JSON.stringify(out.postCheck)}`)
      await page.evaluate(() => window.zen.invoke('app.quit', undefined)).catch(() => undefined)
    }
    await withTimeout(exited, 30000, 'verify quit')
  } catch (e) {
    log(`verify: ${e.message}; killing`)
    await terminate(pid, log)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// version, processes
// ---------------------------------------------------------------------------------------------

function versionCommand() {
  if (!argv.exe) {
    console.error('usage: update-proof.mjs version --exe <executable>')
    process.exit(2)
  }
  const v = binaryVersion(argv.exe, process.platform, fs)
  console.log(JSON.stringify({ exe: argv.exe, ...v }))
  if (!v.version) process.exit(1)
}

function processesCommand() {
  const names =
    typeof argv['app-names'] === 'string' ? argv['app-names'].split(',') : DEFAULT_APP_NAMES
  const all = listProcesses()
  const main = all.filter((p) => isAppMainProcess(p, names))
  console.log(JSON.stringify({ total: all.length, main }, null, 2))
}

// ---------------------------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.yml': 'text/yaml',
  '.json': 'application/json',
  '.sig': 'application/json',
  '.txt': 'text/plain'
}

async function serve() {
  const dir = argv.dir ? path.resolve(argv.dir) : null
  const port = Number(argv.port)
  if (!dir || !port) {
    console.error(
      'usage: update-proof.mjs serve --dir <dir> --port <n> [--detach --pid-file <f> --log <f>]'
    )
    process.exit(2)
  }
  const logFile = argv.log ? path.resolve(argv.log) : null
  if (argv.detach) {
    const args = process.argv.slice(1).filter((a) => a !== '--detach')
    const out = logFile ? fs.openSync(logFile, 'a') : 'ignore'
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] })
    child.unref()
    if (argv['pid-file']) fs.writeFileSync(argv['pid-file'], String(child.pid))
    for (let i = 0; i < 100; i++) {
      await delay(200)
      const ok = await new Promise((resolve) => {
        http
          .get(`http://127.0.0.1:${port}/__proof/health`, (res) => {
            res.resume()
            resolve(res.statusCode === 200)
          })
          .on('error', () => resolve(false))
      })
      if (ok) {
        console.log(`serving ${dir} at http://127.0.0.1:${port} (pid ${child.pid})`)
        return
      }
    }
    console.error('the server did not answer within 20 s')
    process.exit(1)
  }
  const logLine = (line) => {
    const text = `${new Date().toISOString()} ${line}\n`
    if (logFile) fs.appendFileSync(logFile, text)
    else process.stdout.write(text)
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/__proof/health') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const file = path.resolve(dir, rel)
    if (!file.startsWith(dir + path.sep) || rel.split(/[\\/]/).includes('..')) {
      res.writeHead(403).end()
      logLine(`${req.method} ${req.url} 403`)
      return
    }
    let stat
    try {
      stat = fs.statSync(file)
      if (!stat.isFile()) throw new Error('not a file')
    } catch {
      res.writeHead(404).end()
      logLine(`${req.method} ${req.url} 404`)
      return
    }
    const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream'
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
    const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null
    if (range && range.unsatisfiable) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` }).end()
      logLine(`${req.method} ${req.url} 416 ${req.headers.range}`)
      return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : stat.size - 1
    headers['content-length'] = String(end - start + 1)
    if (range) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`
    res.writeHead(range ? 206 : 200, headers)
    logLine(`${req.method} ${req.url} ${range ? 206 : 200} ${start}-${end}/${stat.size}`)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(file, { start, end }).pipe(res)
  })
  server.listen(port, '127.0.0.1', () => logLine(`listening on 127.0.0.1:${port}, serving ${dir}`))
}

switch (command) {
  case 'drive':
    await drive()
    break
  case 'version':
    versionCommand()
    break
  case 'processes':
    processesCommand()
    break
  case 'serve':
    await serve()
    break
  default:
    console.error('usage: update-proof.mjs <drive|version|processes|serve> ...')
    process.exit(2)
}
