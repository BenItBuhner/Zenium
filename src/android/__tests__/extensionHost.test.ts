import { describe, expect, it } from 'vitest'
import type { Browser } from '@core/browser'
import { createChromeShim, type Primordials } from '@core/extensions/runtime/shim'
import type { ZenWindow } from '@core/window'
import type { Bridge } from '../bridge'
import { AndroidExtensionHost } from '../extensions'

const EXT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN = 'tok'

const MANIFEST = {
  manifest_version: 3,
  name: 'Probe',
  version: '1.0',
  permissions: ['storage', 'tabs'],
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'bg.js' },
  content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }]
}

interface Sent {
  method: string
  args: Record<string, unknown>
}

/** A bridge whose Kotlin side is scripted: scan returns one extension, everything else succeeds. */
function fakeBridge(): { bridge: Bridge; sent: Sent[] } {
  const sent: Sent[] = []
  const bridge = {
    call: async (method: string) => {
      if (method === 'ext.scan')
        return {
          token: TOKEN,
          uiLanguage: 'en',
          extensions: [
            {
              id: EXT_ID,
              path: `/data/ext/${EXT_ID}`,
              manifest: JSON.stringify(MANIFEST),
              locales: {},
              icon: null
            }
          ]
        }
      return null
    },
    send: (method: string, args: Record<string, unknown>) => {
      sent.push({ method, args })
    }
  } as unknown as Bridge
  return { bridge, sent }
}

function fakeBrowser(): Browser {
  return {
    platform: { io: { readSync: () => null, write: async () => undefined } },
    tabs: {
      tab: () => null,
      activeTabFor: () => null,
      isPrivate: () => false,
      createTab: () => null,
      model: { tabs: [], spaces: [] }
    },
    state: { subscribe: () => () => undefined, commitVolatile: () => undefined },
    toast: () => undefined,
    history: {},
    bookmarks: {}
  } as unknown as Browser
}

const primordials: Primordials = {
  stringify: (v) => JSON.stringify(v),
  parse: (t) => JSON.parse(t) as unknown,
  setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  queueMicrotask: (cb) => queueMicrotask(cb),
  error: () => undefined
}

async function startedHost(): Promise<{ host: AndroidExtensionHost; sent: Sent[] }> {
  const { bridge, sent } = fakeBridge()
  const host = new AndroidExtensionHost(bridge, fakeBrowser(), () => ({}) as ZenWindow)
  await host.start()
  return { host, sent }
}

function repliesTo(sent: Sent[], ep: string): Array<Record<string, unknown>> {
  return sent
    .filter((s) => s.method === 'ext.send' && s.args.ep === ep)
    .map((s) => JSON.parse(String(s.args.message)) as Record<string, unknown>)
}

describe('AndroidExtensionHost bridge loop', () => {
  it('configures the scanned extension and starts its background', async () => {
    const { sent } = await startedHost()
    expect(sent.some((s) => s.method === 'ext.background.start' && s.args.id === EXT_ID)).toBe(true)
  })

  it('answers a content-script call on the endpoint that asked, with the endpoint id inside', async () => {
    const { host, sent } = await startedHost()
    const ep = 'n1.aaaaaaaa'
    host.onMessage({
      ep,
      tabId: 'tab_1',
      top: true,
      origin: 'https://example.com',
      message: { t: 'hello', ctx: 'content', ext: EXT_ID, url: 'https://example.com/', top: true }
    })
    host.onMessage({
      ep,
      tabId: 'tab_1',
      top: true,
      origin: 'https://example.com',
      message: { t: 'call', id: 7, ns: 'storage', method: 'set', args: ['local', { k: 1 }] }
    })
    host.onMessage({
      ep,
      tabId: 'tab_1',
      top: true,
      origin: 'https://example.com',
      message: { t: 'call', id: 8, ns: 'storage', method: 'get', args: ['local', ['k']] }
    })
    await new Promise((r) => setTimeout(r, 0))
    const replies = repliesTo(sent, ep)
    expect(replies.map((r) => r.id)).toEqual([7, 8])
    // Frames multiplex several extensions over one transport: the bootstrap routes on `ep`.
    for (const reply of replies) expect(reply.ep).toBe(ep)
    expect(replies[1]).toMatchObject({ t: 'reply', ok: true, result: { k: 1 } })
  })

  it('completes a chrome.storage round trip through the real shim', async () => {
    const { host, sent } = await startedHost()
    const ep = 'n2.aaaaaaaa'
    let delivered = 0
    // The host answers asynchronously (storage is awaited), so the pump runs after the current turn.
    const pump = (): void => {
      for (const s of sent.splice(0)) {
        if (s.method !== 'ext.send') continue
        const reply = JSON.parse(String(s.args.message)) as Record<string, unknown>
        if (reply.ep === ep) {
          delivered++
          shim.receive(reply)
        }
      }
    }
    const shim = createChromeShim(
      {
        id: EXT_ID,
        manifest: MANIFEST,
        manifestVersion: 3,
        permissions: ['storage'],
        messages: null,
        uiLanguage: 'en',
        context: 'content',
        token: TOKEN,
        endpointId: ep,
        url: 'https://example.com/',
        isTopFrame: true
      },
      {
        post: (text) => {
          const message = JSON.parse(text) as Record<string, unknown>
          delete message.token
          host.onMessage({
            ep,
            tabId: 'tab_1',
            top: true,
            origin: 'https://example.com',
            message
          })
          // What the bootstrap does with every host → page message: route on `ep`.
          setTimeout(pump, 0)
        }
      },
      primordials
    )
    const storage = shim.chrome.storage as {
      local: {
        set: (items: Record<string, unknown>) => Promise<void>
        get: (keys: string[]) => Promise<Record<string, unknown>>
      }
    }
    await storage.local.set({ theme: 'dark' })
    await expect(storage.local.get(['theme'])).resolves.toEqual({ theme: 'dark' })
    expect(delivered).toBe(2)
  })
})
