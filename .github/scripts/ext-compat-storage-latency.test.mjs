// The storage round-trip reading (`ext-compat-storage-latency.mjs`) over a results.json as the
// sweep writes it: the bridge lines of each step's evidence, with and without the call ids and
// the legs the host's debug trace carries since compat round 19.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./ext-compat-storage-latency.mjs', import.meta.url))

const dirs = []
const results = (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'storage-latency-'))
  dirs.push(dir)
  const path = join(dir, 'results.json')
  writeFileSync(path, JSON.stringify(body))
  return path
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const run = (...paths) =>
  execFileSync(process.execPath, [script, ...paths], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trimEnd()
    .split('\n')

const row = (name, bridge, more = {}) => ({
  id: name.toLowerCase(),
  name,
  core: { verdict: 'P', detail: { bgAtEnd: { bridge, bridgeLines: bridge.length }, ...more } }
})

describe('ext-compat-storage-latency', () => {
  it('pairs by order within a context when the lines carry no ids, other namespaces holding their slots', () => {
    const path = results({
      webView: 'com.google.android.webview 113.0.5672.136',
      isolatedWorlds: false,
      rows: [
        row('Zoom Video', [
          '1000 > ochhcgam/content call storage.get',
          '1065 < ochhcgam/content reply ok',
          '1070 > ochhcgam/content call storage.set',
          '1368 < ochhcgam/content reply ok',
          // A tabs.query ahead of the next get in the same context: its reply takes its own slot.
          '2000 > ochhcgam/background call tabs.query',
          '2010 > ochhcgam/background call storage.get',
          '2020 < ochhcgam/background reply ok',
          '2030 < ochhcgam/background reply ok',
          // Another context's call is another queue.
          '3000 > ochhcgam/popup call storage.get',
          '3004 < ochhcgam/popup reply ok'
        ]),
        row('Quiet', [
          '5000 > abcdefgh/background call tabs.query',
          '5001 < abcdefgh/background reply ok'
        ])
      ]
    })
    const out = run(path)
    expect(out[0]).toBe(
      `${path} (com.google.android.webview 113.0.5672.136, isolated worlds off): 2 rows, 1 with storage calls on the bridge lines kept; paired by order within a context (no ids on the lines)`
    )
    expect(out[1]).toBe('  storage.get n 3 median 20 p90 65 max 65 ms')
    expect(out[2]).toBe('  storage.set n 1 median 298 p90 298 max 298 ms')
    expect(out[3]).toBe(
      '  Zoom Video: content get=65 content set=298 background get=20 popup get=4'
    )
    expect(out).toHaveLength(4)
  })

  it('pairs by id when the lines carry one, out of order, and sums the legs', () => {
    const path = results({
      webView: 'com.android.webview 156.0.8074.0',
      isolatedWorlds: true,
      rows: [
        row('Zoom Video', [
          '1000 > ochhcgam/content call storage.get id=7',
          '1001 > ochhcgam/content call storage.set id=8',
          '1201 < ochhcgam/content reply ok id=8 hop=120 run=1 back=79',
          '1300 < ochhcgam/content reply ok id=7 hop=210 run=2 back=88',
          // An error reply pairs too; its text may hold spaces ahead of the tokens.
          '1400 > ochhcgam/content call storage.set id=9',
          '1450 < ochhcgam/content reply error=QUOTA_BYTES quota exceeded id=9 hop=30 run=1 back=19',
          // A reply whose id matches no pending call is not paired by order when every call has an id.
          '1500 < ochhcgam/content reply ok id=99 hop=1 run=1 back=1'
        ])
      ]
    })
    const out = run(path)
    expect(out[0]).toContain('1 with storage calls on the bridge lines kept; paired by id')
    expect(out[1]).toBe('  storage.get n 1 median 300 p90 300 max 300 ms')
    expect(out[2]).toBe(
      '    legs (1 of them): hop n 1 median 210 p90 210 max 210; run n 1 median 2 p90 2 max 2; back n 1 median 88 p90 88 max 88'
    )
    expect(out[3]).toBe('  storage.set n 2 median 125 p90 200 max 200 ms')
    expect(out[4]).toBe(
      '    legs (2 of them): hop n 2 median 75 p90 120 max 120; run n 2 median 1 p90 1 max 1; back n 2 median 49 p90 79 max 79'
    )
    expect(out[5]).toBe(
      '  Zoom Video: content set=200(120+1+79) content get=300(210+2+88) content set=50(30+1+19)'
    )
  })

  it('reads every evidence window of a row once, the errors list included, in stamp order', () => {
    const path = results({
      rows: [
        row(
          'Chrono',
          ['1000 > njgehaon/popup call storage.set', '1236 < njgehaon/popup reply ok'],
          {
            bgAfterLoad: {
              bridge: [
                '1000 > njgehaon/popup call storage.set',
                '1236 < njgehaon/popup reply ok',
                '500 > njgehaon/background call storage.get',
                '832 < njgehaon/background reply ok'
              ]
            }
          }
        )
      ]
    })
    const out = run(path)
    expect(out[0]).toContain('(WebView ?): 1 rows, 1 with storage calls')
    expect(out[1]).toBe('  storage.get n 1 median 332 p90 332 max 332 ms')
    expect(out[2]).toBe('  storage.set n 1 median 236 p90 236 max 236 ms')
    expect(out[3]).toBe('  Chrono: background get=332 popup set=236')
  })

  it('reports a lane without storage calls, and several files in turn', () => {
    const quiet = results({
      webView: 'w',
      rows: [row('Quiet', ['1 > abcdefgh/background call tabs.query'])]
    })
    const none = results({ rows: [] })
    const out = run(quiet, none)
    expect(out).toEqual([
      `${quiet} (w): 1 rows, 0 with storage calls on the bridge lines kept`,
      `${none} (WebView ?): 0 rows, 0 with storage calls on the bridge lines kept`
    ])
  })
})
