// Facts and assertions about the Linux installers on a runner, the counterpart of win-install.ps1
// and mac-facts.sh. Every action writes a JSON file under --out for the artifact and exits 1 when
// an assertion failed (the file is written first, so the workflow can still read it).
//
//   node linux-install.mjs appimage --file <Zenium.AppImage> --out <dir> [--label appimage]
//       The image is executable, `--appimage-version` answers, and `--appimage-extract` (timed,
//       into a temporary directory removed afterwards) yields AppRun, the zenium executable, the
//       embedded zenium.desktop (Exec=AppRun, the x-scheme-handler MIME types, the two desktop
//       actions) and the .DirIcon, a 512x512 PNG. Writes <out>/<label>-facts.json.
//       To boot the image the workflow sets APPIMAGE_EXTRACT_AND_RUN=1 rather than passing
//       --appimage-extract-and-run: the type-2 runtime reads only the first argument, and
//       Playwright puts --inspect=0 and --remote-debugging-port=0 in front of everything.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  if (!/(^|\s)%U(\s|$)/.test(execValue)) {
    problems.push(`Exec carries no %U: ${JSON.stringify(entry.Exec)}`)
  }
  const mimeTypes = splitList(entry.MimeType)
  for (const scheme of SCHEME_HANDLERS) {
    if (!mimeTypes.includes(scheme)) {
      problems.push(`MimeType lacks ${scheme}: ${JSON.stringify(entry.MimeType)}`)
    }
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

/** Width and height from a PNG's IHDR chunk, or null when `buffer` is not a PNG. */
export function pngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  if (!buffer.subarray(0, 8).equals(signature)) return null
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
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
  if (!facts.executable) {
    facts.problems.push(`${file} is not executable (mode ${(stat.mode & 0o777).toString(8)})`)
  }

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
      else if (executable && !payload[key].executable) {
        facts.problems.push(`${rel} is not executable`)
      }
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
      if (!payload.dirIcon.png) {
        facts.problems.push(`.DirIcon (${payload.dirIcon.target}) is not a PNG`)
      }
    } else facts.problems.push('the image carries no .DirIcon')
    payload.icon = pngFacts(path.join(root, 'usr/share/icons/hicolor/512x512/apps/zenium.png'))
    if (!payload.icon.exists) {
      facts.problems.push('no usr/share/icons/hicolor/512x512/apps/zenium.png in the image')
    } else if (payload.icon.png?.width !== 512 || payload.icon.png?.height !== 512) {
      facts.problems.push(`the hicolor 512x512 icon is ${JSON.stringify(payload.icon.png)}`)
    }
    facts.payload = payload
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
  return finish(out, facts, startedAt)
}

const ACTIONS = {
  appimage: appimageFacts
}

async function main() {
  const action = process.argv[2]
  const opts = parseArgs(process.argv.slice(3))
  const handler = ACTIONS[action]
  if (!handler || !opts.out) {
    console.error(
      'usage: node linux-install.mjs appimage --file <Zenium.AppImage> --out <dir> [--label appimage]'
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
