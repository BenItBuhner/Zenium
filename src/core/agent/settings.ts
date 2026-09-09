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
  const mode: AgentMode = r.defaultMode === 'background' ? 'background' : 'foreground'
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
    showCursor: typeof r.showCursor === 'boolean' ? r.showCursor : d.showCursor
  }
}
