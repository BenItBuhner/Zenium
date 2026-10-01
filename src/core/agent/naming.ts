/**
 * What an agent must call itself before it may touch the browser (`zen_session start`). The
 * user reads the name on the agent's cursor, its tab badges, its group and in Settings → AI
 * Agents, often with several agents at work at once: "Agent", "Claude" or "cursor-vscode" tells
 * them nothing, and two agents of one harness would look the same. A name says what the agent
 * is doing – "Invoice reconciliation", "PR 741 review", "Flight search: Lisbon in May".
 */

export const AGENT_NAME_MIN = 6
export const AGENT_NAME_MAX = 48

/**
 * Words that say nothing about the task: the harness, the model, the role, filler. A name made
 * only of these (and numbers) is refused.
 */
const GENERIC_WORDS = new Set([
  'a',
  'agent',
  'agents',
  'ai',
  'an',
  'app',
  'assistant',
  'auto',
  'automation',
  'background',
  'bot',
  'browser',
  'browsing',
  'chat',
  'chatgpt',
  'chrome',
  'claude',
  'cli',
  'client',
  'code',
  'codex',
  'composer',
  'copilot',
  'cursor',
  'default',
  'desktop',
  'fable',
  'gemini',
  'glm',
  'gpt',
  'grok',
  'helper',
  'instance',
  'kimi',
  'llm',
  'main',
  'mcp',
  'model',
  'my',
  'new',
  'of',
  'opencode',
  'opus',
  'primary',
  'robot',
  'secondary',
  'server',
  'session',
  'sonnet',
  'stdio',
  'sub',
  'subagent',
  'task',
  'test',
  'testing',
  'the',
  'thing',
  'tool',
  'untitled',
  'user',
  'vscode',
  'web',
  'work',
  'worker',
  'zen',
  'zenium'
])

/** What every tool but `zen_status` and `zen_session` answers an agent that has not named itself. */
export const NAME_YOURSELF =
  'Start your session first: zen_session {"action":"start","name":"<what you are doing>"} – a specific, descriptive name the user will see beside your tabs, e.g. "Invoice reconciliation" or "PR 741 review" (generic names such as "Agent", "Claude" or your client\'s name are refused). It returns a session key: keep it, and after any reconnect zen_session {"action":"resume","key":"…"} gives you back your session, groups and tabs. Already started before a reconnect? Resume with your key instead.'

export type NameVerdict = { ok: true; name: string } | { ok: false; reason: string }

const EXAMPLES = '"Invoice reconciliation", "PR 741 review", "Flight search: Lisbon in May"'

/**
 * Whether `raw` is a name an agent may go by: printable, `AGENT_NAME_MIN`–`AGENT_NAME_MAX`
 * characters, at least one word that is not generic (see `GENERIC_WORDS`) and at least three
 * letters long, and not the MCP client's own name (`clientName`, which every agent of that
 * harness shares). `taken` are the names other agents hold now (compared case-insensitively).
 */
export function checkAgentName(
  raw: unknown,
  opts: { clientName?: string; taken?: Iterable<string> } = {}
): NameVerdict {
  if (typeof raw !== 'string' || !raw.trim())
    return {
      ok: false,
      reason: `name is required: a short description of what you are doing, e.g. ${EXAMPLES}`
    }
  const name = raw
    .replace(/[^\p{L}\p{N} _.,:/#@&+'()-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (name.length < AGENT_NAME_MIN)
    return {
      ok: false,
      reason: `${JSON.stringify(name)} is too short: say what you are doing in ${AGENT_NAME_MIN}–${AGENT_NAME_MAX} characters, e.g. ${EXAMPLES}`
    }
  if (name.length > AGENT_NAME_MAX)
    return {
      ok: false,
      reason: `${JSON.stringify(name.slice(0, 60))}… is too long: at most ${AGENT_NAME_MAX} characters – the user reads it on a tab badge`
    }
  const lower = name.toLowerCase()
  const client = (opts.clientName ?? '').trim().toLowerCase()
  if (client && (lower === client || squash(lower) === squash(client)))
    return {
      ok: false,
      reason: `${JSON.stringify(name)} is your MCP client's name, which every agent of that client shares – name the task instead, e.g. ${EXAMPLES}`
    }
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const telling = words.filter((w) => !GENERIC_WORDS.has(w) && /\p{L}{3,}/u.test(w))
  if (!telling.length)
    return {
      ok: false,
      reason: `${JSON.stringify(name)} is generic – it names a model, a harness or a role, not your task. The user sees it beside your tabs; say what you are doing, e.g. ${EXAMPLES}`
    }
  for (const other of opts.taken ?? [])
    if (other.trim().toLowerCase() === lower)
      return {
        ok: false,
        reason: `another agent already goes by ${JSON.stringify(name)} – add what sets your task apart (the site, the ticket, the goal)`
      }
  return { ok: true, name }
}

function squash(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, '')
}
