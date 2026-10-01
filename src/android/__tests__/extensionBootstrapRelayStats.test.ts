// @vitest-environment happy-dom
import type { BootGroup, ContentBootConfig, ExtensionBoot } from '@core/extensions/runtime/boot'
import { extensionOrigin } from '@core/extensions/runtime/plan'
import { describe, expect, it } from 'vitest'

/*
 * The fetch relay's pending count on the debug stats (`__zenExtStats.relay`): a content
 * script's `fetch(chrome.runtime.getURL(…))` goes to the host over the bridge (`extFetch`) and
 * waits for `extFetchDone`; while it waits the count is 1, and the engines' `unanswered` lists
 * stay empty – the two readings the compat sweep takes together when a row's core check runs
 * out its wait (RoValra's init gate on 156, round 26 §3.2: the own-file read answered, the
 * settings `get`s answered, and the extension waiting on a `DOMContentLoaded` that had fired –
 * both counts at zero, so the wait is the page's own). One boot per test file (the bootstrap
 * is an IIFE over `__zenExtBoot`); happy-dom's document is `http://localhost:3000/`.
 */

type GroupFunction = (
  window: unknown,
  self: unknown,
  globalThis: unknown,
  chrome: unknown,
  browser: unknown
) => unknown

interface Boot {
  config: ContentBootConfig
  sources: Record<string, GroupFunction>
  css: Record<string, string>
  debug?: boolean
}

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

interface Stats {
  relay?: { pending: number }
  unanswered?: Record<string, unknown[]>
  bridge?: { hostBound: number; pageBound: number }
}

const TOKEN = 'relay-stats-token'
/** RoValra's id: its content script reads `public/Assets/locales/index.json` at document start. */
const ROVALRA = 'njcickgebhnpgmoodjdgohkclfplejli'

const group = (js: string[]): BootGroup => ({
  index: 0,
  runAt: 'document_start',
  world: 'ISOLATED',
  matches: ['<all_urls>'],
  excludeMatches: [],
  includeGlobs: [],
  excludeGlobs: [],
  allFrames: false,
  matchAboutBlank: false,
  matchOriginAsFallback: false,
  js,
  css: []
})

const extension = (id: string, name: string, groups: BootGroup[]): ExtensionBoot => ({
  id,
  name,
  version: '2.6.13',
  manifestVersion: 3,
  permissions: ['storage'],
  optionalPermissions: [],
  hostPermissions: ['*://*.roblox.com/*'],
  manifest: { manifest_version: 3, name, version: '2.6.13' },
  messages: null,
  groups,
  isolation: 'with'
})

const boot = (ext: ExtensionBoot, source: GroupFunction): Boot => ({
  config: {
    kind: 'content',
    token: TOKEN,
    uiLanguage: 'en',
    world: 'isolated',
    extension: ext
  },
  sources: { [`${ext.id}/0`]: source },
  css: {},
  debug: true
})

const g = globalThis as typeof globalThis & {
  __zenExtBridge?: Bridge
  __zenExtBoot?: Boot
  __zenExtRuntime?: { attach(boot: Boot): void }
  __zenExtStats?: Stats
  chrome?: unknown
}

describe('content bootstrap: the fetch relay’s pending count on the debug stats', () => {
  it('counts an own-file fetch while the host’s extFetchDone is outstanding, beside the engines’ empty unanswered lists', async () => {
    const posted: Array<Record<string, unknown>> = []
    const bridge: Bridge = {
      postMessage: (message) => {
        posted.push(JSON.parse(message) as Record<string, unknown>)
      },
      onmessage: null
    }
    const fromHost = (message: Record<string, unknown>): void => {
      if (!bridge.onmessage) throw new Error('the bootstrap did not listen')
      bridge.onmessage({ data: JSON.stringify(message) })
    }
    delete g.chrome
    g.__zenExtBridge = bridge
    // Assigned from inside the content script's function (a closure TypeScript's narrowing cannot see).
    const got: { answer: Promise<Response> | null } = { answer: null }
    g.__zenExtBoot = boot(
      extension(ROVALRA, 'RoValra', [group(['content.js'])]),
      (window, _self, _globalThis, chrome) => {
        // `supportedLanguagesReady` in RoValra's `i18n.js`: the index of its locales, its own file.
        const runtime = (chrome as { runtime: { getURL(path: string): string } }).runtime
        got.answer = (window as { fetch: typeof fetch }).fetch(
          runtime.getURL('public/Assets/locales/index.json')
        )
      }
    )
    await import('../extensionBootstrap')
    expect(g.__zenExtRuntime).toBeDefined()
    const answer = got.answer
    expect(answer).not.toBeNull()
    if (!answer) return

    // The relay asked the host for the file: one `extFetch`, the file's URL on the extension's origin.
    const ask = posted.find((m) => m.t === 'extFetch')
    expect(ask).toMatchObject({
      ext: ROVALRA,
      url: `${extensionOrigin(ROVALRA)}/public/Assets/locales/index.json`
    })
    expect(String(ask?.ep)).toMatch(new RegExp(`\\.${ROVALRA.slice(0, 8)}$`))

    // The stats while it waits: the relay's one pending request, counted apart from the engines'
    // `unanswered` (their calls alone – the runtime's own voices read at boot here – never the
    // file), the bridge's host-bound count carrying every post together.
    const stats = g.__zenExtStats
    expect(stats).toBeDefined()
    if (!stats) return
    expect(stats.relay).toEqual({ pending: 1 })
    const calls = posted
      .filter((m) => m.t === 'call')
      .map((m) => `${String(m.ns)}.${String(m.method)}`)
    const unanswered = Object.values(stats.unanswered ?? {})
      .flat()
      .map((u) => (u as { what: string }).what)
    expect(unanswered).toEqual(calls)
    // Every post of the copy is in `hostBound` – the engine's (hello, listen, the calls) and the
    // relay's alike: `hostBound − Σ flow.posted` is the relay's share, as round 26 read it.
    expect(stats.bridge?.hostBound).toBe(posted.length)
    expect(posted.filter((m) => m.t === 'extFetch')).toHaveLength(1)

    // The host's answer: the file's bytes and type. The count returns to zero and the content
    // script's promise resolves to the file as a same-origin Response.
    fromHost({
      t: 'extFetchDone',
      ep: ask?.ep,
      id: ask?.id,
      ok: true,
      mime: 'application/json',
      body: btoa('["en","de"]')
    })
    expect(stats.relay).toEqual({ pending: 0 })
    const response = await answer
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual(['en', 'de'])
    // `JSON.stringify(__zenExtStats)` – the sweep's `WORLD_REPORT` – carries the count as a plain field.
    const serialised = JSON.parse(JSON.stringify(stats)) as Stats
    expect(serialised.relay).toEqual({ pending: 0 })
  })
})
