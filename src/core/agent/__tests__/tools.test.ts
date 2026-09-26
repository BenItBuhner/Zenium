import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentInputEvent, TabView } from '../../platform'
import type { Tab } from '../../../shared/types'
import { createTabRecord } from '../../model'
import { TabFrames } from '../frames'
import type { ToolResult } from '../protocol'
import { withUnknownArgsNote } from '../service'
import { signInPage, type FakePage } from './fakePage'
import {
  AGENT_TOOLS,
  ARG_ALIASES,
  ON_SCREEN_WAIT_MS,
  acceptedArgs,
  agentInstructions,
  looksLikeStatements,
  normalizeKey,
  setOnScreenWaitMsForTests,
  wrapScript,
  type ToolContext
} from '../tools'

// Sessions, ownership, the queue, notices, the lease and the tab / group tools run against the
// real `AgentService` in `multiAgent.test.ts`; this file covers the definitions, the argument
// handling and the page tools over fake frames.

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

  it('add the session and group tools of the multi-agent contract', () => {
    const names = AGENT_TOOLS.map((t) => t.definition.name)
    expect(names).toEqual(expect.arrayContaining(['zen_status', 'zen_session', 'zen_groups']))
    const session = AGENT_TOOLS.find((t) => t.definition.name === 'zen_session')!.definition
    expect((session.inputSchema.properties.action as { enum: string[] }).enum).toEqual([
      'status',
      'end',
      'rename'
    ])
    expect(session.inputSchema.properties).toHaveProperty('closeTabs')
    const groups = AGENT_TOOLS.find((t) => t.definition.name === 'zen_groups')!.definition
    expect((groups.inputSchema.properties.action as { enum: string[] }).enum).toEqual([
      'list',
      'create',
      'rename',
      'close',
      'adopt'
    ])
    expect(groups.inputSchema.properties).toHaveProperty('groupId')
  })

  it('every page tool takes an explicit tabId and allowForeign, and says what changed', () => {
    const pageTools = AGENT_TOOLS.filter(
      (t) =>
        t.definition.name.startsWith('browser_') &&
        !['browser_tabs', 'browser_navigate'].includes(t.definition.name)
    )
    expect(pageTools.length).toBeGreaterThan(10)
    for (const { definition } of pageTools) {
      expect(definition.inputSchema.properties, definition.name).toHaveProperty('tabId')
      expect(definition.inputSchema.properties, definition.name).toHaveProperty('allowForeign')
      expect(definition.inputSchema.required ?? [], definition.name).not.toContain('tabId')
      expect(definition.description, definition.name).toContain('Changed:')
    }
    for (const name of ['browser_tabs', 'browser_navigate', 'zen_status', 'zen_mode', 'zen_spaces'])
      expect(
        AGENT_TOOLS.find((t) => t.definition.name === name)!.definition.description,
        name
      ).toContain('Changed:')
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

  it('accept folder vocabulary for groupId and plain words for allowForeign', () => {
    expect(ARG_ALIASES.groupId).toEqual(
      expect.arrayContaining(['group', 'group_id', 'folder', 'folderId'])
    )
    expect(ARG_ALIASES.allowForeign).toEqual(
      expect.arrayContaining(['foreign', 'allow_foreign', 'outside'])
    )
    // "folder" is a group now, not a name: zen_groups create {folder: "x"} must not rename.
    expect(ARG_ALIASES.name ?? []).not.toContain('folder')
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
  /** What the chrome shows: flip these to bring the page on screen, cover it or paint it mid-call. */
  screen: { visible: boolean; covered: boolean; placed: boolean; painted: boolean }
  /** How often a tool asked whether the page is on screen. */
  polls: () => number
  /** How often a tool asked whether the page has painted. */
  paintPolls: () => number
}

interface LiveOptions {
  /** The view is shown (Electron's `isVisible`); false for a hidden or covered view. */
  visible?: boolean
  /** The chrome's layout report says an overlay (URL bar, menu) covers the content area. */
  covered?: boolean
  /** The layout report has placed the tab's view. */
  placed?: boolean
  /** The page's renderer has presented its first frame (`hasPainted`). */
  painted?: boolean
  mode?: 'foreground' | 'background'
  /** A host without real input (no `sendInput`). */
  noInput?: boolean
  /** A host that cannot tell whether the page has painted (no `hasPainted`). */
  noPaintState?: boolean
}

function liveContext(page: FakePage, opts: LiveOptions = {}): Live {
  const t = tab('tab_live', 'https://shop.example/checkout', 'space_a')
  const input: AgentInputEvent[] = []
  const cursor: Live['cursor'] = []
  const screen = {
    visible: opts.visible ?? true,
    covered: opts.covered ?? false,
    placed: opts.placed ?? true,
    painted: opts.painted ?? true
  }
  let polls = 0
  let paintPolls = 0
  const view = {
    executeJavaScript: (code: string, frameId?: number) => page.eval(frameId ?? 0, code),
    frames: () => page.frames() ?? undefined,
    sendInput: async (e: AgentInputEvent) => {
      input.push(e)
    },
    hasPainted: async () => {
      paintPolls++
      return screen.painted
    },
    isVisible: () => {
      polls++
      return screen.visible
    },
    isDestroyed: () => false
  } as unknown as TabView
  if (page.frames() === null) delete (view as { frames?: unknown }).frames
  if (opts.noInput) delete (view as { sendInput?: unknown }).sendInput
  if (opts.noPaintState) delete (view as { hasPainted?: unknown }).hasPainted
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
    groupIds: new Set(['folder_home']),
    homeGroupId: 'folder_home',
    notices: []
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
      ownedTabs: () => [t],
      resolveTab: () => t,
      describeOwner: () => 'yours',
      degraded: () => false,
      degradedBecause: () => null,
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
      visibleTabs: () => [t],
      agentWindow: () => ({ activeSpaceId: 'space_a' })
    },
    session
  }
  return {
    ctx: ctx as unknown as ToolContext,
    page,
    input,
    cursor,
    screen,
    polls: () => polls,
    paintPolls: () => paintPolls
  }
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
    expect(live.paintPolls()).toBe(1)
    expect(live.input).toHaveLength(1)
  })

  /*
   * The first paint: Chromium holds a new page's first frame back and drops presses and keys
   * meanwhile (acknowledged, so the host's dispatch "succeeds"); a placed page that has not
   * painted is waited for like one that is not placed, and named as the cause when it never does.
   */
  it("waits for the page's first paint, then sends real input", async () => {
    const live = liveContext(signInPage(), { painted: false })
    await run('browser_snapshot', live.ctx, {})
    // The renderer's first frame comes while the tool waits (a display compositor starting late).
    setTimeout(() => {
      live.screen.painted = true
    }, 40)
    const out = textOf(await run('browser_click', live.ctx, { target: 'e4' }))
    expect(live.input).toEqual([
      { type: 'click', x: 220, y: 230, button: 'left', clickCount: 1, modifiers: [] }
    ])
    expect(out).not.toContain('input: synthetic')
    expect(live.paintPolls()).toBeGreaterThan(1)
    expect(live.page.frame(7).log.map((l) => l.method)).not.toContain('clickJs')
  })

  it('a page that never paints gets a synthetic click and says why', async () => {
    const live = liveContext(signInPage(), { painted: false })
    await run('browser_snapshot', live.ctx, {})
    const out = textOf(await run('browser_click', live.ctx, { target: 'e4' }))
    expect(live.paintPolls()).toBeGreaterThan(1)
    expect(live.input).toEqual([])
    expect(live.page.frame(7).log.map((l) => l.method)).toContain('clickJs')
    const [headline, warning] = out.split('\n')
    expect(headline).toBe(
      'Clicked button "Sign in with Google" [ref=e4] in frame "Sign in with Google".'
    )
    expect(warning).toMatch(
      /^input: synthetic – the page had not painted its first frame within \d+ s/
    )
    expect(warning).toContain('drops real clicks and keys until it has')
    expect(warning).toContain('isTrusted: false')
  })

  it('the paint is asked about only once the view is placed, and off screen wins as the cause', async () => {
    const live = liveContext(signInPage(), { visible: false, painted: false })
    const out = textOf(await run('browser_click', live.ctx, { x: 200, y: 230 }))
    expect(live.paintPolls()).toBe(0)
    expect(out).toContain('input: synthetic – the tab did not come on screen')
  })

  it('a host that cannot tell about the paint sends real input once the view is on screen', async () => {
    const live = liveContext(signInPage(), { noPaintState: true })
    const out = textOf(await run('browser_click', live.ctx, { x: 200, y: 230 }))
    expect(live.input[0]).toMatchObject({ type: 'click', x: 200, y: 230 })
    expect(out).not.toContain('input: synthetic')
  })
})

describe('page results name the tab they acted on', () => {
  it('carry the tab id, its owner and the mode the action ran in', async () => {
    const { ctx } = liveContext(signInPage())
    const out = textOf(await run('browser_click', ctx, { x: 200, y: 230 }))
    expect(out).toContain('- Tab: tab_live (yours; foreground mode)')
  })

  it('say when the call was degraded to the background by the lease', async () => {
    const live = liveContext(signInPage())
    const agents = live.ctx.agents as unknown as {
      degraded: () => boolean
      degradedBecause: () => 'lease' | 'screen' | null
    }
    agents.degraded = () => true
    agents.degradedBecause = () => 'lease'
    const out = textOf(await run('browser_click', live.ctx, { x: 200, y: 230 }))
    expect(out).toContain(
      '- Tab: tab_live (yours; foreground mode, acted in background – another agent holds the screen)'
    )
    expect(out).toContain('input: synthetic – another agent holds the screen')
    expect(live.input).toEqual([])
  })

  it('say when the call was degraded because the screen was not taken', async () => {
    const live = liveContext(signInPage())
    const agents = live.ctx.agents as unknown as {
      degraded: () => boolean
      degradedBecause: () => 'lease' | 'screen' | null
    }
    agents.degraded = () => true
    agents.degradedBecause = () => 'screen'
    const out = textOf(await run('browser_click', live.ctx, { x: 200, y: 230 }))
    expect(out).toContain(
      '- Tab: tab_live (yours; foreground mode, acted in background – the screen was not taken)'
    )
    expect(out).toContain(
      'input: synthetic – the tab is not what the user is looking at and you have not taken the screen (zen_mode {"mode":"foreground","takeScreen":true})'
    )
    expect(live.input).toEqual([])
  })
})
