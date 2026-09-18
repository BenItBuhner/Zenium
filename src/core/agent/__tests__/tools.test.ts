import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentInputEvent, TabView } from '../../platform'
import type { Tab } from '../../../shared/types'
import { createTabRecord } from '../../model'
import { TabFrames } from '../frames'
import { RpcError } from '../jsonrpc'
import type { ToolResult } from '../protocol'
import { withUnknownArgsNote } from '../service'
import { signInPage, type FakePage } from './fakePage'
import {
  AGENT_TOOLS,
  ARG_ALIASES,
  ON_SCREEN_WAIT_MS,
  acceptedArgs,
  agentInstructions,
  listTabs,
  looksLikeStatements,
  normalizeKey,
  orderedTabs,
  resolveTabRef,
  setOnScreenWaitMsForTests,
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

  it('guesses the shape where the core itself may not compile code (CSP without unsafe-eval)', async () => {
    const csp = (): void => {
      throw new EvalError(
        "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source"
      )
    }
    const run = async (src: string): Promise<unknown> => {
      const w = wrapScript(src, csp)
      if ('error' in w) throw new Error(w.error)
      return await new Function(`return ${w.code}`)()
    }
    expect(await run('1 + 1')).toEqual({ ok: true, value: '2' })
    expect(await run('let n = 2; return n * 3')).toEqual({ ok: true, value: '6' })
    expect(await run("const x = 'ab'; return x.length")).toEqual({ ok: true, value: '2' })
    expect(await run('() => {\n  const a = [1, 2];\n  return a.length\n}')).toEqual({
      ok: true,
      value: '2'
    })
    expect(await run('function f() { return 5 }')).toEqual({ ok: true, value: '5' })
    expect(await run('({ a: 1 })')).toEqual({ ok: true, value: '{"a":1}' })
    expect(looksLikeStatements("history.forward(); 'forwarded'")).toBe(true)
    expect(looksLikeStatements('document.title;')).toBe(false)
    expect(looksLikeStatements('if (a) b()')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A live page: the fake frames of `fakePage.ts` behind a tab view, driven by the page tools.
// ---------------------------------------------------------------------------

interface Live {
  ctx: ToolContext
  page: FakePage
  input: AgentInputEvent[]
  /** The tab a click "opened" through the cursor calls, to check the overlay stays in the top frame. */
  cursor: Array<{ x: number; y: number; action: string }>
  /** What the chrome shows: flip these to bring the page on screen or cover it mid-call. */
  screen: { visible: boolean; covered: boolean; placed: boolean }
  /** How often a tool asked whether the page is on screen. */
  polls: () => number
}

interface LiveOptions {
  /** The view is shown (Electron's `isVisible`); false for a hidden or covered view. */
  visible?: boolean
  /** The chrome's layout report says an overlay (URL bar, menu) covers the content area. */
  covered?: boolean
  /** The layout report has placed the tab's view. */
  placed?: boolean
  mode?: 'foreground' | 'background'
  /** A host without real input (no `sendInput`). */
  noInput?: boolean
}

function liveContext(page: FakePage, opts: LiveOptions = {}): Live {
  const t = tab('tab_live', 'https://shop.example/checkout', 'space_a')
  const input: AgentInputEvent[] = []
  const cursor: Live['cursor'] = []
  const screen = {
    visible: opts.visible ?? true,
    covered: opts.covered ?? false,
    placed: opts.placed ?? true
  }
  let polls = 0
  const view = {
    executeJavaScript: (code: string, frameId?: number) => page.eval(frameId ?? 0, code),
    frames: () => page.frames() ?? undefined,
    sendInput: async (e: AgentInputEvent) => {
      input.push(e)
    },
    isVisible: () => {
      polls++
      return screen.visible
    },
    isDestroyed: () => false
  } as unknown as TabView
  if (page.frames() === null) delete (view as { frames?: unknown }).frames
  if (opts.noInput) delete (view as { sendInput?: unknown }).sendInput
  const win = {
    get contentHidden() {
      return screen.covered
    },
    viewRect: () => (screen.placed ? { x: 0, y: 80, width: 1000, height: 800 } : null)
  }
  const session = {
    id: page.agent,
    name: 'Tester',
    color: '#000',
    mode: opts.mode ?? ('foreground' as const),
    currentTabId: t.id,
    tabIds: new Set([t.id])
  }
  const frames = new Map<string, TabFrames>()
  const ctx = {
    browser: {
      state: { model: { tabs: { [t.id]: t }, essentialTabIds: [], spaces: [], folders: {} } },
      tabs: {
        tab: (id: string) => (id === t.id ? t : undefined),
        view: () => view,
        windowFor: () => win
      }
    },
    agents: {
      settings: { showCursor: true },
      resolveTab: () => t,
      prepare: async () => view,
      evalPage: (v: TabView, code: string) => v.executeJavaScript(code),
      frameState: (_s: unknown, tabId: string) => {
        let state = frames.get(tabId)
        if (!state) frames.set(tabId, (state = new TabFrames()))
        return state
      },
      cursor: async (
        _s: unknown,
        _tab: string,
        _v: unknown,
        x: number,
        y: number,
        action: string
      ) => {
        cursor.push({ x, y, action })
      },
      waitForLoad: async () => true,
      driver: () => session,
      visibleTabs: () => [t],
      agentWindow: () => ({ activeSpaceId: 'space_a' })
    },
    session
  }
  return { ctx: ctx as unknown as ToolContext, page, input, cursor, screen, polls: () => polls }
}

function textOf(result: ToolResult): string {
  return (result.content[0] as { text: string }).text
}

function run(name: string, ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  return AGENT_TOOLS.find((t) => t.definition.name === name)!.run(ctx, args)
}

describe('page tools and cross-origin frames', () => {
  it('browser_snapshot lists the frame content under its iframe line', async () => {
    const { ctx } = liveContext(signInPage())
    const out = textOf(await run('browser_snapshot', ctx, { boxes: true }))
    expect(out).toContain('- iframe "Sign in with Google" [box=100,150,400,300] [ref=e2]')
    expect(out).toContain('  - button "Sign in with Google" [box=120,210,200,40] [ref=e4]')
    expect(out).toContain('  - textbox "Email" [box=120,270,300,30] [ref=e5]')
    expect(out).toContain('5 elements')
  })

  it("browser_click on a frame ref sends real input at the button's top-viewport point", async () => {
    const live = liveContext(signInPage())
    await run('browser_snapshot', live.ctx, {})
    const out = textOf(await run('browser_click', live.ctx, { target: 'e4' }))
    expect(out).toMatch(
      /^Clicked button "Sign in with Google" \[ref=e4\] in frame "Sign in with Google"\./
    )
    expect(live.input).toEqual([
      { type: 'click', x: 220, y: 230, button: 'left', clickCount: 1, modifiers: [] }
    ])
    // The cursor overlay is drawn in the top document at the same point.
    expect(live.cursor).toEqual([
      { x: 220, y: 230, action: 'move' },
      { x: 220, y: 230, action: 'click' }
    ])
    // Nothing synthetic was dispatched inside the frame.
    expect(live.page.frame(7).log.map((l) => l.method)).not.toContain('clickJs')
  })

  it('browser_click at coordinates inside the frame names what is there and clicks it', async () => {
    const live = liveContext(signInPage())
    const out = textOf(await run('browser_click', live.ctx, { x: 200, y: 230 }))
    expect(out).toMatch(
      /^Clicked button "Sign in with Google" \[ref=e\d+\] in frame "Sign in with Google" at \(200, 230\)\./
    )
    expect(live.input[0]).toMatchObject({ type: 'click', x: 200, y: 230 })
  })

  it("browser_type fills through the frame's own runtime after a real click focused the field", async () => {
    const live = liveContext(signInPage())
    await run('browser_snapshot', live.ctx, {})
    const out = textOf(
      await run('browser_type', live.ctx, { target: 'e5', text: 'me@example.com' })
    )
    expect(out).toMatch(/^Typed "me@example.com" into textbox "Email" \[ref=e5\] in frame/)
    expect(live.input[0]).toMatchObject({ type: 'click', x: 270, y: 285 })
    const fill = live.page.frame(7).log.find((l) => l.method === 'fill')
    expect(fill?.args).toEqual([live.page.agent, 'e5', 'me@example.com', true])
    expect(live.page.frame(0).log.map((l) => l.method)).not.toContain('fill')
  })

  it("browser_select_option runs in the option's frame", async () => {
    const page = signInPage()
    page.frame(7).spec.elements.push({
      id: 'lang',
      tag: 'select',
      role: 'combobox',
      name: 'Language',
      box: { x: 20, y: 200, width: 100, height: 30 }
    })
    const live = liveContext(page)
    await run('browser_snapshot', live.ctx, {})
    const out = textOf(
      await run('browser_select_option', live.ctx, { target: '#lang', values: 'de' })
    )
    expect(out).toMatch(/^Selected "de" in combobox "Language"/)
    const sel = live.page.frame(7).log.find((l) => l.method === 'select')
    expect(sel?.args).toEqual([live.page.agent, '#lang', ['de']])
  })

  it('background mode clicks synthetically inside the frame and says so, without waiting', async () => {
    const live = liveContext(signInPage(), { visible: false, mode: 'background' })
    await run('browser_snapshot', live.ctx, {})
    const out = textOf(await run('browser_click', live.ctx, { target: 'e4' }))
    expect(live.input).toEqual([])
    const click = live.page.frame(7).log.find((l) => l.method === 'clickJs')
    expect(click?.args).toEqual([live.page.agent, 'e4', 1])
    expect(out).toMatch(/^Clicked button "Sign in with Google" \[ref=e4\] in frame .*\.\n/)
    expect(out).toContain('input: synthetic – you are in background mode')
    expect(out).toMatch(/untrusted \(isTrusted: false\) and armed no user gesture/)
    // Background mode is synthetic by design: nothing polls the screen.
    expect(live.polls()).toBe(0)
  })

  it('explains a ref whose frame has gone instead of failing obscurely', async () => {
    const live = liveContext(signInPage())
    await run('browser_snapshot', live.ctx, {})
    live.page.detach(7)
    await expect(run('browser_click', live.ctx, { target: 'e4' })).rejects.toThrow(
      /frame that element was in is gone.*take a new browser_snapshot/
    )
  })

  it('works as before on hosts without frame support: the iframe stays opaque', async () => {
    const live = liveContext(signInPage(false))
    const out = textOf(await run('browser_snapshot', live.ctx, {}))
    expect(out).toContain('- iframe "Sign in with Google" [ref=e2]')
    expect(out).not.toContain('Email')
    const click = textOf(await run('browser_click', live.ctx, { x: 200, y: 230 }))
    expect(click).toMatch(/^Clicked iframe "Sign in with Google" \[ref=e2\] at \(200, 230\)\./)
    expect(live.input[0]).toMatchObject({ type: 'click', x: 200, y: 230 })
  })
})

/**
 * The input ruling: in the foreground a click, hover or typed text waits (bounded) for the page
 * to be on screen – view shown, placed by the layout report, not under chrome – and goes out as
 * real input; when the page never comes on screen the tool takes the synthetic path and says so
 * in its result instead of pretending the click was a user gesture.
 */
describe('real input waits for the page to be on screen, and never degrades silently', () => {
  beforeEach(() => setOnScreenWaitMsForTests(120))
  afterEach(() => setOnScreenWaitMsForTests(ON_SCREEN_WAIT_MS))

  it('waits for the first layout report to place the view, then sends real input', async () => {
    const live = liveContext(signInPage(), { visible: false, placed: false })
    await run('browser_snapshot', live.ctx, {})
    // The chrome renderer's first layout arrives while the tool waits (a cold start).
    setTimeout(() => {
      live.screen.visible = true
      live.screen.placed = true
    }, 40)
    const out = textOf(await run('browser_click', live.ctx, { target: 'e4' }))
    expect(live.input).toEqual([
      { type: 'click', x: 220, y: 230, button: 'left', clickCount: 1, modifiers: [] }
    ])
    expect(out).not.toContain('input: synthetic')
    expect(live.polls()).toBeGreaterThan(1)
    expect(live.page.frame(7).log.map((l) => l.method)).not.toContain('clickJs')
  })

  it('waits for chrome covering the page (the URL bar) to close', async () => {
    const live = liveContext(signInPage(), { visible: false, covered: true })
    setTimeout(() => {
      live.screen.covered = false
      live.screen.visible = true
    }, 40)
    const out = textOf(await run('browser_click', live.ctx, { x: 200, y: 230 }))
    expect(live.input[0]).toMatchObject({ type: 'click', x: 200, y: 230 })
    expect(out).not.toContain('input: synthetic')
  })

  it('a page that stays covered gets a synthetic click and an explicit warning', async () => {
    const live = liveContext(signInPage(), { visible: false, covered: true })
    await run('browser_snapshot', live.ctx, {})
    const out = textOf(await run('browser_click', live.ctx, { target: 'e4' }))
    // It kept asking until the bound passed, then gave up on real input.
    expect(live.polls()).toBeGreaterThan(1)
    expect(live.input).toEqual([])
    expect(live.page.frame(7).log.find((l) => l.method === 'clickJs')?.args).toEqual([
      live.page.agent,
      'e4',
      1
    ])
    const [headline, warning] = out.split('\n')
    expect(headline).toBe(
      'Clicked button "Sign in with Google" [ref=e4] in frame "Sign in with Google".'
    )
    expect(warning).toMatch(/^input: synthetic – the tab did not come on screen within \d+ s/)
    expect(warning).toContain('chrome such as the URL bar covers the page')
    expect(warning).toContain('isTrusted: false')
    expect(warning).toMatch(/pop-up.*did not fire/)
  })

  it('a view the layout has not placed counts as off screen', async () => {
    const live = liveContext(signInPage(), { visible: true, placed: false })
    const out = textOf(await run('browser_hover', live.ctx, { x: 200, y: 230 }))
    expect(live.input).toEqual([])
    expect(out).toContain('input: synthetic – the tab did not come on screen')
    expect(live.page.frame(7).log.map((l) => l.method)).toContain('hoverJs')
  })

  it('browser_hover and browser_type carry the warning too', async () => {
    const live = liveContext(signInPage(), { visible: false })
    await run('browser_snapshot', live.ctx, {})
    const hover = textOf(await run('browser_hover', live.ctx, { target: 'e4' }))
    expect(hover).toMatch(
      /^Hovering button "Sign in with Google" \[ref=e4\] in frame .*\.\ninput: synthetic/
    )
    const typed = textOf(
      await run('browser_type', live.ctx, { target: 'e5', text: 'me@example.com', submit: true })
    )
    expect(typed).toMatch(
      /^Typed "me@example.com" into textbox "Email" .* and pressed Enter\.\ninput: synthetic/
    )
    expect(live.input).toEqual([])
    // The value still lands (fill runs in the frame) and Enter goes through the frame's runtime.
    const methods = live.page.frame(7).log.map((l) => l.method)
    expect(methods).toContain('fill')
    expect(methods).toContain('submit')
    expect(methods).toContain('clickJs')
  })

  it('browser_press_key routes the same way', async () => {
    const live = liveContext(signInPage(), { visible: false })
    const out = textOf(await run('browser_press_key', live.ctx, { key: 'Escape' }))
    expect(out).toMatch(/^Pressed Escape\.\ninput: synthetic/)
    expect(live.input).toEqual([])
    expect(live.page.frame(0).log.find((l) => l.method === 'keyJs')?.args).toEqual(['Escape', []])
  })

  it('an element covered by another one is clicked directly, with the warning', async () => {
    const page = signInPage()
    // The top document's hit test finds something else over the "Pay now" button.
    const orig = page.frame(0).locate.bind(page.frame(0))
    page.frame(0).locate = (agent, target, scroll, minSeq) => {
      const loc = orig(agent, target, scroll, minSeq)
      return 'error' in loc ? loc : { ...loc, covered: loc.name === 'Pay now' }
    }
    const live = liveContext(page)
    const out = textOf(await run('browser_click', live.ctx, { target: 'text=Pay now' }))
    expect(live.input).toEqual([])
    expect(out).toContain('input: synthetic – another element covers this point')
    // On screen all along: no waiting was needed for this one.
    expect(live.polls()).toBe(1)
  })

  it('a host without real input says so once, without waiting', async () => {
    const live = liveContext(signInPage(), { noInput: true })
    const out = textOf(await run('browser_click', live.ctx, { x: 200, y: 230 }))
    expect(out).toContain('input: synthetic – this browser cannot send real input')
    expect(live.polls()).toBe(0)
  })

  it('on-screen pages are not slowed down: one look, then real input', async () => {
    const live = liveContext(signInPage())
    await run('browser_click', live.ctx, { x: 200, y: 230 })
    expect(live.polls()).toBe(1)
    expect(live.input).toHaveLength(1)
  })
})

describe('browser_tabs close', () => {
  const tool = AGENT_TOOLS.find((t) => t.definition.name === 'browser_tabs')!

  it("refuses to close the user's Essential or pinned tabs", async () => {
    await expect(tool.run(fakeContext(), { action: 'close', tabId: 'tab_ess' })).rejects.toThrow(
      /an Essential of the user's/
    )
  })

  it('refuses to close a tab another agent drives', async () => {
    await expect(tool.run(fakeContext(), { action: 'close', tabId: 'tab_b1' })).rejects.toThrow(
      /driven by agent "Other"/
    )
  })
})
