import { describe, expect, it } from 'vitest'
import { INCOGNITO_ERROR } from '@core/extensions/api/privacy'
import { PROXY_PERMISSION_ERROR } from '@core/extensions/api/proxy'
import { PROXY_NOT_APPLICABLE_ERROR } from '../extensionProxy'
import {
  type Harness,
  ID,
  ID2,
  backgroundUp,
  call,
  harness,
  manifest,
  record
} from './runtimeHarness'

/** The events the shim keys as `proxy.settings.onChange` / `proxy.onProxyError` (the host spells them `proxy` + `settings.onChange`). */
function events(h: Harness, ep: string, key: string): Record<string, unknown>[] {
  return h.kt.to(ep).filter((m) => m.t === 'event' && `${String(m.ns)}.${String(m.name)}` === key)
}

const PATH2 = `/data/user/0/app.zen.chromium/files/zen/extensions/${ID2}/1.0.0`

/** Touch VPN's shape: the `proxy` permission and a worker that sets `fixed_servers`. */
async function withProxy(
  h: Harness,
  overrides: {
    id?: string
    installedAt?: number
    allowPrivate?: boolean
    permissions?: string[]
  } = {}
): Promise<string> {
  const id = overrides.id ?? ID
  const path = id === ID ? undefined : PATH2
  await h.runtime.attach(
    record(
      h,
      {
        id,
        ...(path ? { path } : {}),
        ...(overrides.installedAt !== undefined ? { installedAt: overrides.installedAt } : {}),
        ...(overrides.allowPrivate !== undefined ? { allowPrivate: overrides.allowPrivate } : {})
      },
      manifest({ permissions: overrides.permissions ?? ['proxy', 'storage'] })
    )
  )
  const ep = `bg-${id.slice(0, 4)}`
  h.runtime.onMessage({
    ep,
    tabId: null,
    top: true,
    origin: `https://${id}.ext.zenium.invalid`,
    message: {
      t: 'hello',
      ext: id,
      ctx: 'background',
      url: `https://${id}.ext.zenium.invalid/bg.html`,
      world: false
    }
  })
  for (const event of ['proxy.settings.onChange', 'proxy.onProxyError'])
    h.runtime.onMessage({
      ep,
      tabId: null,
      top: true,
      origin: '',
      message: { t: 'listen', event, on: true }
    })
  h.runtime.onMessage({ ep, tabId: null, top: true, origin: '', message: { t: 'ready' } })
  return ep
}

const TOUCH_VPN = {
  mode: 'fixed_servers',
  rules: {
    singleProxy: { scheme: 'https', host: 'us1.touchvpn.net', port: 443 },
    bypassList: ['<local>', '*.touchvpn.net']
  }
}

const TOUCH_VPN_CANONICAL = {
  mode: 'fixed_servers',
  rules: {
    singleProxy: { scheme: 'https', host: 'us1.touchvpn.net', port: 443 },
    bypassList: ['<local>', '*.touchvpn.net']
  }
}

describe('chrome.proxy.settings on the phone: fixed servers through the WebView proxy override', () => {
  it('a worker with the permission may control the setting, sets fixed servers the WebView applies, and hears onChange', async () => {
    const h = harness()
    const bg = await withProxy(h)
    const before = await call(h, bg, 'proxy', 'get', ['settings', {}])
    expect(before.result).toEqual({
      value: { mode: 'system' },
      levelOfControl: 'controllable_by_this_extension'
    })
    const set = await call(h, bg, 'proxy', 'set', ['settings', { value: TOUCH_VPN }])
    expect(set.ok).toBe(true)
    // The override in the WebView's terms: one rule for every scheme, `<local>` as the builder's flag.
    expect(h.kt.proxyOverride).toEqual({
      rules: [{ url: 'https://us1.touchvpn.net:443', scheme: '*' }],
      bypass: ['*.touchvpn.net'],
      bypassSimpleHostnames: true,
      removeImplicitRules: false
    })
    const after = await call(h, bg, 'proxy', 'get', ['settings', {}])
    expect(after.result).toEqual({
      value: TOUCH_VPN_CANONICAL,
      levelOfControl: 'controlled_by_this_extension'
    })
    const changes = events(h, bg, 'proxy.settings.onChange')
    expect(changes).toHaveLength(1)
    expect(changes[0].args).toEqual([
      { value: TOUCH_VPN_CANONICAL, levelOfControl: 'controlled_by_this_extension' }
    ])
    // The value is the extension's, kept for the next session (Chrome's ExtensionPrefs).
    const saved = h.saved('extensions-runtime.json')
    expect(Object.keys((saved.proxy as Record<string, unknown>)[ID] as object)).toEqual(['regular'])

    const cleared = await call(h, bg, 'proxy', 'clear', ['settings', {}])
    expect(cleared.ok).toBe(true)
    expect(h.kt.proxyOverride).toBeNull()
    expect(events(h, bg, 'proxy.settings.onChange')[1].args).toEqual([
      { value: { mode: 'system' }, levelOfControl: 'controllable_by_this_extension' }
    ])
    expect(
      (h.saved('extensions-runtime.json').proxy as Record<string, unknown>)[ID]
    ).toBeUndefined()
  })

  it("Chrome's rule slots become the WebView's scheme filters in order, ftp has nothing to apply to, direct is a direct rule", async () => {
    const h = harness()
    const bg = await withProxy(h)
    const set = await call(h, bg, 'proxy', 'set', [
      'settings',
      {
        value: {
          mode: 'fixed_servers',
          rules: {
            proxyForHttp: { host: 'http.proxy.test', port: 8080 },
            proxyForHttps: { scheme: 'https', host: 'tls.proxy.test' },
            proxyForFtp: { host: 'ftp.proxy.test' },
            fallbackProxy: { scheme: 'socks5', host: 'socks.proxy.test', port: 1080 },
            bypassList: ['<-loopback>', 'localhost', '10.0.2.2']
          }
        }
      }
    ])
    expect(set.ok).toBe(true)
    expect(h.kt.proxyOverride).toEqual({
      rules: [
        { url: 'http://http.proxy.test:8080', scheme: 'http' },
        { url: 'https://tls.proxy.test:443', scheme: 'https' },
        { url: 'socks5://socks.proxy.test:1080', scheme: '*' }
      ],
      bypass: ['localhost', '10.0.2.2'],
      bypassSimpleHostnames: false,
      removeImplicitRules: true
    })
    const direct = await call(h, bg, 'proxy', 'set', ['settings', { value: { mode: 'direct' } }])
    expect(direct.ok).toBe(true)
    expect(h.kt.proxyOverride).toEqual({
      rules: [{ url: 'direct://', scheme: '*' }],
      bypass: [],
      bypassSimpleHostnames: false,
      removeImplicitRules: false
    })
    const system = await call(h, bg, 'proxy', 'set', ['settings', { value: { mode: 'system' } }])
    expect(system.ok).toBe(true)
    expect(h.kt.proxyOverride).toBeNull()
  })

  it('a PAC script or auto-detect fails at set with the reason, and stores nothing; without the permission the call is refused with Chrome’s message', async () => {
    const h = harness()
    const bg = await withProxy(h)
    const pac = await call(h, bg, 'proxy', 'set', [
      'settings',
      { value: { mode: 'pac_script', pacScript: { url: 'https://veepn.test/proxy.pac' } } }
    ])
    expect(String(pac.error)).toBe(PROXY_NOT_APPLICABLE_ERROR)
    const auto = await call(h, bg, 'proxy', 'set', ['settings', { value: { mode: 'auto_detect' } }])
    expect(String(auto.error)).toBe(PROXY_NOT_APPLICABLE_ERROR)
    expect(h.kt.proxyOverride).toBeNull()
    expect((await call(h, bg, 'proxy', 'get', ['settings', {}])).result).toEqual({
      value: { mode: 'system' },
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(events(h, bg, 'proxy.settings.onChange')).toHaveLength(0)
    // Chrome's own argument check still comes first.
    const bad = await call(h, bg, 'proxy', 'set', ['settings', { value: { mode: 'tunnel' } }])
    expect(String(bad.error)).toContain('mode')

    const other = harness()
    const noPermission = await withProxy(other, { permissions: ['storage'] })
    const refused = await call(other, noPermission, 'proxy', 'get', ['settings', {}])
    expect(String(refused.error)).toBe(PROXY_PERMISSION_ERROR)
  })

  it('the most recently installed extension controls the setting; the other reads controlled_by_other_extensions and takes over when it goes', async () => {
    const h = harness()
    const older = await withProxy(h, { installedAt: h.clock.now - 60_000 })
    const newer = await withProxy(h, { id: ID2, installedAt: h.clock.now })
    await call(h, older, 'proxy', 'set', ['settings', { value: TOUCH_VPN }])
    expect(h.runtime.api.proxy.controller()).toBe(ID)
    await call(h, newer, 'proxy', 'set', ['settings', { value: { mode: 'direct' } }])
    expect(h.runtime.api.proxy.controller()).toBe(ID2)
    expect(h.kt.proxyOverride?.rules).toEqual([{ url: 'direct://', scheme: '*' }])
    expect((await call(h, older, 'proxy', 'get', ['settings', {}])).result).toEqual({
      value: { mode: 'direct' },
      levelOfControl: 'controlled_by_other_extensions'
    })
    // Both hear of the change, each with its own say.
    const olderHeard = events(h, older, 'proxy.settings.onChange')
    expect(olderHeard[olderHeard.length - 1].args).toEqual([
      { value: { mode: 'direct' }, levelOfControl: 'controlled_by_other_extensions' }
    ])
    expect(events(h, newer, 'proxy.settings.onChange').pop()?.args).toEqual([
      { value: { mode: 'direct' }, levelOfControl: 'controlled_by_this_extension' }
    ])
    // The newer one is disabled: the older one's configuration applies again.
    await h.runtime.detach(ID2)
    expect(h.runtime.api.proxy.controller()).toBe(ID)
    expect(h.kt.proxyOverride).toMatchObject({
      rules: [{ url: 'https://us1.touchvpn.net:443', scheme: '*' }]
    })
    expect(events(h, older, 'proxy.settings.onChange').pop()?.args).toEqual([
      { value: TOUCH_VPN_CANONICAL, levelOfControl: 'controlled_by_this_extension' }
    ])
  })

  it('the value comes back at the next start and the override is applied again before the worker runs; an uninstall drops it', async () => {
    const h = harness()
    const bg = await withProxy(h)
    await call(h, bg, 'proxy', 'set', ['settings', { value: TOUCH_VPN }])
    h.saved('extensions-runtime.json')

    // Next process, same files: the override is the process's, so it is set again at attach.
    const next = harness({ files: h.files })
    await next.runtime.attach(record(next, {}, manifest({ permissions: ['proxy', 'storage'] })))
    expect(next.kt.proxyOverride).toMatchObject({
      rules: [{ url: 'https://us1.touchvpn.net:443', scheme: '*' }]
    })
    expect(next.runtime.api.proxy.controller()).toBe(ID)
    backgroundUp(next, 'bgN', [])
    expect((await call(next, 'bgN', 'proxy', 'get', ['settings', {}])).result).toEqual({
      value: TOUCH_VPN_CANONICAL,
      levelOfControl: 'controlled_by_this_extension'
    })

    // Disabled: the override goes, the value stays for the re-enable.
    await next.runtime.detach(ID)
    expect(next.kt.proxyOverride).toBeNull()
    expect(
      (next.saved('extensions-runtime.json').proxy as Record<string, unknown>)[ID]
    ).toBeDefined()

    // Uninstalled: nothing comes back.
    await next.runtime.attach(record(next, {}, manifest({ permissions: ['proxy', 'storage'] })))
    expect(next.kt.proxyOverride).not.toBeNull()
    await next.runtime.forget(ID)
    expect(next.kt.proxyOverride).toBeNull()
    next.saved('extensions-runtime.json')
    const last = harness({ files: next.files })
    await last.runtime.attach(record(last, {}, manifest({ permissions: ['proxy', 'storage'] })))
    expect(last.kt.proxyOverride).toBeNull()
    expect(last.runtime.api.proxy.controller()).toBeNull()
  })

  it('a configuration the WebView refuses is a fatal onProxyError to the extension that set it, and the setting stands', async () => {
    const h = harness()
    const bg = await withProxy(h)
    h.kt.failProxy = 'Proxy URL is invalid: ftp.proxy.test'
    const set = await call(h, bg, 'proxy', 'set', ['settings', { value: TOUCH_VPN }])
    expect(set.ok).toBe(true)
    const errors = events(h, bg, 'proxy.onProxyError')
    expect(errors).toHaveLength(1)
    expect(errors[0].args).toEqual([
      {
        fatal: true,
        error: 'net::ERR_PROXY_CONFIGURATION_INVALID',
        details: 'Proxy URL is invalid: ftp.proxy.test'
      }
    ])
    expect((await call(h, bg, 'proxy', 'get', ['settings', {}])).result).toMatchObject({
      levelOfControl: 'controlled_by_this_extension'
    })
  })

  it('the private scopes follow Chrome’s checks and answers, while the WebView’s one override is the regular value', async () => {
    const h = harness()
    const bg = await withProxy(h)
    const denied = await call(h, bg, 'proxy', 'set', [
      'settings',
      { value: { mode: 'direct' }, scope: 'incognito_persistent' }
    ])
    expect(String(denied.error)).toBe(INCOGNITO_ERROR)
    expect(
      String((await call(h, bg, 'proxy', 'get', ['settings', { incognito: true }])).error)
    ).toBe(INCOGNITO_ERROR)

    const allowed = harness()
    const bgP = await withProxy(allowed, { allowPrivate: true })
    await call(allowed, bgP, 'proxy', 'set', ['settings', { value: TOUCH_VPN }])
    const privateSet = await call(allowed, bgP, 'proxy', 'set', [
      'settings',
      { value: { mode: 'direct' }, scope: 'incognito_persistent' }
    ])
    expect(privateSet.ok).toBe(true)
    expect(
      (await call(allowed, bgP, 'proxy', 'get', ['settings', { incognito: true }])).result
    ).toEqual({
      value: { mode: 'direct' },
      levelOfControl: 'controlled_by_this_extension',
      incognitoSpecific: true
    })
    expect((await call(allowed, bgP, 'proxy', 'get', ['settings', {}])).result).toEqual({
      value: TOUCH_VPN_CANONICAL,
      levelOfControl: 'controlled_by_this_extension'
    })
    // One override per process: the regular configuration is what the WebView applies.
    expect(allowed.kt.proxyOverride).toMatchObject({
      rules: [{ url: 'https://us1.touchvpn.net:443', scheme: '*' }]
    })
  })
})
