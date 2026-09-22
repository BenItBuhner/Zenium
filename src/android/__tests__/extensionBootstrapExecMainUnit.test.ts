// @vitest-environment happy-dom
import type { BootGroup, ContentBootConfig, ExtensionBoot } from '@core/extensions/runtime/boot'
import { describe, expect, it } from 'vitest'

/*
 * `__zenExtExec` in the copy of the bootstrap that runs an extension's `world: "MAIN"` unit. An
 * extension whose only declared content script is a main-world one (Mobile simulator's
 * `frame-element-spoofer.js`) has no isolated-world copy in a page's main frame, so the host
 * evaluates `scripting.executeScript` into the main world and this copy answers it: a default
 * world injection must still run in the extension's own scope with its `chrome` (the injected
 * `js/simulator.js` wraps `chrome` at its first line), not on the page's window, whose `chrome`
 * a WebView does not have. One boot per test file (the bootstrap is an IIFE over `__zenExtBoot`).
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

type Exec = (
  token: unknown,
  extId: unknown,
  kind: unknown,
  payload: unknown,
  fn: unknown
) => unknown

interface Bridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

const TOKEN = 'exec-main-unit-token'
const EXT = 'm'.repeat(32)

const mainGroup = (): BootGroup => ({
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
  js: ['js/frame-element-spoofer.js'],
  css: []
})

const extension = (): ExtensionBoot => ({
  id: EXT,
  name: 'Mobile simulator',
  version: '4.21.2',
  manifestVersion: 3,
  permissions: ['scripting', 'storage', 'tabs'],
  optionalPermissions: [],
  hostPermissions: ['<all_urls>'],
  manifest: { manifest_version: 3, name: 'Mobile simulator', version: '4.21.2' },
  messages: null,
  groups: [mainGroup()],
  isolation: 'none'
})

describe('content bootstrap: the main-world unit’s copy answers a default-world injection', () => {
  it('runs it in the extension’s own scope with its chrome, and a world: "MAIN" injection on the page’s window', async () => {
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
      __zenExtExec?: Exec
      chrome?: unknown
    }
    const seenByGroup: unknown[] = []
    g.__zenExtBridge = bridge
    g.__zenExtBoot = {
      config: {
        kind: 'content',
        token: TOKEN,
        uiLanguage: 'en',
        world: 'main',
        extension: extension()
      },
      sources: {
        [`${EXT}/0`]: (_w, _s, _g, chrome) => {
          seenByGroup.push(chrome)
        }
      },
      css: {}
    }
    await import('../extensionBootstrap')
    const exec = g.__zenExtExec
    expect(exec).toBeTypeOf('function')
    if (!exec) return

    // The main-world group ran on the page's window: the page's `chrome`, which a WebView lacks.
    expect(seenByGroup).toEqual([undefined])
    expect(g.chrome).toBeUndefined()
    // No content endpoint yet: a main-world unit has no engine of its own.
    expect(posted.filter((m) => m.t === 'hello' && m.ext === EXT)).toHaveLength(0)

    // `scripting.executeScript({ files: ['js/simulator.js'] })`, no `world`: the extension's
    // scope, its `chrome` with the extension's id, the scope's window not the page's.
    const injected = exec(
      TOKEN,
      EXT,
      'js',
      {},
      (win: unknown, self: unknown, global: unknown, chrome: unknown, browser: unknown) => ({
        chromeType: typeof chrome,
        runtimeId: (chrome as { runtime?: { id?: unknown } } | undefined)?.runtime?.id,
        browserType: typeof browser,
        sameScope: win === self && self === global,
        pageWindow: win === globalThis,
        // The polyfill's first move on the injected script's `chrome`.
        wrapped: Object.getPrototypeOf(Object.create(chrome as object)) === chrome
      })
    )
    expect(injected).toEqual({
      chromeType: 'object',
      runtimeId: EXT,
      browserType: 'object',
      sameScope: true,
      pageWindow: false,
      wrapped: true
    })
    // The scope's engine said hello as a content endpoint of the extension when it was made.
    const hello = posted.find((m) => m.t === 'hello' && m.ext === EXT && m.ctx === 'content')
    expect(hello).toBeDefined()

    // The same scope again on the next injection (one engine, one endpoint).
    const again = exec(TOKEN, EXT, 'js', {}, (win: unknown) => win)
    const first = exec(TOKEN, EXT, 'js', {}, (win: unknown) => win)
    expect(again).toBe(first)
    expect(
      posted.filter((m) => m.t === 'hello' && m.ext === EXT && m.ctx === 'content')
    ).toHaveLength(1)

    // A `world: "MAIN"` injection runs on the page's window with the page's `chrome`, as Chrome's.
    const main = exec(
      TOKEN,
      EXT,
      'js',
      { world: 'MAIN' },
      (win: unknown, _s: unknown, _g: unknown, chrome: unknown) => ({
        pageWindow: win === globalThis,
        chromeType: typeof chrome
      })
    )
    expect(main).toEqual({ pageWindow: true, chromeType: 'undefined' })
  })
})
