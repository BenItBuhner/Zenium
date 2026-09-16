import type { AgentMode, Folder, Tab } from '../../shared/types'
import { buildSearchUrl } from '../../shared/search'
import { inputToUrl } from '../../shared/url'
import type { Browser } from '../browser'
import { createFolder } from '../model'
import type { AgentCapture, InputModifier, TabView } from '../platform'
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
 *
 * Small models get the vocabulary slightly wrong all the time (`ref` for `target`, `function`
 * for `expression`, `switch` for `select`, `[ref=e12]` for `e12`, a tab's list position for its
 * id…). Every argument therefore has aliases, tabs resolve by id, id prefix or list position, and
 * every error says what would have worked.
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

/** Other names agents use for an argument (Playwright MCP's vocabulary and common guesses). */
export const ARG_ALIASES: Record<string, string[]> = {
  target: ['ref', 'selector', 'element', 'locator', 'css', 'elementRef'],
  tabId: ['tab', 'tab_id', 'id', 'index', 'tabIndex'],
  tabIds: ['tabs', 'tab_ids', 'ids'],
  url: ['href', 'link', 'address'],
  expression: ['function', 'script', 'code', 'js', 'javascript'],
  text: ['value', 'input', 'string'],
  key: ['keys', 'keyName'],
  values: ['value', 'option', 'options', 'label', 'labels'],
  action: ['command', 'operation', 'op', 'type'],
  direction: ['dir'],
  amount: ['pixels', 'px', 'distance', 'by'],
  fullPage: ['full_page', 'full', 'fullpage', 'entirePage'],
  doubleClick: ['double', 'dblclick', 'double_click'],
  name: ['title', 'folderName', 'groupName', 'folder', 'group'],
  spaceId: ['space', 'space_id', 'workspace'],
  maxChars: ['max_chars', 'limit', 'maxLength'],
  filter: ['search', 'contains', 'query'],
  interactiveOnly: ['interactive', 'interactive_only'],
  time: ['seconds', 'duration', 'wait'],
  textGone: ['text_gone', 'gone', 'disappears'],
  ignoreCache: ['hard', 'ignore_cache', 'bypassCache'],
  background: ['inBackground'],
  submit: ['enter', 'pressEnter']
}

/** The first present value among an argument's own name and its aliases. */
function pick(args: Record<string, unknown>, key: string): unknown {
  if (args[key] !== undefined && args[key] !== null && args[key] !== '') return args[key]
  for (const alias of ARG_ALIASES[key] ?? []) {
    const v = args[alias]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = pick(args, key)
  if (typeof v === 'string') return v.length ? v : undefined
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function need(args: Record<string, unknown>, key: string, hint?: string): string {
  const v = str(args, key)
  if (v === undefined)
    throw new RpcError(-32602, `Missing required argument "${key}"${hint ? ` – ${hint}` : ''}`)
  return v
}

function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = pick(args, key)
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    if (/^(true|yes|1|on)$/i.test(v)) return true
    if (/^(false|no|0|off)$/i.test(v)) return false
  }
  if (typeof v === 'number') return v !== 0
  return fallback
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = pick(args, key)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function strings(args: Record<string, unknown>, key: string): string[] {
  const v = pick(args, key)
  if (Array.isArray(v))
    return v
      .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
      .map(String)
  return typeof v === 'string' ? [v] : typeof v === 'number' ? [String(v)] : []
}

function modifiers(args: Record<string, unknown>): InputModifier[] {
  const allowed: InputModifier[] = ['Shift', 'Control', 'Alt', 'Meta']
  return strings(args, 'modifiers')
    .map((m) => (m === 'ControlOrMeta' || m === 'Ctrl' ? 'Control' : m === 'Cmd' ? 'Meta' : m))
    .filter((m): m is InputModifier => (allowed as string[]).includes(m))
}

/** Viewport coordinates when both are given (numbers or numeric strings). */
function point(args: Record<string, unknown>): { x: number; y: number } | undefined {
  const x = num(args, 'x')
  const y = num(args, 'y')
  if (x === undefined || y === undefined) return undefined
  return { x, y }
}

const TAB_ID = {
  type: 'string',
  description:
    'Which tab: a tab id from browser_tabs list (e.g. "tab_3f9a…"; a unique prefix is enough) or its position in that list (1, 2, …). Defaults to your current tab. Tabs driven by another agent are refused.'
}
const TARGET = {
  type: 'string',
  description:
    'Which element: a ref from your latest browser_snapshot ("e12" – also accepted as "[ref=e12]"), a CSS selector ("#login", "button.primary"), or "text=Sign in" for an element by its visible text.'
}
const XY_NOTE =
  'Alternatively give x and y (CSS pixels from the top-left of the viewport, as reported by the viewport size in snapshots) instead of target.'

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  // Deliberately not `additionalProperties: false`: a client that validates would then reject
  // the aliases above before the server can understand them.
  return { type: 'object', properties, required }
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] }
}

/** Argument names a tool understands (declared properties plus their aliases). */
export function acceptedArgs(def: ToolDefinition): Set<string> {
  const out = new Set<string>()
  for (const key of Object.keys(def.inputSchema.properties)) {
    out.add(key)
    for (const alias of ARG_ALIASES[key] ?? []) out.add(alias)
  }
  return out
}

// ---------------------------------------------------------------------------
// Page access helpers
// ---------------------------------------------------------------------------

interface Target {
  tab: Tab
  view: TabView
}

/**
 * Tabs in the order the user sees them: Essentials first, then each space's tabs (pinned before
 * regular), then anything else the model knows about. Positions in this list are what agents
 * may use instead of ids.
 */
export function orderedTabs(ctx: ToolContext): Tab[] {
  const m = ctx.browser.state.model
  const visible = ctx.agents.visibleTabs(ctx.session)
  const byId = new Map(visible.map((t) => [t.id, t]))
  const out: Tab[] = []
  const take = (id: string): void => {
    const t = byId.get(id)
    if (t) {
      out.push(t)
      byId.delete(id)
    }
  }
  for (const id of m.essentialTabIds) take(id)
  for (const sp of m.spaces) for (const id of sp.tabIds) take(id)
  for (const t of byId.values()) out.push(t)
  return out
}

/**
 * Turn whatever an agent passed as a tab reference into a tab id: the id itself, a unique prefix
 * of one ("tab_3f9a"), or a 1-based position in the browser_tabs list.
 */
export function resolveTabRef(ctx: ToolContext, ref: unknown): string {
  const tabs = orderedTabs(ctx)
  const describe = (): string =>
    tabs.length
      ? `Open tabs: ${tabs.map((t, i) => `${i + 1}. ${t.id}`).join(', ')}`
      : 'There are no open tabs – open one with browser_tabs {"action":"new","url":"…"}'
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim()))) {
    const n = Number(ref)
    const tab = tabs[n - 1]
    if (!tab)
      throw new RpcError(
        -32602,
        `There is no tab at position ${n} (positions are 1-based, ${tabs.length} tab(s) open). ${describe()}`
      )
    return tab.id
  }
  if (typeof ref !== 'string' || !ref.trim())
    throw new RpcError(-32602, `tabId must be a tab id or a list position. ${describe()}`)
  const wanted = ref.trim()
  if (tabs.some((t) => t.id === wanted)) return wanted
  const prefixed = tabs.filter((t) => t.id.startsWith(wanted))
  if (prefixed.length === 1) return prefixed[0].id
  if (prefixed.length > 1)
    throw new RpcError(
      -32602,
      `"${wanted}" matches ${prefixed.length} tabs (${prefixed.map((t) => t.id).join(', ')}) – give more of the id`
    )
  // Private tabs and tabs of other windows are invisible: say so instead of "unknown".
  const anywhere = ctx.browser.tabs.tab(wanted)
  if (anywhere) throw new RpcError(-32002, `Tab ${wanted} is not available to agents`)
  throw new RpcError(
    -32002,
    `Unknown tab "${wanted}" – it may have been closed. ${describe()} (browser_tabs {"action":"list"} shows titles and URLs)`
  )
}

function tabArg(ctx: ToolContext, args: Record<string, unknown>): string | undefined {
  const raw = pick(args, 'tabId')
  return raw === undefined ? undefined : resolveTabRef(ctx, raw)
}

async function actOn(ctx: ToolContext, args: Record<string, unknown>): Promise<Target> {
  const tab = ctx.agents.resolveTab(ctx.session, tabArg(ctx, args))
  const view = await ctx.agents.prepare(ctx.session, tab.id)
  return { tab, view }
}

async function snapshot(
  ctx: ToolContext,
  view: TabView,
  opts: SnapshotOpts = {}
): Promise<PageSnapshot> {
  return (await ctx.agents.evalPage(
    view,
    pageCall('snapshot', {
      agent: ctx.session.id,
      filter: opts.filter ?? null,
      interactiveOnly: Boolean(opts.interactiveOnly),
      boxes: Boolean(opts.boxes),
      maxChars: Math.min(Math.max(opts.maxChars ?? SNAPSHOT_MAX_CHARS, 500), 200_000)
    })
  )) as PageSnapshot
}

interface SnapshotOpts {
  filter?: string | null
  interactiveOnly?: boolean
  boxes?: boolean
  maxChars?: number
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
  opts: SnapshotOpts = {}
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
  const maxScroll = Math.max(0, snap.scroll.height - snap.viewport.height)
  const lines = [
    headline,
    `- Page URL: ${snap.url}`,
    `- Page Title: ${snap.title}`,
    `- Tab: ${describeTab(ctx, current)}`,
    `- Viewport: ${snap.viewport.width}×${snap.viewport.height} CSS px, scrolled to ${snap.scroll.y} of ${maxScroll}${snap.scroll.y >= maxScroll ? ' (bottom)' : ''}${snap.refs ? `; ${snap.refs} elements${snap.truncated ? ', snapshot truncated' : ''}` : ''}`,
    '- Page Snapshot (each line: role "name" [attributes] [ref=eN] – pass the eN as target):',
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

async function locateAt(
  ctx: ToolContext,
  view: TabView,
  p: { x: number; y: number }
): Promise<PageLocation> {
  const loc = (await ctx.agents.evalPage(view, pageCall('locateAt', ctx.session.id, p.x, p.y))) as
    PageLocation | { error: string }
  if ('error' in loc) throw new RpcError(-32602, loc.error)
  return loc
}

/** `target` or a point: what the tool should act on, with a helpful error when neither is given. */
async function locateArg(
  ctx: ToolContext,
  view: TabView,
  args: Record<string, unknown>,
  tool: string
): Promise<{ loc: PageLocation; target: string | null }> {
  const target = str(args, 'target')
  if (target) return { loc: await locate(ctx, view, target), target }
  const p = point(args)
  if (p) return { loc: await locateAt(ctx, view, p), target: null }
  throw new RpcError(
    -32602,
    `${tool} needs a "target" (a ref like "e12" from browser_snapshot, a CSS selector, or "text=Visible label") or viewport coordinates "x" and "y"`
  )
}

function describeElement(loc: PageLocation): string {
  return `${loc.role}${loc.name ? ` "${loc.name.length > 60 ? loc.name.slice(0, 59) + '…' : loc.name}"` : ''}${loc.ref ? ` [ref=${loc.ref}]` : ''}`
}

function describeCapture(kind: string, cap: AgentCapture, tab: Tab): string {
  return `Screenshot (${kind}, ${cap.width}×${cap.height} px, ${cap.mimeType}) of ${JSON.stringify(tab.title)} – ${tab.url} (tab ${tab.id})`
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

/** Move the pointer over an element: trusted when the page is on screen, synthetic otherwise. */
async function hoverAt(
  ctx: ToolContext,
  view: TabView,
  loc: PageLocation,
  target: string | null
): Promise<'trusted' | 'synthetic'> {
  if (wantTrustedInput(view, loc) && view.sendInput) {
    await view.sendInput({ type: 'mouseMove', x: loc.x, y: loc.y })
    return 'trusted'
  }
  const r = (await ctx.agents.evalPage(
    view,
    pageCall('hoverJs', ctx.session.id, target, loc.x, loc.y)
  )) as PageActionResult
  if (!r.ok) throw new RpcError(-32602, r.error ?? 'Hover failed')
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

export function normalizeKey(key: string): string {
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

function folderOf(ctx: ToolContext, t: Tab): Folder | null {
  return t.folderId ? (ctx.browser.state.model.folders[t.folderId] ?? null) : null
}

function tabLine(ctx: ToolContext, t: Tab, position: number): string {
  const driver = ctx.agents.driver(t.id)
  const folder = folderOf(ctx, t)
  const flags: string[] = []
  if (t.essential) flags.push('essential')
  else if (t.pinned) flags.push('pinned')
  if (folder) flags.push(`folder: ${JSON.stringify(folder.name)}`)
  if (t.discarded) flags.push('unloaded')
  if (driver) flags.push(driver.id === ctx.session.id ? 'yours' : `driven by ${driver.name}`)
  if (ctx.session.currentTabId === t.id) flags.push('current')
  const title = (t.customTitle ?? t.title) || '(untitled)'
  return `${position}. ${t.id} ${JSON.stringify(title.slice(0, 80))} ${t.url}${flags.length ? ` [${flags.join(', ')}]` : ''}`
}

/** Every tab the agent may see, numbered, grouped the way the sidebar shows them. */
export function listTabs(ctx: ToolContext): string {
  const tabs = orderedTabs(ctx)
  if (!tabs.length)
    return '(no tabs – open one with browser_tabs {"action":"new","url":"…"} or browser_navigate)'
  const m = ctx.browser.state.model
  const win = ctx.agents.agentWindow()
  const lines: string[] = []
  let position = 0
  const essentials = tabs.filter((t) => t.essential)
  if (essentials.length) {
    lines.push('Essentials:')
    for (const t of essentials) lines.push(tabLine(ctx, t, ++position))
  }
  for (const sp of m.spaces) {
    const inSpace = tabs.filter((t) => !t.essential && t.spaceId === sp.id)
    if (!inSpace.length && m.spaces.length === 1) continue
    lines.push(
      `Space ${JSON.stringify(sp.name)} (${sp.id})${sp.id === win.activeSpaceId ? ' [shown to the user]' : ''}:`
    )
    if (!inSpace.length) lines.push('  (empty)')
    for (const t of inSpace) lines.push(tabLine(ctx, t, ++position))
  }
  const rest = tabs.filter((t) => !t.essential && !m.spaces.some((sp) => sp.id === t.spaceId))
  if (rest.length) {
    lines.push('Other tabs:')
    for (const t of rest) lines.push(tabLine(ctx, t, ++position))
  }
  if (!lines.length) for (const t of tabs) lines.push(tabLine(ctx, t, ++position))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const zenStatus: AgentTool = {
  definition: {
    name: 'zen_status',
    title: 'Browser status',
    description:
      'Who you are in this browser (name, colour, foreground/background mode, current tab), which other agents are connected and which tabs they drive, the spaces, and every open tab with its position and id. Call this first; call browser_tabs {"action":"list"} later for just the tabs.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx) {
    const s = ctx.session
    const win = ctx.agents.agentWindow()
    const m = ctx.browser.state.model
    const agents = ctx.agents.list()
    const lines = [
      `You are "${s.name}" (agent ${s.id}, colour ${s.color}) in ${s.mode} mode. Current tab: ${s.currentTabId ?? 'none – browser_navigate or browser_tabs {"action":"new"} opens one for you'}. Tabs you drive: ${s.tabIds.size}.`,
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
      'Tabs (position. id "title" url [flags]):',
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
    const raw = need(args, 'mode', 'use "foreground" or "background"').toLowerCase()
    const mode: AgentMode | null =
      raw === 'foreground' || raw === 'fg' || raw === 'visible'
        ? 'foreground'
        : raw === 'background' || raw === 'bg' || raw === 'hidden'
          ? 'background'
          : null
    if (!mode)
      throw new RpcError(
        -32602,
        `mode must be "foreground" or "background" (got ${JSON.stringify(raw)})`
      )
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
    const action = need(args, 'action', 'use "list", "create" or "switch"').toLowerCase()
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
    if (action === 'create' || action === 'new') {
      const name = str(args, 'name') ?? `${ctx.session.name}'s space`
      const id = ctx.browser.handleCommand(win, 'space.create', {
        name,
        icon: str(args, 'icon') ?? '🤖',
        containerId: win.activeSpace().containerId,
        theme: null
      }) as string
      return text(`Created space ${id} ${JSON.stringify(name)}.\n\nSpaces:\n${list()}`)
    }
    if (action === 'switch' || action === 'select' || action === 'activate') {
      const wanted = need(args, 'spaceId', 'the id (or name) of the space to show')
      const space =
        m.spaces.find((sp) => sp.id === wanted) ??
        m.spaces.find((sp) => sp.name.toLowerCase() === wanted.toLowerCase())
      if (!space) throw new RpcError(-32602, `Unknown space ${wanted}.\n\nSpaces:\n${list()}`)
      ctx.browser.tabs.switchSpace(space.id, win)
      return text(
        `Switched to space ${space.id} ${JSON.stringify(space.name)}.\n\nSpaces:\n${list()}`
      )
    }
    throw new RpcError(
      -32602,
      `action must be "list", "create" or "switch" (got ${JSON.stringify(action)})`
    )
  }
}

const TAB_ACTIONS = ['list', 'new', 'select', 'close', 'move', 'group', 'ungroup'] as const
type TabAction = (typeof TAB_ACTIONS)[number]

/** Verbs agents reach for instead of the canonical action names. */
const TAB_ACTION_ALIASES: Record<string, TabAction> = {
  list: 'list',
  ls: 'list',
  show: 'list',
  get: 'list',
  new: 'new',
  open: 'new',
  create: 'new',
  add: 'new',
  select: 'select',
  switch: 'select',
  activate: 'select',
  focus: 'select',
  goto: 'select',
  use: 'select',
  close: 'close',
  remove: 'close',
  delete: 'close',
  kill: 'close',
  move: 'move',
  reorder: 'move',
  order: 'move',
  position: 'move',
  group: 'group',
  folder: 'group',
  fold: 'group',
  ungroup: 'ungroup',
  unfold: 'ungroup',
  unfolder: 'ungroup'
}

const browserTabs: AgentTool = {
  definition: {
    name: 'browser_tabs',
    title: 'Manage tabs',
    description:
      'Tab management. action: "list" every tab (position, id, title, url, folder, who drives it); "new" opens a tab (optionally at url) that becomes your current tab; "select" makes an existing tab your current tab (the one page tools act on); "close" closes a tab; "move" reorders a tab to a 1-based index within its space; "group" puts tabIds into a tab folder called name (created if needed); "ungroup" takes a tab out of its folder. To change the page a tab shows, call browser_navigate with that tabId. Tabs driven by another agent are refused.',
    inputSchema: schema(
      {
        action: { type: 'string', enum: [...TAB_ACTIONS] },
        url: { type: 'string', description: 'new: URL (or search words) to open' },
        tabId: {
          ...TAB_ID,
          description:
            'select / close / move / ungroup: the tab (id, unique id prefix, or its 1-based position from list). close defaults to your current tab.'
        },
        tabIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'group: the tabs to put in the folder (ids or positions)'
        },
        index: {
          type: 'number',
          description:
            "move: new 1-based position among the regular tabs of the tab's space (1 = first)"
        },
        name: { type: 'string', description: 'group: the folder name' },
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
    const rawAction = str(args, 'action')
    if (!rawAction) {
      // A bare {url} means "open it"; nothing at all means "list".
      if (str(args, 'url')) args = { ...args, action: 'new' }
      else return text(`Tabs (position. id "title" url [flags]):\n${listTabs(ctx)}`)
    }
    const action = TAB_ACTION_ALIASES[(str(args, 'action') ?? 'list').toLowerCase().trim()]
    if (!action)
      throw new RpcError(
        -32602,
        `Unknown action ${JSON.stringify(rawAction)} – use one of ${TAB_ACTIONS.map((a) => `"${a}"`).join(', ')}`
      )
    const s = ctx.session
    const tabs = ctx.browser.tabs
    const listing = (): string => `Tabs (position. id "title" url [flags]):\n${listTabs(ctx)}`
    if (action === 'list') return text(listing())
    if (action === 'new') {
      const win = ctx.agents.agentWindow()
      const rawUrl = str(args, 'url')
      const url = rawUrl ? resolveUrl(ctx, rawUrl) : undefined
      const foreground = s.mode === 'foreground' && !bool(args, 'background')
      const spaceId = str(args, 'spaceId')
      if (spaceId && !ctx.browser.state.model.spaces.some((sp) => sp.id === spaceId))
        throw new RpcError(
          -32602,
          `Unknown space ${spaceId} – zen_spaces {"action":"list"} shows the ids (or omit spaceId)`
        )
      const tab = tabs.createTab({ url, spaceId, active: foreground, load: false }, win)
      ctx.agents.claim(s, tab.id)
      const view = await ctx.agents.prepare(s, tab.id, { activate: foreground })
      if (url) await ctx.agents.waitForLoad(tab.id, LOAD_TIMEOUT_MS, { expectNavigation: true })
      return pageResult(
        ctx,
        tab,
        view,
        `Opened tab ${tab.id}${url ? ` at ${url}` : ' (blank)'}. It is now your current tab${url ? '' : ' – browser_navigate loads a page in it'}.`
      )
    }
    if (action === 'select') {
      const ref = pick(args, 'tabId')
      if (ref === undefined)
        throw new RpcError(-32602, `select needs tabId (a tab id or its position).\n\n${listing()}`)
      const tab = ctx.agents.claim(s, resolveTabRef(ctx, ref))
      const view = await ctx.agents.prepare(s, tab.id)
      return pageResult(ctx, tab, view, `Tab ${tab.id} is now your current tab.`)
    }
    if (action === 'close') {
      const ref = pick(args, 'tabId')
      const tabId = ref === undefined ? s.currentTabId : resolveTabRef(ctx, ref)
      if (!tabId)
        throw new RpcError(-32602, 'No tab to close – you have no current tab and gave no tabId')
      const driver = ctx.agents.driver(tabId)
      if (driver && driver.id !== s.id)
        throw new RpcError(
          -32001,
          `Tab ${tabId} is being driven by agent "${driver.name}" – only your own tabs (or unclaimed ones) can be closed`
        )
      if (!driver) {
        // Positions make it easy to hit the wrong tab: never close the user's curated tabs.
        const t = tabs.tab(tabId)
        if (t && (t.essential || t.pinned))
          throw new RpcError(
            -32001,
            `Tab ${tabId} is ${t.essential ? 'an Essential' : 'a pinned tab'} of the user's, not one of yours – agents only close tabs they opened or ordinary tabs`
          )
        ctx.agents.claim(s, tabId)
      }
      tabs.closeTab(tabId, true, ctx.agents.agentWindow())
      return text(
        `Closed tab ${tabId}. Your current tab is now ${s.currentTabId ?? 'none'}.\n\n${listing()}`
      )
    }
    if (action === 'move') {
      const ref = pick(args, 'tabId')
      if (ref === undefined)
        throw new RpcError(-32602, `move needs tabId and index.\n\n${listing()}`)
      const index = num(args, 'index') ?? num(args, 'position') ?? num(args, 'to')
      if (index === undefined)
        throw new RpcError(
          -32602,
          "move needs index: the new 1-based position within the tab's space"
        )
      const tab = ctx.agents.claim(s, resolveTabRef(ctx, ref))
      if (tab.essential)
        throw new RpcError(
          -32602,
          `Tab ${tab.id} is an Essential; Essentials cannot be reordered by agents`
        )
      const win = ctx.agents.agentWindow()
      tabs.moveTab(
        tab.id,
        { section: tab.pinned ? 'pinned' : 'regular', index: Math.max(0, Math.round(index) - 1) },
        win
      )
      return text(
        `Moved tab ${tab.id} to position ${Math.max(1, Math.round(index))} in its space.\n\n${listing()}`
      )
    }
    if (action === 'group') {
      // Agents pass the members as an array, or as one comma-separated string in tabIds or tabId.
      const refs = strings(args, 'tabIds').flatMap((r) => r.split(',').map((x) => x.trim()))
      const single = pick(args, 'tabId')
      if (single !== undefined && !refs.length)
        refs.push(
          ...String(single)
            .split(',')
            .map((x) => x.trim())
        )
      if (!refs.length)
        throw new RpcError(
          -32602,
          `group needs tabIds (the tabs to put together) and name (the folder name).\n\n${listing()}`
        )
      const ids = refs.map((r) => resolveTabRef(ctx, r))
      const members = ids.map((id) => ctx.agents.claim(s, id))
      const pinned = members.filter((t) => t.pinned || t.essential)
      if (pinned.length)
        throw new RpcError(
          -32602,
          `Pinned and Essential tabs cannot be put in folders (${pinned.map((t) => t.id).join(', ')})`
        )
      const spaceId = members[0].spaceId ?? ctx.agents.agentWindow().activeSpace().id
      const foreign = members.filter((t) => (t.spaceId ?? spaceId) !== spaceId)
      if (foreign.length)
        throw new RpcError(
          -32602,
          `All tabs of a folder must be in the same space; ${foreign.map((t) => t.id).join(', ')} are elsewhere`
        )
      const name = str(args, 'name') ?? 'Agent tabs'
      const m = ctx.browser.state.model
      const existing = Object.values(m.folders).find(
        (f) => f.spaceId === spaceId && f.name.toLowerCase() === name.toLowerCase()
      )
      const folder = existing ?? createFolder(m, spaceId, name, '📁')
      for (const t of members) tabs.moveToFolder(t.id, folder.id)
      ctx.browser.state.commit()
      return text(
        `${existing ? 'Added' : 'Created folder'} ${JSON.stringify(folder.name)} ${existing ? 'to' : 'with'} ${members.length} tab(s): ${members.map((t) => t.id).join(', ')}.\n\n${listing()}`
      )
    }
    if (action === 'ungroup') {
      const ref = pick(args, 'tabId')
      if (ref === undefined) throw new RpcError(-32602, `ungroup needs tabId.\n\n${listing()}`)
      const tab = ctx.agents.claim(s, resolveTabRef(ctx, ref))
      if (!tab.folderId) return text(`Tab ${tab.id} is not in a folder.\n\n${listing()}`)
      tabs.moveToFolder(tab.id, null)
      return text(`Took tab ${tab.id} out of its folder.\n\n${listing()}`)
    }
    throw new RpcError(-32602, `action must be one of ${TAB_ACTIONS.join(', ')}`)
  }
}

const browserNavigate: AgentTool = {
  definition: {
    name: 'browser_navigate',
    title: 'Navigate',
    description:
      "Load a URL in your current tab (or in tabId – this is also how you change the URL of an existing tab). Plain words are searched with the user's default search engine. Opens a tab for you when you have none. Returns a snapshot of the loaded page. Related: browser_navigate_back, browser_navigate_forward, browser_reload.",
    inputSchema: schema(
      {
        url: { type: 'string', description: 'Full URL (https://…) or search words' },
        tabId: TAB_ID
      },
      ['url']
    ),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const url = resolveUrl(
      ctx,
      need(args, 'url', 'the address to open, e.g. "https://example.com"')
    )
    const s = ctx.session
    const explicit = tabArg(ctx, args)
    let tab: Tab
    if (explicit || s.currentTabId) tab = ctx.agents.resolveTab(s, explicit)
    else {
      const win = ctx.agents.agentWindow()
      tab = ctx.browser.tabs.createTab({ active: s.mode === 'foreground', load: false }, win)
      ctx.agents.claim(s, tab.id)
    }
    await ctx.agents.prepare(s, tab.id)
    ctx.browser.tabs.navigate(tab.id, url)
    const loaded = await ctx.agents.waitForLoad(tab.id, LOAD_TIMEOUT_MS, { expectNavigation: true })
    const view = ctx.browser.tabs.view(tab.id)
    if (!view) throw new RpcError(-32002, 'The tab went away while loading')
    const pos = ctx.agents.cursorPosition(s, tab.id)
    if (pos) await ctx.agents.cursor(s, tab.id, view, pos.x, pos.y, 'show')
    return pageResult(
      ctx,
      tab,
      view,
      `Navigated to ${url}${loaded ? '' : ' (still loading after 15 s – browser_wait_for can wait for content)'}.`
    )
  }
}

const browserNavigateBack: AgentTool = {
  definition: {
    name: 'browser_navigate_back',
    title: 'Go back',
    description:
      "Go back one page in the tab's history (like the Back button) and return a snapshot. Undo with browser_navigate_forward.",
    inputSchema: schema({ tabId: TAB_ID }),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    if (!view.canGoBack())
      return textError(
        `There is no previous page in tab ${tab.id} (it is at the start of its history)`
      )
    ctx.browser.tabs.goBack(tab.id)
    await ctx.agents.waitForLoad(tab.id, LOAD_TIMEOUT_MS, { expectNavigation: true })
    return pageResult(ctx, tab, ctx.browser.tabs.view(tab.id) ?? view, 'Went back.')
  }
}

const browserNavigateForward: AgentTool = {
  definition: {
    name: 'browser_navigate_forward',
    title: 'Go forward',
    description:
      "Go forward one page in the tab's history (like the Forward button, after browser_navigate_back) and return a snapshot.",
    inputSchema: schema({ tabId: TAB_ID }),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    if (!view.canGoForward())
      return textError(
        `There is no next page in tab ${tab.id} – forward only works after going back`
      )
    ctx.browser.tabs.goForward(tab.id)
    await ctx.agents.waitForLoad(tab.id, LOAD_TIMEOUT_MS, { expectNavigation: true })
    return pageResult(ctx, tab, ctx.browser.tabs.view(tab.id) ?? view, 'Went forward.')
  }
}

const browserReload: AgentTool = {
  definition: {
    name: 'browser_reload',
    title: 'Reload',
    description:
      'Reload the current page of the tab (like the Reload button) and return a snapshot. ignoreCache: true forces a fresh download of every resource.',
    inputSchema: schema({
      tabId: TAB_ID,
      ignoreCache: { type: 'boolean', description: 'Hard reload, bypassing the cache' }
    }),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    ctx.browser.tabs.reload(tab.id, bool(args, 'ignoreCache'))
    await ctx.agents.waitForLoad(tab.id, LOAD_TIMEOUT_MS, { expectNavigation: true })
    return pageResult(ctx, tab, ctx.browser.tabs.view(tab.id) ?? view, 'Reloaded.')
  }
}

const browserSnapshot: AgentTool = {
  definition: {
    name: 'browser_snapshot',
    title: 'Page snapshot',
    description:
      "Read the page as an accessibility-style tree (roles, names, values, links). Each element carries a [ref=eN] handle: pass the eN as target to browser_click / browser_type / browser_hover / browser_select_option / browser_take_screenshot. Prefer this over screenshots for finding things to act on; refs stay valid until the element leaves the page. For long pages use filter or interactiveOnly; boxes adds each element's viewport rectangle when you need coordinates.",
    inputSchema: schema({
      tabId: TAB_ID,
      filter: { type: 'string', description: 'Only lines containing this text (case-insensitive)' },
      interactiveOnly: { type: 'boolean', description: 'Only links, buttons, fields and headings' },
      boxes: {
        type: 'boolean',
        description: "Append each element's viewport rectangle as [box=x,y,width,height] (CSS px)"
      },
      maxChars: {
        type: 'number',
        description: 'Truncate the tree after this many characters (default 30000)'
      }
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    return pageResult(ctx, tab, view, 'Snapshot taken.', {
      filter: str(args, 'filter') ?? null,
      interactiveOnly: bool(args, 'interactiveOnly'),
      boxes: bool(args, 'boxes'),
      maxChars: num(args, 'maxChars')
    })
  }
}

const browserClick: AgentTool = {
  definition: {
    name: 'browser_click',
    title: 'Click',
    description: `Click an element (target) or a point (x, y). Scrolls the element into view, moves your cursor there and clicks; returns a snapshot afterwards. ${XY_NOTE}`,
    inputSchema: schema({
      target: TARGET,
      x: { type: 'number', description: 'Viewport x in CSS px (with y, instead of target)' },
      y: { type: 'number', description: 'Viewport y in CSS px (with x, instead of target)' },
      tabId: TAB_ID,
      doubleClick: { type: 'boolean' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['Shift', 'Control', 'Alt', 'Meta'] }
      }
    }),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    const { loc, target } = await locateArg(ctx, view, args, 'browser_click')
    if (loc.disabled)
      return textError(`${describeElement(loc)} is disabled, so it cannot be clicked`)
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'move')
    await sleep(ctx.agents.settings.showCursor ? 260 : 30)
    const button =
      (str(args, 'button')?.toLowerCase() as 'left' | 'right' | 'middle' | undefined) ?? 'left'
    const how = await clickAt(ctx, view, loc, target ?? loc.ref ?? '', {
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
    const where = target ? '' : ` at (${loc.x}, ${loc.y})`
    return pageResult(ctx, tab, current, `Clicked ${describeElement(loc)}${where}${note}.`)
  }
}

const browserHover: AgentTool = {
  definition: {
    name: 'browser_hover',
    title: 'Hover',
    description: `Move the mouse over an element (target) or to a point (x, y) without clicking – opens hover menus, shows tooltips – and return a snapshot with whatever appeared. ${XY_NOTE}`,
    inputSchema: schema({
      target: TARGET,
      x: { type: 'number', description: 'Viewport x in CSS px (with y, instead of target)' },
      y: { type: 'number', description: 'Viewport y in CSS px (with x, instead of target)' },
      tabId: TAB_ID
    }),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    const { loc, target } = await locateArg(ctx, view, args, 'browser_hover')
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'move')
    const how = await hoverAt(ctx, view, loc, target)
    await sleep(350)
    const where = target ? '' : ` at (${loc.x}, ${loc.y})`
    return pageResult(
      ctx,
      tab,
      view,
      `Hovering ${describeElement(loc)}${where}${how === 'synthetic' ? ' (the tab is not on screen, so hover events were dispatched to the page directly)' : ''}.`
    )
  }
}

const browserType: AgentTool = {
  definition: {
    name: 'browser_type',
    title: 'Type text',
    description:
      'Type text into an editable element (text field, textarea, rich editor): clicks it, then enters the text. Replaces the current value unless clear is false. submit: true presses Enter afterwards. Returns a snapshot. Use browser_click for checkboxes and browser_select_option for <select> menus.',
    inputSchema: schema(
      {
        target: TARGET,
        text: { type: 'string', description: 'The text to enter' },
        tabId: TAB_ID,
        submit: { type: 'boolean', description: 'Press Enter after typing' },
        clear: { type: 'boolean', description: 'Replace the existing value (default true)' }
      },
      ['target', 'text']
    ),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const target = need(
      args,
      'target',
      'the field to type into: a ref like "e12" from browser_snapshot, a CSS selector, or "text=Label"'
    )
    const raw = pick(args, 'text')
    const value = typeof raw === 'string' ? raw : raw === undefined ? '' : String(raw)
    const { tab, view } = await actOn(ctx, args)
    const loc = await locate(ctx, view, target)
    if (!loc.editable)
      return textError(
        `${describeElement(loc)} is not an editable field${loc.role === 'combobox' ? ' – use browser_select_option to choose an option' : loc.role === 'checkbox' || loc.role === 'radio' ? ' – use browser_click to toggle it' : ''}`
      )
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
      'Press one keyboard key in the page (Enter, Tab, Escape, ArrowDown, PageDown, a, …) with optional modifiers; it goes to the focused element. Returns a snapshot. To enter a whole text use browser_type.',
    inputSchema: schema(
      {
        key: { type: 'string', description: 'Key name (Enter, Escape, ArrowDown, Tab, a, …)' },
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
    const key = normalizeKey(need(args, 'key', 'e.g. "Enter", "Escape", "ArrowDown", "a"'))
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
      'Scroll the page: by a viewport in a direction (default: down), by amount pixels, to an element (target), or to: "top" / "bottom". Returns a snapshot that states the new scroll position. Content that only loads when scrolled into view appears after scrolling.',
    inputSchema: schema({
      tabId: TAB_ID,
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number', description: 'Pixels (default: 80% of the viewport)' },
      target: { ...TARGET, description: 'Scroll this element into view instead' },
      to: {
        type: 'string',
        enum: ['top', 'bottom'],
        description: 'Jump to the top or bottom of the page'
      }
    }),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    let to = str(args, 'to')?.toLowerCase() ?? null
    let direction = str(args, 'direction')?.toLowerCase() ?? null
    if (direction === 'top' || direction === 'bottom') {
      to = direction
      direction = null
    }
    if (direction && !['up', 'down', 'left', 'right'].includes(direction))
      throw new RpcError(
        -32602,
        `direction must be up, down, left or right (got ${JSON.stringify(direction)}); use to: "top"/"bottom" to jump`
      )
    const r = (await ctx.agents.evalPage(
      view,
      pageCall('scroll', ctx.session.id, {
        target: str(args, 'target') ?? null,
        direction,
        amount: num(args, 'amount') ?? null,
        to
      })
    )) as PageActionResult
    if (!r.ok) return textError(r.error ?? 'Could not scroll')
    await sleep(250)
    return pageResult(ctx, tab, view, `Scrolled (now at ${r.scrollY ?? 0}px from the top).`)
  }
}

const browserSelectOption: AgentTool = {
  definition: {
    name: 'browser_select_option',
    title: 'Select option',
    description:
      'Choose option(s) of a <select> drop-down (role combobox in snapshots) by value or visible label. Returns a snapshot.',
    inputSchema: schema(
      {
        target: TARGET,
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Option value(s) or visible label(s); a single string is accepted too'
        },
        tabId: TAB_ID
      },
      ['target', 'values']
    ),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const target = need(
      args,
      'target',
      'the <select> element: a ref like "e12", a CSS selector, or "text=Label"'
    )
    const values = strings(args, 'values')
    if (!values.length)
      throw new RpcError(-32602, 'values must list at least one option value or label')
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
      'Take a screenshot and return it as an image. Default: the visible viewport. fullPage: true captures the whole scrollable page in one image; target captures just that element (a ref from browser_snapshot or a CSS selector). Use browser_snapshot to find elements to act on; screenshots are for checking layout and images.',
    inputSchema: schema({
      tabId: TAB_ID,
      fullPage: { type: 'boolean', description: 'Capture the entire page, not only the viewport' },
      target: { ...TARGET, description: 'Capture only this element (ref, CSS selector or text=…)' },
      type: { type: 'string', enum: ['jpeg', 'png'], description: 'Image format (default jpeg)' }
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view } = await actOn(ctx, args)
    const format = str(args, 'type')?.toLowerCase() === 'png' ? 'png' : 'jpeg'
    const target = str(args, 'target')
    const fullPage = bool(args, 'fullPage')
    const current = ctx.browser.tabs.tab(tab.id) ?? tab
    let cap: (AgentCapture & { kind: string }) | null = null
    let kind = 'viewport'
    let note = ''
    // The agent's own cursor overlay is UI for the user, not page content: keep it out of the image.
    const overlays = (visible: boolean): Promise<unknown> =>
      ctx.agents
        .evalPage(
          view,
          `for (const el of document.querySelectorAll('[data-zen-agent="cursor"],[data-zen-agent="ripple"]')) el.style.visibility = ${visible ? "''" : "'hidden'"}`
        )
        .catch(() => undefined)
    await overlays(false)
    try {
      cap = await captureFor(ctx, view, { target, fullPage, format })
      if (cap) kind = cap.kind
      else if (!view.capture && (target || fullPage))
        note = ` Note: this host can only capture the visible viewport, so the ${target ? 'target' : 'fullPage'} option was ignored${target ? ' – browser_scroll {"target":…} brings it into view first' : ''}.`
    } finally {
      await overlays(true)
    }
    if (!cap) {
      const dataUrl = await view.snapshot()
      if (!dataUrl)
        return textError(
          'The page could not be captured (a hidden tab may have nothing painted yet – try zen_mode foreground)'
        )
      const comma = dataUrl.indexOf(',')
      const mimeType = /^data:([^;]+)/.exec(dataUrl)?.[1] ?? 'image/jpeg'
      return {
        content: [
          {
            type: 'text',
            text: `Screenshot (viewport) of ${JSON.stringify(current.title)} – ${current.url} (tab ${current.id}).${note}`
          },
          { type: 'image', data: dataUrl.slice(comma + 1), mimeType }
        ]
      }
    }
    return {
      content: [
        { type: 'text', text: describeCapture(kind, cap, current) + note },
        { type: 'image', data: cap.data, mimeType: cap.mimeType }
      ]
    }
  }
}

/** Capture what the agent asked for through the host's `capture`, if it has one. */
async function captureFor(
  ctx: ToolContext,
  view: TabView,
  opts: { target?: string; fullPage: boolean; format: 'jpeg' | 'png' }
): Promise<(AgentCapture & { kind: string }) | null> {
  if (!view.capture) return null
  const { target, fullPage, format } = opts
  if (target) {
    const loc = await locate(ctx, view, target)
    const scroll = (await ctx.agents
      .evalPage(view, '({x: window.scrollX, y: window.scrollY})')
      .catch(() => ({ x: 0, y: 0 }))) as { x: number; y: number }
    const pad = 2
    const cap = await view.capture({
      mode: 'region',
      format,
      region: {
        x: Math.max(0, loc.x - loc.width / 2 + scroll.x - pad),
        y: Math.max(0, loc.y - loc.height / 2 + scroll.y - pad),
        width: loc.width + 2 * pad,
        height: loc.height + 2 * pad
      }
    })
    return cap && { ...cap, kind: `element ${describeElement(loc)}` }
  }
  if (fullPage) {
    const cap = await view.capture({ mode: 'fullPage', format })
    return cap && { ...cap, kind: 'full page' }
  }
  const cap = await view.capture({ mode: 'viewport', format })
  return cap && { ...cap, kind: 'viewport' }
}

const browserReadPage: AgentTool = {
  definition: {
    name: 'browser_read_page',
    title: 'Read page text',
    description:
      'The readable text of the page as plain text: the article (title, byline, body) when the page looks like one, otherwise all visible text. Much cheaper than a snapshot when you only need to read or answer questions about the content; use browser_snapshot when you need to click or type.',
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
      'Wait until text appears (text) or disappears (textGone), until a CSS selector matches (selector), or simply for a number of seconds (time). Returns a snapshot.',
    inputSchema: schema({
      tabId: TAB_ID,
      text: { type: 'string', description: 'Wait until this text is on the page' },
      textGone: { type: 'string', description: 'Wait until this text is gone from the page' },
      selector: { type: 'string', description: 'Wait until this CSS selector matches an element' },
      time: { type: 'number', description: 'Seconds to wait unconditionally (max 30)' },
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
      text: typeof args.text === 'string' && args.text ? args.text : null,
      textGone: str(args, 'textGone') ?? null,
      selector: str(args, 'selector') ?? null
    }
    if (time !== undefined && !conditions.text && !conditions.textGone && !conditions.selector) {
      await sleep(Math.min(Math.max(time, 0), 30) * 1000)
      return pageResult(ctx, tab, view, `Waited ${Math.min(Math.max(time, 0), 30)} s.`)
    }
    if (!conditions.text && !conditions.textGone && !conditions.selector)
      throw new RpcError(-32602, 'Give one of text, textGone, selector or time (seconds)')
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
      'Run JavaScript in the page and return the JSON-serialised result: an expression ("document.title"), or a function ("() => document.body.dataset.build"). Use it to read attributes, computed values or anything the snapshot does not show.',
    inputSchema: schema(
      {
        expression: {
          type: 'string',
          description:
            'JavaScript expression or arrow function, e.g. "document.querySelectorAll(\'p\').length"'
        },
        tabId: TAB_ID
      },
      ['expression']
    ),
    annotations: { openWorldHint: true }
  },
  async run(ctx, args) {
    const expression = need(args, 'expression', 'the JavaScript to run, e.g. "document.title"')
    const { tab, view } = await actOn(ctx, args)
    const wrapped = wrapScript(expression)
    if ('error' in wrapped) return textError(`Script has a syntax error: ${wrapped.error}`)
    try {
      const result = (await view.executeJavaScript(wrapped.code)) as
        { ok: true; value: string } | { ok: false; error: string }
      if (!result.ok) return textError(`Script threw: ${result.error}`)
      const out = result.value
      return text(
        `Result (tab ${tab.id}):\n${out.length > 20_000 ? out.slice(0, 20_000) + '\n… truncated' : out}`
      )
    } catch (error) {
      return textError(`Script failed: ${(error as Error).message}`)
    }
  }
}

/**
 * Agents send expressions (`document.title`), arrow functions (`() => …`) and plain statement
 * lists (`history.forward(); 'done'`) alike. Work out which one parses (the main process speaks
 * the same JavaScript as the page) and wrap it so the page reports exceptions as data instead of
 * Electron's opaque "script failed to execute".
 */
export function wrapScript(source: string): { code: string } | { error: string } {
  const body = (inner: string): string =>
    `(async () => { try { ${inner} const __v = typeof __r === 'function' ? await __r() : await __r; let __s; try { __s = JSON.stringify(__v) } catch (e) { __s = String(__v) } return { ok: true, value: __s === undefined ? 'undefined' : __s } } catch (e) { return { ok: false, error: String((e && e.message) || e) } } })()`
  const asExpression = `const __r = (${source}\n);`
  const asStatements = `const __r = await (async () => { ${source}\n })();`
  for (const inner of [asExpression, asStatements]) {
    try {
      // Parsing only: the function is never called here.
      new Function(`return ${body(inner)}`)
      return { code: body(inner) }
    } catch {
      /* try the next shape */
    }
  }
  try {
    new Function(source)
  } catch (error) {
    return { error: (error as Error).message }
  }
  return { error: 'could not parse the script' }
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
  browserNavigateForward,
  browserReload,
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
    '- Call zen_status first: it tells you your name and colour, your mode, the spaces, every open tab (position, id, title, URL) and which agent drives which tab.',
    '- Open your own tab with browser_tabs {"action":"new","url":"…"} (or just browser_navigate) instead of taking over tabs you do not own. Tabs driven by another agent are refused. Page tools act on your current tab unless you pass tabId (an id, a unique id prefix, or the tab\'s position in the list).',
    '- browser_snapshot returns the page as an accessibility tree whose elements carry [ref=eN] handles; pass the eN as target to browser_click, browser_type, browser_hover, browser_select_option and browser_take_screenshot. target also takes a CSS selector or text=Visible label, and browser_click / browser_hover take x,y viewport coordinates instead. Every action returns a fresh snapshot.',
    '- Navigation: browser_navigate (also changes the URL of an existing tab via tabId), browser_navigate_back, browser_navigate_forward, browser_reload. Tabs: browser_tabs list / new / select / close / move (reorder) / group (folder) / ungroup.',
    '- browser_read_page is the cheap way to read an article; browser_take_screenshot (viewport, fullPage: true, or target for one element) only when the layout or an image matters.',
    `- You start in ${mode.toUpperCase()} mode. Foreground: your tab is brought in front of the user before each action and a cursor with your name shows what you do. Background: you work in your tabs without changing what the user sees. Switch with zen_mode.`,
    '- browser_navigate accepts URLs or search words. Use zen_spaces to keep your work in its own space when it is more than a quick lookup.',
    allowScripts
      ? '- browser_evaluate runs JavaScript in the page (an expression or an arrow function) when nothing else does the job, e.g. to read attributes.'
      : '- Running scripts in pages is disabled by the user.'
  ].join('\n')
}
