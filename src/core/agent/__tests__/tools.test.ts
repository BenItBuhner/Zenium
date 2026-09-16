import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/types'
import { createTabRecord } from '../../model'
import { RpcError } from '../jsonrpc'
import { withUnknownArgsNote } from '../service'
import {
  AGENT_TOOLS,
  ARG_ALIASES,
  acceptedArgs,
  agentInstructions,
  listTabs,
  normalizeKey,
  orderedTabs,
  resolveTabRef,
  wrapScript,
  type ToolContext
} from '../tools'

// ---------------------------------------------------------------------------
// A minimal browser: two spaces, one essential, one folder, no live pages.
// ---------------------------------------------------------------------------

function tab(id: string, url: string, spaceId: string | null, extra: Partial<Tab> = {}): Tab {
  const t = createTabRecord({
    id,
    url,
    title: `Title of ${id}`,
    spaceId,
    containerId: 'default',
    discarded: false
  })
  return Object.assign(t, extra)
}

function fakeContext(): ToolContext {
  const tabs: Record<string, Tab> = {}
  for (const t of [
    tab('tab_ess', 'https://mail.example', null, { essential: true }),
    tab('tab_a1', 'https://a1.example', 'space_a'),
    tab('tab_a2', 'https://a2.example', 'space_a', { folderId: 'folder_r' }),
    tab('tab_b1', 'https://b1.example', 'space_b'),
    tab('tab_private', 'https://private.example', 'space_a')
  ])
    tabs[t.id] = t
  const model = {
    tabs,
    essentialTabIds: ['tab_ess'],
    spaces: [
      { id: 'space_a', name: 'Work', icon: '💼', tabIds: ['tab_a1', 'tab_a2'] },
      { id: 'space_b', name: 'Play', icon: '🎮', tabIds: ['tab_b1'] }
    ],
    folders: { folder_r: { id: 'folder_r', spaceId: 'space_a', name: 'Research', icon: '📁' } }
  }
  const session = {
    id: 'agent1',
    name: 'Tester',
    color: '#000',
    mode: 'foreground' as const,
    currentTabId: 'tab_a1',
    tabIds: new Set(['tab_a1'])
  }
  const ctx = {
    browser: {
      state: { model },
      tabs: { tab: (id: string) => tabs[id] }
    },
    agents: {
      visibleTabs: () => Object.values(tabs).filter((t) => t.id !== 'tab_private'),
      driver: (id: string) =>
        id === 'tab_a1' ? session : id === 'tab_b1' ? { id: 'x', name: 'Other' } : undefined,
      agentWindow: () => ({ activeSpaceId: 'space_a' })
    },
    session
  }
  return ctx as unknown as ToolContext
}

// ---------------------------------------------------------------------------

describe('tool definitions', () => {
  it('are well-formed: unique snake_case names, descriptions, required ⊆ properties', () => {
    const names = AGENT_TOOLS.map((t) => t.definition.name)
    expect(new Set(names).size).toBe(names.length)
    for (const { definition } of AGENT_TOOLS) {
      expect(definition.name).toMatch(/^(browser|zen)_[a-z_]+$/)
      expect(definition.description.length).toBeGreaterThan(40)
      const props = Object.keys(definition.inputSchema.properties)
      for (const r of definition.inputSchema.required ?? []) expect(props).toContain(r)
      // Strict schemas would make clients reject the aliases before the server sees them.
      expect(definition.inputSchema.additionalProperties).toBeUndefined()
    }
  })

  it('expose the navigation set agents expect from a browser', () => {
    const names = AGENT_TOOLS.map((t) => t.definition.name)
    for (const n of [
      'browser_navigate',
      'browser_navigate_back',
      'browser_navigate_forward',
      'browser_reload',
      'browser_take_screenshot',
      'browser_tabs',
      'browser_hover',
      'browser_click'
    ])
      expect(names).toContain(n)
  })

  it('let hover and click take coordinates instead of a target', () => {
    for (const name of ['browser_hover', 'browser_click']) {
      const def = AGENT_TOOLS.find((t) => t.definition.name === name)!.definition
      expect(def.inputSchema.properties).toHaveProperty('x')
      expect(def.inputSchema.properties).toHaveProperty('y')
      expect(def.inputSchema.required ?? []).not.toContain('target')
    }
  })

  it('offer full-page and element screenshots', () => {
    const def = AGENT_TOOLS.find((t) => t.definition.name === 'browser_take_screenshot')!.definition
    expect(def.inputSchema.properties).toHaveProperty('fullPage')
    expect(def.inputSchema.properties).toHaveProperty('target')
  })

  it('offer tab reordering and grouping', () => {
    const def = AGENT_TOOLS.find((t) => t.definition.name === 'browser_tabs')!.definition
    const action = def.inputSchema.properties.action as { enum: string[] }
    expect(action.enum).toEqual(
      expect.arrayContaining(['list', 'new', 'select', 'close', 'move', 'group', 'ungroup'])
    )
  })

  it('mention every navigation and tab verb in the instructions', () => {
    const text = agentInstructions('foreground', true)
    for (const n of ['browser_navigate_forward', 'browser_reload', 'move', 'group', 'fullPage'])
      expect(text).toContain(n)
    expect(agentInstructions('background', false)).toContain('disabled')
  })
})

describe('argument aliases', () => {
  it('accept Playwright MCP vocabulary for the core arguments', () => {
    expect(ARG_ALIASES.target).toEqual(expect.arrayContaining(['ref', 'selector', 'element']))
    expect(ARG_ALIASES.expression).toEqual(expect.arrayContaining(['function', 'script']))
    expect(ARG_ALIASES.tabId).toEqual(expect.arrayContaining(['index', 'tab']))
  })

  it('acceptedArgs covers declared properties and their aliases', () => {
    const def = AGENT_TOOLS.find((t) => t.definition.name === 'browser_click')!.definition
    const args = acceptedArgs(def)
    for (const k of ['target', 'ref', 'selector', 'x', 'y', 'tabId', 'index', 'doubleClick'])
      expect(args.has(k)).toBe(true)
    expect(args.has('selctor')).toBe(false)
  })

  it('appends a note about ignored unknown arguments instead of failing', () => {
    const def = AGENT_TOOLS.find((t) => t.definition.name === 'browser_click')!.definition
    const result = withUnknownArgsNote(
      def,
      { ref: 'e1', selctor: '#x' },
      { content: [{ type: 'text', text: 'Clicked.' }] }
    )
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Clicked.')
    expect(text).toContain('"selctor"')
    expect(text).toContain('browser_click accepts: target')
    const clean = withUnknownArgsNote(
      def,
      { ref: 'e1' },
      { content: [{ type: 'text', text: 'Clicked.' }] }
    )
    expect((clean.content[0] as { text: string }).text).toBe('Clicked.')
  })
})

describe('normalizeKey', () => {
  it('maps friendly names onto DOM key names and keeps single characters', () => {
    expect(normalizeKey('enter')).toBe('Enter')
    expect(normalizeKey('Return')).toBe('Enter')
    expect(normalizeKey('esc')).toBe('Escape')
    expect(normalizeKey('down')).toBe('ArrowDown')
    expect(normalizeKey('space')).toBe(' ')
    expect(normalizeKey('a')).toBe('a')
    expect(normalizeKey('F5')).toBe('F5')
  })
})

describe('tab references', () => {
  it('orders tabs like the sidebar: Essentials, then each space in order', () => {
    expect(orderedTabs(fakeContext()).map((t) => t.id)).toEqual([
      'tab_ess',
      'tab_a1',
      'tab_a2',
      'tab_b1'
    ])
  })

  it('resolve by id, by unique prefix and by 1-based position', () => {
    const ctx = fakeContext()
    expect(resolveTabRef(ctx, 'tab_a2')).toBe('tab_a2')
    expect(resolveTabRef(ctx, 'tab_b')).toBe('tab_b1')
    expect(resolveTabRef(ctx, 3)).toBe('tab_a2')
    expect(resolveTabRef(ctx, '1')).toBe('tab_ess')
  })

  it('explain what went wrong and list the open tabs', () => {
    const ctx = fakeContext()
    expect(() => resolveTabRef(ctx, 9)).toThrow(/no tab at position 9.*1\. tab_ess/)
    expect(() => resolveTabRef(ctx, 'tab_a')).toThrow(/matches 2 tabs/)
    expect(() => resolveTabRef(ctx, 'tab_nope')).toThrow(
      /Unknown tab "tab_nope".*may have been closed/
    )
    expect(() => resolveTabRef(ctx, 'tab_private')).toThrow(/not available to agents/)
    try {
      resolveTabRef(ctx, 'tab_nope')
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError)
    }
  })

  it('lists tabs with positions, spaces, folders and drivers', () => {
    const text = listTabs(fakeContext())
    expect(text).toContain('Essentials:')
    expect(text).toMatch(/1\. tab_ess .*\[essential\]/)
    expect(text).toContain('Space "Work" (space_a) [shown to the user]:')
    expect(text).toMatch(/2\. tab_a1 .*\[yours, current\]/)
    expect(text).toMatch(/3\. tab_a2 .*folder: "Research"/)
    expect(text).toContain('Space "Play" (space_b):')
    expect(text).toMatch(/4\. tab_b1 .*driven by Other/)
    expect(text).not.toContain('tab_private')
  })
})

describe('browser_tabs', () => {
  const tool = AGENT_TOOLS.find((t) => t.definition.name === 'browser_tabs')!

  it('lists when no action is given', async () => {
    const result = await tool.run(fakeContext(), {})
    expect((result.content[0] as { text: string }).text).toContain('1. tab_ess')
  })

  it('names the valid actions for an unknown one', async () => {
    await expect(tool.run(fakeContext(), { action: 'explode' })).rejects.toThrow(
      /Unknown action "explode" – use one of "list", "new", "select", "close", "move", "group", "ungroup"/
    )
  })

  it('tells the agent which arguments select / move / group need', async () => {
    await expect(tool.run(fakeContext(), { action: 'switch' })).rejects.toThrow(
      /select needs tabId/
    )
    await expect(tool.run(fakeContext(), { action: 'reorder' })).rejects.toThrow(
      /move needs tabId and index/
    )
    await expect(tool.run(fakeContext(), { action: 'folder' })).rejects.toThrow(
      /group needs tabIds/
    )
  })
})

describe('zen_mode', () => {
  const tool = AGENT_TOOLS.find((t) => t.definition.name === 'zen_mode')!

  it('accepts short forms and reports the new mode', async () => {
    const ctx = fakeContext()
    ctx.session.currentTabId = null
    const result = await tool.run(ctx, { mode: 'bg' })
    expect(ctx.session.mode).toBe('background')
    expect((result.content[0] as { text: string }).text).toContain('background')
  })

  it('rejects other values with the accepted ones', async () => {
    await expect(tool.run(fakeContext(), { mode: 'sideways' })).rejects.toThrow(
      /"foreground" or "background"/
    )
  })
})

describe('wrapScript', () => {
  it('wraps expressions, functions and statement lists, and reports syntax errors', () => {
    for (const src of [
      'document.title',
      '() => 1 + 1',
      "history.forward(); 'forwarded'",
      'const a = 1; return a + 1'
    ]) {
      const w = wrapScript(src)
      expect('code' in w, src).toBe(true)
    }
    const bad = wrapScript('this is not javascript')
    expect('error' in bad && bad.error).toMatch(/Unexpected/)
  })

  it('produces code whose result carries ok/value or ok/error', async () => {
    const run = async (src: string): Promise<unknown> => {
      const w = wrapScript(src)
      if ('error' in w) throw new Error(w.error)

      return await new Function(`return ${w.code}`)()
    }
    expect(await run('1 + 1')).toEqual({ ok: true, value: '2' })
    expect(await run('() => ({ a: [1, 2] })')).toEqual({ ok: true, value: '{"a":[1,2]}' })
    expect(await run("const x = 'ab'; return x.length")).toEqual({ ok: true, value: '2' })
    expect(await run('undefined')).toEqual({ ok: true, value: 'undefined' })
    expect(await run("throw new Error('boom')")).toEqual({ ok: false, error: 'boom' })
    expect(await run('(() => { throw new TypeError("nope") })()')).toEqual({
      ok: false,
      error: 'nope'
    })
  })
})
