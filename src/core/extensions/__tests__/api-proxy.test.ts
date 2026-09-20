import { describe, expect, it } from 'vitest'
import {
  SYSTEM_PROXY_CONFIG,
  normalizeProxyConfig,
  pacDataUrl,
  pacScriptOfDataUrl,
  proxyConfigOf,
  proxyConfigValue,
  sessionProxyConfig
} from '../api/proxy'

describe('normalizeProxyConfig (Chrome\u2019s ProxyPrefTransformer, there and back)', () => {
  it('keeps the plain modes as just the mode, whatever else was given', () => {
    expect(normalizeProxyConfig({ mode: 'direct' })).toEqual({ mode: 'direct' })
    expect(normalizeProxyConfig({ mode: 'system' })).toEqual({ mode: 'system' })
    expect(
      normalizeProxyConfig({ mode: 'auto_detect', rules: { singleProxy: { host: 'p' } } })
    ).toEqual({ mode: 'auto_detect' })
  })

  it('requires a mode from the enum', () => {
    expect(() => normalizeProxyConfig({})).toThrow(
      "Invalid value for argument 1. Property 'value.mode': Property is required."
    )
    expect(() => normalizeProxyConfig({ mode: 'manual' })).toThrow(
      "Property 'value.mode': Value must be one of direct, auto_detect, pac_script, fixed_servers, system."
    )
    expect(() => normalizeProxyConfig('direct')).toThrow(
      "Property 'value': Invalid type: expected object, found string."
    )
  })

  it('fills in the scheme and the default port of fixed servers, and always reports a bypass list', () => {
    expect(
      normalizeProxyConfig({
        mode: 'fixed_servers',
        rules: {
          proxyForHttp: { host: 'http.example' },
          proxyForHttps: { scheme: 'socks5', host: 'socks.example' },
          proxyForFtp: { scheme: 'https', host: 'tls.example', port: 8443 }
        }
      })
    ).toEqual({
      mode: 'fixed_servers',
      rules: {
        proxyForHttp: { scheme: 'http', host: 'http.example', port: 80 },
        proxyForHttps: { scheme: 'socks5', host: 'socks.example', port: 1080 },
        proxyForFtp: { scheme: 'https', host: 'tls.example', port: 8443 },
        bypassList: []
      }
    })
  })

  it('trims the bypass list and drops empty entries, as Chrome reads its preference back', () => {
    const config = normalizeProxyConfig({
      mode: 'fixed_servers',
      rules: {
        singleProxy: { host: 'p.example', port: 3128 },
        bypassList: [' <local> ', '', '*.example.org', '127.0.0.1/8']
      }
    })
    expect(config.rules?.bypassList).toEqual(['<local>', '*.example.org', '127.0.0.1/8'])
  })

  it('reports a fallback proxy without an explicit scheme as SOCKS4 (Chromium parses `socks=` so)', () => {
    const config = normalizeProxyConfig({
      mode: 'fixed_servers',
      rules: { fallbackProxy: { host: 'fb.example' } }
    })
    expect(config.rules?.fallbackProxy).toEqual({ scheme: 'socks4', host: 'fb.example', port: 80 })
    // Applied from the canonical form, the scheme is spelled out: the same SOCKS4 proxy to Chromium.
    expect(sessionProxyConfig(config).proxyRules).toBe('socks=socks4://fb.example:80')
  })

  it('refuses singleProxy beside a per-scheme proxy, fixed servers without rules, and non-ASCII hosts', () => {
    expect(() =>
      normalizeProxyConfig({
        mode: 'fixed_servers',
        rules: { singleProxy: { host: 'a' }, proxyForHttps: { host: 'b' } }
      })
    ).toThrow('Proxy rule for singleProxy and proxyForHttps cannot be set at the same time.')
    expect(() => normalizeProxyConfig({ mode: 'fixed_servers' })).toThrow(
      "Proxy mode 'fixed_servers' requires a 'rules' field."
    )
    expect(() =>
      normalizeProxyConfig({ mode: 'fixed_servers', rules: { bypassList: [] } })
    ).toThrow("Proxy mode 'fixed_servers' requires a 'rules' field.")
    expect(() =>
      normalizeProxyConfig({
        mode: 'fixed_servers',
        rules: { singleProxy: { host: 'b\u00fccher.example' } }
      })
    ).toThrow("'host' field supports only ASCII URLs (encode URLs in Punycode format).")
    expect(() =>
      normalizeProxyConfig({ mode: 'fixed_servers', rules: { singleProxy: { port: 80 } } })
    ).toThrow("Property 'value.rules.singleProxy.host': Property is required.")
    expect(() =>
      normalizeProxyConfig({
        mode: 'fixed_servers',
        rules: { singleProxy: { host: 'a', scheme: 'ftp' } }
      })
    ).toThrow(
      "Property 'value.rules.singleProxy.scheme': Value must be one of http, https, quic, socks4, socks5."
    )
  })

  it('checks the rules even in a mode that ignores them, as Chrome does', () => {
    expect(() =>
      normalizeProxyConfig({ mode: 'direct', rules: { singleProxy: { host: 42 } } })
    ).toThrow(
      "Property 'value.rules.singleProxy.host': Invalid type: expected string, found number."
    )
    expect(() =>
      normalizeProxyConfig({ mode: 'direct', rules: { bypassList: ['\u00e9.example'] } })
    ).toThrow("'rules.bypassList' could not be parsed.")
  })

  it('keeps a PAC by URL or by inline data, mandatory false unless said, and needs one of the two', () => {
    expect(
      normalizeProxyConfig({ mode: 'pac_script', pacScript: { url: 'http://p.example/proxy.pac' } })
    ).toEqual({
      mode: 'pac_script',
      pacScript: { url: 'http://p.example/proxy.pac', mandatory: false }
    })
    const script = 'function FindProxyForURL(url, host) { return "PROXY p.example:3128"; }'
    expect(
      normalizeProxyConfig({ mode: 'pac_script', pacScript: { data: script, mandatory: true } })
    ).toEqual({ mode: 'pac_script', pacScript: { data: script, mandatory: true } })
    // The URL wins when both are given (Chrome takes the URL first).
    expect(
      normalizeProxyConfig({ mode: 'pac_script', pacScript: { url: 'http://a/', data: script } })
        .pacScript
    ).toEqual({ url: 'http://a/', mandatory: false })
    expect(() => normalizeProxyConfig({ mode: 'pac_script' })).toThrow(
      "Proxy mode 'pac_script' requires a 'pacScript' field with either a 'url' field or a 'data' field."
    )
    expect(() =>
      normalizeProxyConfig({ mode: 'pac_script', pacScript: { url: '', data: '' } })
    ).toThrow("requires a 'pacScript' field")
    expect(() =>
      normalizeProxyConfig({ mode: 'pac_script', pacScript: { url: 'http://b\u00fccher/p.pac' } })
    ).toThrow("'pacScript.url' supports only ASCII URLs (encode URLs in Punycode format).")
    expect(() =>
      normalizeProxyConfig({ mode: 'pac_script', pacScript: { data: 'x', mandatory: 'yes' } })
    ).toThrow("Property 'value.pacScript.mandatory': Invalid type: expected boolean, found string.")
  })
})

describe('sessionProxyConfig (what Electron\u2019s session.setProxy is told)', () => {
  it('writes Chromium\u2019s rules string: the http scheme implied, the others spelled out, per-scheme keys', () => {
    expect(
      sessionProxyConfig(
        normalizeProxyConfig({
          mode: 'fixed_servers',
          rules: {
            proxyForHttp: { host: 'http.example' },
            proxyForHttps: { scheme: 'socks5', host: 'socks.example' },
            proxyForFtp: { scheme: 'https', host: 'tls.example', port: 8443 },
            fallbackProxy: { scheme: 'socks4', host: '::1' },
            bypassList: ['<local>', '*.example.org']
          }
        })
      )
    ).toEqual({
      mode: 'fixed_servers',
      proxyRules:
        'http=http.example:80;https=socks5://socks.example:1080;ftp=https://tls.example:8443;socks=socks4://[::1]:1080',
      proxyBypassRules: '<local>,*.example.org'
    })
    expect(
      sessionProxyConfig(
        normalizeProxyConfig({
          mode: 'fixed_servers',
          rules: { singleProxy: { scheme: 'https', host: 'one.example', port: 443 } }
        })
      )
    ).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'https://one.example:443',
      proxyBypassRules: ''
    })
  })

  it('hands a PAC URL through and turns inline data into the data: URL Chromium\u2019s fetcher takes', () => {
    expect(
      sessionProxyConfig({ mode: 'pac_script', pacScript: { url: 'http://p.example/proxy.pac' } })
    ).toEqual({ mode: 'pac_script', pacScript: 'http://p.example/proxy.pac' })
    const script = 'function FindProxyForURL(url, host) { return "DIRECT"; } // caf\u00e9'
    const applied = sessionProxyConfig({ mode: 'pac_script', pacScript: { data: script } })
    expect(applied.mode).toBe('pac_script')
    expect(applied.pacScript).toBe(pacDataUrl(script))
    expect(applied.pacScript?.startsWith('data:application/x-ns-proxy-autoconfig;base64,')).toBe(
      true
    )
    expect(pacScriptOfDataUrl(applied.pacScript ?? '')).toBe(script)
    expect(pacScriptOfDataUrl('http://p.example/proxy.pac')).toBeUndefined()
  })

  it('maps the plain modes one to one', () => {
    expect(sessionProxyConfig({ mode: 'direct' })).toEqual({ mode: 'direct' })
    expect(sessionProxyConfig({ mode: 'auto_detect' })).toEqual({ mode: 'auto_detect' })
    expect(sessionProxyConfig(SYSTEM_PROXY_CONFIG)).toEqual({ mode: 'system' })
  })
})

describe('the config as a setting value', () => {
  it('round-trips through its JSON text and reads anything else as the system\u2019s settings', () => {
    const config = normalizeProxyConfig({
      mode: 'fixed_servers',
      rules: { singleProxy: { host: 'p.example' } }
    })
    expect(proxyConfigOf(proxyConfigValue(config))).toEqual(config)
    expect(proxyConfigOf(undefined)).toEqual(SYSTEM_PROXY_CONFIG)
    expect(proxyConfigOf('not json')).toEqual(SYSTEM_PROXY_CONFIG)
    expect(proxyConfigOf(JSON.stringify({ mode: 'nope' }))).toEqual(SYSTEM_PROXY_CONFIG)
  })
})
