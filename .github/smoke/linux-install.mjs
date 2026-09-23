// Facts and assertions about the Linux installers on a runner, the counterpart of win-install.ps1
// and mac-facts.sh: what the AppImage carries, what the .deb put on the system, and that `dpkg -r`
// took it all away again. Every action writes a JSON file under --out for the artifact and exits 1
// when an assertion failed (the file is written first, so the workflow can still read it).
//
//   node linux-install.mjs appimage --file <Zenium.AppImage> --out <dir> [--label appimage]
//       The image is executable, `--appimage-version` answers, and `--appimage-extract` (timed,
//       into a temporary directory removed afterwards) yields AppRun, the zenium executable, the
//       embedded zenium.desktop (Exec=AppRun, the x-scheme-handler MIME types, the two desktop
//       actions) and the .DirIcon, a 512x512 PNG. Writes <out>/<label>-facts.json.
//       To boot the image the workflow sets APPIMAGE_EXTRACT_AND_RUN=1 rather than passing
//       --appimage-extract-and-run: the type-2 runtime reads only the first argument, and
//       Playwright puts --inspect=0 and --remote-debugging-port=0 in front of everything.
//   node linux-install.mjs deb-installed --out <dir> [--label deb] [--desktop-id zenium.desktop]
//                                        [--dpkg-exit <n>] [--dpkg-log <file>]
//       After `sudo dpkg -i` (and, where the runner image lacked one of the package's Depends,
//       `sudo apt-get install -f`, which completes the configuration from the declared Depends
//       alone: ubuntu-latest carries neither libnotify4 nor libsecret-1-0): the package is
//       installed, every file dpkg lists exists,
//       /opt/Zenium/zenium is executable, /usr/bin/zenium resolves to it (update-alternatives),
//       the desktop entry is the LINUX_DESKTOP_ID of src/main/platform/defaultBrowser.ts with
//       Exec, MimeType (x-scheme-handler/http and https), Actions and Icon in order, the hicolor
//       icon is a 512x512 PNG and mimeinfo.cache names the entry for both schemes. Writes
//       <out>/<label>-install.json; its `exe` is the path the smoke has to boot, written whether
//       or not the install went well (the harness turns a missing executable into an "install"
//       failure). --dpkg-exit and --dpkg-log record how the install went: the exit status of
//       `dpkg -i`, the Depends it found unmet and the packages `apt-get install -f` pulled in
//       (facts, not failures: a missing library on the runner image is not the package's doing).
//   node linux-install.mjs deb-removed --out <dir> [--label deb] [--timeout-ms 30000]
//       After `sudo dpkg -r zenium`: polls until every path the install put down is gone (the
//       binary directory, the desktop entry, the icon, both /usr/bin links, the alternatives
//       link, the AppArmor profile), then checks dpkg no longer has the package installed and
//       mimeinfo.cache no longer names the entry. Writes <out>/<label>-uninstall.json.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The package name, the executable and the install prefix electron-builder.yml's deb produces. */
export const PACKAGE = 'zenium'
export const INSTALL_DIR = '/opt/Zenium'
export const INSTALLED_EXE = `${INSTALL_DIR}/zenium`
export const APPLICATIONS_DIR = '/usr/share/applications'
export const ICON_PATH = '/usr/share/icons/hicolor/512x512/apps/zenium.png'
export const APPARMOR_PROFILE = '/etc/apparmor.d/zenium'
/** Everything the deb's files, its postinst (build/linux/after-install.sh) and dpkg leave behind. */
export const REMOVED_PATHS = [
  INSTALL_DIR,
  `${APPLICATIONS_DIR}/zenium.desktop`,
  ICON_PATH,
  '/usr/bin/zenium',
  '/etc/alternatives/zenium',
  '/usr/bin/zen-chromium',
  APPARMOR_PROFILE
]
export const SCHEME_HANDLERS = ['x-scheme-handler/http', 'x-scheme-handler/https']
export const DESKTOP_ACTIONS = ['new-window', 'new-private-window']

/** `--key value` and bare `--flag` pairs after the action word, like verdict.mjs reads them. */
export function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      opts[a.slice(2)] = next
      i++
    } else opts[a.slice(2)] = true
  }
  return opts
}

/**
 * The groups of a desktop entry: `{ 'Desktop Entry': { Name: 'Zenium', … }, 'Desktop Action
 * new-window': { … } }`. Comments and blank lines are skipped; a key before any group header
 * lands in the '' group; a repeated key keeps its last value like glib does.
 */
export function parseDesktopEntry(text) {
  const groups = {}
  let current = ''
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      current = header[1]
      groups[current] ??= {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    groups[current] ??= {}
    groups[current][line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return groups
}

/** The items of a `;`-separated desktop entry list (`a;b;` → ['a', 'b']). */
export function splitList(value) {
  return String(value ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * What is wrong with a Zenium desktop entry (`problems`, each a failed assertion) and what is
 * merely untidy (`warnings`). `exec` is how Exec= has to start: the installed binary for the deb,
 * `AppRun` inside the AppImage. The URL schemes come from `protocols` in electron-builder.yml
 * (the default-browser registration reads them back through this file's MimeType); the actions
 * from `linux.desktop.entry.Actions` and `desktopActions` there.
 */
export function checkDesktopEntry(text, { exec, name = 'Zenium', icon = 'zenium' } = {}) {
  const problems = []
  const warnings = []
  const groups = parseDesktopEntry(text)
  const entry = groups['Desktop Entry']
  if (!entry) return { problems: ['no [Desktop Entry] group'], warnings, entry: null }
  if (entry.Type !== 'Application') problems.push(`Type is ${JSON.stringify(entry.Type)}`)
  if (entry.Name !== name) problems.push(`Name is ${JSON.stringify(entry.Name)}, not ${name}`)
  if (entry.Icon !== icon) problems.push(`Icon is ${JSON.stringify(entry.Icon)}, not ${icon}`)
  const execValue = String(entry.Exec ?? '')
  if (exec !== undefined && !(execValue === exec || execValue.startsWith(`${exec} `))) {
    problems.push(`Exec is ${JSON.stringify(entry.Exec)}, expected it to start with ${exec}`)
  }
  if (!/(^|\s)%U(\s|$)/.test(execValue))
    problems.push(`Exec carries no %U: ${JSON.stringify(entry.Exec)}`)
  const mimeTypes = splitList(entry.MimeType)
  for (const scheme of SCHEME_HANDLERS) {
    if (!mimeTypes.includes(scheme))
      problems.push(`MimeType lacks ${scheme}: ${JSON.stringify(entry.MimeType)}`)
  }
  const seen = new Set()
  for (const type of mimeTypes) {
    if (seen.has(type)) warnings.push(`MimeType lists ${type} more than once`)
    seen.add(type)
  }
  const actions = splitList(entry.Actions)
  for (const action of DESKTOP_ACTIONS) {
    if (!actions.includes(action)) {
      problems.push(`Actions lacks ${action}: ${JSON.stringify(entry.Actions)}`)
      continue
    }
    const group = groups[`Desktop Action ${action}`]
    if (!group) problems.push(`no [Desktop Action ${action}] group`)
    else if (!group.Exec) problems.push(`[Desktop Action ${action}] has no Exec`)
  }
  if (!splitList(entry.Categories).includes('Network')) {
    problems.push(`Categories lacks Network: ${JSON.stringify(entry.Categories)}`)
  }
  return { problems, warnings, entry }
}

/** LINUX_DESKTOP_ID as src/main/platform/defaultBrowser.ts declares it, or null. */
export function readLinuxDesktopId(source) {
  const m = /export\s+const\s+LINUX_DESKTOP_ID\s*=\s*(['"`])([^'"`]+)\1/.exec(String(source))
  return m ? m[2] : null
}

/** Width and height from a PNG's IHDR chunk, or null when `buffer` is not a PNG. */
export function pngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  if (!buffer.subarray(0, 8).equals(signature)) return null
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** The desktop ids mimeinfo.cache (update-desktop-database) lists for `mimeType`. */
export function mimeinfoHandlers(text, mimeType) {
  for (const line of String(text).split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq === -1 || line.slice(0, eq).trim() !== mimeType) continue
    return splitList(line.slice(eq + 1))
  }
  return []
}

/**
 * dpkg's view of the package from `dpkg-query -W -f='${db:Status-Status}'`: the status word when
 * it answered, 'unknown' when it exited non-zero (a package it has never seen).
 */
export function dpkgStatus(stdout, exitCode) {
  const word = String(stdout ?? '').trim()
  if (exitCode !== 0 || !word) return 'unknown'
  return word
}

/**
 * What the `dpkg -i` log (with `apt-get install -f`'s output appended when it ran) says about the
 * package's Depends on this system: the ones dpkg found unmet (" zenium depends on libnotify4;
 * however:") and the packages apt then pulled in ("Selecting previously unselected package
 * libnotify4:amd64."), the package itself excepted. Both empty when dpkg configured it outright.
 */
export function parseDpkgInstallLog(text, packageName = PACKAGE) {
  const unmet = []
  const pulledIn = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const dep = line.match(/^\s*(\S+) depends on ([^;]+); however:\s*$/)
    if (dep && dep[1] === packageName) {
      const name = dep[2].trim()
      if (!unmet.includes(name)) unmet.push(name)
      continue
    }
    const selected = line.match(/^Selecting previously unselected package (\S+)\.\s*$/)
    if (selected && selected[1].replace(/:.*$/, '') !== packageName) pulledIn.push(selected[1])
  }
  return { unmet, pulledIn }
}

/** Is `status` (see dpkgStatus) one under which no file of the package remains? */
export function isRemovedStatus(status) {
  // `dpkg -r` keeps the record around as 'config-files' even for a package without conffiles;
  // 'not-installed' is the state after `--purge`, 'unknown' means dpkg never saw it.
  return ['config-files', 'not-installed', 'unknown'].includes(status)
}

/**
 * Polls `exists` for every path until none is left or `timeoutMs` have passed: the shape of the
 * teardown assertions elsewhere in the repo (shortcuts.test.ts), since dpkg's triggers and the
 * kernel's directory removal are not instant. Resolves to the paths still there and how long the
 * wait took. `exists`, `sleep` and `now` are injectable for the unit tests.
 */
export async function waitForGone(
  paths,
  { timeoutMs = 30000, intervalMs = 250, exists = pathExists, sleep = wait, now = Date.now } = {}
) {
  const start = now()
  let left = paths.filter((p) => exists(p))
  while (left.length && now() - start < timeoutMs) {
    await sleep(intervalMs)
    left = paths.filter((p) => exists(p))
  }
  return { left, waitedMs: now() - start }
}

/** True for a file, directory or symlink at `p`, even a dangling one (lstat, not stat). */
export function pathExists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...options })
  return {
    exit: r.status ?? (r.error ? -1 : null),
    signal: r.signal ?? null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
    error: r.error ? String(r.error.message) : undefined
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function pngFacts(file) {
  const facts = { path: file, exists: pathExists(file), png: null }
  if (facts.exists) {
    try {
      facts.png = pngSize(fs.readFileSync(file))
    } catch (e) {
      facts.error = String(e.message)
    }
  }
  return facts
}

function validateDesktopFile(file) {
  const r = run('desktop-file-validate', [file])
  return {
    available: r.error === undefined,
    exit: r.exit,
    output: (r.stdout + r.stderr).trim().split('\n').filter(Boolean)
  }
}

function expectedDesktopId(opts) {
  if (opts['desktop-id']) return String(opts['desktop-id'])
  const source = readText(
    path.join(here, '..', '..', 'src', 'main', 'platform', 'defaultBrowser.ts')
  )
  return source === null ? null : readLinuxDesktopId(source)
}

function finish(file, facts, startedAt) {
  facts.durationMs = Date.now() - startedAt
  facts.ok = facts.problems.length === 0
  writeJson(file, facts)
  console.log(JSON.stringify(facts, null, 2))
  for (const p of facts.problems) console.error(`FAIL: ${p}`)
  return facts.ok ? 0 : 1
}

/** The `appimage` action. */
export async function appimageFacts(opts) {
  const startedAt = Date.now()
  const label = String(opts.label ?? 'appimage')
  const outDir = path.resolve(String(opts.out ?? '.'))
  const file = path.resolve(String(opts.file ?? ''))
  const facts = {
    action: 'appimage',
    label,
    startedAt: new Date(startedAt).toISOString(),
    file,
    problems: []
  }
  const out = path.join(outDir, `${label}-facts.json`)
  if (!opts.file || !fs.existsSync(file)) {
    facts.problems.push(`AppImage not found: ${file}`)
    return finish(out, facts, startedAt)
  }
  const stat = fs.statSync(file)
  facts.sizeBytes = stat.size
  facts.executable = (stat.mode & 0o111) !== 0
  if (!facts.executable)
    facts.problems.push(`${file} is not executable (mode ${(stat.mode & 0o777).toString(8)})`)

  // The runtime answers on stderr ("Version: effcebc" for AppImageKit 12).
  const version = run(file, ['--appimage-version'])
  facts.runtimeVersion = version.exit === 0 ? (version.stdout + version.stderr).trim() : null
  if (version.exit !== 0) {
    facts.problems.push(
      `--appimage-version exited ${version.exit}: ${(version.stderr || version.stdout).trim()}`
    )
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenium-appimage-'))
  try {
    const t0 = Date.now()
    const extract = run(file, ['--appimage-extract'], { cwd: workDir, maxBuffer: 64 * 1024 * 1024 })
    const root = path.join(workDir, 'squashfs-root')
    facts.extract = { durationMs: Date.now() - t0, exit: extract.exit, root }
    if (extract.exit !== 0) {
      facts.problems.push(
        `--appimage-extract exited ${extract.exit}: ${extract.stderr.trim().slice(0, 2000)}`
      )
      return finish(out, facts, startedAt)
    }
    const payload = {}
    for (const [key, rel, executable] of [
      ['appRun', 'AppRun', true],
      ['exe', 'zenium', true],
      ['desktopEntry', 'zenium.desktop', false]
    ]) {
      const p = path.join(root, rel)
      const exists = fs.existsSync(p)
      const mode = exists ? fs.statSync(p).mode : 0
      payload[key] = { path: rel, exists, executable: exists && (mode & 0o111) !== 0 }
      if (!exists) facts.problems.push(`the image carries no ${rel}`)
      else if (executable && !payload[key].executable)
        facts.problems.push(`${rel} is not executable`)
    }
    if (payload.desktopEntry.exists) {
      const text = fs.readFileSync(path.join(root, 'zenium.desktop'), 'utf8')
      const check = checkDesktopEntry(text, { exec: 'AppRun' })
      payload.desktopEntry.entry = check.entry
      payload.desktopEntry.problems = check.problems
      payload.desktopEntry.warnings = check.warnings
      payload.desktopEntry.validate = validateDesktopFile(path.join(root, 'zenium.desktop'))
      facts.problems.push(...check.problems.map((p) => `zenium.desktop: ${p}`))
      if (payload.desktopEntry.validate.available && payload.desktopEntry.validate.exit !== 0) {
        facts.problems.push(
          `desktop-file-validate: ${payload.desktopEntry.validate.output.join(' | ')}`
        )
      }
    }
    // .DirIcon is what an integrator (AppImageLauncher, the desktop's thumbnailer) shows.
    const dirIcon = path.join(root, '.DirIcon')
    payload.dirIcon = { exists: pathExists(dirIcon), target: null }
    if (payload.dirIcon.exists) {
      try {
        payload.dirIcon.target = fs.readlinkSync(dirIcon)
      } catch {
        payload.dirIcon.target = '.DirIcon'
      }
      Object.assign(payload.dirIcon, pngFacts(path.resolve(root, payload.dirIcon.target)))
      if (!payload.dirIcon.png)
        facts.problems.push(`.DirIcon (${payload.dirIcon.target}) is not a PNG`)
    } else facts.problems.push('the image carries no .DirIcon')
    payload.icon = pngFacts(path.join(root, 'usr/share/icons/hicolor/512x512/apps/zenium.png'))
    if (!payload.icon.exists)
      facts.problems.push('no usr/share/icons/hicolor/512x512/apps/zenium.png in the image')
    else if (payload.icon.png?.width !== 512 || payload.icon.png?.height !== 512) {
      facts.problems.push(`the hicolor 512x512 icon is ${JSON.stringify(payload.icon.png)}`)
    }
    facts.payload = payload
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
  return finish(out, facts, startedAt)
}

/** The `deb-installed` action. */
export async function debInstalledFacts(opts) {
  const startedAt = Date.now()
  const label = String(opts.label ?? 'deb')
  const outDir = path.resolve(String(opts.out ?? '.'))
  const desktopId = expectedDesktopId(opts)
  const facts = {
    action: 'deb-installed',
    label,
    startedAt: new Date(startedAt).toISOString(),
    // The path the smoke boots, whether or not it is there: the harness names the miss.
    exe: INSTALLED_EXE,
    dpkgExit: opts['dpkg-exit'] !== undefined ? Number(opts['dpkg-exit']) : null,
    // The Depends the runner image lacked and what apt-get install -f pulled in for them.
    depends: parseDpkgInstallLog(opts['dpkg-log'] ? readText(String(opts['dpkg-log'])) : ''),
    problems: []
  }
  const out = path.join(outDir, `${label}-install.json`)

  const status = run('dpkg-query', ['-W', '-f=${db:Status-Status} ${Version}', PACKAGE])
  const [word, version] = status.stdout.trim().split(/\s+/)
  facts.package = { name: PACKAGE, status: dpkgStatus(word, status.exit), version: version ?? null }
  if (facts.package.status !== 'installed') {
    facts.problems.push(`dpkg says ${PACKAGE} is ${facts.package.status}: ${status.stderr.trim()}`)
  }

  const listed = run('dpkg', ['-L', PACKAGE])
  // Paths only: for a removed package dpkg -L prints a sentence and exits 0.
  const files =
    listed.exit === 0
      ? listed.stdout.split('\n').filter((l) => l.startsWith('/') && l !== '/.')
      : []
  const missing = files.filter((f) => !pathExists(f))
  facts.files = { listed: files.length, missing }
  if (listed.exit !== 0) facts.problems.push(`dpkg -L ${PACKAGE} exited ${listed.exit}`)
  if (missing.length) facts.problems.push(`files dpkg lists are missing: ${missing.join(', ')}`)
  for (const must of [
    INSTALLED_EXE,
    `${APPLICATIONS_DIR}/${desktopId ?? 'zenium.desktop'}`,
    ICON_PATH
  ]) {
    if (!files.includes(must)) facts.problems.push(`dpkg -L does not list ${must}`)
  }

  const exeStat = pathExists(INSTALLED_EXE) ? fs.statSync(INSTALLED_EXE) : null
  facts.exeExecutable = exeStat !== null && (exeStat.mode & 0o111) !== 0
  if (!exeStat) facts.problems.push(`${INSTALLED_EXE} is missing`)
  else if (!facts.exeExecutable) facts.problems.push(`${INSTALLED_EXE} is not executable`)

  facts.links = {}
  for (const [link, required] of [
    ['/usr/bin/zenium', true],
    // after-install.sh creates the alias only where the name is free; it is on a fresh runner.
    ['/usr/bin/zen-chromium', true]
  ]) {
    let target = null
    try {
      target = fs.realpathSync(link)
    } catch {
      /* missing or dangling */
    }
    facts.links[link] = target
    if (required && target !== INSTALLED_EXE) {
      facts.problems.push(`${link} resolves to ${JSON.stringify(target)}, not ${INSTALLED_EXE}`)
    }
  }

  const desktopPath = path.join(APPLICATIONS_DIR, desktopId ?? 'zenium.desktop')
  const desktopText = readText(desktopPath)
  facts.desktopEntry = { path: desktopPath, expectedId: desktopId, exists: desktopText !== null }
  if (desktopId === null)
    facts.problems.push('LINUX_DESKTOP_ID not found in src/main/platform/defaultBrowser.ts')
  if (desktopText === null) facts.problems.push(`no desktop entry at ${desktopPath}`)
  else {
    const check = checkDesktopEntry(desktopText, { exec: INSTALLED_EXE })
    Object.assign(facts.desktopEntry, check, { validate: validateDesktopFile(desktopPath) })
    facts.problems.push(...check.problems.map((p) => `${path.basename(desktopPath)}: ${p}`))
    if (!facts.desktopEntry.validate.available)
      facts.problems.push('desktop-file-validate is not installed')
    else if (facts.desktopEntry.validate.exit !== 0) {
      facts.problems.push(
        `desktop-file-validate: ${facts.desktopEntry.validate.output.join(' | ')}`
      )
    }
  }
  const others = fs.existsSync(APPLICATIONS_DIR)
    ? fs.readdirSync(APPLICATIONS_DIR).filter((f) => /zenium/i.test(f) && f !== desktopId)
    : []
  facts.desktopEntry.others = others
  if (others.length) facts.problems.push(`unexpected desktop entries: ${others.join(', ')}`)

  facts.icon = pngFacts(ICON_PATH)
  if (!facts.icon.exists) facts.problems.push(`no icon at ${ICON_PATH}`)
  else if (facts.icon.png?.width !== 512 || facts.icon.png?.height !== 512) {
    facts.problems.push(`${ICON_PATH} is ${JSON.stringify(facts.icon.png)}, not a 512x512 PNG`)
  }

  const cachePath = path.join(APPLICATIONS_DIR, 'mimeinfo.cache')
  const cache = readText(cachePath)
  facts.mimeinfoCache = { path: cachePath, exists: cache !== null, handlers: {} }
  if (cache === null) facts.problems.push(`no ${cachePath} (update-desktop-database did not run)`)
  else {
    for (const scheme of SCHEME_HANDLERS) {
      const handlers = mimeinfoHandlers(cache, scheme)
      facts.mimeinfoCache.handlers[scheme] = handlers
      if (desktopId && !handlers.includes(desktopId)) {
        facts.problems.push(
          `mimeinfo.cache does not name ${desktopId} for ${scheme}: ${handlers.join(';') || '(none)'}`
        )
      }
    }
  }

  // Informational: the profile lands only where AppArmor is enabled and accepts it (Ubuntu 24+);
  // deb-removed asserts it is gone either way.
  facts.apparmor = {
    kernelEnabled: readText('/sys/module/apparmor/parameters/enabled')?.trim() === 'Y',
    profile: APPARMOR_PROFILE,
    present: pathExists(APPARMOR_PROFILE)
  }
  const sandbox = `${INSTALL_DIR}/chrome-sandbox`
  facts.chromeSandboxMode = pathExists(sandbox)
    ? (fs.statSync(sandbox).mode & 0o7777).toString(8)
    : null

  return finish(out, facts, startedAt)
}

/** The `deb-removed` action. */
export async function debRemovedFacts(opts) {
  const startedAt = Date.now()
  const label = String(opts.label ?? 'deb')
  const outDir = path.resolve(String(opts.out ?? '.'))
  const timeoutMs = Number(opts['timeout-ms'] ?? 30000)
  const facts = {
    action: 'deb-removed',
    label,
    startedAt: new Date(startedAt).toISOString(),
    timeoutMs,
    paths: REMOVED_PATHS,
    problems: []
  }
  const out = path.join(outDir, `${label}-uninstall.json`)

  const { left, waitedMs } = await waitForGone(REMOVED_PATHS, { timeoutMs })
  facts.left = left
  facts.waitedMs = waitedMs
  if (left.length)
    facts.problems.push(`still there ${waitedMs} ms after dpkg -r: ${left.join(', ')}`)

  const status = run('dpkg-query', ['-W', '-f=${db:Status-Status}', PACKAGE])
  facts.package = { name: PACKAGE, status: dpkgStatus(status.stdout, status.exit) }
  if (!isRemovedStatus(facts.package.status)) {
    facts.problems.push(`dpkg still says ${PACKAGE} is ${facts.package.status}`)
  }

  const cachePath = path.join(APPLICATIONS_DIR, 'mimeinfo.cache')
  const cache = readText(cachePath)
  const mentions =
    cache === null
      ? []
      : cache
          .split(/\r?\n/)
          .filter((l) => splitList(l.slice(l.indexOf('=') + 1)).some((id) => /zenium/i.test(id)))
  facts.mimeinfoCache = { path: cachePath, exists: cache !== null, mentions }
  if (mentions.length)
    facts.problems.push(`mimeinfo.cache still names the entry: ${mentions.join(' | ')}`)

  const entries = fs.existsSync(APPLICATIONS_DIR)
    ? fs.readdirSync(APPLICATIONS_DIR).filter((f) => /zenium/i.test(f))
    : []
  facts.desktopEntries = entries
  if (entries.length) facts.problems.push(`desktop entries left: ${entries.join(', ')}`)

  return finish(out, facts, startedAt)
}

const ACTIONS = {
  appimage: appimageFacts,
  'deb-installed': debInstalledFacts,
  'deb-removed': debRemovedFacts
}

async function main() {
  const action = process.argv[2]
  const opts = parseArgs(process.argv.slice(3))
  const handler = ACTIONS[action]
  if (!handler || !opts.out) {
    console.error(
      'usage: node linux-install.mjs appimage --file <Zenium.AppImage> --out <dir> [--label appimage]\n' +
        '       node linux-install.mjs deb-installed --out <dir> [--label deb] [--desktop-id zenium.desktop] [--dpkg-exit <n>] [--dpkg-log <file>]\n' +
        '       node linux-install.mjs deb-removed --out <dir> [--label deb] [--timeout-ms 30000]'
    )
    process.exit(2)
  }
  process.exit(await handler(opts))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
