// @vitest-environment happy-dom
import type { BootGroup, ContentBootConfig, ExtensionBoot } from '@core/extensions/runtime/boot'
import { EXTENSION_ORIGIN_SUFFIX, extensionUrl } from '@core/extensions/runtime/plan'
import { describe, expect, it, vi } from 'vitest'

/*
 * An extension page open as a tab (an options page, a page the background opens with
 * `tabs.create`) runs in a tab WebView's main world, behind the transport janitor, next to every
 * document-start copy of the bootstrap whose origin rule covers the page: the content units over
 * `*` of this extension and of every other one, and a late boot for an injection aimed at the
 * tab. Chrome injects no content scripts into extension pages and neither do those copies, but
 * the janitor keeps one sink, and a copy that finds no runtime installed claims the transport
 * before it finds out it has nothing to do here. The page's copy has to install the runtime the
 * others attach to, or the host's replies land in a copy that returned (Adblock Plus's options
 * page and Ghostery's settings page were blank on both WebViews of the compat sweep for it).
 *
 * The janitor and the bootstrap are IIFEs over `__zenExtBoot`; each copy is a fresh evaluation
 * of the module (`vi.resetModules`), as each is a fresh evaluation of the script in the WebView.
 */

type GroupFunction = (
  window: unknown,
  self: unknown,
  globalThis: unknown,
  chrome: unknown,
  browser: unknown
) => unknown

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

interface Exec {
  (token: unknown, extId: unknown, kind: unknown, payload: unknown, fn: unknown): unknown
}

const TOKEN = 'unit-test-token'
const EXT_A = 'a'.repeat(32)
const EXT_B = 'b'.repeat(32)

const group = (): BootGroup => ({
  index: 0,
  runAt: 'document_start',
  world: 'ISOLATED',
  matches: ['<all_urls>'],
  excludeMatches: [],
  includeGlobs: [],
  excludeGlobs: [],
  allFrames: true,
  matchAboutBlank: false,
  matchOriginAsFallback: false,
  js: ['content.js'],
  css: []
})

const extension = (id: string, name: string, groups: BootGroup[]): ExtensionBoot => ({
  id,
  name,
  version: '1.0',
  manifestVersion: 3,
  permissions: ['storage', 'tabs'],
  optionalPermissions: [],
  hostPermissions: ['<all_urls>'],
  manifest: { manifest_version: 3, name, version: '1.0' },
  messages: null,
  groups,
  isolation: 'with'
})

/** A content unit's boot whose one group records that it ran (it must not, on an extension page). */
const contentUnit = (
  ext: ExtensionBoot,
  ran: string[],
  late = false
): {
  config: ContentBootConfig
  sources: Record<string, GroupFunction>
  css: Record<string, string>
} => ({
  config: {
    kind: 'content',
    token: TOKEN,
    uiLanguage: 'en',
    world: 'isolated',
    extension: ext,
    ...(late ? { late: true } : {})
  },
  sources: {
    [`${ext.id}/0`]: () => {
      ran.push(ext.id)
    }
  },
  css: {}
})

describe('the page bootstrap in a tab, next to other copies of the script', () => {
  it('keeps the host reachable: later copies attach to the page runtime instead of claiming the transport, and an injection into the page is refused', async () => {
    const posted: Array<Record<string, unknown>> = []
    const bridge: Bridge = {
      postMessage: (message) => {
        posted.push(JSON.parse(message) as Record<string, unknown>)
      },
      onmessage: null
    }
    const g = globalThis as typeof globalThis & {
      __zenExtBridge?: Bridge
      __zenExtBoot?: unknown
      __zenExtRuntime?: unknown
      __zenExtExec?: Exec
      happyDOM?: { setURL(url: string): void }
      chrome?: {
        tabs: { getCurrent(): Promise<unknown> }
        storage: { local: { get(keys: unknown): Promise<unknown> } }
      }
    }
    // The document is the extension's options page, on the origin the runtime serves it from.
    g.happyDOM?.setURL(extensionUrl(EXT_A, 'options.html'))
    expect(location.hostname.endsWith(EXTENSION_ORIGIN_SUFFIX)).toBe(true)
    // The tab WebView's main world: the janitor takes the bridge first, as on every origin.
    g.__zenExtBridge = bridge
    g.__zenExtBoot = { token: TOKEN }
    await import('../extensionTransport')
    expect(g.__zenExtBridge).toBeUndefined()
    const deliver = (message: Record<string, unknown>): void => {
      expect(bridge.onmessage).toBeTypeOf('function')
      bridge.onmessage?.({ data: JSON.stringify(message) })
    }
    const lastCall = (): Record<string, unknown> => {
      const call = posted.filter((m) => m.t === 'call').at(-1)
      expect(call).toBeDefined()
      return call ?? {}
    }
    const replyTo = (call: Record<string, unknown>, result: unknown): void =>
      deliver({ t: 'reply', ep: call.ep, id: call.id, ok: true, result })
    /** What a page's call came to once the host answered it: its result, or nothing within 200 ms. */
    const outcome = (promise: Promise<unknown> | undefined): Promise<unknown> =>
      Promise.race([
        promise ?? Promise.resolve('no chrome'),
        new Promise((resolve) => setTimeout(() => resolve('lost'), 200))
      ])

    // The extension's own options page boots (page mode, context "page").
    const extA = extension(EXT_A, 'Options', [group()])
    g.__zenExtBoot = {
      config: { kind: 'page', token: TOKEN, uiLanguage: 'en', context: 'page', extension: extA },
      sources: {},
      css: {}
    }
    await import('../extensionBootstrap')
    const hello = posted.find((m) => m.t === 'hello')
    expect(hello).toMatchObject({ ctx: 'page', ext: EXT_A })
    expect(g.chrome?.tabs).toBeDefined()

    // A host call from the page comes back through the janitor's sink.
    const current = g.chrome?.tabs.getCurrent()
    replyTo(lastCall(), { id: 7, url: location.href })
    await expect(outcome(current)).resolves.toMatchObject({ id: 7 })

    // The extension's own unit over `*` runs next (a `world: "MAIN"` group with isolated worlds,
    // every group without them), then another extension's, then a late boot for an injection
    // aimed at this tab. None runs a script on the extension page; none takes the sink.
    const ran: string[] = []
    const copies = [
      contentUnit(extA, ran),
      contentUnit(extension(EXT_B, 'Blocker', [group()]), ran),
      contentUnit({ ...extA, groups: [] }, ran, true)
    ]
    for (const copy of copies) {
      vi.resetModules()
      g.__zenExtBoot = copy
      await import('../extensionBootstrap')
      const hellos = posted.filter((m) => m.t === 'hello')
      expect(hellos).toHaveLength(1)
      const items = g.chrome?.storage.local.get(null)
      replyTo(lastCall(), { theme: 'dark' })
      await expect(outcome(items)).resolves.toEqual({ theme: 'dark' })
    }
    expect(ran).toEqual([])

    // The page's copy is the one that installed the runtime the copies attached to, and
    // `scripting.executeScript` into the extension's own page gets Chrome's refusal through the
    // `__zenExtExec` the exec script calls after the late boot.
    expect(g.__zenExtRuntime).toBeDefined()
    const exec = g.__zenExtExec
    expect(exec).toBeTypeOf('function')
    expect(() => exec?.(TOKEN, EXT_A, 'js', {}, () => 1)).toThrow(
      /Cannot access contents of the page/
    )
    expect(() => exec?.('wrong', EXT_A, 'js', {}, () => 1)).toThrow(/bad token/)
  })
})
