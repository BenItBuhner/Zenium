import { describe, expect, it } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidSiteData, cookieFromNative } from '../siteData'
import { AndroidTabView } from '../views'

/** A bridge that records calls and answers each method from `answers`. */
function fakeBridge(answers: Record<string, unknown> = {}): {
  bridge: Bridge
  calls: Array<{ method: string; args: unknown }>
} {
  const calls: Array<{ method: string; args: unknown }> = []
  const bridge = {
    call: async (method: string, args: unknown) => {
      calls.push({ method, args })
      return answers[method] ?? null
    },
    send: (method: string, args: unknown) => {
      calls.push({ method, args })
    }
  } as unknown as Bridge
  return { bridge, calls }
}

describe('AndroidSiteData', () => {
  it('asks Kotlin for the cookies of a page and shapes its answer', async () => {
    const { bridge, calls } = fakeBridge({
      'site.cookies': [
        { name: 'AEC', domain: '.google.com', secure: true, size: 9 },
        { name: 'host_only', domain: 'www.google.com', secure: false, size: 12 },
        // A reading Kotlin could not classify keeps the unknowns unknown.
        { name: 'odd', domain: null, secure: null, size: 'x' }
      ]
    })
    const cookies = await new AndroidSiteData(bridge).cookies(
      'default',
      'https://www.google.com/search'
    )
    expect(calls[0]).toEqual({
      method: 'site.cookies',
      args: { containerId: 'default', url: 'https://www.google.com/search' }
    })
    expect(cookies).toEqual([
      {
        name: 'AEC',
        domain: '.google.com',
        path: '',
        secure: true,
        httpOnly: null,
        session: null,
        size: 9
      },
      {
        name: 'host_only',
        domain: 'www.google.com',
        path: '',
        secure: false,
        httpOnly: null,
        session: null,
        size: 12
      },
      { name: 'odd', domain: '', path: '', secure: null, httpOnly: null, session: null, size: 0 }
    ])
  })

  it('treats a missing or malformed cookie answer as no cookies', async () => {
    const { bridge } = fakeBridge({ 'site.cookies': { not: 'an array' } })
    expect(await new AndroidSiteData(bridge).cookies('default', 'https://a.example/')).toEqual([])
    const none = fakeBridge()
    expect(await new AndroidSiteData(none.bridge).cookies('default', 'https://a.example/')).toEqual(
      []
    )
    expect(cookieFromNative({ name: 'n', domain: 'd', secure: null, size: -3 }).size).toBe(0)
  })

  it('reads storage per site and defaults what Kotlin leaves out', async () => {
    const { bridge, calls } = fakeBridge({
      'site.storage': {
        usageBytes: 2048,
        quotaBytes: null,
        origins: ['https://www.google.com', 'https://accounts.google.com']
      }
    })
    const reading = await new AndroidSiteData(bridge).storage('work', 'google.com')
    expect(calls[0]).toEqual({
      method: 'site.storage',
      args: { containerId: 'work', site: 'google.com' }
    })
    expect(reading).toEqual({
      usageBytes: 2048,
      quotaBytes: null,
      origins: ['https://www.google.com', 'https://accounts.google.com']
    })
    const empty = await new AndroidSiteData(fakeBridge().bridge).storage('work', 'google.com')
    expect(empty).toEqual({ usageBytes: null, quotaBytes: null, origins: [] })
  })

  it('clears cookies and storage through the bridge', async () => {
    const { bridge, calls } = fakeBridge({ 'site.clearCookies': { removed: 4, remaining: 0 } })
    const data = new AndroidSiteData(bridge)
    expect(await data.clearCookies('default', 'https://www.google.com/')).toBe(4)
    await data.clearStorage('default', 'google.com', ['https://www.google.com'])
    expect(calls).toEqual([
      {
        method: 'site.clearCookies',
        args: { containerId: 'default', url: 'https://www.google.com/' }
      },
      {
        method: 'site.clearStorage',
        args: { containerId: 'default', site: 'google.com', origins: ['https://www.google.com'] }
      }
    ])
    expect(await new AndroidSiteData(fakeBridge().bridge).clearCookies('default', 'x')).toBe(0)
  })
})

describe('AndroidTabView.certificate', () => {
  it('shapes the WebView certificate and tolerates its absence', async () => {
    const { bridge, calls } = fakeBridge({
      'view.certificate': {
        subject: 'www.google.com',
        issuer: 'Google Trust Services',
        validFrom: 1_700_000_000_000,
        validTo: 1_710_000_000_000,
        protocol: null
      }
    })
    const view = new AndroidTabView('tab_1', bridge)
    expect(await view.certificate()).toEqual({
      subject: 'www.google.com',
      issuer: 'Google Trust Services',
      validFrom: 1_700_000_000_000,
      validTo: 1_710_000_000_000,
      protocol: null
    })
    expect(calls[0]).toEqual({ method: 'view.certificate', args: { tabId: 'tab_1' } })
    const plain = new AndroidTabView('tab_2', fakeBridge().bridge)
    expect(await plain.certificate()).toBe(null)
    const odd = new AndroidTabView(
      'tab_3',
      fakeBridge({ 'view.certificate': { validTo: 0 } }).bridge
    )
    expect(await odd.certificate()).toEqual({
      subject: '',
      issuer: '',
      validFrom: null,
      validTo: null,
      protocol: null
    })
  })
})
