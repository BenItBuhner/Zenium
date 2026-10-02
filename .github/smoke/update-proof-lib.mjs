// Pure helpers of the in-app update proof (update-proof.mjs): what can be judged without a
// display or a process. Unit-tested by update-proof-lib.test.mjs.
//
// The proof installs an OLDER published build like a user, drives Settings › Updates through
// check → download → install over the renderer's own command bridge, and then has to say which
// version the process that came back is running. The surest reading of that is the binary's
// own package.json inside `resources/app.asar` next to the executable (`binaryVersion`): the
// relaunched process may run without the harness's profile (the NSIS installer's --force-run
// starts the app with no arguments) and cannot be attached to, so the executable path of the
// new process is what there is to read.

import path from 'node:path'

// ---------------------------------------------------------------------------------------------
// asar
// ---------------------------------------------------------------------------------------------

/**
 * The header of an asar archive from its first bytes: `{ header, filesStart }`. The format is
 * two Chromium pickles – a UInt32 (4) and the header pickle's size at offset 4, then the header
 * pickle: its payload size at 8, the JSON string's length at 12 and the JSON from 16. File
 * contents follow at `8 + headerPickleSize` plus each entry's `offset`.
 */
export function parseAsarHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) throw new Error('asar: file too short')
  const headerPickleSize = buffer.readUInt32LE(4)
  const jsonLength = buffer.readUInt32LE(12)
  if (16 + jsonLength > buffer.length) throw new Error('asar: header truncated')
  const header = JSON.parse(buffer.toString('utf8', 16, 16 + jsonLength))
  return { header, filesStart: 8 + headerPickleSize }
}

/** One entry's `{ size, offset }` by its slash-separated path in the asar header; null when absent. */
export function asarEntry(header, filePath) {
  let node = header
  for (const part of filePath.split('/')) {
    if (!node || !node.files || !(part in node.files)) return null
    node = node.files[part]
  }
  if (!node || typeof node.size !== 'number' || node.offset === undefined) return null
  return { size: node.size, offset: Number(node.offset), unpacked: node.unpacked === true }
}

/**
 * The bytes of `filePath` inside the archive at `archivePath`, through `io` (`node:fs`'s
 * openSync / readSync / closeSync / fstatSync). Null when the archive has no such entry.
 */
export function readAsarFile(archivePath, filePath, io) {
  const fd = io.openSync(archivePath, 'r')
  try {
    const head = Buffer.alloc(16)
    io.readSync(fd, head, 0, 16, 0)
    const jsonLength = head.readUInt32LE(12)
    const headerBytes = Buffer.alloc(16 + jsonLength)
    io.readSync(fd, headerBytes, 0, headerBytes.length, 0)
    const { header, filesStart } = parseAsarHeader(headerBytes)
    const entry = asarEntry(header, filePath)
    if (!entry || entry.unpacked) return null
    const out = Buffer.alloc(entry.size)
    io.readSync(fd, out, 0, entry.size, filesStart + entry.offset)
    return out
  } finally {
    io.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------------------------
// The version a binary carries
// ---------------------------------------------------------------------------------------------

/** Where electron-builder puts `app.asar` relative to the executable, per platform. */
export function asarPathFor(exe, platform) {
  const dir = path.dirname(exe)
  if (platform === 'darwin') return path.join(dir, '..', 'Resources', 'app.asar')
  return path.join(dir, 'resources', 'app.asar')
}

/** The bundle's Info.plist relative to a macOS executable (`Zenium.app/Contents/MacOS/Zenium`). */
export function infoPlistPathFor(exe) {
  return path.join(path.dirname(exe), '..', 'Info.plist')
}

/** `CFBundleShortVersionString` out of an Info.plist's XML text; null when absent. */
export function plistShortVersion(xml) {
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
    String(xml ?? '')
  )
  return match ? match[1].trim() : null
}

/**
 * The version the executable at `exe` would report as `app.getVersion()`: its package.json
 * inside `resources/app.asar` (every platform), else – macOS – the bundle's Info.plist. `io`
 * is `node:fs` (or a stand-in). Returns `{ version, source }` or `{ version: null, error }`.
 */
export function binaryVersion(exe, platform, io) {
  const asar = asarPathFor(exe, platform)
  const tried = []
  try {
    const bytes = readAsarFile(asar, 'package.json', io)
    if (bytes) {
      const pkg = JSON.parse(bytes.toString('utf8'))
      if (typeof pkg.version === 'string') return { version: pkg.version, source: asar }
      tried.push(`${asar}: package.json has no version`)
    } else tried.push(`${asar}: no package.json entry`)
  } catch (e) {
    tried.push(`${asar}: ${e && e.message ? e.message : String(e)}`)
  }
  if (platform === 'darwin') {
    const plist = infoPlistPathFor(exe)
    try {
      const version = plistShortVersion(io.readFileSync(plist, 'utf8'))
      if (version) return { version, source: plist }
      tried.push(`${plist}: no CFBundleShortVersionString`)
    } catch (e) {
      tried.push(`${plist}: ${e && e.message ? e.message : String(e)}`)
    }
  }
  return { version: null, error: tried.join('; ') }
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

/**
 * Whether a process record `{ pid, exe, cmdline }` is a browser (main) process of the app: the
 * executable's base name is the app's (`zenium`, `zenium.exe`, `Zenium`), and the command line
 * carries no `--type=` (Chromium's helpers: renderer, gpu, utility). `appNames` are the base
 * names to accept, case-insensitively.
 */
export function isAppMainProcess(proc, appNames = ['zenium', 'zenium.exe']) {
  if (!proc || typeof proc.exe !== 'string' || !proc.exe) return false
  // Windows paths are judged on every platform (the tests run on Linux).
  const base = proc.exe.split(/[\\/]/).pop().toLowerCase()
  if (!appNames.some((n) => n.toLowerCase() === base)) return false
  const cmdline = Array.isArray(proc.cmdline) ? proc.cmdline.join(' ') : String(proc.cmdline ?? '')
  return !/(^|\s)--type=/.test(cmdline)
}

/**
 * The main processes of the app in `procs` that are new since `knownPids` (the pids seen
 * before the install was asked for, the driven process included).
 */
export function newAppProcesses(procs, knownPids, appNames) {
  const known = new Set(knownPids)
  return procs.filter((p) => isAppMainProcess(p, appNames) && !known.has(p.pid))
}

/**
 * Parse `ps -axo pid=,ppid=,comm=` output (macOS; `comm` is the executable's full path there)
 * into `{ pid, ppid, exe }` records.
 */
export function parsePsComm(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), exe: m[3] })
  }
  return out
}

/** Parse `ps -axo pid=,args=` output into a pid → command line map. */
export function parsePsArgs(text) {
  const out = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m) out.set(Number(m[1]), m[2])
  }
  return out
}

/**
 * Normalise `Get-CimInstance Win32_Process | ConvertTo-Json` output (one object or an array)
 * into `{ pid, ppid, exe, cmdline }` records.
 */
export function parseWin32Processes(json) {
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  return list
    .filter((p) => p && typeof p.ProcessId === 'number')
    .map((p) => ({
      pid: p.ProcessId,
      ppid: typeof p.ParentProcessId === 'number' ? p.ParentProcessId : null,
      exe: typeof p.ExecutablePath === 'string' ? p.ExecutablePath : '',
      cmdline: typeof p.CommandLine === 'string' ? p.CommandLine : ''
    }))
}

// ---------------------------------------------------------------------------------------------
// Toasts and the verdict
// ---------------------------------------------------------------------------------------------

/** The text of the first error toast of the update flow in `toasts` (`{ message, kind }`), or null. */
export function updateErrorToast(toasts) {
  for (const t of toasts ?? []) {
    if (!t || typeof t.message !== 'string') continue
    if (
      /^(Could not install the update|Update failed|Could not check for updates):/.test(t.message)
    )
      return t.message
  }
  return null
}

/**
 * The verdict of one driven update, from the facts the drive recorded:
 *   expected      the version the new build has
 *   oldVersion    what the driven process reported at launch
 *   check         `{ phase, error, mode, assetName }` after the check settled
 *   download      `{ phase, error }` after the download settled (absent when never reached)
 *   install       `{ exited, exitCode, errorToast, stillRunning }` after Restart/Install
 *   relaunched    `{ found, version, exe }` of the process that came back
 *   verified      `{ version }` the installed binary reported when launched again (optional)
 * Returns `{ ok, stage, reason }` – `stage` names the first step that did not pass.
 */
/**
 * Where Electron keeps the app's profile when no `--user-data-dir` is given (`app.setName('Zenium')`):
 * %APPDATA%\Zenium, ~/Library/Application Support/Zenium, $XDG_CONFIG_HOME/Zenium (~/.config).
 */
export function defaultUserDataDir(env, platform = process.platform, home = env.HOME ?? '') {
  if (platform === 'win32')
    return `${env.APPDATA ?? `${env.USERPROFILE ?? ''}\\AppData\\Roaming`}\\Zenium`
  if (platform === 'darwin') return `${home}/Library/Application Support/Zenium`
  return `${env.XDG_CONFIG_HOME || `${home}/.config`}/Zenium`
}

/** A new process seen this close to the old one's exit is the relaunch, not a second instance. */
export const BESIDE_GRACE_MS = 3000
/** How long the drive takes to answer the quit question – a person reading it (ms). */
export const QUIT_ANSWER_DELAY_MS = 5000

export function judge(facts) {
  const { expected, oldVersion, check, download, install, relaunched, verified } = facts
  if (!check) return { ok: false, stage: 'check', reason: 'the check never settled' }
  if (check.phase === 'error')
    return { ok: false, stage: 'check', reason: `check failed: ${check.error ?? 'unknown error'}` }
  if (check.phase === 'up-to-date')
    return {
      ok: false,
      stage: 'check',
      reason: `no update offered: ${oldVersion} reads as up to date (expected ${expected})`
    }
  if (check.phase !== 'available')
    return { ok: false, stage: 'check', reason: `check ended in phase ${check.phase}` }
  if (check.mode === 'manual')
    return {
      ok: false,
      stage: 'check',
      reason: `the build reports mode "manual" (install kind ${check.kind ?? '?'}): Settings sends the user to the release page`
    }
  if (!check.assetName)
    return {
      ok: false,
      stage: 'check',
      reason: 'the release lists no package for this installation'
    }
  if (!download) return { ok: false, stage: 'download', reason: 'the download never settled' }
  if (download.phase !== 'ready')
    return {
      ok: false,
      stage: 'download',
      reason: `download ended in phase ${download.phase}: ${download.error ?? 'no error text'}`
    }
  if (!install) return { ok: false, stage: 'install', reason: 'install was never asked for' }
  if (install.errorToast) return { ok: false, stage: 'install', reason: install.errorToast }
  // The quit question over the open tabs is the user's to answer (the drive answers it the way
  // a user would); what the question must not do is hold the old app while the new version is
  // already running beside it – a second instance that came up before the old one went.
  const beside = install.besideOld
  const prompt = install.windowPrompt
  const promptText = prompt
    ? `a "${prompt.kind}" question (${prompt.count} tabs) stood in the window${prompt.answered ? ' (answered)' : ''}`
    : null
  if (!install.exited) {
    const why = []
    if (promptText) why.push(promptText)
    if (beside)
      why.push(
        `a second instance (${beside.version ?? 'unknown version'}, pid ${beside.pid}) started beside it`
      )
    return {
      ok: false,
      stage: 'install',
      reason: `the app did not quit after Restart to update / Install${why.length ? `: ${why.join('; ')}` : ''}`
    }
  }
  if (beside && (install.exit?.at ?? 0) - (beside.at ?? 0) > BESIDE_GRACE_MS)
    return {
      ok: false,
      stage: 'install',
      reason: `a second instance (${beside.version ?? 'unknown version'}, pid ${beside.pid}) started ${Math.round(((install.exit?.at ?? 0) - (beside.at ?? 0)) / 1000)}s before the old app quit${promptText ? `; ${promptText}` : ''} – with one profile it would have died on the single-instance lock`
    }
  if (!relaunched || !relaunched.found)
    return {
      ok: false,
      stage: 'relaunch',
      reason: beside?.gone
        ? `no new app process appeared after the install: the instance (${beside.version ?? 'unknown version'}, pid ${beside.pid}) that started beside the old app while the quit question stood did not outlive it – one profile, one single-instance lock`
        : 'no new app process appeared after the install'
    }
  if (relaunched.version !== expected)
    return {
      ok: false,
      stage: 'relaunch',
      reason: `the relaunched process runs ${relaunched.version ?? 'an unreadable version'} from ${relaunched.exe}; expected ${expected}`
    }
  if (verified && verified.version !== expected)
    return {
      ok: false,
      stage: 'verify',
      reason: `the installed build reports ${verified.version}; expected ${expected}`
    }
  return { ok: true, stage: 'done', reason: `${oldVersion} → ${expected}` }
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

/**
 * `--key value` / `--key=value` / `--flag` into an object; positionals under `_`. A key given
 * more than once collects its values in an array (`--env A=1 --env B=2`).
 */
export function parseArgs(argv) {
  const out = { _: [] }
  const put = (key, value) => {
    if (!(key in out)) out[key] = value
    else if (Array.isArray(out[key])) out[key].push(value)
    else out[key] = [out[key], value]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq !== -1) {
      put(a.slice(2, eq), a.slice(eq + 1))
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      put(key, next)
      i++
    } else put(key, true)
  }
  return out
}

/** Strip a leading `v` from a tag or version. */
export function bareVersion(text) {
  return String(text ?? '')
    .trim()
    .replace(/^v/, '')
}

/** Byte ranges for a static server: `bytes=a-b` / `bytes=a-` / `bytes=-n` against `size`. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim())
  if (!m) return null
  let start
  let end
  if (m[1] === '' && m[2] === '') return null
  if (m[1] === '') {
    const suffix = Number(m[2])
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start > end || start >= size) return { unsatisfiable: true }
  return { start, end }
}
