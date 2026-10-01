import { describe, expect, it } from 'vitest'
import { AGENT_NAME_MAX, checkAgentName } from '../naming'

describe('checkAgentName', () => {
  it('accepts names that say what the agent is doing', () => {
    for (const name of [
      'Invoice reconciliation',
      'PR 741 review',
      'Flight search: Lisbon in May',
      'Recherche de vols',
      'Docs audit (billing)'
    ])
      expect(checkAgentName(name)).toEqual({ ok: true, name })
  })

  it('refuses names of a model, a harness or a role, however they are dressed up', () => {
    for (const name of [
      'Agent',
      'Claude',
      'Cursor Agent',
      'claude-code',
      'AI assistant',
      'GPT 5 agent',
      'Browser bot 2',
      'subagent 3',
      'Zenium MCP client',
      'Test agent'
    ]) {
      const verdict = checkAgentName(name)
      expect(verdict.ok, name).toBe(false)
    }
    const generic = checkAgentName('Claude Opus agent')
    expect(generic.ok).toBe(false)
    if (!generic.ok) expect(generic.reason).toContain('"Invoice reconciliation"')
  })

  it('refuses the MCP client name every agent of that client shares, in any spelling', () => {
    expect(checkAgentName('Acme Copilot X', { clientName: 'acme-copilot-x' }).ok).toBe(false)
    expect(checkAgentName('acme copilot x review', { clientName: 'acme-copilot-x' }).ok).toBe(true)
  })

  it('refuses empty, short, long and taken names, and cleans control characters', () => {
    expect(checkAgentName(undefined).ok).toBe(false)
    expect(checkAgentName('   ').ok).toBe(false)
    expect(checkAgentName('Docs').ok).toBe(false)
    expect(checkAgentName('x'.repeat(AGENT_NAME_MAX + 1)).ok).toBe(false)
    expect(checkAgentName('Price watch', { taken: ['price WATCH'] }).ok).toBe(false)
    expect(checkAgentName('Price\u0000 watch\n\tdaily')).toEqual({
      ok: true,
      name: 'Price watch daily'
    })
  })
})
