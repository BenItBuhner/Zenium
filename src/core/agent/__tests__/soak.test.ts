import { describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../service'
import { fakeBrowser, textOf } from './fakeBrowser'

/**
 * A soak of the service over the fake browser: 300 agent lives, 8 at a time, each opening two
 * tabs, snapshotting, ending (half with closeTabs), calling again on the same session, adopting
 * an earlier session's orphaned group and ending again; every 15th session parks after idling
 * and is touched back, every 10th loses its record and is resurrected through the HTTP layer
 * with the bearer token. What must hold at the end: no session record outlives its client, the
 * orphan map holds exactly the orphaned groups that exist, the diagnostics add up to what was
 * done, and a tool call on the fake stays under the latency budget.
 */

const SESSIONS = 300
const CONCURRENCY = 8
const PARK_EVERY = 15
const RESURRECT_EVERY = 10
const MEDIAN_BUDGET_MS = 20

interface Internals {
  sessions: Map<string, AgentSession>
  orphans: Map<string, unknown>
  sweep(): void
}

const ADOPT_RACE = /which is still connected|Unknown group|is already yours/
const ORPHAN_HEADER =
  /^Group "(?:[^"\\]|\\.)*" \((folder_[\w-]+)\) \[orphaned, was "((?:[^"\\]|\\.)*)"\]/gm

function percentile(samples: number[], p: number): number {
  if (!samples.length) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

async function pool(
  concurrency: number,
  count: number,
  worker: (i: number) => Promise<void>
): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, async () => {
      for (;;) {
        const i = next++
        if (i >= count) return
        await worker(i)
      }
    })
  )
}

describe('soak: 300 agent lives, 8 at a time, over the fake browser', () => {
  it('leaks no session, bounds the orphan map, adds up the diagnostics and stays within the latency budget', async () => {
    // The service logs every lifecycle event; 300 lives would drown the run's output.
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fake = fakeBrowser()
    const service = fake.service
    const internals = service as unknown as Internals
    const token = service.serverStatus().token
    const started = performance.now()

    const live = new Set<string>()
    const samples = new Map<string, number[]>()
    let calls = 0
    let parks = 0
    let resurrections = 0
    let adopted = 0
    let adoptRaces = 0
    let peakLive = 0

    const timed = async (
      s: AgentSession,
      name: string,
      args: Record<string, unknown> = {}
    ): ReturnType<typeof fake.call> => {
      const t0 = performance.now()
      const result = await fake.call(s, name, args)
      const ms = performance.now() - t0
      let arr = samples.get(name)
      if (!arr) samples.set(name, (arr = []))
      arr.push(ms)
      calls++
      return result
    }

    const life = async (i: number): Promise<void> => {
      const name = `S${i + 1}`
      // As fakeBrowser.connect does, but the id is tracked in the same tick as the record.
      let s = service.create({
        transport: 'http',
        token,
        remoteAddress: '127.0.0.1',
        userAgent: 'soak'
      })
      live.add(s.id)
      await service.onInitialize(s, { name, version: '1.0' })
      s.mode = 'background'
      peakLive = Math.max(peakLive, internals.sessions.size)

      const a = fake.openedTab(
        await timed(s, 'browser_tabs', { action: 'new', url: `https://soak.test/s${i}/a` })
      )
      fake.openedTab(
        await timed(s, 'browser_tabs', { action: 'new', url: `https://soak.test/s${i}/b` })
      )
      const home = s.homeGroupId!
      expect(home).toBeTruthy()
      const snap = await timed(s, 'browser_snapshot', { tabId: a })
      expect(snap.isError).toBeFalsy()
      expect(textOf(snap)).toMatch(/- Viewport: \d+×\d+ CSS px/)

      if (i % PARK_EVERY === PARK_EVERY - 1) {
        // Idle past the limit: parked, the group orphaned; a touch brings both back.
        s.lastActiveAt = Date.now() - 31 * 60 * 1000
        internals.sweep()
        expect(s.parked).toBe(true)
        expect(service.isOrphan(home)).toBe(true)
        expect(internals.sessions.has(s.id)).toBe(true)
        service.touch(s)
        expect(s.parked).toBe(false)
        expect(s.groupIds.has(home)).toBe(true)
        expect(service.isOrphan(home)).toBe(false)
        const status = await timed(s, 'zen_status')
        expect(textOf(status)).toContain('yours again')
        parks++
      }

      if (i % RESURRECT_EVERY === RESURRECT_EVERY - 1) {
        // The record goes (a DELETE, a restart); the client carries on with the token.
        service.close(s.id)
        live.delete(s.id)
        expect(internals.sessions.has(s.id)).toBe(false)
        expect(service.isOrphan(home)).toBe(true)
        // The record comes back under the same id inside handleHttp; a neighbour's leak check
        // may run before this await returns, so the id counts as live from here.
        live.add(s.id)
        const t0 = performance.now()
        const res = await service.handleHttp({
          method: 'POST',
          url: '/mcp',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'soak',
            'mcp-session-id': s.id,
            'mcp-protocol-version': '2025-06-18',
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'zen_status', arguments: {} }
          }),
          remoteAddress: '127.0.0.1'
        })
        const ms = performance.now() - t0
        let arr = samples.get('zen_status (resurrected over HTTP)')
        if (!arr) samples.set('zen_status (resurrected over HTTP)', (arr = []))
        arr.push(ms)
        calls++
        expect(res.status).toBe(200)
        const body = JSON.parse(res.body) as { result: { content: { text: string }[] } }
        expect(body.result.content[0].text).toContain(
          'your connection was resumed without an initialize'
        )
        const again = service.session(s.id)
        expect(again).toBeDefined()
        s = again!
        live.add(s.id)
        resurrections++
        // The home group is orphaned now; take it back – unless a neighbour got there first.
        const back = await timed(s, 'zen_groups', { action: 'adopt', groupId: home })
        if (back.isError) {
          expect(textOf(back)).toMatch(ADOPT_RACE)
          adoptRaces++
        } else adopted++
      }

      const end = await timed(
        s,
        'zen_session',
        i % 2 === 0 ? { action: 'end', closeTabs: true } : { action: 'end' }
      )
      expect(end.isError).toBeFalsy()
      // The connection outlives the agent's tidy-up: the same session answers.
      const after = await timed(s, 'zen_status')
      expect(after.isError).toBeFalsy()
      expect(internals.sessions.get(s.id)).toBe(s)

      const list = await timed(s, 'zen_groups', { action: 'list', scope: 'all' })
      expect(list.isError).toBeFalsy()
      const orphan = [...textOf(list).matchAll(ORPHAN_HEADER)].find((m) => m[2] !== name)
      if (orphan) {
        const r = await timed(s, 'zen_groups', { action: 'adopt', groupId: orphan[1] })
        if (r.isError) {
          expect(textOf(r)).toMatch(ADOPT_RACE)
          adoptRaces++
        } else {
          adopted++
          expect(s.groupIds.has(orphan[1])).toBe(true)
        }
      }
      const last = await timed(s, 'zen_session', { action: 'end', closeTabs: true })
      expect(last.isError).toBeFalsy()
      expect(s.groupIds.size).toBe(0)

      service.close(s.id)
      live.delete(s.id)
      expect(internals.sessions.has(s.id)).toBe(false)
      // Never more records than clients in flight.
      expect(internals.sessions.size).toBeLessThanOrEqual(CONCURRENCY)
      for (const id of internals.sessions.keys()) expect(live.has(id)).toBe(true)
    }

    await pool(CONCURRENCY, SESSIONS, life)

    // No record outlives its client.
    expect(live.size).toBe(0)
    expect(internals.sessions.size).toBe(0)
    expect(peakLive).toBeLessThanOrEqual(CONCURRENCY)

    // The orphan map holds exactly the orphaned groups that still exist, and nothing else has
    // been left in the browser but them.
    const orphanedLeft = service.agentGroups().filter((g) => service.isOrphan(g.id))
    expect(service.agentGroups().length).toBe(orphanedLeft.length)
    expect(internals.orphans.size).toBe(orphanedLeft.length)
    expect(orphanedLeft.length).toBeLessThan(SESSIONS / 2)

    // A last session adopts what was left behind and closes it: the browser is as it was.
    const tidy = await fake.connect('tidy')
    for (const g of orphanedLeft) {
      const r = await timed(tidy, 'zen_groups', { action: 'adopt', groupId: g.id })
      expect(r.isError).toBeFalsy()
    }
    if (orphanedLeft.length) {
      const r = await timed(tidy, 'zen_session', { action: 'end', closeTabs: true })
      expect(r.isError).toBeFalsy()
    }
    service.close(tidy.id)
    expect(service.agentGroups()).toEqual([])
    expect(internals.orphans.size).toBe(0)
    expect(internals.sessions.size).toBe(0)
    expect(Object.values(fake.model.tabs).length).toBe(0)

    // The diagnostics add up.
    const d = service.diagnosticsSnapshot()
    expect(parks).toBe(SESSIONS / PARK_EVERY)
    expect(resurrections).toBe(SESSIONS / RESURRECT_EVERY)
    expect(d.sessions).toEqual({
      live: 0,
      parked: 0,
      created: SESSIONS + resurrections + 1,
      ended: 2 * SESSIONS + (orphanedLeft.length ? 1 : 0),
      parkedTotal: parks,
      resumed: parks,
      resurrected: resurrections,
      closed: SESSIONS + resurrections + 1,
      unknown: 0
    })
    expect(d.calls.total).toBe(calls)
    expect(d.calls.inFlight).toBe(0)
    expect(d.calls.errors).toBe(adoptRaces)
    expect(adopted).toBeGreaterThan(SESSIONS / 4)
    const toolCalls = Object.values(d.tools).reduce((n, t) => n + t.calls, 0)
    expect(toolCalls).toBe(calls)

    // The latency budget: the median tool call on the fake, with p95 reported.
    const all = [...samples.values()].flat()
    const median = percentile(all, 50)
    const p95 = percentile(all, 95)
    expect(median).toBeLessThan(MEDIAN_BUDGET_MS)
    const perTool = [...samples]
      .map(
        ([name, arr]) =>
          `${name} ×${arr.length} p50 ${percentile(arr, 50).toFixed(2)} p95 ${percentile(arr, 95).toFixed(2)} ms`
      )
      .join('; ')
    info.mockRestore()
    console.log(
      `[soak] ${SESSIONS} sessions, ${calls} calls, ${parks} parked, ${resurrections} resurrected, ${adopted} adopted (${adoptRaces} races) in ${((performance.now() - started) / 1000).toFixed(1)} s; ` +
        `p50 ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${percentile(all, 100).toFixed(1)} ms; server: ${JSON.stringify(d.sessions)} ${JSON.stringify(d.calls)}; ${perTool}`
    )
    await fake.stop()
  }, 60_000)
})
