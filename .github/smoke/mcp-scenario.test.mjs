import { describe, expect, it } from 'vitest'
import { SOFT_CHECKS, Verdict } from '../../scripts/mcp-soak.mjs'
import {
  MCP_RESTART_SCENARIO,
  MCP_SCENARIO,
  MCP_SOAK,
  agentSettings,
  freePort,
  judgeStep,
  mark
} from './mcp-scenario.mjs'

describe('the profile the scenario seeds', () => {
  it('turns the server on at the port, loopback only, new agents let in, scripts allowed', () => {
    expect(agentSettings(41739)).toEqual({
      enabled: true,
      port: 41739,
      lan: false,
      approveNewAgents: false,
      approvedNames: [],
      defaultMode: 'foreground',
      allowScripts: true,
      showCursor: true
    })
  })

  it('finds a free loopback port', async () => {
    const port = await freePort()
    expect(Number.isInteger(port)).toBe(true)
    expect(port).toBeGreaterThanOrEqual(1024)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('keeps the CI soak short and names its two launches', () => {
    expect(MCP_SOAK.sessions * MCP_SOAK.rounds).toBeLessThanOrEqual(12)
    expect(MCP_SOAK.concurrency).toBeLessThanOrEqual(MCP_SOAK.sessions)
    expect(MCP_SOAK.shimSessions).toBeLessThanOrEqual(3)
    expect(MCP_SCENARIO).toBe('mcp')
    expect(MCP_RESTART_SCENARIO).toBe('mcp-restart')
  })
})

describe('judgeStep', () => {
  it('passes a step whose only failures are soft, and puts them in the detail', () => {
    const v = new Verdict()
    v.hard('initialize', true)
    const before = mark(v)
    v.sessions += 2
    v.calls += 9
    v.hard('zen_status', true)
    v.soft(SOFT_CHECKS.dropForceAdopt, false, 'still connected after the drop')
    v.soft(SOFT_CHECKS.dropForceAdopt, false, 'still connected after the drop')
    const { detail, error } = judgeStep(v, before)
    expect(error).toBeNull()
    expect(detail).toEqual({
      sessions: 2,
      calls: 9,
      hardFailures: 0,
      softFailures: 2,
      failed: {
        hard: [],
        soft: [
          {
            name: SOFT_CHECKS.dropForceAdopt,
            failures: 2,
            sample: 'still connected after the drop'
          }
        ]
      }
    })
  })

  it('fails a step on a hard check that failed during it, naming the check and what it quoted', () => {
    const v = new Verdict({ secrets: ['s3cret'] })
    v.hard('resurrection-with-token', false, 'HTTP 404 for Bearer s3cret')
    const before = mark(v)
    v.hard('zen_status after end', false, 'JSON-RPC error -32001 Unknown session')
    v.hard('zen_status after end', true)
    v.soft(SOFT_CHECKS.dropForceAdopt, false, 'still connected')
    const { detail, error } = judgeStep(v, before)
    expect(error).toBe(
      '1 hard check(s) failed: zen_status after end ×1 (JSON-RPC error -32001 Unknown session)'
    )
    expect(detail.hardFailures).toBe(1)
    expect(detail.softFailures).toBe(1)
    // The failure before the mark belongs to an earlier step.
    expect(detail.failed.hard.map((f) => f.name)).toEqual(['zen_status after end'])
    expect(JSON.stringify(detail)).not.toContain('s3cret')
  })
})
