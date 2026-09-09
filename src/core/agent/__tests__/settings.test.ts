import { describe, expect, it } from 'vitest'
import { sanitizeAgentSettings } from '../settings'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/defaults'
import { AGENT_TOOLS, agentInstructions } from '../tools'
import { AGENT_COLORS } from '../service'

describe('sanitizeAgentSettings', () => {
  it('fills defaults from nothing', () => {
    expect(sanitizeAgentSettings(undefined)).toEqual(DEFAULT_AGENT_SETTINGS)
    expect(sanitizeAgentSettings({})).toEqual(DEFAULT_AGENT_SETTINGS)
  })

  it('clamps an out-of-range port back to the default', () => {
    expect(sanitizeAgentSettings({ port: 80 }).port).toBe(DEFAULT_AGENT_SETTINGS.port)
    expect(sanitizeAgentSettings({ port: 999999 }).port).toBe(DEFAULT_AGENT_SETTINGS.port)
    expect(sanitizeAgentSettings({ port: 8123 }).port).toBe(8123)
  })

  it('keeps a valid mode and rejects a bad one', () => {
    expect(sanitizeAgentSettings({ defaultMode: 'background' }).defaultMode).toBe('background')
    expect(sanitizeAgentSettings({ defaultMode: 'sideways' as never }).defaultMode).toBe(
      'foreground'
    )
  })

  it('dedupes and trims approved names', () => {
    const s = sanitizeAgentSettings({ approvedNames: ['A', 'A', ' ', 'B'] as string[] })
    expect(s.approvedNames).toEqual(['A', 'B'])
  })

  it('coerces non-boolean flags', () => {
    const s = sanitizeAgentSettings({ enabled: 'yes' as never, lan: 1 as never })
    expect(s.enabled).toBe(DEFAULT_AGENT_SETTINGS.enabled)
    expect(s.lan).toBe(DEFAULT_AGENT_SETTINGS.lan)
  })
})

describe('tool registry', () => {
  it('exposes unique, well-formed tool definitions', () => {
    const names = new Set<string>()
    for (const tool of AGENT_TOOLS) {
      expect(tool.definition.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(tool.definition.description.length).toBeGreaterThan(10)
      expect(tool.definition.inputSchema.type).toBe('object')
      expect(names.has(tool.definition.name)).toBe(false)
      names.add(tool.definition.name)
    }
  })

  it('ships the Playwright-compatible core plus the zen_* tools', () => {
    const names = AGENT_TOOLS.map((t) => t.definition.name)
    for (const n of [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_tabs',
      'browser_take_screenshot'
    ])
      expect(names).toContain(n)
    for (const n of ['zen_status', 'zen_mode', 'zen_spaces']) expect(names).toContain(n)
  })

  it('marks only browser_evaluate as scripting', () => {
    const scripting = AGENT_TOOLS.filter((t) => t.scripting).map((t) => t.definition.name)
    expect(scripting).toEqual(['browser_evaluate'])
  })

  it('describes the mode in the instructions', () => {
    expect(agentInstructions('background', true)).toContain('BACKGROUND')
    expect(agentInstructions('foreground', false)).toContain('disabled')
    expect(agentInstructions('foreground', true)).toContain('browser_evaluate')
  })
})

describe('agent colours', () => {
  it('are eight distinct, legible hex colours', () => {
    expect(AGENT_COLORS.length).toBe(8)
    expect(new Set(AGENT_COLORS).size).toBe(8)
    for (const c of AGENT_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })
})
