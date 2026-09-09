import type { AgentMode, Tab } from '../../shared/types'
import { buildSearchUrl } from '../../shared/search'
import { inputToUrl } from '../../shared/url'
import type { Browser } from '../browser'
import type { InputModifier, TabView } from '../platform'
import { RpcError } from './jsonrpc'
import { pageCall, type PageActionResult, type PageLocation, type PageSnapshot } from './page'
import type { JsonSchema, ToolDefinition, ToolResult } from './protocol'
import type { AgentService, AgentSession } from './service'
import { sleep, textError } from './util'

/**
 * The tools agents see. Page tools use the vocabulary agents already know from Playwright MCP
 * (`browser_navigate`, `browser_snapshot` with `[ref=eN]` handles, `browser_click`, …); the
 * `zen_*` tools expose what makes this browser different: spaces, agent modes and who is doing
 * what.
 */

export interface ToolContext {
  browser: Browser
  agents: AgentService
  session: AgentSession
}

export interface AgentTool {
  definition: ToolDefinition
  /** Runs arbitrary JavaScript – hidden when scripts are disabled in Settings. */
  scripting?: boolean
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>
}

const SNAPSHOT_MAX_CHARS = 30_000
const LOAD_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.length ? v : undefined
}

function need(args: Record<string, unknown>, key: string): string {
  const v = str(args, key)
  if (v === undefined) throw new RpcError(-32602, `Missing required argument "${key}"`)
  return v
}

function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key]
  return typeof v === 'boolean' ? v : fallback
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function strings(args: Record<string, unknown>, key: string): string[] {
  const v = args[key]
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return typeof v === 'string' ? [v] : []
}

function modifiers(args: Record<string, unknown>): InputModifier[] {
  const allowed: InputModifier[] = ['Shift', 'Control', 'Alt', 'Meta']
  return strings(args, 'modifiers')
    .map((m) => (m === 'ControlOrMeta' || m === 'Ctrl' ? 'Control' : m === 'Cmd' ? 'Meta' : m))
    .filter((m): m is InputModifier => (allowed as string[]).includes(m))
}

const TAB_ID = {
  type: 'string',
  description:
    'Tab to act on; defaults to your current tab. Tabs driven by other agents are refused.'
}
const TARGET = {
  type: 'string',
  description:
    'Element handle from the latest browser_snapshot (e.g. "e12"), a CSS selector, or "text=Sign in" for visible text.'
}

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] }
}

// ---------------------------------------------------------------------------
// Page access helpers
// ---------------------------------------------------------------------------

interface Target {
  tab: Tab
  view: TabView
}

async function actOn(ctx: ToolContext, args: Record<string, unknown>): Promise<Target> {
  const tab = ctx.agents.resolveTab(ctx.session, args.tabId)
  const view = await ctx.agents.prepare(ctx.session, tab.id)
  return { tab, view }
}

async function snapshot(
  ctx: ToolContext,
  view: TabView,
  opts: { filter?: string | null; interactiveOnly?: boolean; boxes?: boolean } = {}
): Promise<PageSnapshot> {
  return (await ctx.agents.evalPage(
    view,
    pageCall('snapshot', {
      agent: ctx.session.id,
      filter: opts.filter ?? null,
      interactiveOnly: Boolean(opts.interactiveOnly),
      boxes: Boolean(opts.boxes),
      maxChars: SNAPSHOT_MAX_CHARS
    })
  )) as PageSnapshot
}

function describeTab(ctx: ToolContext, tab: Tab): string {
  const s = ctx.session
  const driver = ctx.agents.driver(tab.id)
  const who = driver ? (driver.id === s.id ? 'yours' : `driven by ${driver.name}`) : 'not claimed'
  return `${tab.id} (${who}; you are in ${s.mode} mode)`
}

/** The standard answer after an action: what happened, then a fresh snapshot of the page. */
async function pageResult(
  ctx: ToolContext,
  tab: Tab,
  view: TabView,
  headline: string,
  opts: { filter?: string | null; interactiveOnly?: boolean; boxes?: boolean } = {}
): Promise<ToolResult> {
  let snap: PageSnapshot
  try {
    snap = await snapshot(ctx, view, opts)
  } catch (error) {
    return text(
      `${headline}\n\n(The page could not be read yet: ${(error as Error).message}. Take a browser_snapshot in a moment.)`
    )
  }
  const current = ctx.browser.tabs.tab(tab.id) ?? tab
  const lines = [
    headline,
    `- Page URL: ${snap.url}`,
    `- Page Title: ${snap.title}`,
    `- Tab: ${describeTab(ctx, current)} – viewport ${snap.viewport.width}×${snap.viewport.height}, scrolled ${snap.scroll.y}/${Math.max(0, snap.scroll.height - snap.viewport.height)}${snap.refs ? `, ${snap.refs} elements` : ''}`,
    '- Page Snapshot:',
    '```yaml',
    snap.tree || '(nothing visible yet)',
    '```'
  ]
  return text(lines.join('\n'))
}

async function locate(ctx: ToolContext, view: TabView, target: string): Promise<PageLocation> {
  const loc = (await ctx.agents.evalPage(
    view,
    pageCall('locate', ctx.session.id, target, true)
  )) as PageLocation | { error: string }
  if ('error' in loc) throw new RpcError(-32602, loc.error)
  return loc
}

function describeElement(loc: PageLocation): string {
  return `${loc.role}${loc.name ? ` "${loc.name.length > 60 ? loc.name.slice(0, 59) + '…' : loc.name}"` : ''}${loc.ref ? ` [${loc.ref}]` : ''}`
}

/** After an action, let a navigation (if one started) finish, else let the page react. */
async function settle(ctx: ToolContext, tabId: string): Promise<void> {
  await sleep(200)
  const tab = ctx.browser.tabs.tab(tabId)
  if (tab?.loading) await ctx.agents.waitForLoad(tabId, LOAD_TIMEOUT_MS)
  else await sleep(150)
}

/**
 * Trusted OS-level input when the tab is actually on screen (foreground), synthetic in-page
 * input otherwise. Trusted events carry `isTrusted` and drive complex widgets, but Chromium only
 * hit-tests a painted, visible view; a hidden background tab is driven through the page runtime,
 * whose native `.click()` still performs default actions.
 */
function wantTrustedInput(view: TabView, loc?: PageLocation): boolean {
  return Boolean(view.sendInput) && view.isVisible() && (!loc || !loc.covered)
}

async function clickAt(
  ctx: ToolContext,
  view: TabView,
  loc: PageLocation,
  target: string,
  opts: { button: 'left' | 'right' | 'middle'; count: number; modifiers: InputModifier[] }
): Promise<'trusted' | 'synthetic'> {
  if (wantTrustedInput(view, loc)) {
    await view.sendInput!({
      type: 'click',
      x: loc.x,
      y: loc.y,
      button: opts.button,
      clickCount: opts.count,
      modifiers: opts.modifiers
    })
    return 'trusted'
  }
  const r = (await ctx.agents.evalPage(
    view,
    pageCall('clickJs', ctx.session.id, target, opts.count)
  )) as PageActionResult
  if (!r.ok) throw new RpcError(-32602, r.error ?? 'Click failed')
  return 'synthetic'
}

async function pressKey(
  ctx: ToolContext,
  view: TabView,
  key: string,
  mods: InputModifier[]
): Promise<void> {
  if (wantTrustedInput(view)) {
    await view.sendInput!({ type: 'key', key, modifiers: mods })
    return
  }
  const r = (await ctx.agents.evalPage(view, pageCall('keyJs', key, mods))) as PageActionResult
  if (!r.ok) throw new RpcError(-32602, r.error ?? 'Key press failed')
}

function normalizeKey(key: string): string {
  const map: Record<string, string> = {
    return: 'Enter',
    enter: 'Enter',
    esc: 'Escape',
    escape: 'Escape',
    space: ' ',
    spacebar: ' ',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    del: 'Delete',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown'
  }
  if (key.length === 1) return key
  return map[key.toLowerCase()] ?? key
}

function resolveUrl(ctx: ToolContext, input: string): string {
  const direct = inputToUrl(input.trim())
  if (direct) return direct
  const engines = ctx.browser.state.searchEngines
  const engine =
    engines.find((e) => e.id === ctx.browser.state.settings.searchEngineId) ?? engines[0]
  return buildSearchUrl(engine, input.trim())
}

function tabLine(ctx: ToolContext, t: Tab): string {
  const m = ctx.browser.state.model
  const space = t.spaceId ? m.spaces.find((sp) => sp.id === t.spaceId) : null
  const driver = ctx.agents.driver(t.id)
  const flags: string[] = []
  if (t.essential) flags.push('essential')
  else if (t.pinned) flags.push('pinned')
  if (space) flags.push(`space: ${space.name}`)
  if (t.discarded) flags.push('unloaded')
  if (driver) flags.push(driver.id === ctx.session.id ? 'yours' : `driven by ${driver.name}`)
  if (ctx.session.currentTabId === t.id) flags.push('current')
  const title = (t.customTitle ?? t.title) || '(untitled)'
  return `- ${t.id} ${JSON.stringify(title.slice(0, 80))} ${t.url}${flags.length ? ` [${flags.join(', ')}]` : ''}`
}

function listTabs(ctx: ToolContext): string {
  const tabs = ctx.agents.visibleTabs(ctx.session)
  if (!tabs.length) return '(no tabs)'
  return tabs.map((t) => tabLine(ctx, t)).join('\n')
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const zenStatus: AgentTool = {
  definition: {
    name: 'zen_status',
    title: 'Browser status',
    description:
      'Who you are in this browser (id, colour, foreground/background mode, current tab), which other agents are connected and which tabs they drive, the spaces, and every open tab. Call this first.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx) {
    const s = ctx.session
    const win = ctx.agents.agentWindow()
    const m = ctx.browser.state.model
    const agents = ctx.agents.list()
    const lines = [
      `You are "${s.name}" (agent ${s.id}, colour ${s.color}) in ${s.mode} mode. Current tab: ${s.currentTabId ?? 'none'}. Tabs you drive: ${s.tabIds.size}.`,
      '',
      `Connected agents (${agents.length}):`,
      ...agents.map(
        (a) =>
          `- ${a.name}${a.id === s.id ? ' (you)' : ''} – ${a.mode}, ${a.tabIds.length} tab(s)${a.pending ? ', waiting for approval' : ''}`
      ),
      '',
      'Spaces:',
      ...m.spaces.map(
        (sp) =>
          `- ${sp.id} ${JSON.stringify(sp.name)} ${sp.icon} – ${sp.tabIds.length} tab(s)${sp.id === win.activeSpaceId ? ' [shown to the user]' : ''}`
      ),
      '',
      'Tabs:',
      listTabs(ctx)
    ]
    return text(lines.join('\n'))
  }
}

const zenMode: AgentTool = {
  definition: {
    name: 'zen_mode',
    title: 'Set your operating mode',
    description:
      'foreground: your tab is brought in front of the user before every action and your cursor shows what you do. background: you work in your own tabs without changing what the user sees (use this when the user is browsing or another agent works in the foreground).',
    inputSchema: schema({ mode: { type: 'string', enum: ['foreground', 'background'] } }, ['mode']),
    annotations: { idempotentHint: true, openWorldHint: false }
  },
  async run(ctx, args) {
    const mode = need(args, 'mode') as AgentMode
    if (mode !== 'foreground' && mode !== 'background')
      throw new RpcError(-32602, 'mode must be "foreground" or "background"')
    ctx.session.mode = mode
    if (mode === 'foreground' && ctx.session.currentTabId) {
      await ctx.agents.prepare(ctx.session, ctx.session.currentTabId, { activate: true })
    }
    return text(`You are now in ${mode} mode.`)
  }
}

const zenSpaces: AgentTool = {
  definition: {
    name: 'zen_spaces',
    title: 'Spaces',
    description:
      "List, create or switch Zen spaces (workspaces that group tabs). New tabs open in the space shown to the user unless you pass spaceId to browser_tabs; create your own space to keep your work separate from the user's tabs.",
    inputSchema: schema(
      {
        action: { type: 'string', enum: ['list', 'create', 'switch'] },
        name: { type: 'string', description: 'create: the new space name' },
        icon: { type: 'string', description: 'create: an emoji for the space' },
        spaceId: { type: 'string', description: 'switch: the space to show' }
      },
      ['action']
    ),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const action = need(args, 'action')
    const win = ctx.agents.agentWindow()
    const m = ctx.browser.state.model
    const list = (): string =>
      m.spaces
        .map(
          (sp) =>
            `- ${sp.id} ${JSON.stringify(sp.name)} ${sp.icon} – ${sp.tabIds.length} tab(s)${sp.id === win.activeSpaceId ? ' [shown to the user]' : ''}`
        )
        .join('\n')
    if (action === 'list') return text(`Spaces:\n${list()}`)
    if (action === 'create') {
      const name = str(args, 'name') ?? `${ctx.session.name}'s space`
      const id = ctx.browser.handleCommand(win, 'space.create', {
        name,
        icon: str(args, 'icon') ?? '🤖',
        containerId: win.activeSpace().containerId,
        theme: null
      }) as string
      return text(`Created space ${id} ${JSON.stringify(name)}.\n\nSpaces:\n${list()}`)
    }
    if (action === 'switch') {
      const spaceId = need(args, 'spaceId')
      if (!m.spaces.some((sp) => sp.id === spaceId))
        throw new RpcError(-32602, `Unknown space ${spaceId}`)
      ctx.browser.tabs.switchSpace(spaceId, win)
      return text(`Switched to space ${spaceId}.\n\nSpaces:\n${list()}`)
    }
    throw new RpcError(-32602, 'action must be list, create or switch')
  }
}

const browserTabs: AgentTool = {
  definition: {
    name: 'browser_tabs',
    title: 'Manage tabs',
    description:
      'list: every tab with its id, url and who drives it. new: open a tab (optionally at url) that becomes your current tab. select: make an existing tab your current tab (fails when another agent drives it). close: close one of your tabs.',
    inputSchema: schema(
      {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        url: { type: 'string', description: 'new: URL (or search words) to open' },
        tabId: { type: 'string', description: 'select / close: the tab' },
        spaceId: {
          type: 'string',
          description: 'new: space to open the tab in (default: the space shown to the user)'
        },
        background: {
          type: 'boolean',
          description: 'new: never bring the new tab in front of the user, even in foreground mode'
        }
      },
      ['action']
    ),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const action = need(args, 'action')
    const s = ctx.session
    const tabs = ctx.browser.tabs
    if (action === 'list') return text(`Tabs:\n${listTabs(ctx)}`)
    if (action === 'new') {
      const win = ctx.agents.agentWindow()
      const rawUrl = str(args, 'url')
      const url = rawUrl ? resolveUrl(ctx, rawUrl) : undefined
      const foreground = s.mode === 'foreground' && !bool(args, 'background')
      const spaceId = str(args, 'spaceId')
      if (spaceId && !ctx.browser.state.model.spaces.some((sp) => sp.id === spaceId))
        throw new RpcError(-32602, `Unknown space ${spaceId}`)
      const tab = tabs.createTab({ url, spaceId, active: foreground, load: false }, win)
      ctx.agents.claim(s, tab.id)
      const view = await ctx.agents.prepare(s, tab.id, { activate: foreground })
      if (url) await ctx.agents.waitForLoad(tab.id, LOAD_TIMEOUT_MS)
      return pageResult(
        ctx,
        tab,
        view,
        `Opened tab ${tab.id}${url ? ` at ${url}` : ''}. It is now your current tab.`
      )
    }
    if (action === 'select') {
      const tab = ctx.agents.claim(s, need(args, 'tabId'))
      const view = await ctx.agents.prepare(s, tab.id)
      return pageResult(ctx, tab, view, `Tab ${tab.id} is now your current tab.`)
    }
    if (action === 'close') {
      const tabId = str(args, 'tabId') ?? s.currentTabId
      if (!tabId) throw new RpcError(-32602, 'No tab to close')
      const driver = ctx.agents.driver(tabId)
      if (!driver || driver.id !== s.id)
        throw new RpcError(
          -32001,
          `Tab ${tabId} is not one of your tabs – only tabs you opened or selected can be closed`
        )
      tabs.closeTab(tabId, true, ctx.agents.agentWindow())
      return text(
        `Closed tab ${tabId}. Your current tab is now ${s.currentTabId ?? 'none'}.\n\nTabs:\n${listTabs(ctx)}`
      )
    }
    throw new RpcError(-32602, 'action must be list, new, select or close')
  }
}

const browserNavigate: AgentTool = {
  definition: {
    name: 'browser_navigate',
    title: 'Navigate',
    description:
      "Load a URL in your current tab (or tabId). Plain words are searched with the user's default search engine. Opens a tab for you when you have none. Returns a snapshot of the loaded page.",
    inputSchema: schema({ url: { type: 'string' }, tabId: TAB_ID }, ['url']),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const url = resolveUrl(ctx, need(args, 'url'))
    const s = ctx.session
    let tab: Tab
    if (typeof args.tabId === 'string' || s.currentTabId) tab = ctx.agents.resolveTab(s, args.tabId)
    else {
      const win = ctx.agents.agentWindow()
      tab = ctx.browser.tabs.createTab({ active: s.mode === 'foreground', load: false }, win)
      ctx.agents.claim(s, tab.id)
    }
    await ctx.agents.prepare(s, tab.id)
    ctx.browser.tabs.navigate(tab.id, url)
    const loaded = await ctx.agents.waitForLoad(tab.id, LOAD_TIMEOUT_MS)
    const view = ctx.browser.tabs.view(tab.id)
    if (!view) throw new RpcError(-32002, 'The tab went away while loading')
    const pos = ctx.agents.cursorPosition(s, tab.id)
    if (pos) await ctx.agents.cursor(s, tab.id, view, pos.x, pos.y, 'show')
    return pageResult(
      ctx,
      tab,
      view,
      `Navigated to ${url}${loaded ? '' : ' (still loading after 15 s)'}.`
    )
  }
}

const browserNavigateBack: AgentTool = {
  definition: {
    name: 'browser_navigate_back',
    title: 'Go back',
    description: "Go back one page in the tab's history and return a snapshot.",
    inputSchema: schema({ tabId: TAB_ID }),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    if (!view.canGoBack()) return textError('There is no previous page in this tab')
    ctx.browser.tabs.goBack(tab.id)
    await ctx.agents.waitForLoad(tab.id, LOAD_TIMEOUT_MS)
    return pageResult(ctx, tab, ctx.browser.tabs.view(tab.id) ?? view, 'Went back.')
  }
}

const browserSnapshot: AgentTool = {
  definition: {
    name: 'browser_snapshot',
    title: 'Page snapshot',
    description:
      'Read the page as an accessibility-style tree. Each element carries a [ref=eN] handle for browser_click / browser_type / browser_hover / browser_select_option. Prefer this over screenshots; refs from older snapshots become stale once the page changes.',
    inputSchema: schema({
      tabId: TAB_ID,
      filter: { type: 'string', description: 'Only lines containing this text (case-insensitive)' },
      interactiveOnly: { type: 'boolean', description: 'Only links, buttons, fields and headings' },
      boxes: { type: 'boolean', description: "Append each element's viewport box as [box=x,y,w,h]" }
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    return pageResult(ctx, tab, view, 'Snapshot taken.', {
      filter: str(args, 'filter') ?? null,
      interactiveOnly: bool(args, 'interactiveOnly'),
      boxes: bool(args, 'boxes')
    })
  }
}

const browserClick: AgentTool = {
  definition: {
    name: 'browser_click',
    title: 'Click',
    description:
      'Click an element. Scrolls it into view, moves your cursor there and clicks; returns a snapshot afterwards.',
    inputSchema: schema(
      {
        target: TARGET,
        tabId: TAB_ID,
        doubleClick: { type: 'boolean' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Shift', 'Control', 'Alt', 'Meta'] }
        }
      },
      ['target']
    ),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const target = need(args, 'target')
    const { tab, view } = await actOn(ctx, args)
    const loc = await locate(ctx, view, target)
    if (loc.disabled) return textError(`${describeElement(loc)} is disabled`)
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'move')
    await sleep(ctx.agents.settings.showCursor ? 260 : 30)
    const button = (str(args, 'button') as 'left' | 'right' | 'middle' | undefined) ?? 'left'
    const how = await clickAt(ctx, view, loc, target, {
      button,
      count: bool(args, 'doubleClick') ? 2 : 1,
      modifiers: modifiers(args)
    })
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'click')
    await settle(ctx, tab.id)
    const current = ctx.browser.tabs.view(tab.id) ?? view
    const note =
      how === 'synthetic' && loc.covered
        ? ' (another element covered it, so the click was dispatched to it directly)'
        : ''
    return pageResult(ctx, tab, current, `Clicked ${describeElement(loc)}${note}.`)
  }
}

const browserHover: AgentTool = {
  definition: {
    name: 'browser_hover',
    title: 'Hover',
    description:
      'Move the cursor over an element (opens hover menus, shows tooltips) and return a snapshot.',
    inputSchema: schema({ target: TARGET, tabId: TAB_ID }, ['target']),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const target = need(args, 'target')
    const { tab, view } = await actOn(ctx, args)
    const loc = await locate(ctx, view, target)
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'move')
    if (view.sendInput) await view.sendInput({ type: 'mouseMove', x: loc.x, y: loc.y })
    await sleep(350)
    return pageResult(ctx, tab, view, `Hovering ${describeElement(loc)}.`)
  }
}

const browserType: AgentTool = {
  definition: {
    name: 'browser_type',
    title: 'Type text',
    description:
      'Type into an editable element (text field, textarea, rich editor). Replaces the current value unless clear is false. submit presses Enter afterwards. Returns a snapshot.',
    inputSchema: schema(
      {
        target: TARGET,
        text: { type: 'string' },
        tabId: TAB_ID,
        submit: { type: 'boolean', description: 'Press Enter after typing' },
        clear: { type: 'boolean', description: 'Replace the existing value (default true)' }
      },
      ['target', 'text']
    ),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const target = need(args, 'target')
    const value = typeof args.text === 'string' ? args.text : ''
    const { tab, view } = await actOn(ctx, args)
    const loc = await locate(ctx, view, target)
    if (!loc.editable) return textError(`${describeElement(loc)} is not an editable field`)
    if (loc.disabled) return textError(`${describeElement(loc)} is disabled`)
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'move')
    await sleep(ctx.agents.settings.showCursor ? 220 : 20)
    // Focus the way a person would, so focus handlers and autocomplete popups behave.
    await clickAt(ctx, view, loc, target, { button: 'left', count: 1, modifiers: [] })
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'click')
    await sleep(60)
    const filled = (await ctx.agents.evalPage(
      view,
      pageCall('fill', ctx.session.id, target, value, bool(args, 'clear', true))
    )) as PageActionResult
    if (!filled.ok) return textError(filled.error ?? 'Could not type into the element')
    let headline = `Typed ${JSON.stringify(value)} into ${describeElement(loc)}`
    if (bool(args, 'submit')) {
      await sleep(80)
      if (wantTrustedInput(view))
        await view.sendInput!({ type: 'key', key: 'Enter', modifiers: [] })
      else await ctx.agents.evalPage(view, pageCall('submit', ctx.session.id, target))
      headline += ' and pressed Enter'
    }
    await settle(ctx, tab.id)
    return pageResult(ctx, tab, ctx.browser.tabs.view(tab.id) ?? view, `${headline}.`)
  }
}

const browserPressKey: AgentTool = {
  definition: {
    name: 'browser_press_key',
    title: 'Press a key',
    description:
      'Press a keyboard key in the page (Enter, Tab, Escape, ArrowDown, a, …) with optional modifiers. Returns a snapshot.',
    inputSchema: schema(
      {
        key: { type: 'string' },
        tabId: TAB_ID,
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Shift', 'Control', 'Alt', 'Meta'] }
        }
      },
      ['key']
    ),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const key = normalizeKey(need(args, 'key'))
    const { tab, view } = await actOn(ctx, args)
    await pressKey(ctx, view, key, modifiers(args))
    await settle(ctx, tab.id)
    return pageResult(
      ctx,
      tab,
      ctx.browser.tabs.view(tab.id) ?? view,
      `Pressed ${key === ' ' ? 'Space' : key}.`
    )
  }
}

const browserScroll: AgentTool = {
  definition: {
    name: 'browser_scroll',
    title: 'Scroll',
    description:
      'Scroll the page by a viewport (direction), to an element (target) or to the top/bottom. Returns a snapshot.',
    inputSchema: schema({
      tabId: TAB_ID,
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number', description: 'Pixels (default: 80% of the viewport)' },
      target: { ...TARGET, description: 'Scroll this element into view instead' },
      to: { type: 'string', enum: ['top', 'bottom'] }
    }),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    const r = (await ctx.agents.evalPage(
      view,
      pageCall('scroll', ctx.session.id, {
        target: str(args, 'target') ?? null,
        direction: str(args, 'direction') ?? null,
        amount: num(args, 'amount') ?? null,
        to: str(args, 'to') ?? null
      })
    )) as PageActionResult
    if (!r.ok) return textError(r.error ?? 'Could not scroll')
    await sleep(250)
    return pageResult(ctx, tab, view, `Scrolled (now at ${r.scrollY ?? 0}px).`)
  }
}

const browserSelectOption: AgentTool = {
  definition: {
    name: 'browser_select_option',
    title: 'Select option',
    description:
      'Choose option(s) of a <select> element by value or visible label. Returns a snapshot.',
    inputSchema: schema(
      { target: TARGET, values: { type: 'array', items: { type: 'string' } }, tabId: TAB_ID },
      ['target', 'values']
    ),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const target = need(args, 'target')
    const values = strings(args, 'values')
    if (!values.length) throw new RpcError(-32602, 'values must list at least one option')
    const { tab, view } = await actOn(ctx, args)
    const loc = await locate(ctx, view, target)
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'click')
    const r = (await ctx.agents.evalPage(
      view,
      pageCall('select', ctx.session.id, target, values)
    )) as PageActionResult
    if (!r.ok) return textError(r.error ?? 'Could not select')
    await settle(ctx, tab.id)
    return pageResult(
      ctx,
      tab,
      ctx.browser.tabs.view(tab.id) ?? view,
      `Selected ${JSON.stringify(r.value ?? values[0])} in ${describeElement(loc)}.`
    )
  }
}

const browserTakeScreenshot: AgentTool = {
  definition: {
    name: 'browser_take_screenshot',
    title: 'Screenshot',
    description:
      "A JPEG screenshot of the tab's viewport. Use browser_snapshot to act on elements; screenshots are for checking layout and images.",
    inputSchema: schema({ tabId: TAB_ID }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    const dataUrl = await view.snapshot()
    if (!dataUrl)
      return textError(
        'The page could not be captured (a hidden tab may have nothing painted yet – try zen_mode foreground)'
      )
    const comma = dataUrl.indexOf(',')
    const mimeType = /^data:([^;]+)/.exec(dataUrl)?.[1] ?? 'image/jpeg'
    const current = ctx.browser.tabs.tab(tab.id) ?? tab
    return {
      content: [
        {
          type: 'text',
          text: `Screenshot of ${JSON.stringify(current.title)} – ${current.url} (tab ${current.id})`
        },
        { type: 'image', data: dataUrl.slice(comma + 1), mimeType }
      ]
    }
  }
}

const browserReadPage: AgentTool = {
  definition: {
    name: 'browser_read_page',
    title: 'Read page text',
    description:
      'The readable text of the page: the article (title, byline, body) when the page looks like one, otherwise the visible text. Much cheaper than a snapshot when you only need to read.',
    inputSchema: schema({
      tabId: TAB_ID,
      maxChars: {
        type: 'number',
        description: 'Truncate after this many characters (default 20000)'
      }
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    const max = Math.min(Math.max(num(args, 'maxChars') ?? 20_000, 500), 200_000)
    const src = ctx.browser.platform.readabilitySource('Readability.js')
    const current = ctx.browser.tabs.tab(tab.id) ?? tab
    if (src && /^https?:/.test(current.url)) {
      const article = (await ctx.agents
        .evalPage(
          view,
          `(() => { ${src}
            try {
              const doc = document.cloneNode(true)
              for (const el of doc.querySelectorAll('[data-zen-agent]')) el.remove()
              const a = new Readability(doc, { keepClasses: false }).parse()
              return a && a.textContent && a.textContent.trim().length > 200 ? { title: a.title, byline: a.byline, text: a.textContent } : null
            } catch (e) { return null }
          })()`
        )
        .catch(() => null)) as { title: string; byline: string | null; text: string } | null
      if (article) {
        const body = article.text.replace(/\n{3,}/g, '\n\n').trim()
        const head = `# ${article.title || current.title}\n${article.byline ? `by ${article.byline}\n` : ''}URL: ${current.url}\n\n`
        return text(
          head +
            body.slice(0, max) +
            (body.length > max ? `\n\n… truncated (${body.length} characters in total)` : '')
        )
      }
    }
    const plain = (await ctx.agents.evalPage(view, pageCall('text', max))) as {
      title: string
      text: string
      truncated: boolean
    }
    return text(
      `# ${plain.title || current.title}\nURL: ${current.url}\n\n${plain.text}${plain.truncated ? '\n\n… truncated' : ''}`
    )
  }
}

const browserWaitFor: AgentTool = {
  definition: {
    name: 'browser_wait_for',
    title: 'Wait',
    description:
      'Wait until text appears (text) or disappears (textGone), until a CSS selector matches, or for a number of seconds (time). Returns a snapshot.',
    inputSchema: schema({
      tabId: TAB_ID,
      text: { type: 'string' },
      textGone: { type: 'string' },
      selector: { type: 'string' },
      time: { type: 'number', description: 'Seconds to wait (max 30)' },
      timeout: {
        type: 'number',
        description: 'Seconds to wait for the condition (default 10, max 30)'
      }
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    const time = num(args, 'time')
    const conditions = {
      text: str(args, 'text') ?? null,
      textGone: str(args, 'textGone') ?? null,
      selector: str(args, 'selector') ?? null
    }
    if (time !== undefined && !conditions.text && !conditions.textGone && !conditions.selector) {
      await sleep(Math.min(Math.max(time, 0), 30) * 1000)
      return pageResult(ctx, tab, view, `Waited ${Math.min(Math.max(time, 0), 30)} s.`)
    }
    if (!conditions.text && !conditions.textGone && !conditions.selector)
      throw new RpcError(-32602, 'Give text, textGone, selector or time')
    const timeout = Math.min(Math.max(num(args, 'timeout') ?? 10, 0.1), 30) * 1000
    const r = (await ctx.agents.evalPage(
      view,
      pageCall('waitFor', { ...conditions, timeout })
    )) as { ok: boolean; elapsed: number; reason: string }
    if (!r.ok) {
      const result = await pageResult(
        ctx,
        tab,
        view,
        `Timed out after ${Math.round(r.elapsed / 100) / 10} s: ${r.reason}.`
      )
      return { ...result, isError: true }
    }
    return pageResult(ctx, tab, view, `Condition met after ${Math.round(r.elapsed / 100) / 10} s.`)
  }
}

const browserEvaluate: AgentTool = {
  scripting: true,
  definition: {
    name: 'browser_evaluate',
    title: 'Run JavaScript',
    description:
      'Evaluate a JavaScript expression (or a function like "() => document.title") in the page and return its JSON result.',
    inputSchema: schema({ expression: { type: 'string' }, tabId: TAB_ID }, ['expression']),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const expression = need(args, 'expression')
    const { tab, view } = await actOn(ctx, args)
    const code = `(async () => { const __r = (${expression}); const __v = typeof __r === 'function' ? await __r() : await __r; try { return JSON.stringify(__v) ?? 'undefined' } catch (e) { return String(__v) } })()`
    try {
      const result = (await view.executeJavaScript(code)) as string
      const out = typeof result === 'string' ? result : JSON.stringify(result)
      return text(
        `Result (tab ${tab.id}):\n${out.length > 20_000 ? out.slice(0, 20_000) + '\n… truncated' : out}`
      )
    } catch (error) {
      return textError(`Script failed: ${(error as Error).message}`)
    }
  }
}

const zenHistory: AgentTool = {
  definition: {
    name: 'zen_history',
    title: 'Search history',
    description:
      "Search the user's browsing history by title or URL (empty query: most recent pages).",
    inputSchema: schema({ query: { type: 'string' }, limit: { type: 'number' } }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx, args) {
    const limit = Math.min(Math.max(num(args, 'limit') ?? 20, 1), 100)
    const entries = ctx.browser.history.search(str(args, 'query') ?? '', limit)
    if (!entries.length) return text('No matching history entries.')
    return text(
      entries
        .map(
          (e) =>
            `- ${JSON.stringify(e.title || e.url)} ${e.url} (visited ${e.visitCount}×, last ${new Date(e.lastVisit).toISOString()})`
        )
        .join('\n')
    )
  }
}

export const AGENT_TOOLS: AgentTool[] = [
  zenStatus,
  browserTabs,
  browserNavigate,
  browserNavigateBack,
  browserSnapshot,
  browserClick,
  browserType,
  browserPressKey,
  browserHover,
  browserScroll,
  browserSelectOption,
  browserWaitFor,
  browserTakeScreenshot,
  browserReadPage,
  browserEvaluate,
  zenSpaces,
  zenMode,
  zenHistory
]

export function agentInstructions(mode: AgentMode, allowScripts: boolean): string {
  return [
    "You are controlling the user's Zen browser (Chromium) through its built-in MCP server. The user – and possibly other agents – share this browser, so:",
    '- Call zen_status first: it tells you your name and colour, your mode, the spaces, every open tab and which agent drives which tab.',
    '- Open your own tab with browser_tabs {"action":"new","url":"…"} (or just browser_navigate) instead of taking over tabs you do not own. Tabs driven by another agent are refused. Page tools act on your current tab unless you pass tabId.',
    '- browser_snapshot returns the page as an accessibility tree whose elements carry [ref=eN] handles; use them as target for browser_click, browser_type, browser_hover and browser_select_option. Every action returns a fresh snapshot and invalidates older refs.',
    '- browser_read_page is the cheap way to read an article; browser_take_screenshot only when the layout or an image matters.',
    `- You start in ${mode.toUpperCase()} mode. Foreground: your tab is brought in front of the user before each action and a cursor with your name shows what you do. Background: you work in your tabs without changing what the user sees. Switch with zen_mode.`,
    '- browser_navigate accepts URLs or search words. Use zen_spaces to keep your work in its own space when it is more than a quick lookup.',
    allowScripts
      ? '- browser_evaluate runs JavaScript in the page when nothing else does the job.'
      : '- Running scripts in pages is disabled by the user.'
  ].join('\n')
}
