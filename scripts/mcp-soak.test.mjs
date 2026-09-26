// The pure parts of scripts/mcp-soak.mjs, and its legs against a fake of the MCP server (plain
// node:http, the wire shapes of src/core/agent/http.ts and the listing formats of tools.ts) – so
// the harness's accounting (hard vs soft, skips, counters, latencies, the table, soak.json) is
// proven before it ever meets a real build.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADOPT_RACE,
  DEFAULTS,
  FIXTURE,
  HttpClient,
  Latencies,
  SOFT_CHECKS,
  SoakError,
  Verdict,
  fixturePage,
  formatTable,
  hasImage,
  main,
  openedTab,
  parseArgs,
  parseGroups,
  parseSnapshot,
  percentiles,
  pool,
  randomSessionId,
  readDiagnostics,
  readEndpoint,
  resurrectionProbes,
  soakDropLeg,
  soakMainLeg,
  soakSession,
  startFixture,
  summarizeDiagnostics,
  textOf,
  tidy
} from './mcp-soak.mjs'

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

describe('parseArgs', () => {
  it('has the documented defaults', () => {
    const o = parseArgs([])
    expect(o.sessions).toBe(DEFAULTS.sessions)
    expect(o.concurrency).toBe(DEFAULTS.concurrency)
    expect(o.rounds).toBe(DEFAULTS.rounds)
    expect(o.shimSessions).toBe(DEFAULTS.shimSessions)
    expect(o).toMatchObject({
      drop: false,
      restart: false,
      strict: false,
      keep: false,
      help: false
    })
    expect(o.extraArgs).toEqual([])
    expect(o.userDataDir).toBeNull()
  })

  it('takes --key value, --key=value and bare flags', () => {
    const o = parseArgs([
      '--sessions=4',
      '--concurrency',
      '2',
      '--drop',
      '--verbose=false',
      '--extra-args=--no-sandbox  --disable-gpu',
      '--user-data-dir',
      'prof',
      '--url',
      'http://127.0.0.1:1/mcp',
      '--token=abc',
      '--pid',
      '4242'
    ])
    expect(o.sessions).toBe(4)
    expect(o.concurrency).toBe(2)
    expect(o.drop).toBe(true)
    expect(o.verbose).toBe(false)
    expect(o.extraArgs).toEqual(['--no-sandbox', '--disable-gpu'])
    expect(o.userDataDir).toBe(path.resolve('prof'))
    expect(o.url).toBe('http://127.0.0.1:1/mcp')
    expect(o.token).toBe('abc')
    expect(o.pid).toBe(4242)
  })

  it('refuses what it does not know', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option --bogus/)
    expect(() => parseArgs(['positional'])).toThrow(/unexpected argument/)
    expect(() => parseArgs(['--sessions', 'many'])).toThrow(/whole number/)
    expect(() => parseArgs(['--rounds=-1'])).toThrow(/whole number/)
    expect(() => parseArgs(['--out'])).toThrow(/needs a value/)
  })

  it('treats a concurrency of 0 as 1', () => {
    expect(parseArgs(['--concurrency=0']).concurrency).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

describe('percentiles', () => {
  it('is nearest-rank, like the server', () => {
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i)
    expect(percentiles(samples)).toEqual({ count: 100, p50: 50, p95: 95, max: 100 })
    expect(percentiles([7.26])).toEqual({ count: 1, p50: 7.3, p95: 7.3, max: 7.3 })
    expect(percentiles([])).toEqual({ count: 0, p50: 0, p95: 0, max: 0 })
  })
})

describe('pool', () => {
  it('runs every index with at most `concurrency` in flight', async () => {
    let inFlight = 0
    let peak = 0
    const seen = []
    await pool(3, 10, async (i) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      seen.push(i)
      inFlight--
    })
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(peak).toBe(3)
    let ran = 0
    await pool(8, 2, async () => {
      ran++
    })
    expect(ran).toBe(2)
  })
})

describe('result helpers', () => {
  it('reads text and image parts', () => {
    const result = {
      content: [
        { type: 'text', text: 'one' },
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        { type: 'text', text: 'two' }
      ]
    }
    expect(textOf(result)).toBe('one\ntwo')
    expect(hasImage(result)).toBe(true)
    expect(hasImage({ content: [{ type: 'image', data: '', mimeType: 'image/png' }] })).toBe(false)
    expect(hasImage({ content: [{ type: 'text', text: 'no' }] })).toBe(false)
    expect(textOf(undefined)).toBe('')
  })

  it('finds the tab browser_tabs new opened', () => {
    expect(
      openedTab(
        'Opened tab tab_a1-B2 in your group "x" (folder_1) at http://h/. Pass tabId: "tab_a1-B2" to page tools.'
      )
    ).toBe('tab_a1-B2')
    expect(openedTab('Nothing here')).toBeNull()
  })

  it('makes 24-hex-character session ids', () => {
    const id = randomSessionId()
    expect(id).toMatch(/^[0-9a-f]{24}$/)
    expect(randomSessionId()).not.toBe(id)
  })
})

describe('parseSnapshot', () => {
  const text = [
    'Snapshot of tab tab_1',
    '- Page URL: http://127.0.0.1:1/',
    '- Page Title: Soak fixture',
    '- Tab: tab_1 "Soak fixture" http://127.0.0.1:1/',
    '- Viewport: 1000×800 CSS px, scrolled to 0 of 0 (bottom); 5 elements',
    '- Page Snapshot (each line: role "name" [attributes] [ref=eN] – pass the eN as target):',
    '```yaml',
    '- main [ref=e1]',
    '  - heading "Soak fixture" [level=1] [ref=e2]',
    '  - paragraph "The MCP soak\'s \\"page\\"" [ref=e3]',
    '  - textbox "Name" [ref=e4]',
    '  - combobox "Kind" [value=one] [ref=e5]',
    '  - button "Go" [ref=e6]',
    '```'
  ].join('\n')

  it('reads the viewport, the nodes and the headings', () => {
    const snap = parseSnapshot(text)
    expect(snap.viewport).toEqual({ width: 1000, height: 800 })
    expect(snap.nodes.map((n) => n.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6'])
    expect(snap.headings).toEqual(['Soak fixture'])
    expect(snap.nodes[2].name).toBe('The MCP soak\'s "page"')
    expect(snap.nodes[4]).toEqual({
      role: 'combobox',
      name: 'Kind',
      attrs: '[value=one]',
      ref: 'e5'
    })
    expect(snap.ref('textbox')).toBe('e4')
    expect(snap.ref('button', 'Go')).toBe('e6')
    expect(snap.ref('button', 'Stop')).toBeNull()
    expect(snap.ref('link')).toBeNull()
  })

  it('copes with an unpainted page', () => {
    const snap = parseSnapshot(
      '- Viewport: 0×0 CSS px, scrolled to 0 of 0 (bottom)\n```yaml\n(nothing visible yet)\n```'
    )
    expect(snap.viewport).toEqual({ width: 0, height: 0 })
    expect(snap.nodes).toEqual([])
    expect(parseSnapshot('The page could not be read').viewport).toBeNull()
  })
})

describe('parseGroups', () => {
  it('reads every header line with its flags', () => {
    const text = [
      "Every agent group (3) and the user's folders:",
      'Group "soak-http-1" (folder_a1) [home, yours] in space "Agents" – 1 tab:',
      '- tab_1 "Soak fixture" http://127.0.0.1:1/ [group: "soak-http-1", yours]',
      'Group "left \\"behind\\"" (folder_b2) [orphaned, was "soak-http-3"] in space "Agents" – 2 tabs:',
      '- tab_2 "x" http://x/ [orphaned]',
      '- tab_3 "y" http://y/ [orphaned]',
      'Group "B" (folder_c3) [owned by "soak-drop-A"] in space "Agents" – 0 tabs:',
      '  (empty)',
      '',
      "The user's folders (1; not yours to use):",
      'Group "Work" (folder_d4) [the user\'s] in space "Personal" – 4 tabs:'
    ].join('\n')
    const groups = parseGroups(text)
    expect(groups.map((g) => g.id)).toEqual(['folder_a1', 'folder_b2', 'folder_c3', 'folder_d4'])
    expect(groups[0]).toMatchObject({
      name: 'soak-http-1',
      space: 'Agents',
      tabs: 1,
      home: true,
      yours: true,
      orphaned: false,
      was: null,
      owner: null,
      user: false
    })
    expect(groups[1]).toMatchObject({
      name: 'left "behind"',
      tabs: 2,
      orphaned: true,
      was: 'soak-http-3',
      yours: false
    })
    expect(groups[2]).toMatchObject({ owner: 'soak-drop-A', orphaned: false, tabs: 0 })
    expect(groups[3]).toMatchObject({ user: true, space: 'Personal', tabs: 4 })
    expect(parseGroups('You have no groups.')).toEqual([])
  })

  it('knows the adopt races', () => {
    expect(
      ADOPT_RACE.test('Group "x" (folder_1) belongs to agent "A", which is still connected')
    ).toBe(true)
    expect(ADOPT_RACE.test('Unknown group "folder_9"')).toBe(true)
    expect(ADOPT_RACE.test('Group folder_1 is already yours')).toBe(true)
    expect(ADOPT_RACE.test('Not authorized')).toBe(false)
  })
})

describe('readEndpoint', () => {
  it('reads <profile>/zen/agent.json and is null without one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-soak-test-'))
    try {
      expect(readEndpoint(dir)).toBeNull()
      fs.mkdirSync(path.join(dir, 'zen'))
      fs.writeFileSync(
        path.join(dir, 'zen', 'agent.json'),
        JSON.stringify({
          token: 't'.repeat(32),
          running: true,
          port: 41735,
          url: 'http://127.0.0.1:41735/mcp'
        })
      )
      expect(readEndpoint(dir)).toEqual({
        url: 'http://127.0.0.1:41735/mcp',
        token: 't'.repeat(32),
        running: true
      })
      fs.writeFileSync(path.join(dir, 'zen', 'agent.json'), '{"running": true}')
      expect(readEndpoint(dir)).toBeNull()
      fs.writeFileSync(path.join(dir, 'zen', 'agent.json'), 'not json')
      expect(readEndpoint(dir)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The verdict and the table
// ---------------------------------------------------------------------------------------------

describe('Verdict', () => {
  it('counts hard and soft checks, skips and counters, and redacts the token', () => {
    const v = new Verdict({ secrets: ['s3cret-token', ''] })
    expect(v.hard('a', true)).toBe(true)
    expect(v.hard('a', false, 'Bearer s3cret-token was refused')).toBe(false)
    expect(v.soft('b (until B)', false, 'no image')).toBe(false)
    v.skip('c', 'hard', 'nothing to adopt')
    v.skip('c', 'hard', 'nothing to adopt')
    v.bump('adopted')
    v.bump('adopted', 2)
    v.sessions = 2
    v.calls = 9
    expect(v.hardFailures).toBe(1)
    expect(v.softFailures).toBe(1)
    expect(v.hardFailed()).toEqual([
      { name: 'a', fail: 1, samples: ['Bearer <token> was refused'] }
    ])
    const s = v.summary({ extra: 1 })
    expect(s.ok).toBe(false)
    expect(s.counts).toEqual({
      sessions: 2,
      calls: 9,
      hardFailures: 1,
      softFailures: 1,
      skipped: 2,
      adopted: 3
    })
    expect(s.checks.a).toMatchObject({ kind: 'hard', pass: 1, fail: 1, skipped: 0 })
    expect(s.checks.c).toMatchObject({
      kind: 'hard',
      skipped: 2,
      skipReasons: ['nothing to adopt']
    })
    expect(s.extra).toBe(1)
    expect(typeof s.wallMs).toBe('number')
    const before = v.snapshot()
    v.hard('a', false, 'again')
    v.calls++
    expect(v.since(before)).toEqual({ hard: 1, soft: 0, sessions: 0, calls: 1 })
  })

  it('keeps at most three samples per check', () => {
    const v = new Verdict()
    for (let i = 0; i < 5; i++) v.hard('x', false, `sample ${i}`)
    expect(v.summary().checks.x.samples).toEqual(['sample 0', 'sample 1', 'sample 2'])
  })
})

describe('Latencies and the table', () => {
  it('summarises per leg and tool, and the table names every check and the verdict', () => {
    const l = new Latencies()
    l.record('http', 'zen_status', 3)
    l.record('http', 'zen_status', 5)
    l.record('stdio', 'browser_snapshot', 40)
    expect(l.summary()).toEqual({
      http: { zen_status: { count: 2, p50: 3, p95: 5, max: 5 } },
      stdio: { browser_snapshot: { count: 1, p50: 40, p95: 40, max: 40 } }
    })
    const v = new Verdict()
    v.hard('initialize', true)
    v.soft(SOFT_CHECKS.backgroundScreenshot, false, 'no image')
    v.sessions = 1
    v.calls = 4
    const table = formatTable(
      v.summary({
        latency: l.summary(),
        diagnostics: {
          sessions: {
            live: 1,
            parked: 0,
            created: 3,
            ended: 2,
            parkedTotal: 0,
            resumed: 0,
            resurrected: 1,
            closed: 2,
            unknown: 1
          },
          calls: { total: 40, errors: 2, inFlight: 0 },
          tools: { zen_status: { calls: 10, errors: 0, p50Ms: 1, p95Ms: 2, maxMs: 3 } }
        }
      })
    )
    expect(table).toContain('HARD  initialize')
    expect(table).toContain(`SOFT  ${SOFT_CHECKS.backgroundScreenshot}`)
    expect(table).toContain('http  zen_status')
    expect(table).toContain('stdio  browser_snapshot')
    expect(table).toContain('server: sessions 1 live (0 parked), 3 created, 2 ended')
    expect(table).toContain('1 resurrected, 2 closed, 1 unknown; calls 40 (2 errors, 0 running)')
    expect(table).toContain('slowest: zen_status p95 2 ms')
    expect(table).toMatch(
      /1 sessions, 4 calls, 0 hard failure\(s\), 1 soft failure\(s\) \(background-screenshot \(until B\) ×1\) in \d+\.\d s – PASS$/
    )
    expect(summarizeDiagnostics(null)).toBe('no diagnostics read')
  })
})

// ---------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------

describe('the fixture', () => {
  it('has the heading and the form the checks look for, and serves them', async () => {
    const page = fixturePage()
    expect(page).toContain(`<h1`)
    expect(page).toContain(FIXTURE.heading)
    for (const control of Object.values(FIXTURE.form))
      expect(page).toContain(`id="${control.selector.slice(1)}"`)
    for (const option of FIXTURE.form.select.options) expect(page).toContain(`<option>${option}`)
    expect(fixturePage('slow')).toContain(`after ${FIXTURE.slowDelayMs} ms`)

    const fixture = await startFixture()
    try {
      expect(fixture.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
      expect(fixture.slowUrl).toBe(`${fixture.origin}${FIXTURE.slowPath}`)
      expect(fixture.custom).toBe(false)
      const res = await fetch(fixture.url)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toBe(page)
      expect((await fetch(`${fixture.origin}/favicon.ico`)).status).toBe(204)
      expect((await fetch(`${fixture.origin}/nope`)).status).toBe(404)
      expect(fixture.requests).toBe(3)
    } finally {
      await fixture.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------
// A fake of the MCP server: the wire of http.ts, the listing formats of tools.ts, orphaned
// groups, adoption, resurrection and diagnostics – enough for every leg but the shim's
// ---------------------------------------------------------------------------------------------

const TOKEN = 'fake-token-0123456789abcdef0123456789abcdef'
const RESUMED =
  'Notice: your connection was resumed without an initialize – your groups are yours again.'

class FakeZenium {
  /**
   * `screenshots`: 'image' (always an image), 'hidden-error' (an error while the session is in
   * background mode, as PR-A does), 'error' (always). `hiddenSnapshot`: a 0×0 viewport and no
   * refs in background mode (PR-A). `forceAdopt`: adopt with force: true takes a live agent's
   * group (PR-E). `resurrect`: unknown ids with the token are resumed (PR-A); false 404s them.
   */
  constructor({
    screenshots = 'image',
    hiddenSnapshot = false,
    forceAdopt = false,
    resurrect = true
  } = {}) {
    this.options = { screenshots, hiddenSnapshot, forceAdopt, resurrect }
    this.sessions = new Map()
    this.groups = new Map()
    this.tabs = new Map()
    this.seq = 0
    this.counters = {
      created: 0,
      ended: 0,
      resurrected: 0,
      closed: 0,
      unknown: 0,
      calls: 0,
      errors: 0
    }
    this.tools = new Map()
    this.requests = []
    this.server = http.createServer((req, res) => this.handle(req, res))
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${this.server.address().port}/mcp`
    return this
  }

  async stop() {
    this.server.closeAllConnections()
    await new Promise((resolve) => this.server.close(() => resolve()))
  }

  handle(req, res) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const out = this.respond(req, body)
      this.requests.push({ method: req.method, status: out.status })
      res.writeHead(out.status, {
        'content-type': 'application/json',
        ...(out.sessionId ? { 'mcp-session-id': out.sessionId } : {})
      })
      res.end(out.body === undefined ? '' : JSON.stringify(out.body))
    })
  }

  authorized(req) {
    return req.headers.authorization === `Bearer ${TOKEN}`
  }

  respond(req, body) {
    const sid = req.headers['mcp-session-id']
    if (req.method === 'DELETE') {
      const s = sid && this.sessions.get(sid)
      if (!s) return { status: 404 }
      this.closeSession(s)
      return { status: 204 }
    }
    if (req.method !== 'POST') return { status: 405 }
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      return { status: 400 }
    }
    const error = (status, code, message) => ({
      status,
      body: { jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } }
    })
    if (msg.method === 'initialize') {
      const s = this.createSession(msg.params?.clientInfo?.name ?? 'agent')
      return {
        status: 200,
        sessionId: s.id,
        body: {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'fake-zenium', version: '0' }
          }
        }
      }
    }
    let s = sid ? this.sessions.get(sid) : null
    let notice = ''
    if (!s) {
      if (!sid || !this.authorized(req) || !this.options.resurrect) {
        this.counters.unknown++
        return error(404, -32001, 'Unknown session – initialize again')
      }
      s = this.createSession(`resumed-${sid.slice(0, 6)}`, sid)
      this.counters.resurrected++
      notice = RESUMED
    }
    if (typeof msg.method === 'string' && msg.method.startsWith('notifications/'))
      return { status: 202 }
    if (msg.method === 'resources/read') {
      if (msg.params?.uri !== 'zenium://diagnostics') return error(200, -32002, 'Unknown resource')
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            contents: [
              {
                uri: 'zenium://diagnostics',
                mimeType: 'application/json',
                text: JSON.stringify(this.diagnostics())
              }
            ]
          }
        }
      }
    }
    if (msg.method !== 'tools/call') return error(200, -32601, `Method not found: ${msg.method}`)
    const name = msg.params?.name
    const args = msg.params?.arguments ?? {}
    this.counters.calls++
    const t = this.tools.get(name) ?? { calls: 0, errors: 0 }
    t.calls++
    this.tools.set(name, t)
    let result
    try {
      result = this.tool(s, name, args)
    } catch (e) {
      result = { content: [{ type: 'text', text: e.message }], isError: true }
    }
    if (result.isError) {
      this.counters.errors++
      t.errors++
    }
    if (notice) result.content.unshift({ type: 'text', text: notice })
    return { status: 200, body: { jsonrpc: '2.0', id: msg.id, result } }
  }

  createSession(name, id = randomSessionId()) {
    const s = { id, name, mode: 'foreground', home: null }
    this.sessions.set(id, s)
    this.counters.created++
    return s
  }

  closeSession(s) {
    this.releaseGroups(s)
    this.sessions.delete(s.id)
    this.counters.closed++
  }

  groupsOf(s) {
    return [...this.groups.values()].filter((g) => g.owner === s.id)
  }

  releaseGroups(s) {
    for (const g of this.groupsOf(s)) {
      g.owner = null
      g.was = s.name
    }
    s.home = null
  }

  closeGroup(g) {
    for (const tabId of g.tabs) this.tabs.delete(tabId)
    this.groups.delete(g.id)
  }

  header(s, g, scope) {
    const flags = []
    if (g.id === s.home) flags.push('home')
    if (scope === 'all') {
      if (g.owner) {
        const owner = this.sessions.get(g.owner)
        flags.push(owner.id === s.id ? 'yours' : `owned by ${JSON.stringify(owner.name)}`)
      } else flags.push(g.was ? `orphaned, was ${JSON.stringify(g.was)}` : 'orphaned')
    }
    const n = g.tabs.length
    return `Group ${JSON.stringify(g.name)} (${g.id})${flags.length ? ` [${flags.join(', ')}]` : ''} in space "Agents" – ${n} tab${n === 1 ? '' : 's'}:`
  }

  listing(s, scope) {
    const groups = scope === 'all' ? [...this.groups.values()] : this.groupsOf(s)
    if (!groups.length) return 'You have no groups yet.'
    const lines = []
    for (const g of groups) {
      lines.push(this.header(s, g, scope))
      if (!g.tabs.length) lines.push('  (empty)')
      for (const id of g.tabs) lines.push(`- ${id} "Soak fixture" ${this.tabs.get(id).url}`)
    }
    return lines.join('\n')
  }

  snapshot(s, tabId) {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error(`Unknown tab ${tabId}`)
    const hidden = this.options.hiddenSnapshot && s.mode === 'background'
    const tree = hidden
      ? '(nothing visible yet)'
      : [
          '- main [ref=e1]',
          '  - heading "Soak fixture" [level=1] [ref=e2]',
          '  - textbox "Name" [ref=e3]',
          '  - combobox "Kind" [value=one] [ref=e4]',
          '  - button "Go" [ref=e5]'
        ].join('\n')
    return [
      `Snapshot of tab ${tabId}`,
      `- Page URL: ${tab.url}`,
      '- Page Title: Soak fixture',
      `- Viewport: ${hidden ? '0×0' : '1000×800'} CSS px, scrolled to 0 of 0 (bottom)`,
      '- Page Snapshot (each line: role "name" [attributes] [ref=eN] – pass the eN as target):',
      '```yaml',
      tree,
      '```'
    ].join('\n')
  }

  tool(s, name, args) {
    const text = (t) => ({ content: [{ type: 'text', text: t }] })
    const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
    const needTab = () => {
      if (!args.tabId || !this.tabs.has(args.tabId)) throw new Error(`Unknown tab ${args.tabId}`)
      return this.tabs.get(args.tabId)
    }
    switch (name) {
      case 'zen_status':
        return text(`You are ${JSON.stringify(s.name)} (session ${s.id}) in ${s.mode} mode.`)
      case 'zen_mode':
        if (args.mode !== 'foreground' && args.mode !== 'background')
          throw new Error('mode must be "foreground" or "background"')
        s.mode = args.mode
        return text(`Mode: ${s.mode}.`)
      case 'browser_tabs': {
        if (args.action !== 'new') throw new Error(`Unsupported action ${args.action}`)
        let home = s.home && this.groups.get(s.home)
        if (!home) {
          home = { id: `folder_${++this.seq}`, name: s.name, owner: s.id, was: null, tabs: [] }
          this.groups.set(home.id, home)
          s.home = home.id
        }
        const tab = { id: `tab_${++this.seq}`, url: args.url, group: home.id }
        this.tabs.set(tab.id, tab)
        home.tabs.push(tab.id)
        return text(
          `Opened tab ${tab.id} in your group ${JSON.stringify(home.name)} (${home.id}) at ${tab.url}. Pass tabId: ${JSON.stringify(tab.id)} to page tools.`
        )
      }
      case 'browser_snapshot':
        return text(this.snapshot(s, needTab().id))
      case 'browser_take_screenshot': {
        needTab()
        const mode = this.options.screenshots
        if (mode === 'error' || (mode === 'hidden-error' && s.mode === 'background'))
          return fail(
            'The page could not be captured (a hidden tab may have nothing painted yet – try zen_mode foreground)'
          )
        return { content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/jpeg' }] }
      }
      case 'browser_type':
      case 'browser_select_option':
      case 'browser_click': {
        const tab = needTab()
        if (typeof args.target !== 'string' || !/^(e\d+|#[\w-]+)$/.test(args.target))
          throw new Error(`Bad target ${JSON.stringify(args.target)}`)
        if (name === 'browser_type' && typeof args.text !== 'string') throw new Error('text needed')
        if (name === 'browser_select_option' && !Array.isArray(args.values))
          throw new Error('values needed')
        return text(`${name} on ${args.target}\n\n${this.snapshot(s, tab.id)}`)
      }
      case 'zen_session': {
        if (args.action !== 'end') throw new Error(`Unsupported action ${args.action}`)
        if (args.closeTabs) for (const g of this.groupsOf(s)) this.closeGroup(g)
        else this.releaseGroups(s)
        s.home = null
        s.mode = 'foreground'
        this.counters.ended++
        return text('Your session ended; the connection stays open.')
      }
      case 'zen_groups': {
        if (args.action === 'list')
          return text(this.listing(s, args.scope === 'all' ? 'all' : 'own'))
        if (args.action !== 'adopt') throw new Error(`Unsupported action ${args.action}`)
        const g = this.groups.get(args.groupId)
        if (!g) return fail(`Unknown group ${JSON.stringify(args.groupId)}`)
        if (g.owner === s.id) return fail(`Group ${g.id} is already yours`)
        if (g.owner) {
          const owner = this.sessions.get(g.owner)
          if (!(args.force === true && this.options.forceAdopt))
            return fail(
              `Group ${JSON.stringify(g.name)} (${g.id}) belongs to agent ${JSON.stringify(owner.name)}, which is still connected${args.force !== undefined && !this.options.forceAdopt ? '\n\n(Ignored unknown argument force)' : ''}`
            )
        }
        const was = g.owner ? this.sessions.get(g.owner).name : g.was
        g.owner = s.id
        g.was = null
        if (!s.home) s.home = g.id
        return text(
          `Adopted group ${g.id} ${JSON.stringify(g.name)} (was ${JSON.stringify(was)}'s) with ${g.tabs.length} tab${g.tabs.length === 1 ? '' : 's'}.\n\nYour groups:\n${this.listing(s, 'own')}`
        )
      }
      default:
        throw new Error(`Unknown tool ${name}`)
    }
  }

  diagnostics() {
    const tools = {}
    for (const [name, t] of this.tools)
      tools[name] = { calls: t.calls, errors: t.errors, p50Ms: 1, p95Ms: 2, maxMs: 3 }
    const c = this.counters
    return {
      sessions: {
        live: this.sessions.size,
        parked: 0,
        created: c.created,
        ended: c.ended,
        parkedTotal: 0,
        resumed: 0,
        resurrected: c.resurrected,
        closed: c.closed,
        unknown: c.unknown
      },
      calls: { total: c.calls, errors: c.errors, inFlight: 0 },
      tools,
      recentErrors: []
    }
  }
}

const silent = () => undefined

function context(fake, { fixture, secrets = [TOKEN] } = {}) {
  return {
    endpoint: { url: fake.url, token: TOKEN },
    fixture: fixture ?? {
      url: 'http://fixture.test/',
      slowUrl: 'http://fixture.test/slow',
      custom: false,
      close: async () => undefined
    },
    verdict: new Verdict({ secrets }),
    latencies: new Latencies(),
    log: silent,
    verbose: silent,
    extraArgs: []
  }
}

let fake = null
afterEach(async () => {
  if (fake) await fake.stop()
  fake = null
})

describe('HttpClient', () => {
  it('initializes, calls, reads resources and DELETEs, recording latencies', async () => {
    fake = await new FakeZenium().start()
    const latencies = new Latencies()
    const c = new HttpClient({ url: fake.url, token: TOKEN, name: 'unit', latencies })
    const init = await c.initialize()
    expect(init.serverInfo.name).toBe('fake-zenium')
    expect(c.sessionId).toMatch(/^[0-9a-f]{24}$/)
    const r = await c.call('zen_status')
    expect(r.isError).toBe(false)
    expect(r.text).toContain('"unit"')
    expect(latencies.summary().http.zen_status.count).toBe(1)
    const bad = await c.call('zen_mode', { mode: 'sideways' })
    expect(bad.isError).toBe(true)
    const contents = await c.readResource('zenium://diagnostics')
    expect(JSON.parse(contents[0].text).sessions.live).toBe(1)
    await expect(c.request('nope', {})).rejects.toBeInstanceOf(SoakError)
    expect(await c.close()).toBe(true)
    expect(c.sessionId).toBeNull()
    expect(fake.sessions.size).toBe(0)
    // A call without a session, and without the token, is the server's 404.
    await expect(c.call('zen_status')).rejects.toThrow(/HTTP 404/)
    const anon = new HttpClient({ url: fake.url, token: null, name: 'anon' })
    anon.sessionId = randomSessionId()
    await expect(anon.call('zen_status')).rejects.toThrow(/HTTP 404 Unknown session/)
  })

  it('turns a dead server into a SoakError', async () => {
    const c = new HttpClient({
      url: 'http://127.0.0.1:9/mcp',
      token: TOKEN,
      name: 'x',
      timeoutMs: 500
    })
    await expect(c.initialize()).rejects.toBeInstanceOf(SoakError)
  })
})

describe('soakSession', () => {
  it("runs an agent's life with no failure against a compliant server", async () => {
    fake = await new FakeZenium().start()
    const ctx = context(fake)
    const first = new HttpClient({ ...ctx.endpoint, name: 'soak-http-1', latencies: ctx.latencies })
    await soakSession(first, ctx, { index: 1, leg: 'http' }) // odd: its group stays orphaned
    const second = new HttpClient({
      ...ctx.endpoint,
      name: 'soak-http-2',
      latencies: ctx.latencies
    })
    await soakSession(second, ctx, { index: 2, leg: 'http' })
    const v = ctx.verdict
    expect(v.hardFailures).toBe(0)
    expect(v.softFailures).toBe(0)
    expect(v.sessions).toBe(2)
    // 14 calls each, plus the second session's adopt of the first's orphan.
    expect(v.calls).toBe(29)
    expect(v.counters).toEqual({ formViaRef: 2, adopted: 1 })
    const s = v.summary()
    expect(s.checks['zen_groups adopt']).toMatchObject({
      kind: 'hard',
      pass: 1,
      fail: 0,
      skipped: 1
    })
    expect(s.checks['zen_status after end']).toMatchObject({ pass: 2 })
    expect(s.checks['zen_session end']).toMatchObject({ pass: 1 })
    expect(s.checks['zen_session end closeTabs']).toMatchObject({ pass: 3 })
    expect(s.checks.delete).toMatchObject({ pass: 2 })
    for (const name of Object.values(SOFT_CHECKS).slice(0, 3))
      expect(s.checks[name]).toMatchObject({ kind: 'soft', pass: 2, fail: 0 })
    expect(fake.groups.size).toBe(0)
    expect(fake.sessions.size).toBe(0)
    const latency = ctx.latencies.summary().http
    expect(latency.browser_snapshot.count).toBe(2)
    expect(latency['(whole session)'].count).toBe(2)
    expect(fake.tabs.size).toBe(0)
  })

  it("reports PR-A's background limits as soft failures and falls back to CSS selectors", async () => {
    fake = await new FakeZenium({ screenshots: 'hidden-error', hiddenSnapshot: true }).start()
    const ctx = context(fake)
    const client = new HttpClient({
      ...ctx.endpoint,
      name: 'soak-http-1',
      latencies: ctx.latencies
    })
    await soakSession(client, ctx, { index: 0, leg: 'http' })
    const v = ctx.verdict
    expect(v.hardFailures).toBe(0)
    expect(v.softFailures).toBe(2)
    const s = v.summary()
    expect(s.ok).toBe(true)
    expect(s.checks[SOFT_CHECKS.backgroundSnapshot]).toMatchObject({ fail: 1 })
    expect(s.checks[SOFT_CHECKS.backgroundSnapshot].samples[0]).toContain('viewport 0×0')
    expect(s.checks[SOFT_CHECKS.backgroundScreenshot]).toMatchObject({ fail: 1 })
    expect(s.checks[SOFT_CHECKS.foregroundScreenshot]).toMatchObject({ pass: 1, fail: 0 })
    expect(v.counters).toEqual({ formViaSelector: 1 })
    expect(s.checks.browser_type).toMatchObject({ pass: 1 })
  })

  it('records a transport failure under the check it was at and aborts the session', async () => {
    fake = await new FakeZenium().start()
    const ctx = context(fake)
    const client = new HttpClient({
      ...ctx.endpoint,
      name: 'soak-http-1',
      latencies: ctx.latencies
    })
    const original = client.call.bind(client)
    let n = 0
    client.call = async (name, args) => {
      if (++n === 3) throw new SoakError(`${name}: HTTP 500`)
      return original(name, args)
    }
    await soakSession(client, ctx, { index: 0, leg: 'http' })
    const s = ctx.verdict.summary()
    expect(s.ok).toBe(false)
    expect(s.checks['browser_tabs new']).toMatchObject({ kind: 'hard', fail: 1 })
    expect(s.checks['browser_tabs new'].samples[0]).toContain('HTTP 500')
    expect(ctx.verdict.counters.abortedSessions).toBe(1)
    expect(fake.sessions.size).toBe(0) // the client still DELETEd
  })

  it('skips the form on a custom fixture without refs', async () => {
    fake = await new FakeZenium({ hiddenSnapshot: true }).start()
    const ctx = context(fake, {
      fixture: {
        url: 'http://mine/',
        slowUrl: 'http://mine/',
        custom: true,
        close: async () => undefined
      }
    })
    const client = new HttpClient({
      ...ctx.endpoint,
      name: 'soak-http-1',
      latencies: ctx.latencies
    })
    await soakSession(client, ctx, { index: 0, leg: 'http' })
    const s = ctx.verdict.summary()
    expect(ctx.verdict.hardFailures).toBe(0)
    expect(s.checks.browser_type).toMatchObject({ pass: 0, skipped: 1 })
    expect(s.checks.browser_click.skipReasons[0]).toMatch(/custom fixture/)
  })
})

describe('the legs', () => {
  it('soakMainLeg runs rounds × sessions with adoption of earlier orphans', async () => {
    fake = await new FakeZenium().start()
    const ctx = context(fake)
    await soakMainLeg(ctx, { sessions: 6, concurrency: 3, rounds: 2 })
    const v = ctx.verdict
    expect(v.sessions).toBe(12)
    expect(v.hardFailures).toBe(0)
    expect(v.calls).toBeGreaterThanOrEqual(12 * 14)
    expect(v.counters.adopted).toBeGreaterThanOrEqual(3)
    expect(fake.sessions.size).toBe(0)
    expect(fake.counters.created).toBe(12)
    expect(fake.counters.ended).toBe(24)
    // Whatever odd sessions left behind and nobody adopted is what tidy is for.
    const orphansLeft = [...fake.groups.values()].filter((g) => !g.owner).length
    await tidy(ctx)
    expect(fake.groups.size).toBe(0)
    expect(v.counters.tidiedGroups).toBe(orphansLeft)
    const d = await readDiagnostics(ctx)
    expect(d.sessions.created).toBe(14) // 12 soak sessions, tidy's and the reader's
    expect(d.sessions.live).toBe(1) // the reader itself
    expect(d.calls.total).toBeGreaterThan(0)
  })

  it('the drop leg: force adopt is soft until E, adoption after the DELETE is hard', async () => {
    fake = await new FakeZenium().start()
    const ctx = context(fake)
    await soakDropLeg(ctx)
    const s = ctx.verdict.summary()
    expect(ctx.verdict.hardFailures).toBe(0)
    expect(s.checks['drop-setup']).toMatchObject({ pass: 1 })
    expect(s.checks['drop-live-group-listed']).toMatchObject({ pass: 1 })
    expect(s.checks[SOFT_CHECKS.dropForceAdopt]).toMatchObject({ kind: 'soft', fail: 1 })
    expect(s.checks[SOFT_CHECKS.dropForceAdopt].samples[0]).toContain('still connected')
    expect(s.checks['drop-adopt-after-delete']).toMatchObject({ kind: 'hard', pass: 1 })
    expect(s.checks.delete).toMatchObject({ pass: 2 })
    expect(fake.sessions.size).toBe(0)
    expect(fake.groups.size).toBe(0)

    await fake.stop()
    fake = await new FakeZenium({ forceAdopt: true }).start()
    const ctx2 = context(fake)
    await soakDropLeg(ctx2)
    const s2 = ctx2.verdict.summary()
    expect(ctx2.verdict.hardFailures).toBe(0)
    expect(s2.checks[SOFT_CHECKS.dropForceAdopt]).toMatchObject({ pass: 1, fail: 0 })
    expect(s2.checks['drop-adopt-after-delete']).toBeUndefined()
  })

  it('the resurrection probes: 200 + resumed with the token, 404 without', async () => {
    fake = await new FakeZenium().start()
    const ctx = context(fake)
    await resurrectionProbes(ctx)
    const s = ctx.verdict.summary()
    expect(ctx.verdict.hardFailures).toBe(0)
    expect(s.checks['resurrection-with-token']).toMatchObject({ pass: 1 })
    expect(s.checks['resurrection-without-token']).toMatchObject({ pass: 1 })
    expect(s.checks.delete).toMatchObject({ pass: 1 })
    expect(fake.counters.resurrected).toBe(1)
    expect(fake.counters.unknown).toBe(1)
    expect(fake.sessions.size).toBe(0)

    await fake.stop()
    fake = await new FakeZenium({ resurrect: false }).start()
    const ctx2 = context(fake)
    await resurrectionProbes(ctx2)
    const s2 = ctx2.verdict.summary()
    expect(s2.ok).toBe(false)
    expect(s2.checks['resurrection-with-token']).toMatchObject({ fail: 1 })
    expect(s2.checks['resurrection-with-token'].samples[0]).toContain('HTTP 404')
  })
})

describe('main', () => {
  it('runs the http leg and the drop leg against a server named by --url/--token and writes soak.json', async () => {
    fake = await new FakeZenium({ screenshots: 'hidden-error' }).start()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-soak-out-'))
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const code = await main([
        '--url',
        fake.url,
        '--token',
        TOKEN,
        '--sessions=4',
        '--concurrency=2',
        '--rounds=1',
        '--drop',
        '--out',
        out
      ])
      expect(code).toBe(0)
      const summary = JSON.parse(fs.readFileSync(path.join(out, 'soak.json'), 'utf8'))
      expect(summary.ok).toBe(true)
      expect(summary.counts.sessions).toBe(4)
      expect(summary.counts.hardFailures).toBe(0)
      expect(summary.counts.softFailures).toBe(5) // 4 background screenshots + the force adopt
      expect(summary.options).toMatchObject({
        sessions: 4,
        concurrency: 2,
        rounds: 1,
        legs: ['http', 'drop']
      })
      expect(summary.latency.http.zen_status.count).toBeGreaterThan(0)
      expect(summary.diagnostics.sessions.live).toBe(1) // the reader itself
      expect(summary.diagnostics.sessions.resurrected).toBe(1)
      const printed = stdout.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(printed).toContain('– PASS')
      expect(printed).toContain(`soak.json: ${path.join(out, 'soak.json')}`)
      expect(printed).not.toContain(TOKEN)
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).not.toContain(TOKEN)

      // --strict: the soft failures fail the run.
      expect(
        await main([
          '--url',
          fake.url,
          '--token',
          TOKEN,
          '--sessions=1',
          '--rounds=1',
          '--strict',
          '--out',
          out
        ])
      ).toBe(1)
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('exits 2 on a usage error', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(await main([])).toBe(2)
      expect(await main(['--bogus'])).toBe(2)
      expect(await main(['--user-data-dir', '/nowhere', '--restart'])).toBe(2)
      expect(
        await main(['--url', 'http://127.0.0.1:9/mcp', '--token', 'x', '--shim', 'zenium'])
      ).toBe(2)
      expect(await main(['--help'])).toBe(0)
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('usage:')
    } finally {
      stderr.mockRestore()
    }
  })
})
