// @vitest-environment happy-dom
import type { BootGroup, ContentBootConfig, ExtensionBoot } from '@core/extensions/runtime/boot'
import { describe, expect, it } from 'vitest'

/*
 * The content bootstrap under the `with` fallback (a WebView without isolated worlds): every
 * unit of every extension lands in the page's one main world, the first copy of the script
 * installs the transport and the later copies attach their boot to it. A user-script unit and a
 * content unit of one extension are two scopes with two engines: the user-script world's `chrome`
 * is messaging only (`runtime`, `extension`), the content script's carries the extension's
 * namespaces (`storage`, `i18n`). The first unit to boot must not lend its world to the rest.
 *
 * The bootstrap is an IIFE over `__zenExtBoot` that runs on import and exposes `__zenExtRuntime`
 * as a frozen own property of the global, so one boot per test file: this file boots a
 * user-script unit first – the order Video Speed Controller met on WebView 113, whose bridge got
 * a `chrome` without `storage` – and attaches the rest.
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
}

interface Runtime {
  attach(boot: Boot): void
}

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

const TOKEN = 'unit-test-token'
const EXT_A = 'a'.repeat(32)
const EXT_B = 'b'.repeat(32)
const EXT_C = 'c'.repeat(32)

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

const extension = (id: string, name: string): ExtensionBoot => ({
  id,
  name,
  version: '1.0',
  manifestVersion: 3,
  permissions: ['storage'],
  hostPermissions: ['<all_urls>'],
  manifest: { manifest_version: 3, name, version: '1.0' },
  messages: null,
  groups: [group()],
  isolation: 'with'
})

interface Seen {
  chrome: unknown
  browser: unknown
}

/** A unit's boot whose one group records the `chrome` and `browser` it was called with. */
function unit(
  ext: ExtensionBoot,
  world: ContentBootConfig['world'],
  messaging: boolean | undefined,
  seen: Seen[]
): Boot {
  const config: ContentBootConfig = {
    kind: 'content',
    token: TOKEN,
    uiLanguage: 'en',
    world,
    extension: ext,
    ...(messaging === undefined ? {} : { userScriptMessaging: messaging })
  }
  return {
    config,
    sources: {
      [`${ext.id}/0`]: (_window, _self, _globalThis, chrome, browser) => {
        seen.push({ chrome, browser })
      }
    },
    css: {}
  }
}

const namespaces = (chrome: unknown): string[] =>
  chrome && typeof chrome === 'object' ? Object.keys(chrome).sort() : []

describe('content bootstrap units under the with fallback', () => {
  it('gives each attaching unit its own world: a user-script unit booting first lends nothing to the content units', async () => {
    const posted: Array<Record<string, unknown>> = []
    const bridge: Bridge = {
      postMessage: (message) => {
        posted.push(JSON.parse(message) as Record<string, unknown>)
      },
      onmessage: null
    }
    const g = globalThis as typeof globalThis & {
      __zenExtBridge?: Bridge
      __zenExtBoot?: Boot
      __zenExtRuntime?: Runtime
    }
    const extA = extension(EXT_A, 'Monkey')
    const extB = extension(EXT_B, 'Speed')
    const extC = extension(EXT_C, 'Quiet')

    // Extension A's user-script unit boots first (configureWorld({ messaging: true })).
    const aUser: Seen[] = []
    g.__zenExtBridge = bridge
    g.__zenExtBoot = unit(extA, 'user', true, aUser)
    await import('../extensionBootstrap')
    const runtime = g.__zenExtRuntime
    expect(runtime).toBeDefined()
    if (!runtime) return

    expect(aUser).toHaveLength(1)
    expect(namespaces(aUser[0]?.chrome)).toEqual(['extension', 'runtime'])

    // Extension A's content unit attaches: the content script's chrome, not the world's.
    const aContent: Seen[] = []
    runtime.attach(unit(extA, 'isolated', undefined, aContent))
    expect(aContent).toHaveLength(1)
    const aContentChrome = aContent[0]?.chrome as Record<string, unknown>
    expect(aContentChrome.storage).toBeDefined()
    expect(aContentChrome.i18n).toBeDefined()
    expect(aContentChrome.runtime).toBeDefined()
    expect(aContentChrome).not.toBe(aUser[0]?.chrome)

    // Another extension's content unit attaches after the user-script unit: its own storage.
    const bContent: Seen[] = []
    runtime.attach(unit(extB, 'isolated', undefined, bContent))
    expect(bContent).toHaveLength(1)
    expect((bContent[0]?.chrome as Record<string, unknown>).storage).toBeDefined()
    expect(bContent[0]?.chrome).not.toBe(aContentChrome)

    // The other way round: B's user-script unit attaches after B's content unit and gets the
    // messaging-only world, not the content script's namespaces.
    const bUser: Seen[] = []
    runtime.attach(unit(extB, 'user', true, bUser))
    expect(bUser).toHaveLength(1)
    expect(namespaces(bUser[0]?.chrome)).toEqual(['extension', 'runtime'])

    // A user-script world without messaging configured has no chrome at all, as in Chrome.
    const cUser: Seen[] = []
    runtime.attach(unit(extC, 'user', undefined, cUser))
    expect(cUser).toHaveLength(1)
    expect(cUser[0]?.chrome).toBeUndefined()
    expect(cUser[0]?.browser).toBeUndefined()

    // Every engine said hello on an endpoint of its own; a user-script unit's endpoint is told
    // apart from its extension's content endpoint (both share this copy of the script).
    const hellos = posted.filter((m) => m.t === 'hello')
    const endpoints = hellos.map((m) => String(m.ep))
    expect(new Set(endpoints).size).toBe(hellos.length)
    const byExtension = (id: string, ctx: string): Record<string, unknown> | undefined =>
      hellos.find((m) => m.ext === id && m.ctx === ctx)
    expect(byExtension(EXT_A, 'userScript')).toBeDefined()
    expect(byExtension(EXT_A, 'content')).toBeDefined()
    expect(byExtension(EXT_B, 'userScript')).toBeDefined()
    expect(byExtension(EXT_B, 'content')).toBeDefined()
    expect(byExtension(EXT_C, 'userScript')).toBeUndefined()
    for (const hello of hellos) expect(hello.token).toBe(TOKEN)
  })
})
