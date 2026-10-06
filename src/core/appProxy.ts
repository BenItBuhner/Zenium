/**
 * Compile the user's in-app proxy settings into a `chrome.proxy` config the sessions apply
 * while no extension holds the setting.
 */
import {
  compilePacScript,
  profileById,
  proxyAuthority,
  type AppProxySettings,
  type ProxyProfile
} from '../shared/appProxy'
import {
  normalizeProxyConfig,
  sessionProxyConfig,
  type ProxyConfig,
  type SessionProxyConfig
} from './extensions/api/proxy'

export function profileToProxyConfig(profile: ProxyProfile): ProxyConfig {
  if (profile.kind === 'pac') {
    const url = profile.pacUrl.trim()
    const data = profile.pacData
    if (url) return normalizeProxyConfig({ mode: 'pac_script', pacScript: { url } })
    return normalizeProxyConfig({ mode: 'pac_script', pacScript: { data } })
  }
  const scheme =
    profile.kind === 'https'
      ? 'https'
      : profile.kind === 'socks4'
        ? 'socks4'
        : profile.kind === 'socks5'
          ? 'socks5'
          : 'http'
  return normalizeProxyConfig({
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme, host: proxyAuthority(profile), port: profile.port },
      bypassList: profile.bypassList
    }
  })
}

export function targetToProxyConfig(settings: AppProxySettings, target: string): ProxyConfig {
  if (target === 'direct') return { mode: 'direct' }
  if (target === 'system') return { mode: 'system' }
  const profile = profileById(settings, target)
  if (!profile) return { mode: 'system' }
  try {
    return profileToProxyConfig(profile)
  } catch {
    return { mode: 'system' }
  }
}

/**
 * What the browsing sessions apply while no extension holds `chrome.proxy`: a single server,
 * a PAC compiled from the routing rules, or the computer's proxy.
 */
export function compiledBrowserProxy(settings: AppProxySettings): ProxyConfig {
  const enabledRoutes = settings.routes.filter((route) => route.enabled)
  if (enabledRoutes.length === 0) return targetToProxyConfig(settings, settings.defaultTarget)
  try {
    return normalizeProxyConfig({
      mode: 'pac_script',
      pacScript: { data: compilePacScript(settings) }
    })
  } catch {
    return targetToProxyConfig(settings, settings.defaultTarget)
  }
}

export function compiledSessionProxy(settings: AppProxySettings): SessionProxyConfig {
  return sessionProxyConfig(compiledBrowserProxy(settings))
}
