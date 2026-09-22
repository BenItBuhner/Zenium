// @vitest-environment happy-dom
import type { BootGroup, ContentBootConfig, ExtensionBoot } from '@core/extensions/runtime/boot'
import { describe, expect, it } from 'vitest'

/*
 * `__zenExtExec`, the entry the host evaluates for `scripting.executeScript`: a plain value is
 * the injection's answer as before; a promise (an `async` func, a script ending in one) becomes
 * a ticket, and the frame settles it over the extension's endpoint with `execSettled` when the
 * promise does, as Chrome awaits the promise before it answers. One boot per test file (the
 * bootstrap is an IIFE over `__zenExtBoot`), under the `with` fallback.
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

const TOKEN = 'exec-test-token'
const EXT = 'e'.repeat(32)

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

const extension = (): ExtensionBoot => ({
  id: EXT,
  name: 'Pictures',
  version: '1.0',
  manifestVersion: 3,
  permissions: ['storage', 'scripting'],
  hostPermissions: ['<all_urls>'],
  manifest: { manifest_version: 3, name: 'Pictures', version: '1.0' },
  messages: null,
  groups: [group()],
  isolation: 'with'
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('content bootstrap: an injection whose value is a promise', () => {
  it('answers a ticket and settles it over the endpoint when the promise does; a plain value goes straight back', async () => {
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
    }
    g.__zenExtBridge = bridge
    g.__zenExtBoot = {
      config: {
        kind: 'content',
        token: TOKEN,
        uiLanguage: 'en',
        world: 'isolated',
        extension: extension()
      },
      sources: { [`${EXT}/0`]: () => undefined },
      css: {}
    }
    await import('../extensionBootstrap')
    const exec = g.__zenExtExec
    expect(exec).toBeTypeOf('function')
    if (!exec) return
    const hello = posted.find((m) => m.t === 'hello' && m.ext === EXT && m.ctx === 'content')
    expect(hello).toBeDefined()
    const ep = String(hello?.ep)
    const settles = (): Array<Record<string, unknown>> =>
      posted.filter((m) => m.t === 'execSettled')

    // A plain value: the injection's answer, nothing posted.
    expect(exec(TOKEN, EXT, 'js', {}, () => ({ images: 3 }))).toEqual({ images: 3 })
    expect(exec(TOKEN, EXT, 'js', {}, () => 'title')).toBe('title')
    expect(exec(TOKEN, EXT, 'js', {}, () => undefined)).toBeUndefined()
    expect(settles()).toHaveLength(0)

    // An async func (Image Downloader's `findImages`): a ticket now, the value when it resolves.
    let resolveImages: (value: unknown) => void = () => undefined
    const marker = exec(
      TOKEN,
      EXT,
      'js',
      {},
      () => new Promise((resolve) => (resolveImages = resolve))
    ) as { __zenExtPending?: unknown; ep?: unknown }
    expect(typeof marker.__zenExtPending).toBe('string')
    expect(marker.ep).toBe(ep)
    await settle()
    expect(settles()).toHaveLength(0)
    resolveImages({ allImages: ['https://example.com/a.png'], linkedImages: [] })
    await settle()
    expect(settles()).toHaveLength(1)
    expect(settles()[0]).toMatchObject({
      t: 'execSettled',
      token: TOKEN,
      ep,
      ticket: marker.__zenExtPending,
      ok: true,
      result: { allImages: ['https://example.com/a.png'], linkedImages: [] },
      error: ''
    })

    // A rejection settles with its message; a resolution the bridge cannot carry, as null; every
    // ticket is its own.
    const failing = exec(TOKEN, EXT, 'js', {}, () =>
      Promise.reject(new Error('Cannot access images in this page'))
    ) as { __zenExtPending: string }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const uncarriable = exec(TOKEN, EXT, 'js', {}, () => Promise.resolve(cyclic)) as {
      __zenExtPending: string
    }
    const nothing = exec(TOKEN, EXT, 'js', {}, () => Promise.resolve(undefined)) as {
      __zenExtPending: string
    }
    await settle()
    const byTicket = (ticket: string): Record<string, unknown> | undefined =>
      settles().find((m) => m.ticket === ticket)
    expect(
      new Set([
        marker.__zenExtPending,
        failing.__zenExtPending,
        uncarriable.__zenExtPending,
        nothing.__zenExtPending
      ]).size
    ).toBe(4)
    expect(byTicket(failing.__zenExtPending)).toMatchObject({
      ok: false,
      result: null,
      error: 'Cannot access images in this page'
    })
    expect(byTicket(uncarriable.__zenExtPending)).toMatchObject({ ok: true, result: null })
    expect(byTicket(nothing.__zenExtPending)).toMatchObject({ ok: true, result: null })

    // A thenable that is no Promise is awaited the same way (Chrome resolves thenables too).
    const thenable = exec(TOKEN, EXT, 'js', {}, () => ({
      then: (ok: (v: unknown) => void) => ok(42)
    })) as { __zenExtPending: string }
    await settle()
    expect(byTicket(thenable.__zenExtPending)).toMatchObject({ ok: true, result: 42 })

    // A `world: "MAIN"` injection in this copy settles over the extension's content endpoint: the
    // real window's scope has no engine of its own, the `with` scope beside it has.
    const main = exec(TOKEN, EXT, 'js', { world: 'MAIN' }, () => Promise.resolve('main')) as {
      __zenExtPending: string
      ep: string
    }
    expect(main.ep).toBe(ep)
    await settle()
    expect(byTicket(main.__zenExtPending)).toMatchObject({ ok: true, result: 'main' })
  })
})
