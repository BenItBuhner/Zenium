import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidPlatform, type BootInfo } from '../platform'

const BOOT: BootInfo = {
  version: '0.0.0-test',
  sdkInt: 34,
  signer: null,
  packageName: null,
  files: {},
  downloadsDir: '/sdcard/Download',
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  fullscreen: false
}

const TOKEN = 'fedcba9876543210fedcba9876543210'

/** A bridge whose `net.fetch` answers `reply`, recording every call. */
function fakeBridge(reply: unknown): {
  bridge: Bridge
  calls: Array<{ method: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const bridge = {
    call: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args })
      return method === 'net.fetch' ? reply : null
    },
    send: (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args })
    },
    callSync: () => undefined
  } as unknown as Bridge
  return { bridge, calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AndroidPlatform.net.fetchText', () => {
  it('answers a body Kotlin returned inline as before, without a fetch', async () => {
    const { bridge, calls } = fakeBridge({
      ok: true,
      status: 200,
      text: '["suggestion"]',
      headers: { etag: 'W/"1"' }
    })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const result = await new AndroidPlatform(bridge, BOOT).net.fetchText('https://s.example/q', {
      headers: { Accept: 'application/json' },
      timeoutMs: 1000
    })
    expect(result).toEqual({
      ok: true,
      status: 200,
      text: '["suggestion"]',
      headers: { etag: 'W/"1"' }
    })
    expect(calls).toEqual([
      {
        method: 'net.fetch',
        args: {
          url: 'https://s.example/q',
          headers: { Accept: 'application/json' },
          timeoutMs: 1000
        }
      }
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads a spilled body from the app origin by token and releases it', async () => {
    const { bridge, calls } = fakeBridge({
      ok: true,
      status: 200,
      text: '',
      body: { token: TOKEN, bytes: 11_000_000 },
      headers: { etag: '"feed-3"', 'last-modified': 'Mon, 01 Sep 2026 00:00:00 GMT' }
    })
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(`https://appassets.androidplatform.net/zen-net/${TOKEN}`)
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => 'phishing.example\nmalware.example\n'
      }
    })
    vi.stubGlobal('fetch', fetch)
    const result = await new AndroidPlatform(bridge, BOOT).net.fetchText(
      'https://feeds.example/hosts.txt',
      { headers: {}, timeoutMs: 60_000 }
    )
    expect(result.text).toBe('phishing.example\nmalware.example\n')
    expect(result.headers).toEqual({
      etag: '"feed-3"',
      'last-modified': 'Mon, 01 Sep 2026 00:00:00 GMT'
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(calls.map((c) => c.method)).toEqual(['net.fetch', 'net.release'])
    expect(calls[1]?.args).toEqual({ token: TOKEN })
  })

  it('releases a spilled body the caller no longer wants without reading it', async () => {
    const { bridge, calls } = fakeBridge({
      ok: true,
      status: 200,
      text: '',
      body: { token: TOKEN, bytes: 300_000 }
    })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    controller.abort()
    await expect(
      new AndroidPlatform(bridge, BOOT).net.fetchText('https://feeds.example/hosts.txt', {
        headers: {},
        signal: controller.signal
      })
    ).rejects.toThrow('aborted')
    expect(fetch).not.toHaveBeenCalled()
    expect(calls.map((c) => c.method)).toEqual(['net.fetch', 'net.release'])
  })
})
