import type { AgentMode, AgentSettings } from '../../shared/types'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/defaults'

export const MIN_AGENT_PORT = 1024
export const MAX_AGENT_PORT = 65535

/** Fill in missing fields and clamp values from persisted / client-supplied settings. */
export function sanitizeAgentSettings(
  raw: Partial<AgentSettings> | undefined | null
): AgentSettings {
  const d = DEFAULT_AGENT_SETTINGS
  const r = raw ?? {}
  const port = Number(r.port)
  // A mode the user chose stands, either one; anything else is the default's.
  const mode: AgentMode =
    r.defaultMode === 'background' || r.defaultMode === 'foreground' ? r.defaultMode : d.defaultMode
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    port:
      Number.isInteger(port) && port >= MIN_AGENT_PORT && port <= MAX_AGENT_PORT ? port : d.port,
    lan: typeof r.lan === 'boolean' ? r.lan : d.lan,
    approveNewAgents:
      typeof r.approveNewAgents === 'boolean' ? r.approveNewAgents : d.approveNewAgents,
    approvedNames: Array.isArray(r.approvedNames)
      ? [...new Set(r.approvedNames.filter((n) => typeof n === 'string' && n.trim()))].slice(0, 200)
      : [],
    defaultMode: mode,
    allowScripts: typeof r.allowScripts === 'boolean' ? r.allowScripts : d.allowScripts,
    showCursor: typeof r.showCursor === 'boolean' ? r.showCursor : d.showCursor,
    remote: typeof r.remote === 'boolean' ? r.remote : d.remote,
    relayUrl:
      typeof r.relayUrl === 'string' && isRelayUrl(r.relayUrl.trim()) ? r.relayUrl.trim() : '',
    remoteApprovedClients: Array.isArray(r.remoteApprovedClients)
      ? [
          ...new Set(
            r.remoteApprovedClients.filter((n) => typeof n === 'string' && n.trim().length > 0)
          )
        ].slice(0, 200)
      : []
  }
}

/** An `https://` address (or `http://` on the loopback, for a relay run with `wrangler dev`). */
export function isRelayUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}
