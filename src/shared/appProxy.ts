/**
 * In-app proxy configuration: named servers, domain (and similar) routing, per-tab overrides
 * and which proxies agents may send traffic through. Pure — persistence and Electron sessions
 * live elsewhere. `chrome.proxy` still wins while an extension holds the setting.
 */
import { newId } from './ids'

export const PROXY_PROFILE_KINDS = ['http', 'https', 'socks4', 'socks5', 'pac'] as const
export type ProxyProfileKind = (typeof PROXY_PROFILE_KINDS)[number]

export const PROXY_BUILTINS = ['system', 'direct'] as const
export type ProxyBuiltin = (typeof PROXY_BUILTINS)[number]

export const PROXY_ROUTE_MATCHES = [
  'host',
  'host-suffix',
  'wildcard',
  'scheme',
  'url-prefix'
] as const
export type ProxyRouteMatch = (typeof PROXY_ROUTE_MATCHES)[number]

export const AGENT_PROXY_MODES = ['follow', 'allow', 'direct'] as const
export type AgentProxyMode = (typeof AGENT_PROXY_MODES)[number]

/** A configured server or PAC the user named. */
export interface ProxyProfile {
  id: string
  name: string
  kind: ProxyProfileKind
  host: string
  port: number
  username: string
  password: string
  pacUrl: string
  pacData: string
  bypassList: string[]
}

/** One routing rule: first enabled match wins. */
export interface ProxyRoute {
  id: string
  enabled: boolean
  match: ProxyRouteMatch
  pattern: string
  /** A profile id, or `direct` / `system`. */
  target: string
}

/** Which proxies one MCP client (by name) may send traffic through. `*` is the default grant. */
export interface AgentProxyGrant {
  agentName: string
  mode: AgentProxyMode
  proxyIds: string[]
}

export interface AppProxySettings {
  profiles: ProxyProfile[]
  /** `system`, `direct`, or a profile id. */
  defaultTarget: string
  routes: ProxyRoute[]
  agentGrants: AgentProxyGrant[]
}

export const DEFAULT_APP_PROXY_SETTINGS: AppProxySettings = {
  profiles: [],
  defaultTarget: 'system',
  routes: [],
  agentGrants: []
}

export const MAX_PROXY_PROFILES = 40
export const MAX_PROXY_ROUTES = 80
export const MAX_AGENT_PROXY_GRANTS = 80

const DEFAULT_PORTS: Readonly<Record<Exclude<ProxyProfileKind, 'pac'>, number>> = {
  http: 8080,
  https: 443,
  socks4: 1080,
  socks5: 1080
}

export function isProxyProfileKind(value: unknown): value is ProxyProfileKind {
  return typeof value === 'string' && (PROXY_PROFILE_KINDS as readonly string[]).includes(value)
}

export function isProxyBuiltin(value: unknown): value is ProxyBuiltin {
  return typeof value === 'string' && (PROXY_BUILTINS as readonly string[]).includes(value)
}

export function isProxyRouteMatch(value: unknown): value is ProxyRouteMatch {
  return typeof value === 'string' && (PROXY_ROUTE_MATCHES as readonly string[]).includes(value)
}

export function isAgentProxyMode(value: unknown): value is AgentProxyMode {
  return typeof value === 'string' && (AGENT_PROXY_MODES as readonly string[]).includes(value)
}

export function emptyProxyProfile(kind: ProxyProfileKind = 'http'): ProxyProfile {
  return {
    id: newId('proxy'),
    name: '',
    kind,
    host: '',
    port: kind === 'pac' ? 0 : DEFAULT_PORTS[kind],
    username: '',
    password: '',
    pacUrl: '',
    pacData: '',
    bypassList: []
  }
}

export function emptyProxyRoute(): ProxyRoute {
  return {
    id: newId('route'),
    enabled: true,
    match: 'host-suffix',
    pattern: '',
    target: 'direct'
  }
}

export function emptyAgentProxyGrant(): AgentProxyGrant {
  return { agentName: '', mode: 'follow', proxyIds: [] }
}

export function sanitizeAppProxySettings(raw: unknown): AppProxySettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return structuredClone(DEFAULT_APP_PROXY_SETTINGS)
  }
  const entry = raw as Record<string, unknown>
  const seen = new Set<string>()
  const profiles: ProxyProfile[] = []
  if (Array.isArray(entry.profiles)) {
    for (const item of entry.profiles) {
      const profile = sanitizeProfile(item)
      if (!profile || seen.has(profile.id)) continue
      seen.add(profile.id)
      profiles.push(profile)
      if (profiles.length >= MAX_PROXY_PROFILES) break
    }
  }
  const profileIds = new Set(profiles.map((p) => p.id))
  const routes: ProxyRoute[] = []
  if (Array.isArray(entry.routes)) {
    const routeIds = new Set<string>()
    for (const item of entry.routes) {
      const route = sanitizeRoute(item, profileIds)
      if (!route || routeIds.has(route.id)) continue
      routeIds.add(route.id)
      routes.push(route)
      if (routes.length >= MAX_PROXY_ROUTES) break
    }
  }
  const grants: AgentProxyGrant[] = []
  if (Array.isArray(entry.agentGrants)) {
    const names = new Set<string>()
    for (const item of entry.agentGrants) {
      const grant = sanitizeGrant(item, profileIds)
      if (!grant) continue
      const key = grant.agentName.toLowerCase()
      if (names.has(key)) continue
      names.add(key)
      grants.push(grant)
      if (grants.length >= MAX_AGENT_PROXY_GRANTS) break
    }
  }
  return {
    profiles,
    defaultTarget: sanitizeTarget(entry.defaultTarget, profileIds, 'system'),
    routes,
    agentGrants: grants
  }
}

function sanitizeProfile(raw: unknown): ProxyProfile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || entry.id.trim() === '') return null
  const kind = isProxyProfileKind(entry.kind) ? entry.kind : 'http'
  const host = typeof entry.host === 'string' ? entry.host.trim() : ''
  const port = Number(entry.port)
  const bypass = Array.isArray(entry.bypassList)
    ? entry.bypassList
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .slice(0, 64)
    : []
  return {
    id: entry.id.trim(),
    name: typeof entry.name === 'string' ? entry.name.trim().slice(0, 80) : '',
    kind,
    host: host.slice(0, 253),
    port:
      Number.isInteger(port) && port >= 0 && port <= 65535
        ? port
        : kind === 'pac'
          ? 0
          : DEFAULT_PORTS[kind],
    username: typeof entry.username === 'string' ? entry.username.slice(0, 200) : '',
    password: typeof entry.password === 'string' ? entry.password.slice(0, 400) : '',
    pacUrl: typeof entry.pacUrl === 'string' ? entry.pacUrl.trim().slice(0, 2000) : '',
    pacData: typeof entry.pacData === 'string' ? entry.pacData.slice(0, 100_000) : '',
    bypassList: bypass
  }
}

function sanitizeRoute(raw: unknown, profileIds: Set<string>): ProxyRoute | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  if (typeof entry.id !== 'string' || entry.id.trim() === '') return null
  const pattern = typeof entry.pattern === 'string' ? entry.pattern.trim() : ''
  if (pattern === '') return null
  return {
    id: entry.id.trim(),
    enabled: entry.enabled !== false,
    match: isProxyRouteMatch(entry.match) ? entry.match : 'host-suffix',
    pattern: pattern.slice(0, 500),
    target: sanitizeTarget(entry.target, profileIds, 'direct')
  }
}

function sanitizeGrant(raw: unknown, profileIds: Set<string>): AgentProxyGrant | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  const name = typeof entry.agentName === 'string' ? entry.agentName.trim() : ''
  if (name === '') return null
  const ids = Array.isArray(entry.proxyIds)
    ? [
        ...new Set(
          entry.proxyIds.filter((id): id is string => typeof id === 'string' && profileIds.has(id))
        )
      ]
    : []
  return {
    agentName: name.slice(0, 80),
    mode: isAgentProxyMode(entry.mode) ? entry.mode : 'follow',
    proxyIds: ids
  }
}

function sanitizeTarget(raw: unknown, profileIds: Set<string>, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const target = raw.trim()
  if (isProxyBuiltin(target) || profileIds.has(target)) return target
  return fallback
}

export function profileById(
  settings: AppProxySettings,
  id: string | null | undefined
): ProxyProfile | undefined {
  if (!id) return undefined
  return settings.profiles.find((profile) => profile.id === id)
}

export function isKnownProxyTarget(settings: AppProxySettings, target: string): boolean {
  return isProxyBuiltin(target) || settings.profiles.some((profile) => profile.id === target)
}

/** A tab override: a builtin, a profile id, or empty (follow default + routes). */
export function sanitizeTabProxyId(
  raw: unknown,
  settings: AppProxySettings
): string | undefined {
  if (typeof raw !== 'string') return undefined
  const id = raw.trim()
  if (id === '' || !isKnownProxyTarget(settings, id)) return undefined
  return id
}

export function profileLabel(profile: ProxyProfile): string {
  const name = profile.name.trim()
  if (name) return name
  if (profile.kind === 'pac') {
    return profile.pacUrl.trim() || 'PAC script'
  }
  return profile.host ? `${profile.host}:${profile.port}` : 'Untitled proxy'
}

export function targetLabel(settings: AppProxySettings, target: string): string {
  if (target === 'system') return 'System proxy'
  if (target === 'direct') return 'Direct connection'
  const profile = profileById(settings, target)
  return profile ? profileLabel(profile) : 'Unknown proxy'
}

export function routeLabel(route: ProxyRoute): string {
  switch (route.match) {
    case 'host':
      return route.pattern
    case 'host-suffix':
      return `*.${route.pattern.replace(/^\*\./, '')}`
    case 'wildcard':
      return route.pattern
    case 'scheme':
      return `${route.pattern}://`
    case 'url-prefix':
      return `${route.pattern}…`
  }
}

export function profileProblem(profile: ProxyProfile): string | null {
  if (profile.kind === 'pac') {
    if (profile.pacUrl.trim() === '' && profile.pacData.trim() === '') {
      return 'Enter a PAC URL or paste a PAC script'
    }
    return null
  }
  if (profile.host.trim() === '') return 'Enter a host'
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
    return 'Enter a port from 1 to 65535'
  }
  return null
}

export function routeProblem(route: ProxyRoute): string | null {
  const pattern = route.pattern.trim()
  if (pattern === '') return 'Enter a pattern'
  if (route.match === 'scheme') {
    const scheme = pattern.toLowerCase().replace(/:.*$/, '')
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') {
      return 'Scheme must be http, https, ws or wss'
    }
  }
  if (route.match === 'host' || route.match === 'host-suffix') {
    if (/\s/.test(pattern) || pattern.includes('/')) return 'Enter a hostname, not a URL'
  }
  return null
}

export function grantForAgent(
  settings: AppProxySettings,
  agentName: string | null | undefined
): AgentProxyGrant {
  const name = (agentName ?? '').trim().toLowerCase()
  if (name) {
    const exact = settings.agentGrants.find((grant) => grant.agentName.toLowerCase() === name)
    if (exact) return exact
  }
  const star = settings.agentGrants.find((grant) => grant.agentName === '*')
  return star ?? { agentName: '*', mode: 'follow', proxyIds: [] }
}

/**
 * Which configured target a request should use: tab override, then the first matching route,
 * then the default — then an agent's grant may narrow it.
 */
export function resolveProxyTarget(
  settings: AppProxySettings,
  url: string,
  tabOverride?: string | null,
  agentName?: string | null
): string {
  const override =
    typeof tabOverride === 'string' && isKnownProxyTarget(settings, tabOverride)
      ? tabOverride
      : undefined
  let target = override ?? matchingRoute(settings, url)?.target ?? settings.defaultTarget
  if (!isKnownProxyTarget(settings, target)) target = 'system'
  return applyAgentGrant(settings, target, agentName)
}

export function matchingRoute(settings: AppProxySettings, url: string): ProxyRoute | undefined {
  for (const route of settings.routes) {
    if (!route.enabled) continue
    if (routeMatches(route, url)) return route
  }
  return undefined
}

export function routeMatches(route: ProxyRoute, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  const pattern = route.pattern.trim().toLowerCase()
  if (pattern === '') return false
  switch (route.match) {
    case 'host':
      return host === pattern.replace(/^\*\./, '')
    case 'host-suffix': {
      const suffix = pattern.replace(/^\*\./, '')
      return host === suffix || host.endsWith(`.${suffix}`)
    }
    case 'wildcard':
      return wildcardMatch(host, pattern.replace(/^\*\./, '*') === pattern ? pattern : `*${pattern}`)
    case 'scheme':
      return parsed.protocol.replace(/:$/, '') === pattern.replace(/:.*$/, '')
    case 'url-prefix':
      return url.toLowerCase().startsWith(pattern)
  }
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

export function applyAgentGrant(
  settings: AppProxySettings,
  target: string,
  agentName?: string | null
): string {
  if (!agentName) return target
  const grant = grantForAgent(settings, agentName)
  if (grant.mode === 'follow') return target
  if (grant.mode === 'direct') return 'direct'
  if (target === 'direct' || grant.proxyIds.includes(target)) return target
  return grant.proxyIds[0] ?? 'direct'
}

/** The target an agent-created tab should start with (null = follow default + routes). */
export function agentTabProxyId(
  settings: AppProxySettings,
  agentName: string,
  url?: string
): string | undefined {
  const grant = grantForAgent(settings, agentName)
  if (grant.mode === 'follow') return undefined
  if (grant.mode === 'direct') return 'direct'
  const resolved = resolveProxyTarget(settings, url ?? 'https://example.com/', undefined, agentName)
  return resolved === settings.defaultTarget ? undefined : resolved
}

/** Host[:port] authority, with optional userinfo for a proxy that asks for a password. */
export function proxyAuthority(profile: ProxyProfile): string {
  const host = profile.host.trim()
  const user = profile.username.trim()
  if (!user) return host
  const pass = profile.password
  const auth = pass
    ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
    : `${encodeURIComponent(user)}@`
  return `${auth}${host}`
}

/** PAC for the routing table. Unmatched traffic uses the default; `system` there becomes DIRECT. */
export function compilePacScript(settings: AppProxySettings): string {
  const lines = [
    'function FindProxyForURL(url, host) {',
    '  host = host.toLowerCase();'
  ]
  for (const route of settings.routes) {
    if (!route.enabled) continue
    const ret = pacReturn(settings, route.target)
    const test = pacTest(route)
    if (!test) continue
    lines.push(`  if (${test}) return ${JSON.stringify(ret)};`)
  }
  lines.push(`  return ${JSON.stringify(pacReturn(settings, settings.defaultTarget))};`)
  lines.push('}')
  return lines.join('\n')
}

function pacTest(route: ProxyRoute): string | null {
  const pattern = route.pattern.trim()
  if (pattern === '') return null
  switch (route.match) {
    case 'host': {
      const host = pattern.replace(/^\*\./, '').toLowerCase()
      return `host === ${JSON.stringify(host)}`
    }
    case 'host-suffix': {
      const suffix = pattern.replace(/^\*\./, '').toLowerCase()
      return `host === ${JSON.stringify(suffix)} || dnsDomainIs(host, ${JSON.stringify(suffix)})`
    }
    case 'wildcard':
      return `shExpMatch(host, ${JSON.stringify(pattern)})`
    case 'scheme': {
      const scheme = pattern.toLowerCase().replace(/:.*$/, '')
      return `url.substring(0, ${scheme.length + 1}) === ${JSON.stringify(`${scheme}:`)}`
    }
    case 'url-prefix':
      return `url.toLowerCase().indexOf(${JSON.stringify(pattern.toLowerCase())}) === 0`
  }
}

function pacReturn(settings: AppProxySettings, target: string): string {
  if (target === 'direct' || target === 'system') return 'DIRECT'
  const profile = profileById(settings, target)
  if (!profile || profile.kind === 'pac') return 'DIRECT'
  const host = profile.host.trim()
  if (!host) return 'DIRECT'
  const token =
    profile.kind === 'socks5'
      ? 'SOCKS5'
      : profile.kind === 'socks4'
        ? 'SOCKS'
        : profile.kind === 'https'
          ? 'HTTPS'
          : 'PROXY'
  return `${token} ${host}:${profile.port}`
}

export const APP_PROXY_COPY = {
  default: 'Default connection',
  defaultDescription: 'Used when a tab has no override and no routing rule matches.',
  proxies: 'Proxies',
  proxiesEmpty: 'No proxies added yet',
  addProxy: 'Add proxy',
  routes: 'Routing rules',
  routesDescription:
    'The first matching rule wins. A tab override still beats every rule.',
  routesEmpty: 'No routing rules yet',
  addRoute: 'Add routing rule',
  agents: 'Agent access',
  agentsDescription: 'Which traffic agents may send through which proxy.',
  agentDefault: 'Default for agents',
  addGrant: 'Add agent rule',
  computer: 'Computer',
  openSystem: "Open your computer's proxy settings",
  openSystemDescription: 'The operating system panel. Zenium can also use it as the default.',
  followTab: 'Follow the tab',
  followTabDescription: 'Use the tab’s proxy, then the routing rules, then the default.',
  allowListed: 'Only listed proxies',
  allowListedDescription: 'Agent traffic may use these proxies, or a direct connection.',
  alwaysDirect: 'Direct connection only',
  alwaysDirectDescription: 'Agent traffic never goes through a configured proxy.'
} as const
