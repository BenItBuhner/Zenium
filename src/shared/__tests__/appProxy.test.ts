import { describe, expect, it } from 'vitest'
import {
  APP_PROXY_COPY,
  DEFAULT_APP_PROXY_SETTINGS,
  agentTabProxyId,
  applyAgentGrant,
  compilePacScript,
  emptyProxyProfile,
  emptyProxyRoute,
  grantForAgent,
  profileLabel,
  profileProblem,
  resolveProxyTarget,
  routeLabel,
  routeMatches,
  routeProblem,
  sanitizeAppProxySettings,
  sanitizeTabProxyId,
  targetLabel,
  type AppProxySettings,
  type ProxyProfile,
  type ProxyRoute
} from '../appProxy'

function profile(patch: Partial<ProxyProfile> = {}): ProxyProfile {
  return {
    id: 'office',
    name: 'Office',
    kind: 'http',
    host: 'proxy.office.test',
    port: 8080,
    username: '',
    password: '',
    pacUrl: '',
    pacData: '',
    bypassList: [],
    ...patch
  }
}

function settings(patch: Partial<AppProxySettings> = {}): AppProxySettings {
  return sanitizeAppProxySettings({
    profiles: [profile()],
    defaultTarget: 'system',
    routes: [],
    agentGrants: [],
    ...patch
  })
}

describe('sanitizeAppProxySettings', () => {
  it('reads the empty default for anything unreadable', () => {
    expect(sanitizeAppProxySettings(undefined)).toEqual(DEFAULT_APP_PROXY_SETTINGS)
    expect(sanitizeAppProxySettings('socks')).toEqual(DEFAULT_APP_PROXY_SETTINGS)
    expect(sanitizeAppProxySettings({ defaultTarget: 'missing' }).defaultTarget).toBe('system')
  })

  it('keeps named profiles, drops duplicate ids, and falls an unknown default back to system', () => {
    const raw = {
      profiles: [
        profile(),
        profile({ id: 'office', name: 'Dup' }),
        { id: 'home', kind: 'socks5', host: '127.0.0.1', port: 1080 }
      ],
      defaultTarget: 'home',
      routes: [{ id: 'r1', match: 'host-suffix', pattern: 'intranet.test', target: 'office' }],
      agentGrants: [{ agentName: 'Claude', mode: 'allow', proxyIds: ['office', 'gone'] }]
    }
    const clean = sanitizeAppProxySettings(raw)
    expect(clean.profiles.map((p) => p.id)).toEqual(['office', 'home'])
    expect(clean.defaultTarget).toBe('home')
    expect(clean.routes).toEqual([
      {
        id: 'r1',
        enabled: true,
        match: 'host-suffix',
        pattern: 'intranet.test',
        target: 'office'
      }
    ])
    expect(clean.agentGrants).toEqual([
      { agentName: 'Claude', mode: 'allow', proxyIds: ['office'] }
    ])
  })

  it('drops a route with no pattern and an unknown target becomes direct', () => {
    const clean = sanitizeAppProxySettings({
      profiles: [profile()],
      routes: [
        { id: 'empty', pattern: '  ' },
        { id: 'gone', pattern: 'x.test', target: 'missing' }
      ]
    })
    expect(clean.routes).toEqual([
      { id: 'gone', enabled: true, match: 'host-suffix', pattern: 'x.test', target: 'direct' }
    ])
  })
})

describe('resolveProxyTarget', () => {
  const routed = settings({
    defaultTarget: 'system',
    routes: [
      {
        id: 'corp',
        enabled: true,
        match: 'host-suffix',
        pattern: 'corp.test',
        target: 'office'
      },
      { id: 'off', enabled: false, match: 'host', pattern: 'skip.test', target: 'office' }
    ]
  })

  it('uses the tab override, then the first matching rule, then the default', () => {
    expect(resolveProxyTarget(routed, 'https://corp.test/a')).toBe('office')
    expect(resolveProxyTarget(routed, 'https://skip.test/')).toBe('system')
    expect(resolveProxyTarget(routed, 'https://news.test/', 'office')).toBe('office')
    expect(resolveProxyTarget(routed, 'https://news.test/', 'direct')).toBe('direct')
    expect(resolveProxyTarget(routed, 'https://news.test/')).toBe('system')
  })

  it('matches host, suffix, wildcard, scheme and URL prefix', () => {
    const rule = (match: ProxyRoute['match'], pattern: string): ProxyRoute => ({
      id: match,
      enabled: true,
      match,
      pattern,
      target: 'office'
    })
    expect(routeMatches(rule('host', 'mail.test'), 'https://mail.test/x')).toBe(true)
    expect(routeMatches(rule('host', 'mail.test'), 'https://box.mail.test/x')).toBe(false)
    expect(routeMatches(rule('host-suffix', 'mail.test'), 'https://box.mail.test/x')).toBe(true)
    expect(routeMatches(rule('wildcard', '*.cdn.test'), 'https://a.cdn.test/')).toBe(true)
    expect(routeMatches(rule('scheme', 'https'), 'https://x.test/')).toBe(true)
    expect(routeMatches(rule('scheme', 'https'), 'http://x.test/')).toBe(false)
    expect(routeMatches(rule('url-prefix', 'https://intranet/'), 'https://intranet/app')).toBe(true)
  })
})

describe('agent grants', () => {
  const locked = settings({
    agentGrants: [
      { agentName: 'Claude', mode: 'allow', proxyIds: ['office'] },
      { agentName: '*', mode: 'direct', proxyIds: [] }
    ]
  })

  it('names a grant, then *, then follow', () => {
    expect(grantForAgent(locked, 'Claude').mode).toBe('allow')
    expect(grantForAgent(locked, 'Codex').mode).toBe('direct')
    expect(grantForAgent(settings(), 'Claude').mode).toBe('follow')
  })

  it('narrows a resolved target: follow keeps it, direct forces direct, allow-list substitutes', () => {
    expect(applyAgentGrant(locked, 'office', 'Claude')).toBe('office')
    expect(applyAgentGrant(locked, 'system', 'Claude')).toBe('office')
    expect(applyAgentGrant(locked, 'office', 'Codex')).toBe('direct')
    expect(resolveProxyTarget(locked, 'https://x.test/', 'office', 'Codex')).toBe('direct')
    expect(agentTabProxyId(locked, 'Claude')).toBe('office')
    expect(agentTabProxyId(locked, 'Codex')).toBe('direct')
    expect(agentTabProxyId(settings(), 'Claude')).toBeUndefined()
  })
})

describe('labels, problems and PAC', () => {
  it('names a profile from its title, else the host, else PAC', () => {
    expect(profileLabel(profile())).toBe('Office')
    expect(profileLabel(profile({ name: '' }))).toBe('proxy.office.test:8080')
    expect(profileLabel(profile({ name: '', kind: 'pac', host: '', pacUrl: 'http://p/x.pac' }))).toBe(
      'http://p/x.pac'
    )
    expect(targetLabel(settings(), 'system')).toBe('System proxy')
    expect(targetLabel(settings(), 'direct')).toBe('Direct connection')
    expect(targetLabel(settings(), 'office')).toBe('Office')
    expect(routeLabel({ id: 'r', enabled: true, match: 'host-suffix', pattern: 'corp.test', target: 'office' })).toBe(
      '*.corp.test'
    )
  })

  it('refuses an empty host, a PAC with nothing in it, and a scheme that is not http(s)/ws(s)', () => {
    expect(profileProblem(emptyProxyProfile())).toBe('Enter a host')
    expect(profileProblem(profile())).toBeNull()
    expect(profileProblem(emptyProxyProfile('pac'))).toBe('Enter a PAC URL or paste a PAC script')
    expect(routeProblem(emptyProxyRoute())).toBe('Enter a pattern')
    expect(routeProblem({ ...emptyProxyRoute(), match: 'scheme', pattern: 'ftp' })).toBe(
      'Scheme must be http, https, ws or wss'
    )
  })

  it('compiles routing rules to a PAC whose unmatched return is DIRECT when the default is the system', () => {
    const pac = compilePacScript(
      settings({
        routes: [
          {
            id: 'r',
            enabled: true,
            match: 'host-suffix',
            pattern: 'corp.test',
            target: 'office'
          }
        ]
      })
    )
    expect(pac).toContain('return "PROXY proxy.office.test:8080"')
    expect(pac).toContain('return "DIRECT"')
    expect(APP_PROXY_COPY.default).toBe('Default connection')
  })

  it('keeps a tab override only when the target still exists', () => {
    expect(sanitizeTabProxyId('office', settings())).toBe('office')
    expect(sanitizeTabProxyId('direct', settings())).toBe('direct')
    expect(sanitizeTabProxyId('gone', settings())).toBeUndefined()
    expect(sanitizeTabProxyId(1, settings())).toBeUndefined()
  })
})
