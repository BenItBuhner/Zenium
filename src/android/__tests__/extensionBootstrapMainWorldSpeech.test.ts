// @vitest-environment happy-dom
import type { BootGroup, ContentBootConfig, ExtensionBoot } from '@core/extensions/runtime/boot'
import { describe, expect, it } from 'vitest'

/*
 * The Web Speech API on a web page under a `world: "MAIN"` content script. Chrome's documents
 * have `speechSynthesis` natively and the Android System WebView's have none, so Speak Subtitles
 * for YouTube's page bundle – a `world: "MAIN"` group that reads the subtitles off the player and
 * speaks them – died at `speechSynthesis.getVoices()` with `ReferenceError: speechSynthesis is
 * not defined` on every subtitle (compat rounds 18 and 19, both WebViews). The `none` scope now
 * puts the API's six names on the page's window as accessors, and the first read builds the shim
 * over an engine of the extension's made then (endpoint marked `s`); a page that never speaks
 * gets no engine, no hello and nothing else of the extension's. One boot per test file (the
 * bootstrap is an IIFE over `__zenExtBoot`); happy-dom's document is `http://localhost:3000/`.
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

interface Synthesis extends EventTarget {
  readonly speaking: boolean
  readonly pending: boolean
  getVoices(): unknown[]
  speak(utterance: unknown): void
}

type Utterance = new (text?: string) => EventTarget & { text: string }

const TOKEN = 'main-world-speech-token'
/** Speak Subtitles' shape: a `world: "MAIN"` group over the page (ids spell a-p). */
const SPEAK = 'p'.repeat(32)
/** Another extension with a `world: "MAIN"` group on the same page. */
const OTHER = 'o'.repeat(32)

const mainGroup = (js: string): BootGroup => ({
  index: 0,
  runAt: 'document_start',
  world: 'MAIN',
  matches: ['<all_urls>'],
  excludeMatches: [],
  includeGlobs: [],
  excludeGlobs: [],
  allFrames: true,
  matchAboutBlank: false,
  matchOriginAsFallback: false,
  js: [js],
  css: []
})

const extension = (id: string, name: string, over: Partial<ExtensionBoot> = {}): ExtensionBoot => ({
  id,
  name,
  version: '1.0.0',
  manifestVersion: 3,
  permissions: ['storage'],
  optionalPermissions: [],
  hostPermissions: [],
  manifest: { manifest_version: 3, name, version: '1.0.0' },
  messages: null,
  groups: [],
  isolation: 'none',
  ...over
})

const mainUnit = (ext: ExtensionBoot): ContentBootConfig => ({
  kind: 'content',
  token: TOKEN,
  uiLanguage: 'en',
  world: 'main',
  extension: ext
})

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('content bootstrap: speechSynthesis on the page under a world: "MAIN" script', () => {
  it('is there to a feature check at once, built with an engine of the extension’s on the first read alone, and speaks through the host', async () => {
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
    const g = globalThis as typeof globalThis & {
      __zenExtBridge?: Bridge
      __zenExtBoot?: Boot
      __zenExtRuntime?: { attach(boot: Boot): void }
      chrome?: unknown
      speechSynthesis?: Synthesis
      SpeechSynthesisUtterance?: Utterance
    }
    expect('speechSynthesis' in g).toBe(false)
    const seenByGroup: Array<{ present: boolean; lazy: boolean; chrome: unknown }> = []
    g.__zenExtBridge = bridge
    g.__zenExtBoot = {
      config: mainUnit(
        extension(SPEAK, 'Speak Subtitles for YouTube', { groups: [mainGroup('js/webpage.js')] })
      ),
      sources: {
        // The page bundle's own view at document start: the API is there to `in` and `typeof`
        // checks without a read that would build it.
        [`${SPEAK}/0`]: (w, _s, _g, chrome) => {
          const win = w as Record<string, unknown>
          seenByGroup.push({
            present: 'speechSynthesis' in win,
            lazy:
              typeof Object.getOwnPropertyDescriptor(win, 'speechSynthesis')?.get === 'function',
            chrome
          })
        }
      },
      css: {},
      debug: true
    }
    await import('../extensionBootstrap')
    const runtime = g.__zenExtRuntime
    expect(runtime).toBeDefined()
    if (!runtime) return
    expect(seenByGroup).toEqual([{ present: true, lazy: true, chrome: undefined }])
    // Nothing built, nothing said to the host: no engine for a page that never speaks.
    expect(posted.filter((m) => m.t === 'hello')).toHaveLength(0)
    expect(g.chrome).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(g, 'SpeechSynthesisUtterance')?.get).toBeTypeOf(
      'function'
    )

    // The first read (the bundle's `speechSynthesis.getVoices()`): one engine, marked `s`, a
    // content endpoint of the extension's; the shim asks the host for its voices.
    const synthesis = g.speechSynthesis
    expect(synthesis).toBeTypeOf('object')
    if (!synthesis) return
    const hellos = posted.filter((m) => m.t === 'hello')
    expect(hellos).toHaveLength(1)
    expect(hellos[0]).toMatchObject({ ctx: 'content', ext: SPEAK, top: true })
    expect(hellos[0].world).toBeUndefined()
    const ep = String(hellos[0].ep)
    expect(ep).toMatch(new RegExp(`s\\.${SPEAK.slice(0, 8)}$`))
    expect(posted.filter((m) => m.t === 'listen').map((m) => m.event)).toEqual([
      'speechSynthesis.onVoicesChanged'
    ])
    const voicesCall = posted.find((m) => m.t === 'call')
    expect(voicesCall).toMatchObject({ ep, ns: 'speechSynthesis', method: 'getVoices', args: [] })
    expect(synthesis.getVoices()).toEqual([])
    fromHost({
      t: 'reply',
      id: voicesCall?.id,
      ok: true,
      result: [{ voiceName: 'en-us-x-sfg', lang: 'en-US' }],
      ep
    })
    await settle()
    expect(synthesis.getVoices()).toHaveLength(1)
    // The real properties are in place now: the same object on every read, the classes as values.
    expect(g.speechSynthesis).toBe(synthesis)
    const Utterance = g.SpeechSynthesisUtterance
    expect(Utterance).toBeTypeOf('function')
    if (!Utterance) return
    expect(Object.getOwnPropertyDescriptor(g, 'SpeechSynthesisUtterance')?.value).toBe(Utterance)
    // Still nothing of the extension's on the page's window.
    expect(g.chrome).toBeUndefined()

    // A subtitle spoken: the host's `speechSynthesis.speak` over the `s` endpoint, the engine's
    // events back to the utterance.
    const utterance = new Utterance('Me at the zoo')
    const events: string[] = []
    for (const type of ['start', 'end', 'error'])
      utterance.addEventListener(type, () => events.push(type))
    synthesis.speak(utterance)
    const speak = posted.filter((m) => m.t === 'call').at(-1)
    expect(speak).toMatchObject({ ep, ns: 'speechSynthesis', method: 'speak' })
    const args = speak?.args as unknown[]
    expect(args[0]).toBe('Me at the zoo')
    expect(args[1]).toMatchObject({ enqueue: true, rate: 1, pitch: 1, volume: 1 })
    expect(args[2]).toBe('ws1')
    expect(posted.filter((m) => m.t === 'listen').map((m) => m.event)).toEqual([
      'speechSynthesis.onVoicesChanged',
      'speechSynthesis.onEvent'
    ])
    expect(synthesis.pending).toBe(true)
    fromHost({ t: 'reply', id: speak?.id, ok: true, result: undefined, ep })
    fromHost({
      t: 'event',
      ep,
      ns: 'speechSynthesis',
      name: 'onEvent',
      args: ['ws1', { type: 'start' }]
    })
    expect(events).toEqual(['start'])
    expect(synthesis.speaking).toBe(true)
    fromHost({
      t: 'event',
      ep,
      ns: 'speechSynthesis',
      name: 'onEvent',
      args: ['ws1', { type: 'end' }]
    })
    expect(events).toEqual(['start', 'end'])
    expect(synthesis.speaking).toBe(false)

    // Another extension's `world: "MAIN"` unit on the same page finds the API there: the same
    // object, no second engine.
    const seenByOther: unknown[] = []
    runtime.attach({
      config: mainUnit(extension(OTHER, 'Another', { groups: [mainGroup('js/other.js')] })),
      sources: {
        [`${OTHER}/0`]: (w) => {
          seenByOther.push((w as { speechSynthesis: unknown }).speechSynthesis)
        }
      },
      css: {}
    })
    expect(seenByOther).toEqual([synthesis])
    expect(posted.filter((m) => m.t === 'hello')).toHaveLength(1)
  })
})
