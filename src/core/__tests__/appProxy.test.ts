import { describe, expect, it } from 'vitest'
import { sanitizeAppProxySettings, type ProxyProfile } from '../../shared/appProxy'
import { compiledBrowserProxy, compiledSessionProxy, profileToProxyConfig } from '../appProxy'

const office: ProxyProfile = {
  id: 'office',
  name: 'Office',
  kind: 'http',
  host: 'proxy.office.test',
  port: 8080,
  username: '',
  password: '',
  pacUrl: '',
  pacData: '',
  bypassList: ['localhost']
}

describe('compiledBrowserProxy', () => {
  it('is the system proxy when nothing is configured', () => {
    expect(compiledBrowserProxy(sanitizeAppProxySettings(undefined))).toEqual({ mode: 'system' })
    expect(compiledSessionProxy(sanitizeAppProxySettings({ defaultTarget: 'direct' }))).toEqual({
      mode: 'direct'
    })
  })

  it('is the named server when that is the default and there are no rules', () => {
    const settings = sanitizeAppProxySettings({
      profiles: [office],
      defaultTarget: 'office'
    })
    expect(compiledBrowserProxy(settings)).toEqual({
      mode: 'fixed_servers',
      rules: {
        singleProxy: { scheme: 'http', host: 'proxy.office.test', port: 8080 },
        bypassList: ['localhost']
      }
    })
    expect(compiledSessionProxy(settings)).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'proxy.office.test:8080',
      proxyBypassRules: 'localhost'
    })
  })

  it('becomes a PAC when any routing rule is on', () => {
    const settings = sanitizeAppProxySettings({
      profiles: [office],
      defaultTarget: 'system',
      routes: [{ id: 'r', match: 'host-suffix', pattern: 'corp.test', target: 'office' }]
    })
    const config = compiledBrowserProxy(settings)
    expect(config.mode).toBe('pac_script')
    expect(config.pacScript?.data).toContain('PROXY proxy.office.test:8080')
  })

  it('turns a PAC profile into a pac_script config', () => {
    expect(
      profileToProxyConfig({
        ...office,
        kind: 'pac',
        pacUrl: 'http://p.example/proxy.pac'
      })
    ).toEqual({
      mode: 'pac_script',
      pacScript: { url: 'http://p.example/proxy.pac', mandatory: false }
    })
  })
})
