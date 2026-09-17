import { describe, expect, it } from 'vitest'
import {
  IDLE_DELAY_MS,
  runAtOrder,
  scheduleRunAt,
  type LifecycleHooks,
  type ReadyState
} from '../scheduling'
import { parseRuntimeManifest } from '../manifest'
import { planInjection, extensionUrl, parseExtensionUrl, isWebAccessible } from '../plan'

/** A scripted document lifecycle: the test advances readyState and fires the events by hand. */
function fakeDocument(initial: ReadyState): LifecycleHooks & {
  advance(state: ReadyState): void
  tick(ms: number): void
  timeline: string[]
} {
  let state = initial
  const dcl: Array<() => void> = []
  const load: Array<() => void> = []
  const timers: Array<{ at: number; cb: () => void }> = []
  let now = 0
  const timeline: string[] = []
  return {
    timeline,
    readyState: () => state,
    onDomContentLoaded: (cb) => void dcl.push(cb),
    onLoad: (cb) => void load.push(cb),
    setTimeout: (cb, ms) => void timers.push({ at: now + ms, cb }),
    advance(next) {
      state = next
      timeline.push(next)
      if (next === 'interactive') dcl.splice(0).forEach((cb) => cb())
      if (next === 'complete') load.splice(0).forEach((cb) => cb())
    },
    tick(ms) {
      now += ms
      timeline.push(`t+${now}`)
      for (const timer of timers.splice(0)) {
        if (timer.at <= now) timer.cb()
        else timers.push(timer)
      }
    }
  }
}

describe('scheduleRunAt', () => {
  it('document_start runs immediately, once', () => {
    const doc = fakeDocument('loading')
    let runs = 0
    scheduleRunAt('document_start', doc, () => runs++)
    expect(runs).toBe(1)
    doc.advance('interactive')
    doc.advance('complete')
    expect(runs).toBe(1)
  })

  it('document_end waits for DOMContentLoaded', () => {
    const doc = fakeDocument('loading')
    let ran = false
    scheduleRunAt('document_end', doc, () => (ran = true))
    expect(ran).toBe(false)
    doc.advance('interactive')
    expect(ran).toBe(true)
  })

  it('document_end runs at once when the DOM is already parsed', () => {
    const doc = fakeDocument('interactive')
    let ran = false
    scheduleRunAt('document_end', doc, () => (ran = true))
    expect(ran).toBe(true)
  })

  it('document_idle runs at load or DOMContentLoaded + 200 ms, whichever is first', () => {
    const slow = fakeDocument('loading')
    const order: string[] = []
    scheduleRunAt('document_idle', slow, () => order.push(`run@${slow.timeline.at(-1)}`))
    slow.advance('interactive')
    slow.tick(100)
    expect(order).toEqual([])
    slow.tick(IDLE_DELAY_MS - 100)
    expect(order).toEqual([`run@t+${IDLE_DELAY_MS}`])
    slow.advance('complete')
    expect(order).toHaveLength(1)

    const fast = fakeDocument('loading')
    let runs = 0
    scheduleRunAt('document_idle', fast, () => runs++)
    fast.advance('interactive')
    fast.advance('complete')
    expect(runs).toBe(1)
    fast.tick(IDLE_DELAY_MS)
    expect(runs).toBe(1)
  })

  it('document_idle runs immediately on a complete document', () => {
    const doc = fakeDocument('complete')
    let runs = 0
    scheduleRunAt('document_idle', doc, () => runs++)
    expect(runs).toBe(1)
  })

  it('orders run_at values', () => {
    expect([
      runAtOrder('document_idle'),
      runAtOrder('document_start'),
      runAtOrder('document_end')
    ]).toEqual([2, 0, 1])
  })
})

describe('planInjection', () => {
  const id = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'
  const manifest = parseRuntimeManifest(
    {
      manifest_version: 3,
      name: 'x',
      version: '1',
      content_scripts: [
        { matches: ['<all_urls>'], js: ['idle.js'] },
        {
          matches: ['<all_urls>'],
          js: ['start1.js', 'start2.js'],
          css: ['start.css'],
          run_at: 'document_start'
        },
        { matches: ['<all_urls>'], css: [] },
        { matches: ['<all_urls>'], js: ['end.js', 'start2.js'], run_at: 'document_end' }
      ],
      web_accessible_resources: [
        { resources: ['inject/*.js', 'img/icon.png'], matches: ['https://*.example.com/*'] },
        { resources: ['public/*'], matches: [] }
      ]
    },
    null
  )

  it('groups files per declaration, sorted by run_at, skipping empty declarations', () => {
    const plan = planInjection(id, manifest)
    expect(plan.origin).toBe(`https://${id}.ext.zenium.invalid`)
    expect(plan.groups.map((g) => [g.index, g.runAt, g.js])).toEqual([
      [1, 'document_start', ['start1.js', 'start2.js']],
      [3, 'document_end', ['end.js', 'start2.js']],
      [0, 'document_idle', ['idle.js']]
    ])
    expect(plan.jsFiles).toEqual(['start1.js', 'start2.js', 'end.js', 'idle.js'])
    expect(plan.cssFiles).toEqual(['start.css'])
  })

  it('appends scripting.registerContentScripts entries', () => {
    const plan = planInjection(id, manifest, [
      {
        id: 'dyn',
        persistAcrossSessions: true,
        matches: ['https://a/*'],
        excludeMatches: [],
        includeGlobs: [],
        excludeGlobs: [],
        js: ['dyn.js'],
        css: [],
        runAt: 'document_start',
        allFrames: false,
        matchAboutBlank: false,
        matchOriginAsFallback: false,
        world: 'MAIN'
      }
    ])
    expect(plan.groups[1]).toMatchObject({
      index: 4,
      runAt: 'document_start',
      world: 'MAIN',
      js: ['dyn.js']
    })
  })

  it('maps extension URLs both ways', () => {
    expect(extensionUrl(id, '/popup.html')).toBe(`https://${id}.ext.zenium.invalid/popup.html`)
    expect(extensionUrl(id, 'popup.html')).toBe(`https://${id}.ext.zenium.invalid/popup.html`)
    expect(parseExtensionUrl(`https://${id}.ext.zenium.invalid/a/b.js?x#y`)).toEqual({
      id,
      path: 'a/b.js'
    })
    expect(parseExtensionUrl('https://example.com/a')).toBeNull()
    expect(parseExtensionUrl('https://nope.ext.zenium.invalid/a')).toBeNull()
  })

  it('decides web_accessible_resources with MV3 matches', () => {
    const onExample = (patterns: string[]): boolean => patterns.includes('https://*.example.com/*')
    const elsewhere = (): boolean => false
    expect(isWebAccessible(manifest, 'inject/a.js', onExample)).toBe(true)
    expect(isWebAccessible(manifest, '/inject/a.js', elsewhere)).toBe(false)
    // `*` spans path separators, like base::MatchPattern in Chrome.
    expect(isWebAccessible(manifest, 'inject/sub/a.js', onExample)).toBe(true)
    expect(isWebAccessible(manifest, 'inject/a.css', onExample)).toBe(false)
    expect(isWebAccessible(manifest, 'public/deep/x.png', elsewhere)).toBe(true)
    expect(isWebAccessible(manifest, 'manifest.json', onExample)).toBe(false)
  })
})
