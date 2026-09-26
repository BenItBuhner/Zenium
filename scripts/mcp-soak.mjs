#!/usr/bin/env node
// A soak of Zenium's MCP server (Settings → AI Agents) against a RUNNING build, over plain HTTP:
// many agent sessions, several at a time, each living an agent's life – initialize, a look at
// the status, background mode, a tab on the fixture page, a snapshot, a screenshot, the form
// filled in, foreground mode, another screenshot, `zen_session end` (with closeTabs on the even
// sessions, without on the odd ones, whose groups stay behind orphaned), a call after the end on
// the SAME session id (the connection outlives the agent's tidy-up), the adoption of a group an
// earlier session orphaned, a last end with closeTabs, a DELETE – with the client-side latency of
// every tool call and, at the end, the server's own counters (`zenium://diagnostics`).
//
// Optional legs: the stdio shim (`zenium --mcp`, one process per session; --shim), a dropped
// client and simulated resurrections (--drop), a restart of the browser with the old session id
// and a shim process carried across it (--restart). With --exe and no server answering, the
// script starts the browser itself and quits it at the end. The browser is left as it was found:
// the groups the sessions orphaned are closed and the user's window, which foreground sessions
// switch to the Agents space, is switched back to the user's own space.
//
// Usage:
//
//   node scripts/mcp-soak.mjs --user-data-dir <profile>           # endpoint from <profile>/zen/agent.json
//   node scripts/mcp-soak.mjs --url http://127.0.0.1:41735/mcp --token <token>
//   node scripts/mcp-soak.mjs --user-data-dir <profile> --shim dist/linux-unpacked/zenium --drop
//   node scripts/mcp-soak.mjs --user-data-dir <profile> --exe dist/linux-unpacked/zenium \
//        --drop --restart --extra-args="--no-sandbox --disable-gpu"
//
//   --sessions N        sessions per round (30)        --concurrency K    sessions in flight (6)
//   --rounds M          rounds (3)                      --shim-sessions N  stdio sessions (5)
//   --fixture <url>     a page of your own instead of the built-in fixture (a heading, a
//                       paragraph, a form with a text input, a select and a button; /slow answers
//                       after 2 s and every fourth session opens it)
//   --out <dir>         where soak.json goes ($TMPDIR/mcp-soak)
//   --exe <zenium>      the executable: launched on --user-data-dir when no server answers, and
//                       the one --restart quits and starts again (--pid <n> names a browser this
//                       script did not start)
//   --shim <zenium>     the executable for the stdio leg (`--exe` when --restart is on)
//   --extra-args "…"    switches for the processes this script starts: e.g. --no-sandbox --disable-gpu
//   --strict            soft failures fail the run too      --keep    leave a launched browser running
//   --verbose           one line per session, the shim's stderr
//
// Checks are HARD (the run fails) or SOFT (reported, never failing the run without --strict). A
// soft check is named with the PR it waits on: `drop-force-adopt (until E)`. The background
// snapshot and the two screenshots are hard since B (the host stages a hidden page an agent drives).
// A hard check that has nothing to act on (no orphaned group to adopt) is counted as skipped.
//
// Output: a compact table on stdout and <out>/soak.json – counts (sessions, calls, hard and soft
// failures by check), client latency p50 / p95 / max per tool and leg, the server's diagnostics
// (with --restart, read before the restart, which starts the counters over; the restarted
// server's are `diagnosticsAfterRestart`). Progress goes to stderr. Exit codes: 0 no hard failure, 1 a hard failure (or a soft one under
// --strict), 2 usage. The token is never printed: anything quoted from the server has it redacted.
//
// On a headless Linux box run it under `xvfb-run -a` (the shim and --exe start Electron processes).
// Unit tests of the pure parts: scripts/mcp-soak.test.mjs (vitest).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULTS = Object.freeze({ sessions: 30, concurrency: 6, rounds: 3, shimSessions: 5 })

/** Soft checks, named with the PR that turns them hard. */
export const SOFT_CHECKS = Object.freeze({
  dropForceAdopt: 'drop-force-adopt (until E)'
})

const PROTOCOL_VERSION = '2025-06-18'
const USER_AGENT = 'zenium-mcp-soak'
const CLIENT_VERSION = '1'
/** A tool call that has not answered by then failed the session (the server has no such limit). */
const CALL_TIMEOUT_MS = 90_000

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const FLAGS = new Set(['drop', 'restart', 'strict', 'keep', 'verbose', 'help'])
const NUMBERS = new Set(['sessions', 'concurrency', 'rounds', 'shim-sessions', 'pid'])
const STRINGS = new Set([
  'user-data-dir',
  'url',
  'token',
  'shim',
  'exe',
  'fixture',
  'out',
  'extra-args'
])

const camel = (key) => key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

/** `--key value`, `--key=value` and bare flags into options; throws on anything it does not know. */
export function parseArgs(argv) {
  const opts = {
    userDataDir: null,
    url: null,
    token: null,
    shim: null,
    exe: null,
    pid: null,
    fixture: null,
    out: null,
    extraArgs: [],
    sessions: DEFAULTS.sessions,
    concurrency: DEFAULTS.concurrency,
    rounds: DEFAULTS.rounds,
    shimSessions: DEFAULTS.shimSessions,
    drop: false,
    restart: false,
    strict: false,
    keep: false,
    verbose: false,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(arg)}`)
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    let value = eq === -1 ? undefined : arg.slice(eq + 1)
    if (FLAGS.has(key)) {
      opts[camel(key)] = value === undefined ? true : value !== 'false'
      continue
    }
    if (!NUMBERS.has(key) && !STRINGS.has(key)) throw new Error(`unknown option --${key}`)
    if (value === undefined) {
      value = argv[++i]
      if (value === undefined) throw new Error(`--${key} needs a value`)
    }
    if (NUMBERS.has(key)) {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0) throw new Error(`--${key} needs a whole number`)
      opts[camel(key)] = n
    } else if (key === 'extra-args') opts.extraArgs = value.split(/\s+/).filter(Boolean)
    else if (key === 'user-data-dir' || key === 'out') opts[camel(key)] = path.resolve(value)
    else opts[camel(key)] = value
  }
  if (opts.concurrency === 0) opts.concurrency = 1
  return opts
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const round1 = (ms) => Math.round(ms * 10) / 10

/** Nearest-rank percentiles of `samples` (ms), as the server's diagnostics compute theirs. */
export function percentiles(samples) {
  if (!samples.length) return { count: 0, p50: 0, p95: 0, max: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
  return {
    count: sorted.length,
    p50: round1(at(50)),
    p95: round1(at(95)),
    max: round1(sorted[sorted.length - 1])
  }
}

/** Run `worker(i)` for i in [0, count) with at most `concurrency` in flight. */
export async function pool(concurrency, count, worker) {
  let next = 0
  const lanes = Math.max(1, Math.min(concurrency, count))
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const i = next++
        if (i >= count) return
        await worker(i)
      }
    })
  )
}

/** The text parts of a tool result, joined. */
export function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
}

/** Whether a tool result carries an image content part with data. */
export function hasImage(result) {
  return (result?.content ?? []).some(
    (c) =>
      c &&
      c.type === 'image' &&
      typeof c.data === 'string' &&
      c.data.length > 0 &&
      typeof c.mimeType === 'string'
  )
}

/** The tab id `browser_tabs new` reports, or null. */
export function openedTab(text) {
  return /Opened tab (tab_[\w-]+)/.exec(text)?.[1] ?? null
}

function unquote(s) {
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return s
  }
}

/**
 * A page snapshot as the tools print it: the viewport line, and every `- role "name" [attrs]
 * [ref=eN]` node. `ref(role, name?)` finds the first node of a role (and name, when given);
 * `headings` are the heading names.
 */
export function parseSnapshot(text) {
  const vp = /- Viewport: (\d+)×(\d+) CSS px/.exec(text)
  const viewport = vp ? { width: Number(vp[1]), height: Number(vp[2]) } : null
  const nodes = []
  const re = /^\s*- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]\n]*\])*) \[ref=(e\d+)\]\s*$/gm
  for (const m of text.matchAll(re)) {
    nodes.push({
      role: m[1],
      name: m[2] === undefined ? '' : unquote(m[2]),
      attrs: m[3].trim(),
      ref: m[4]
    })
  }
  return {
    viewport,
    nodes,
    headings: nodes.filter((n) => n.role === 'heading').map((n) => n.name),
    ref(role, name) {
      return (
        nodes.find((n) => n.role === role && (name === undefined || n.name === name))?.ref ?? null
      )
    }
  }
}

/**
 * The groups a `zen_groups list` names, from their header lines
 * (`Group "name" (folder_x) [flags] in space "…" – N tabs:`): id, name, tab count, and what the
 * flags say – `home`, `yours`, `orphaned` (with `was`, the former owner), `owner` (a live
 * session's name), `user` (the user's folder).
 */
export function parseGroups(text) {
  const out = []
  const re =
    /^Group "((?:[^"\\]|\\.)*)" \((folder_[\w-]+)\)(?: \[(.*?)\])? in space "((?:[^"\\]|\\.)*)" – (\d+) tabs?:/gm
  for (const m of text.matchAll(re)) {
    const flags = m[3] ?? ''
    out.push({
      id: m[2],
      name: unquote(m[1]),
      space: unquote(m[4]),
      tabs: Number(m[5]),
      flags,
      home: /(^|, )home(,|$)/.test(flags),
      yours: /(^|, )yours(,|$)/.test(flags),
      orphaned: /(^|, )orphaned(,|$)/.test(flags),
      was: /orphaned, was "((?:[^"\\]|\\.)*)"/.exec(flags)?.[1] ?? null,
      owner: /owned by "((?:[^"\\]|\\.)*)"/.exec(flags)?.[1] ?? null,
      user: /(^|, )the user's(,|$)/.test(flags)
    })
  }
  return out.map((g) => ({
    ...g,
    was: g.was === null ? null : unquote(g.was),
    owner: g.owner === null ? null : unquote(g.owner)
  }))
}

/**
 * The spaces a `zen_spaces list` names (`- space_x "name" 🏠 – N tab(s) [shown to the user]
 * [agents]`): id, name, tab count, whether the user's window shows it, whether it is agents'.
 */
export function parseSpaces(text) {
  const out = []
  const re = /^- (\S+) "((?:[^"\\]|\\.)*)" .*?– (\d+) tab\(s\)(.*)$/gm
  for (const m of text.matchAll(re)) {
    const flags = m[4]
    out.push({
      id: m[1],
      name: unquote(m[2]),
      tabs: Number(m[3]),
      shown: /\[shown to the user\]/.test(flags),
      agents: /\[agents\]/.test(flags)
    })
  }
  return out
}

/** An adopt that failed because another session got there first, or the group is gone. */
export const ADOPT_RACE = /which is still connected|Unknown group|is already yours/

/** A space switch refused because another agent's screen lease is still warm. */
const LEASE_HELD = /holds it|holds the screen/

/** 24 hex characters, the shape of the server's own session ids. */
export function randomSessionId() {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `<userDataDir>/zen/agent.json` as the shim reads it: `{ url, token, running }`, or null. */
export function readEndpoint(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, 'zen', 'agent.json'), 'utf8'))
    if (!raw || typeof raw.token !== 'string') return null
    return {
      url: typeof raw.url === 'string' ? raw.url : null,
      token: raw.token,
      running: raw.running === true
    }
  } catch {
    return null
  }
}

/** Whether something answers MCP at `url` (an OPTIONS is 204 there; anything HTTP will do). */
export async function answers(url) {
  try {
    await fetch(url, { method: 'OPTIONS', signal: AbortSignal.timeout(2000) })
    return true
  } catch {
    return false
  }
}

/** The endpoint once agent.json says `running: true` and the URL answers; throws at the deadline. */
export async function waitForEndpoint(userDataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const e = readEndpoint(userDataDir)
    if (e?.running && e.url && (await answers(e.url))) return { url: e.url, token: e.token }
    if (Date.now() >= deadline)
      throw new Error(
        `no MCP server answered within ${timeoutMs} ms (${path.join(userDataDir, 'zen', 'agent.json')}: ${
          e ? `running ${e.running}, url ${e.url}` : 'absent or unreadable'
        }) – is Zenium running with Settings → AI Agents on?`
      )
    await delay(250)
  }
}

/** The endpoint when a server answers right now, else null (never waits). */
export async function probeEndpoint(userDataDir) {
  const e = readEndpoint(userDataDir)
  if (!e?.running || !e.url || !(await answers(e.url))) return null
  return { url: e.url, token: e.token }
}

// ---------------------------------------------------------------------------------------------
// The fixture: one page with a heading, a paragraph and a small form; /slow answers after 2 s
// ---------------------------------------------------------------------------------------------

export const FIXTURE = Object.freeze({
  heading: 'Soak fixture',
  slowPath: '/slow',
  slowDelayMs: 2000,
  /** The form's controls: their labels and the CSS selectors the harness falls back on. */
  form: {
    text: { label: 'Name', selector: '#name' },
    select: { label: 'Kind', selector: '#kind', options: ['one', 'two', 'three'] },
    button: { label: 'Go', selector: '#go' }
  }
})

export function fixturePage(variant = 'fast') {
  const f = FIXTURE.form
  const slow = variant === 'slow'
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${FIXTURE.heading}${slow ? ' (slow)' : ''}</title></head>` +
    `<body style="margin:0;font:18px/1.5 sans-serif;color:#222"><main style="margin:48px 40px;max-width:720px">` +
    `<h1 style="margin:0 0 16px;font-size:40px;font-weight:600">${FIXTURE.heading}</h1>` +
    `<p>The MCP soak's page, served by scripts/mcp-soak.mjs on the loopback interface${slow ? ` after ${FIXTURE.slowDelayMs} ms` : ''}. Nothing on it comes from the internet.</p>` +
    `<form onsubmit="return false">` +
    `<p><label for="name">${f.text.label}</label> <input id="name" type="text" size="24"></p>` +
    `<p><label for="kind">${f.select.label}</label> <select id="kind">${f.select.options.map((o) => `<option>${o}</option>`).join('')}</select></p>` +
    `<p><button id="go" type="button" onclick="document.getElementById('status').textContent='clicked with '+JSON.stringify(document.getElementById('name').value)">${f.button.label}</button> <output id="status"></output></p>` +
    `</form></main></body></html>`
  )
}

/** Starts the fixture on 127.0.0.1 (an ephemeral port): `{ origin, url, slowUrl, requests, close }`. */
export function startFixture() {
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    const { pathname } = new URL(req.url ?? '/', 'http://fixture')
    if (pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    const slow = pathname === FIXTURE.slowPath
    if (pathname !== '/' && !slow) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const body = fixturePage(slow ? 'slow' : 'fast')
    const send = () => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(body)
    }
    if (slow) setTimeout(send, FIXTURE.slowDelayMs)
    else send()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`
      resolve({
        origin,
        url: `${origin}/`,
        slowUrl: `${origin}${FIXTURE.slowPath}`,
        custom: false,
        get requests() {
          return requests
        },
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}

// ---------------------------------------------------------------------------------------------
// The verdict: hard and soft checks, counters, latencies, the table
// ---------------------------------------------------------------------------------------------

export class Verdict {
  constructor({ secrets = [] } = {}) {
    this.secrets = secrets.filter(Boolean)
    this.checks = new Map()
    this.counters = {}
    this.sessions = 0
    this.calls = 0
    this.startedAt = Date.now()
  }

  /** `text` with every secret (the token) replaced. */
  redact(text) {
    let out = String(text ?? '')
    for (const s of this.secrets) out = out.split(s).join('<token>')
    return out
  }

  entry(name, kind) {
    let c = this.checks.get(name)
    if (!c) {
      c = { kind, pass: 0, fail: 0, skipped: 0, samples: [], skipReasons: [] }
      this.checks.set(name, c)
    }
    return c
  }

  check(kind, name, ok, detail) {
    const c = this.entry(name, kind)
    if (ok) c.pass++
    else {
      c.fail++
      if (c.samples.length < 3 && detail) c.samples.push(this.redact(detail).slice(0, 400))
    }
    return Boolean(ok)
  }

  hard(name, ok, detail) {
    return this.check('hard', name, ok, detail)
  }

  soft(name, ok, detail) {
    return this.check('soft', name, ok, detail)
  }

  /** A check with nothing to act on this time (no orphan to adopt): counted, never failed. */
  skip(name, kind, why) {
    const c = this.entry(name, kind)
    c.skipped++
    if (why && c.skipReasons.length < 3 && !c.skipReasons.includes(why)) c.skipReasons.push(why)
  }

  bump(counter, n = 1) {
    this.counters[counter] = (this.counters[counter] ?? 0) + n
  }

  failures(kind) {
    let n = 0
    for (const c of this.checks.values()) if (c.kind === kind) n += c.fail
    return n
  }

  get hardFailures() {
    return this.failures('hard')
  }

  get softFailures() {
    return this.failures('soft')
  }

  /** The failure counts now, for `since`. */
  snapshot() {
    return {
      hard: this.hardFailures,
      soft: this.softFailures,
      sessions: this.sessions,
      calls: this.calls
    }
  }

  since(snapshot) {
    return {
      hard: this.hardFailures - snapshot.hard,
      soft: this.softFailures - snapshot.soft,
      sessions: this.sessions - snapshot.sessions,
      calls: this.calls - snapshot.calls
    }
  }

  /** The hard checks that failed, by name, with what they quoted. */
  hardFailed() {
    return [...this.checks]
      .filter(([, c]) => c.kind === 'hard' && c.fail > 0)
      .map(([name, c]) => ({ name, fail: c.fail, samples: c.samples }))
  }

  summary(extra = {}) {
    const checks = {}
    let skipped = 0
    for (const [name, c] of this.checks) {
      checks[name] = { ...c, samples: [...c.samples], skipReasons: [...c.skipReasons] }
      skipped += c.skipped
    }
    const endedAt = Date.now()
    return {
      ok: this.hardFailures === 0,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      wallMs: endedAt - this.startedAt,
      counts: {
        sessions: this.sessions,
        calls: this.calls,
        hardFailures: this.hardFailures,
        softFailures: this.softFailures,
        skipped,
        ...this.counters
      },
      checks,
      ...extra
    }
  }
}

export class Latencies {
  constructor() {
    this.samples = new Map()
  }

  record(leg, tool, ms) {
    const key = `${leg}\n${tool}`
    let arr = this.samples.get(key)
    if (!arr) this.samples.set(key, (arr = []))
    arr.push(ms)
  }

  /** `{ [leg]: { [tool]: { count, p50, p95, max } } }`, legs and tools in name order. */
  summary() {
    const out = {}
    for (const [key, arr] of [...this.samples].sort(([a], [b]) => a.localeCompare(b))) {
      const [leg, tool] = key.split('\n')
      ;(out[leg] ??= {})[tool] = percentiles(arr)
    }
    return out
  }
}

function tabulate(rows) {
  const widths = []
  for (const row of rows)
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  return rows.map((row) =>
    row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')
  )
}

const fmtMs = (ms) => (Number.isFinite(ms) ? String(round1(ms)) : '-')
const fmtSeconds = (ms) => `${(ms / 1000).toFixed(1)} s`

/** The server's diagnostics in one line (the shape `zen_status` uses). */
export function summarizeDiagnostics(d) {
  if (!d || !d.sessions) return 'no diagnostics read'
  const s = d.sessions
  const slowest = Object.entries(d.tools ?? {})
    .sort(([, a], [, b]) => b.p95Ms - a.p95Ms)
    .slice(0, 3)
    .map(([name, t]) => `${name} p95 ${t.p95Ms} ms`)
  return (
    `sessions ${s.live} live (${s.parked} parked), ${s.created} created, ${s.ended} ended, ` +
    `${s.parkedTotal} parked, ${s.resumed} resumed, ${s.resurrected} resurrected, ${s.closed} closed, ` +
    `${s.unknown} unknown; calls ${d.calls?.total ?? '?'} (${d.calls?.errors ?? '?'} errors, ` +
    `${d.calls?.inFlight ?? '?'} running)${slowest.length ? `; slowest: ${slowest.join(', ')}` : ''}`
  )
}

/** The compact table the run ends with: checks, latencies per leg and tool, the server's line. */
export function formatTable(summary) {
  const rows = [['KIND', 'CHECK', 'PASS', 'FAIL', 'SKIP']]
  for (const [name, c] of Object.entries(summary.checks ?? {}))
    rows.push([c.kind.toUpperCase(), name, String(c.pass), String(c.fail), String(c.skipped)])
  const lines = tabulate(rows)
  for (const [leg, tools] of Object.entries(summary.latency ?? {})) {
    const latency = [['LEG', 'TOOL', 'CALLS', 'P50 MS', 'P95 MS', 'MAX MS']]
    for (const [tool, t] of Object.entries(tools))
      latency.push([leg, tool, String(t.count), fmtMs(t.p50), fmtMs(t.p95), fmtMs(t.max)])
    lines.push('', ...tabulate(latency))
  }
  lines.push('', `server: ${summarizeDiagnostics(summary.diagnostics)}`)
  if (summary.diagnosticsAfterRestart !== undefined)
    lines.push(`server after the restart: ${summarizeDiagnostics(summary.diagnosticsAfterRestart)}`)
  const c = summary.counts ?? {}
  const soft = Object.entries(summary.checks ?? {})
    .filter(([, x]) => x.kind === 'soft' && x.fail > 0)
    .map(([name, x]) => `${name} ×${x.fail}`)
  lines.push(
    `${c.sessions ?? 0} sessions, ${c.calls ?? 0} calls, ${c.hardFailures ?? 0} hard failure(s), ` +
      `${c.softFailures ?? 0} soft failure(s)${soft.length ? ` (${soft.join(', ')})` : ''} in ${fmtSeconds(summary.wallMs ?? 0)}` +
      ` – ${summary.ok ? 'PASS' : 'FAIL'}`
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Clients: Streamable HTTP (one JSON response per POST) and the stdio shim
// ---------------------------------------------------------------------------------------------

/** A transport-level failure of a call: the wrong status, a JSON-RPC error, a timeout. */
export class SoakError extends Error {}

const rpc = (method, params, id) =>
  id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }

export class HttpClient {
  constructor({ url, token, name, leg = 'http', latencies = null, timeoutMs = CALL_TIMEOUT_MS }) {
    this.url = url
    this.token = token
    this.name = name
    this.leg = leg
    this.latencies = latencies
    this.timeoutMs = timeoutMs
    this.sessionId = null
    this.nextId = 1
  }

  /** One POST: `{ status, headers, text, json, ms }`. `auth: false` leaves the bearer token off. */
  async post(body, { headers = {}, auth = true, session = true } = {}) {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...headers
    }
    if (auth && this.token) h.authorization = `Bearer ${this.token}`
    if (session && this.sessionId && !('mcp-session-id' in headers))
      h['mcp-session-id'] = this.sessionId
    const t0 = performance.now()
    let res
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      throw new SoakError(
        `${body.method ?? 'request'}: ${error.name === 'TimeoutError' ? `no answer within ${this.timeoutMs} ms` : error.message}`
      )
    }
    const text = await res.text()
    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    return { status: res.status, headers: res.headers, text, json, ms: performance.now() - t0 }
  }

  async request(method, params) {
    const { status, json } = await this.post(rpc(method, params, this.nextId++))
    if (status !== 200)
      throw new SoakError(`${method}: HTTP ${status}${json?.error ? ` ${json.error.message}` : ''}`)
    if (!json || json.error)
      throw new SoakError(
        `${method}: JSON-RPC error ${json?.error?.code ?? '?'} ${json?.error?.message ?? '(no body)'}`
      )
    return json.result
  }

  /** initialize + notifications/initialized; the session id from the response header. */
  async initialize() {
    const { status, headers, json } = await this.post(
      rpc(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: this.name, version: CLIENT_VERSION }
        },
        this.nextId++
      ),
      { session: false }
    )
    if (status !== 200 || !json || json.error)
      throw new SoakError(
        `initialize: HTTP ${status}${json?.error ? ` ${json.error.message}` : ''}`
      )
    const id = headers.get('mcp-session-id')
    if (!id) throw new SoakError('initialize: no mcp-session-id header on the response')
    this.sessionId = id
    const note = await this.post(rpc('notifications/initialized', undefined))
    if (note.status !== 202)
      throw new SoakError(`notifications/initialized: HTTP ${note.status}, expected 202`)
    return json.result
  }

  /** tools/call: `{ result, text, isError, ms }`; the latency recorded under the tool's name. */
  async call(name, args = {}) {
    const { status, json, ms } = await this.post(
      rpc('tools/call', { name, arguments: args }, this.nextId++)
    )
    this.latencies?.record(this.leg, name, ms)
    if (status !== 200)
      throw new SoakError(`${name}: HTTP ${status}${json?.error ? ` ${json.error.message}` : ''}`)
    if (!json || json.error)
      throw new SoakError(
        `${name}: JSON-RPC error ${json?.error?.code ?? '?'} ${json?.error?.message ?? '(no body)'}`
      )
    const result = json.result ?? {}
    return { result, text: textOf(result), isError: Boolean(result.isError), ms, status }
  }

  async readResource(uri) {
    const result = await this.request('resources/read', { uri })
    return result?.contents ?? []
  }

  /** DELETE the session; true on the 204. */
  async close() {
    if (!this.sessionId) return true
    const h = { 'mcp-session-id': this.sessionId, 'user-agent': USER_AGENT }
    if (this.token) h.authorization = `Bearer ${this.token}`
    this.sessionId = null
    try {
      const res = await fetch(this.url, {
        method: 'DELETE',
        headers: h,
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      return res.status === 204
    } catch {
      return false
    }
  }
}

/**
 * A client of `zenium --mcp`: one shim process on the profile, newline-delimited JSON-RPC on its
 * stdin / stdout. The same `initialize` / `call` / `close` face as {@link HttpClient}; `close`
 * ends stdin, which has the shim DELETE its session and exit.
 */
export class StdioClient {
  constructor({
    exe,
    userDataDir,
    extraArgs = [],
    name,
    leg = 'stdio',
    latencies = null,
    log = () => undefined,
    timeoutMs = CALL_TIMEOUT_MS
  }) {
    this.exe = exe
    this.userDataDir = userDataDir
    this.extraArgs = extraArgs
    this.name = name
    this.leg = leg
    this.latencies = latencies
    this.log = log
    this.timeoutMs = timeoutMs
    this.child = null
    this.pending = new Map()
    this.nextId = 1
    this.stderr = []
    this.exit = null
    this.exited = null
  }

  start() {
    const args = ['--mcp', `--user-data-dir=${this.userDataDir}`, ...this.extraArgs]
    const child = spawn(this.exe, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        this.onLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        this.stderr.push(line)
        if (this.stderr.length > 40) this.stderr.shift()
        this.log(`${this.name} stderr: ${line}`)
      }
    })
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.exit = { code, signal }
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(
            new SoakError(`${p.method}: the shim exited (${code ?? signal}) before answering`)
          )
        }
        this.pending.clear()
        resolve(this.exit)
      })
    })
    child.once('error', (error) => {
      this.log(`${this.name}: could not start ${this.exe}: ${error.message}`)
    })
    child.stdin.on('error', () => undefined)
    return this
  }

  onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.log(`${this.name}: unparsable line from the shim: ${line.slice(0, 120)}`)
      return
    }
    const p = message && this.pending.get(message.id)
    if (!p) return
    this.pending.delete(message.id)
    clearTimeout(p.timer)
    p.resolve(message)
  }

  write(message) {
    if (!this.child || this.exit) throw new SoakError(`${message.method}: the shim is not running`)
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  /** A request over stdin; resolves with the whole JSON-RPC response message. */
  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SoakError(`${method}: the shim gave no answer within ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.write(rpc(method, params, id))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.name, version: CLIENT_VERSION }
    })
    if (response.error)
      throw new SoakError(`initialize: ${response.error.code} ${response.error.message}`)
    this.write(rpc('notifications/initialized', undefined))
    return response.result
  }

  async call(name, args = {}) {
    const t0 = performance.now()
    const response = await this.request('tools/call', { name, arguments: args })
    const ms = performance.now() - t0
    this.latencies?.record(this.leg, name, ms)
    if (response.error)
      throw new SoakError(
        `${name}: JSON-RPC error ${response.error.code} ${response.error.message}`
      )
    const result = response.result ?? {}
    return { result, text: textOf(result), isError: Boolean(result.isError), ms, status: 200 }
  }

  async readResource(uri) {
    const response = await this.request('resources/read', { uri })
    if (response.error)
      throw new SoakError(`resources/read: ${response.error.code} ${response.error.message}`)
    return response.result?.contents ?? []
  }

  /** End stdin: the shim DELETEs its session and exits. True when it exited cleanly in time. */
  async close(timeoutMs = 15_000) {
    if (!this.child) return true
    if (!this.exit) {
      this.child.stdin.end()
      await Promise.race([this.exited, delay(timeoutMs)])
    }
    if (!this.exit) {
      this.child.kill('SIGKILL')
      await Promise.race([this.exited, delay(5000)])
      return false
    }
    return this.exit.code === 0
  }

  /** The last lines the shim said on stderr, for a failure's detail. */
  tail() {
    return this.stderr.slice(-6).join(' | ')
  }
}

// ---------------------------------------------------------------------------------------------
// The browser process (when this script starts it, or is told its pid)
// ---------------------------------------------------------------------------------------------

export class BrowserProcess {
  constructor({ exe, userDataDir, extraArgs = [], pid = null, log = () => undefined }) {
    this.exe = exe
    this.userDataDir = userDataDir
    this.extraArgs = extraArgs
    this.pid = pid
    this.log = log
    this.child = null
    this.tail = []
    this.launched = false
  }

  launch() {
    const args = [`--user-data-dir=${this.userDataDir}`, ...this.extraArgs]
    this.log(`launching ${this.exe} ${args.join(' ')}`)
    const child = spawn(this.exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const keep = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        this.tail.push(line)
        if (this.tail.length > 30) this.tail.shift()
      }
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.once('error', (error) => this.log(`could not start ${this.exe}: ${error.message}`))
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.log(`browser exited (${code ?? signal})`)
        if (this.child === child) this.child = null
        resolve({ code, signal })
      })
    })
    this.child = child
    this.pid = child.pid ?? null
    this.launched = true
  }

  alive() {
    if (this.child) return this.child.exitCode === null && this.child.signalCode === null
    if (!this.pid) return false
    try {
      process.kill(this.pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** SIGTERM (Electron quits on it), SIGKILL after `timeoutMs`; resolves once the process is gone. */
  async quit(timeoutMs = 30_000) {
    if (!this.pid) throw new Error('no browser process to quit (pass --pid or let --exe start it)')
    const started = Date.now()
    if (this.alive()) {
      this.log(`quitting the browser (pid ${this.pid}, SIGTERM)`)
      try {
        process.kill(this.pid, 'SIGTERM')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    while (this.alive() && Date.now() - started < timeoutMs) await delay(100)
    if (this.alive()) {
      this.log('the browser did not quit on SIGTERM; SIGKILL')
      try {
        process.kill(this.pid, 'SIGKILL')
      } catch {
        /* gone meanwhile */
      }
      while (this.alive() && Date.now() - started < timeoutMs + 5000) await delay(100)
    }
    this.log(`browser gone after ${fmtSeconds(Date.now() - started)}`)
    this.child = null
    this.pid = null
  }
}

// ---------------------------------------------------------------------------------------------
// One session's life
// ---------------------------------------------------------------------------------------------

/**
 * Runs a session's script over `client` (HTTP or stdio) and records its checks in `ctx.verdict`.
 * `index` decides the variants: odd sessions end without closeTabs (their group stays orphaned),
 * every fourth opens the slow page.
 */
export async function soakSession(client, ctx, { index, leg }) {
  const { verdict, fixture, latencies } = ctx
  const label = `${leg} #${index + 1}`
  const started = performance.now()
  const url = index % 4 === 3 ? fixture.slowUrl : fixture.url
  const closeOnFirstEnd = index % 2 === 0
  verdict.sessions++
  const call = async (name, args) => {
    const r = await client.call(name, args)
    verdict.calls++
    return r
  }
  let at = 'initialize'
  try {
    await client.initialize()
    verdict.hard(at, true)

    at = 'zen_status'
    let r = await call('zen_status', {})
    verdict.hard(at, !r.isError, r.text)

    at = 'zen_mode background'
    r = await call('zen_mode', { mode: 'background' })
    verdict.hard(at, !r.isError, r.text)

    at = 'browser_tabs new'
    r = await call('browser_tabs', { action: 'new', url })
    const tabId = openedTab(r.text)
    verdict.hard(at, !r.isError && Boolean(tabId), r.text)

    if (tabId) {
      at = 'background-snapshot'
      r = await call('browser_snapshot', { tabId })
      const snap = parseSnapshot(r.text)
      const heading = fixture.custom
        ? snap.headings.length > 0
        : snap.headings.some((h) => h.startsWith(FIXTURE.heading))
      const viewportOk = Boolean(
        snap.viewport && snap.viewport.width > 0 && snap.viewport.height > 0
      )
      verdict.hard(
        at,
        !r.isError && viewportOk && heading,
        r.isError
          ? `error: ${r.text}`
          : `viewport ${snap.viewport ? `${snap.viewport.width}×${snap.viewport.height}` : 'missing'}, headings ${JSON.stringify(snap.headings)}, ${snap.nodes.length} refs`
      )

      at = 'background-screenshot'
      r = await call('browser_take_screenshot', { tabId })
      verdict.hard(
        at,
        !r.isError && hasImage(r.result),
        r.isError ? r.text : 'no image part in the result'
      )

      // The form: by the refs the snapshot gave, else by CSS selector (the built-in fixture's).
      const form = FIXTURE.form
      const targets = {
        text: snap.ref('textbox') ?? (fixture.custom ? null : form.text.selector),
        select: snap.ref('combobox') ?? (fixture.custom ? null : form.select.selector),
        button: snap.ref('button') ?? (fixture.custom ? null : form.button.selector)
      }
      const viaRef = snap.ref('textbox') !== null
      if (targets.text && targets.select && targets.button) {
        verdict.bump(viaRef ? 'formViaRef' : 'formViaSelector')
        at = 'browser_type'
        r = await call('browser_type', { target: targets.text, text: `soak ${index + 1}`, tabId })
        verdict.hard(at, !r.isError, r.text)
        at = 'browser_select_option'
        r = await call('browser_select_option', {
          target: targets.select,
          values: [form.select.options[1]],
          tabId
        })
        verdict.hard(at, !r.isError, r.text)
        at = 'browser_click'
        r = await call('browser_click', { target: targets.button, tabId })
        verdict.hard(at, !r.isError, r.text)
      } else {
        for (const name of ['browser_type', 'browser_select_option', 'browser_click'])
          verdict.skip(name, 'hard', 'the snapshot gave no ref for the form (custom fixture)')
      }

      at = 'zen_mode foreground'
      r = await call('zen_mode', { mode: 'foreground' })
      verdict.hard(at, !r.isError, r.text)

      at = 'foreground-screenshot'
      r = await call('browser_take_screenshot', { tabId })
      verdict.hard(
        at,
        !r.isError && hasImage(r.result),
        r.isError ? r.text : 'no image part in the result'
      )
    }

    at = closeOnFirstEnd ? 'zen_session end closeTabs' : 'zen_session end'
    r = await call(
      'zen_session',
      closeOnFirstEnd ? { action: 'end', closeTabs: true } : { action: 'end' }
    )
    verdict.hard(at, !r.isError, r.text)

    // The connection survives the end: the same session id answers.
    at = 'zen_status after end'
    r = await call('zen_status', {})
    verdict.hard(at, !r.isError, r.text)

    at = 'zen_groups list'
    r = await call('zen_groups', { action: 'list', scope: 'all' })
    verdict.hard(at, !r.isError, r.text)
    const orphans = parseGroups(r.text).filter((g) => g.orphaned && g.was !== client.name)

    at = 'zen_groups adopt'
    if (!orphans.length) verdict.skip(at, 'hard', 'no orphaned group of another session to adopt')
    else {
      let adopted = null
      let raced = 0
      for (const g of orphans.slice(0, 3)) {
        const a = await call('zen_groups', { action: 'adopt', groupId: g.id })
        if (!a.isError) {
          adopted = g
          break
        }
        if (ADOPT_RACE.test(a.text)) {
          raced++
          continue
        }
        verdict.hard(at, false, a.text)
        adopted = false
        break
      }
      if (adopted) {
        verdict.hard(at, true)
        verdict.bump('adopted')
      } else if (adopted === null) {
        verdict.bump('adoptRaces', raced)
        verdict.skip(at, 'hard', 'every candidate was taken or closed by another session first')
      }
    }

    at = 'zen_session end closeTabs'
    r = await call('zen_session', { action: 'end', closeTabs: true })
    verdict.hard(at, !r.isError, r.text)

    at = 'delete'
    const closed = await client.close()
    verdict.hard(
      at,
      closed,
      client.tail
        ? `shim exit ${JSON.stringify(client.exit)}: ${client.tail()}`
        : 'DELETE did not answer 204'
    )
  } catch (error) {
    if (!(error instanceof SoakError)) throw error
    verdict.hard(at, false, `${label}: ${error.message}${client.tail ? ` – ${client.tail()}` : ''}`)
    verdict.bump('abortedSessions')
    ctx.log(`${label} aborted at ${at}: ${verdict.redact(error.message)}`)
    await client.close().catch(() => undefined)
  }
  const ms = performance.now() - started
  latencies?.record(leg, '(whole session)', ms)
  ctx.verbose(`${label}: ${fmtSeconds(ms)}`)
}

// ---------------------------------------------------------------------------------------------
// The legs
// ---------------------------------------------------------------------------------------------

/** `rounds` × `sessions` HTTP sessions, `concurrency` at a time. */
export async function soakMainLeg(ctx, { sessions, concurrency, rounds }) {
  ctx.log(
    `http leg: ${rounds} round(s) × ${sessions} sessions, ${concurrency} at a time, pages on ${ctx.fixture.url}`
  )
  for (let round = 1; round <= rounds; round++) {
    const t0 = Date.now()
    const before = ctx.verdict.snapshot()
    await pool(concurrency, sessions, async (i) => {
      const index = (round - 1) * sessions + i
      const client = new HttpClient({
        ...ctx.endpoint,
        name: `soak-http-${index + 1}`,
        leg: 'http',
        latencies: ctx.latencies
      })
      await soakSession(client, ctx, { index, leg: 'http' })
    })
    const d = ctx.verdict.since(before)
    ctx.log(
      `round ${round}/${rounds}: ${d.sessions} sessions, ${d.calls} calls in ${fmtSeconds(Date.now() - t0)}; ${d.hard} hard, ${d.soft} soft failure(s)`
    )
  }
}

/** `sessions` sessions through `zenium --mcp`, one shim process each. */
export async function soakShimLeg(ctx, { exe, userDataDir, sessions, concurrency }) {
  ctx.log(`stdio leg: ${sessions} sessions through ${exe} --mcp, ${concurrency} at a time`)
  const t0 = Date.now()
  const before = ctx.verdict.snapshot()
  await pool(concurrency, sessions, async (i) => {
    const client = new StdioClient({
      exe,
      userDataDir,
      extraArgs: ctx.extraArgs,
      name: `soak-stdio-${i + 1}`,
      leg: 'stdio',
      latencies: ctx.latencies,
      log: ctx.verbose
    }).start()
    await soakSession(client, ctx, { index: i, leg: 'stdio' })
  })
  const d = ctx.verdict.since(before)
  ctx.log(
    `stdio leg: ${d.sessions} sessions, ${d.calls} calls in ${fmtSeconds(Date.now() - t0)}; ${d.hard} hard, ${d.soft} soft failure(s)`
  )
}

/**
 * A client that stops calling without a DELETE: its group is listed as owned by it; another
 * client's `adopt` with `force: true` is the soft check (until E); after the DELETE the group is
 * orphaned and the other client adopts it (hard).
 */
export async function soakDropLeg(ctx) {
  const { verdict } = ctx
  ctx.log('drop leg: a client goes quiet without DELETE, another wants its group')
  const A = new HttpClient({ ...ctx.endpoint, name: 'soak-drop-A', latencies: ctx.latencies })
  const B = new HttpClient({ ...ctx.endpoint, name: 'soak-drop-B', latencies: ctx.latencies })
  const call = async (client, name, args) => {
    const r = await client.call(name, args)
    verdict.calls++
    return r
  }
  let at = 'drop-setup'
  try {
    await A.initialize()
    await call(A, 'zen_mode', { mode: 'background' })
    const opened = await call(A, 'browser_tabs', { action: 'new', url: ctx.fixture.url })
    const own = parseGroups((await call(A, 'zen_groups', { action: 'list' })).text)
    const group = own[0]
    if (!verdict.hard(at, Boolean(openedTab(opened.text)) && Boolean(group), opened.text)) return
    // A goes quiet here: no DELETE, no more calls.
    await B.initialize()
    at = 'drop-live-group-listed'
    const all = parseGroups((await call(B, 'zen_groups', { action: 'list', scope: 'all' })).text)
    const seen = all.find((g) => g.id === group.id)
    verdict.hard(at, Boolean(seen) && seen.owner === A.name, seen ? seen.flags : 'not listed')
    at = SOFT_CHECKS.dropForceAdopt
    const forced = await call(B, 'zen_groups', { action: 'adopt', groupId: group.id, force: true })
    const forcedOk = verdict.soft(at, !forced.isError, forced.text)
    at = 'delete'
    verdict.hard(at, await A.close(), 'DELETE of the quiet client did not answer 204')
    if (!forcedOk) {
      at = 'drop-adopt-after-delete'
      const after = parseGroups(
        (await call(B, 'zen_groups', { action: 'list', scope: 'all' })).text
      ).find((g) => g.id === group.id)
      const adopt = after?.orphaned
        ? await call(B, 'zen_groups', { action: 'adopt', groupId: group.id })
        : null
      verdict.hard(
        at,
        Boolean(after?.orphaned) && adopt !== null && !adopt.isError,
        adopt ? adopt.text : `after the DELETE the group was ${after ? `[${after.flags}]` : 'gone'}`
      )
    }
    at = 'zen_session end closeTabs'
    const end = await call(B, 'zen_session', { action: 'end', closeTabs: true })
    verdict.hard(at, !end.isError, end.text)
    at = 'delete'
    verdict.hard(at, await B.close(), 'DELETE did not answer 204')
  } catch (error) {
    if (!(error instanceof SoakError)) throw error
    verdict.hard(at, false, `drop leg: ${error.message}`)
    await A.close().catch(() => undefined)
    await B.close().catch(() => undefined)
  }
}

/**
 * Resurrection as the server promises it: a tools/call under a made-up session id WITH the
 * bearer token is answered 200 with the "resumed" notice; the same WITHOUT the token is a 404.
 */
export async function resurrectionProbes(ctx) {
  const { verdict } = ctx
  ctx.log('resurrection probes: a made-up session id with and without the token')
  const probe = new HttpClient({ ...ctx.endpoint, name: 'soak-resurrection' })
  const body = () => rpc('tools/call', { name: 'zen_status', arguments: {} }, probe.nextId++)
  try {
    const madeUp = randomSessionId()
    const withToken = await probe.post(body(), { headers: { 'mcp-session-id': madeUp } })
    verdict.calls++
    const text = withToken.json?.result ? textOf(withToken.json.result) : withToken.text
    verdict.hard(
      'resurrection-with-token',
      withToken.status === 200 && /resumed/.test(text),
      `HTTP ${withToken.status}: ${text.slice(0, 200)}`
    )
    probe.sessionId = madeUp
    verdict.hard(
      'delete',
      await probe.close(),
      'DELETE of the resurrected session did not answer 204'
    )

    const withoutToken = await probe.post(body(), {
      headers: { 'mcp-session-id': randomSessionId() },
      auth: false,
      session: false
    })
    verdict.calls++
    verdict.hard(
      'resurrection-without-token',
      withoutToken.status === 404,
      `HTTP ${withoutToken.status}: ${withoutToken.text.slice(0, 200)}`
    )
  } catch (error) {
    if (!(error instanceof SoakError)) throw error
    verdict.hard('resurrection-with-token', false, error.message)
  }
}

/**
 * Before a restart: an HTTP session (its id is what the restarted browser must answer) and a
 * shim process that stays alive across it. Returns what {@link restartVerify} needs.
 */
export async function restartCarry(ctx, { exe, userDataDir }) {
  const { verdict } = ctx
  const client = new HttpClient({
    ...ctx.endpoint,
    name: 'soak-restart-http',
    latencies: ctx.latencies
  })
  let carry = { sessionId: null, shim: null }
  try {
    await client.initialize()
    const r = await client.call('zen_status', {})
    verdict.calls++
    verdict.hard('restart-before', !r.isError, r.text)
    carry.sessionId = client.sessionId
  } catch (error) {
    if (!(error instanceof SoakError)) throw error
    verdict.hard('restart-before', false, error.message)
  }
  if (exe) {
    const shim = new StdioClient({
      exe,
      userDataDir,
      extraArgs: ctx.extraArgs,
      name: 'soak-restart-stdio',
      latencies: ctx.latencies,
      log: ctx.verbose
    }).start()
    try {
      await shim.initialize()
      const r = await shim.call('zen_status', {})
      verdict.calls++
      verdict.hard('restart-shim-before', !r.isError, r.text)
      carry.shim = shim
    } catch (error) {
      if (!(error instanceof SoakError)) throw error
      verdict.hard('restart-shim-before', false, `${error.message} – ${shim.tail()}`)
      await shim.close().catch(() => undefined)
    }
  }
  return carry
}

/** After the restart: the old session id (with the token) is answered, and so is the shim. */
export async function restartVerify(ctx, carry) {
  const { verdict } = ctx
  if (carry.sessionId) {
    const client = new HttpClient({
      ...ctx.endpoint,
      name: 'soak-restart-http',
      latencies: ctx.latencies
    })
    client.sessionId = carry.sessionId
    try {
      const r = await client.call('zen_status', {})
      verdict.calls++
      verdict.hard('restart-resume', !r.isError && /resumed/.test(r.text), r.text)
      verdict.hard('delete', await client.close(), 'DELETE after the restart did not answer 204')
    } catch (error) {
      if (!(error instanceof SoakError)) throw error
      verdict.hard('restart-resume', false, error.message)
    }
  }
  if (carry.shim) {
    try {
      const r = await carry.shim.call('zen_status', {})
      verdict.calls++
      verdict.hard('restart-shim', !r.isError, `${r.text.slice(0, 200)} – ${carry.shim.tail()}`)
    } catch (error) {
      if (!(error instanceof SoakError)) throw error
      verdict.hard('restart-shim', false, `${error.message} – ${carry.shim.tail()}`)
    }
    verdict.hard(
      'delete',
      await carry.shim.close(),
      `shim exit ${JSON.stringify(carry.shim.exit)}: ${carry.shim.tail()}`
    )
  }
}

/**
 * Leave the browser as it was: every orphaned group left behind is adopted and closed, and the
 * user's window, which the foreground sessions switched to the Agents space, is switched back to
 * the first space that is the user's own (`spaceReturned` counts it). The switch matters to a
 * restart: a window restored in a space with no tabs gets a new tab page there, and the next
 * quit then asks about "2 tabs" – a question neither this script nor SIGTERM can answer.
 */
export async function tidy(ctx) {
  const client = new HttpClient({ ...ctx.endpoint, name: 'soak-tidy' })
  try {
    await client.initialize()
    const all = parseGroups(
      (await client.call('zen_groups', { action: 'list', scope: 'all' })).text
    )
    let adopted = 0
    for (const g of all.filter((x) => x.orphaned)) {
      const r = await client.call('zen_groups', { action: 'adopt', groupId: g.id })
      if (!r.isError) adopted++
    }
    if (adopted) await client.call('zen_session', { action: 'end', closeTabs: true })
    ctx.verdict.bump('tidiedGroups', adopted)
    const spaces = parseSpaces((await client.call('zen_spaces', { action: 'list' })).text)
    const shown = spaces.find((sp) => sp.shown)
    const users = spaces.find((sp) => !sp.agents)
    if (shown?.agents && users) {
      await client.call('zen_mode', { mode: 'foreground' })
      // Another agent's lease outlives its last act by FOREGROUND_LEASE_MS (20 s): one wait.
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await client.call('zen_spaces', { action: 'switch', spaceId: users.id })
        if (!r.isError) {
          ctx.verdict.bump('spaceReturned', 1)
          break
        }
        if (!LEASE_HELD.test(r.text) || attempt === 1) {
          ctx.log(`tidy: the user's window stays in ${shown.name}: ${ctx.verdict.redact(r.text)}`)
          break
        }
        await delay(21_000)
      }
    }
    await client.close()
  } catch (error) {
    if (!(error instanceof SoakError)) throw error
    ctx.log(`tidy: ${ctx.verdict.redact(error.message)}`)
    await client.close().catch(() => undefined)
  }
}

/** `zenium://diagnostics` through a session of its own; null when it could not be read. */
export async function readDiagnostics(ctx) {
  const client = new HttpClient({ ...ctx.endpoint, name: 'soak-diagnostics' })
  try {
    await client.initialize()
    const contents = await client.readResource('zenium://diagnostics')
    await client.close()
    const text = contents.find((c) => typeof c.text === 'string')?.text
    return text ? JSON.parse(text) : null
  } catch (error) {
    if (!(error instanceof SoakError)) throw error
    ctx.log(`diagnostics: ${ctx.verdict.redact(error.message)}`)
    await client.close().catch(() => undefined)
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

function usage(problem) {
  const text = [
    'usage: node scripts/mcp-soak.mjs (--user-data-dir <profile> | --url <mcp url> --token <token>)',
    '         [--sessions 30] [--concurrency 6] [--rounds 3] [--fixture <url>] [--out <dir>]',
    '         [--shim <zenium exe>] [--shim-sessions 5] [--drop] [--restart --exe <zenium exe> [--pid <n>]]',
    '         [--extra-args="--no-sandbox --disable-gpu"] [--strict] [--keep] [--verbose]',
    'The header comment of the script says what each leg does.'
  ]
  if (problem) text.unshift(`mcp-soak: ${problem}`)
  process.stderr.write(text.join('\n') + '\n')
}

export async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    usage(error.message)
    return 2
  }
  if (opts.help) {
    usage()
    return 0
  }
  if (!opts.userDataDir && !(opts.url && opts.token)) {
    usage('--user-data-dir <profile>, or --url and --token, names the server')
    return 2
  }
  if (opts.restart && !(opts.exe && opts.userDataDir)) {
    usage('--restart needs --exe and --user-data-dir')
    return 2
  }
  const shimExe = opts.shim ?? (opts.restart ? opts.exe : null)
  if (shimExe && !opts.userDataDir) {
    usage('--shim needs --user-data-dir (the shim reads <profile>/zen/agent.json)')
    return 2
  }
  const out = opts.out ?? path.join(os.tmpdir(), 'mcp-soak')
  fs.mkdirSync(out, { recursive: true })

  const secrets = []
  const log = (line) => {
    let text = String(line)
    for (const s of secrets) text = text.split(s).join('<token>')
    process.stderr.write(`[soak] ${text}\n`)
  }
  const verbose = opts.verbose ? log : () => undefined

  const browser = new BrowserProcess({
    exe: opts.exe,
    userDataDir: opts.userDataDir,
    extraArgs: opts.extraArgs,
    pid: opts.pid,
    log
  })
  let endpoint = opts.url && opts.token ? { url: opts.url, token: opts.token } : null
  if (!endpoint) {
    endpoint = await probeEndpoint(opts.userDataDir)
    if (!endpoint) {
      if (!opts.exe) {
        usage(
          `no MCP server answers for ${opts.userDataDir} – start Zenium on that profile with Settings → AI Agents on, or pass --exe`
        )
        return 2
      }
      browser.launch()
      endpoint = await waitForEndpoint(opts.userDataDir, 90_000)
    }
  }
  secrets.push(endpoint.token)
  log(`server at ${endpoint.url}`)
  if (opts.restart && !browser.launched && !opts.pid) {
    usage(
      'the browser is already running and this script did not start it: --restart needs --pid <browser pid> to quit it'
    )
    return 2
  }

  const onSignal = () => {
    log('interrupted')
    if (browser.launched) browser.quit(5000).finally(() => process.exit(130))
    else process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  const fixture = opts.fixture
    ? { url: opts.fixture, slowUrl: opts.fixture, custom: true, close: async () => undefined }
    : await startFixture()
  const verdict = new Verdict({ secrets })
  const latencies = new Latencies()
  const ctx = { endpoint, fixture, verdict, latencies, log, verbose, extraArgs: opts.extraArgs }
  const legs = ['http']
  let diagnostics = null
  let diagnosticsAfterRestart = null
  try {
    await soakMainLeg(ctx, opts)
    if (shimExe && opts.shimSessions > 0) {
      legs.push('stdio')
      await soakShimLeg(ctx, {
        exe: shimExe,
        userDataDir: opts.userDataDir,
        sessions: opts.shimSessions,
        concurrency: Math.min(opts.concurrency, 3)
      })
    }
    if (opts.drop) {
      legs.push('drop')
      await soakDropLeg(ctx)
      await resurrectionProbes(ctx)
    }
    if (opts.restart) {
      legs.push('restart')
      const carry = await restartCarry(ctx, { exe: shimExe, userDataDir: opts.userDataDir })
      // The restart starts the server's counters over: what the soak did is read before it.
      // Tidied first, so the quit has no orphaned tabs to ask about (the open-tabs prompt would
      // hold the SIGTERM up until the SIGKILL, and a killed browser leaves no clean exit).
      await tidy(ctx)
      diagnostics = await readDiagnostics(ctx)
      await browser.quit()
      browser.launch()
      ctx.endpoint = endpoint = await waitForEndpoint(opts.userDataDir, 90_000)
      log(`server back at ${endpoint.url}`)
      await restartVerify(ctx, carry)
      await tidy(ctx)
      diagnosticsAfterRestart = await readDiagnostics(ctx)
    } else {
      await tidy(ctx)
      diagnostics = await readDiagnostics(ctx)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await fixture.close()
    if (browser.launched && !opts.keep) await browser.quit()
  }

  const summary = verdict.summary({
    options: {
      sessions: opts.sessions,
      concurrency: opts.concurrency,
      rounds: opts.rounds,
      shimSessions: shimExe ? opts.shimSessions : 0,
      legs,
      fixture: fixture.custom ? fixture.url : 'built-in',
      strict: opts.strict
    },
    latency: latencies.summary(),
    diagnostics,
    ...(opts.restart ? { diagnosticsAfterRestart } : {})
  })
  const file = path.join(out, 'soak.json')
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + '\n')
  console.log(formatTable(summary))
  console.log(`soak.json: ${file}`)
  return summary.counts.hardFailures > 0 || (opts.strict && summary.counts.softFailures > 0) ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error)
      process.exit(1)
    }
  )
}
