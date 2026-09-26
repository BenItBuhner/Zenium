import type { AgentMode, Folder, Space, Tab } from '../../shared/types'
import { buildSearchUrl } from '../../shared/search'
import { inputToUrl } from '../../shared/url'
import type { Browser } from '../browser'
import { folderTabs } from '../model'
import type { AgentCapture, InputModifier, TabView } from '../platform'
import {
  deepSnapshot,
  frameAction,
  locateAtPoint,
  locateTarget,
  type DeepSnapshot,
  type FramePage,
  type Located
} from './frames'
import { summarize } from './diagnostics'
import { RpcError, UNAUTHORIZED } from './jsonrpc'
import { pageCall, type PageLocation } from './page'
import type { JsonSchema, ToolDefinition, ToolResult } from './protocol'
import type { AgentService, AgentSession } from './service'
import {
  describeIdle,
  FOREGROUND_LEASE_MS,
  GHOST_IDLE_MS,
  looksLikeStatements,
  sleep,
  textError,
  titleOf
} from './util'
import type { ZenWindow } from '../window'

export { looksLikeStatements }

/**
 * The tools agents see. Page tools use the vocabulary agents already know from Playwright MCP
 * (`browser_navigate`, `browser_snapshot` with `[ref=eN]` handles, `browser_click`, …); the
 * `zen_*` tools expose what makes this browser different: tab groups an agent owns, spaces,
 * sessions, agent modes and who is doing what.
 *
 * Several agents and the user share one browser, so nothing here is implicit: every page tool
 * names its tab by id (there is no current tab), list positions are refused because they shift
 * under other agents, and a tab outside the caller's groups is reached only with an explicit
 * `allowForeign: true` – never another live agent's.
 *
 * Small models get the vocabulary slightly wrong all the time (`ref` for `target`, `function`
 * for `expression`, `switch` for `select`, `[ref=e12]` for `e12`, `folder` for `groupId`…).
 * Every argument therefore has aliases, tabs resolve by id or unique id prefix, and every error
 * says what would have worked.
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
const LEASE_SECONDS = Math.round(FOREGROUND_LEASE_MS / 1000)

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/** Other names agents use for an argument (Playwright MCP's vocabulary and common guesses). */
export const ARG_ALIASES: Record<string, string[]> = {
  target: ['ref', 'selector', 'element', 'locator', 'css', 'elementRef'],
  tabId: ['tab', 'tab_id', 'id', 'index', 'tabIndex'],
  tabIds: ['tabs', 'tab_ids', 'ids'],
  groupId: ['group', 'group_id', 'folder', 'folderId', 'folder_id'],
  allowForeign: ['foreign', 'allow_foreign', 'outside', 'allowOutside'],
  closeTabs: ['close_tabs', 'closeAll', 'close_all'],
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
  name: ['title', 'folderName', 'groupName', 'newName', 'new_name'],
  space: ['spaceId', 'space_id', 'workspace'],
  spaceId: ['space', 'space_id', 'workspace'],
  maxChars: ['max_chars', 'limit', 'maxLength'],
  filter: ['search', 'contains', 'query'],
  interactiveOnly: ['interactive', 'interactive_only'],
  time: ['seconds', 'duration', 'wait'],
  textGone: ['text_gone', 'gone', 'disappears'],
  ignoreCache: ['hard', 'ignore_cache', 'bypassCache'],
  background: ['inBackground', 'hidden'],
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
    'Which tab: its id from browser_tabs list ("tab_3f9a…"; a unique prefix is enough). Required unless you own exactly one tab – there is no current tab. List positions (1, 2, …) are refused: they shift whenever anyone opens or closes a tab. A tab outside your groups needs allowForeign: true; another live agent\'s tabs are never available.'
}
const ALLOW_FOREIGN = {
  type: 'boolean',
  description:
    "Act on a tab outside your groups – the user's, or one in an orphaned agent group – because the user asked you to. Never another live agent's tab; the user's Essentials and pinned tabs are never closed, moved or grouped; the tab does not become yours."
}
const GROUP_ID = {
  type: 'string',
  description:
    'One of your groups: its id from zen_groups list (a unique prefix or its exact name works too), or "home" for your home group.'
}
const TARGET = {
  type: 'string',
  description:
    'Which element: a ref from your latest browser_snapshot ("e12" – also accepted as "[ref=e12]"), a CSS selector ("#login", "button.primary"), or "text=Sign in" for an element by its visible text.'
}
const XY_NOTE =
  'Alternatively give x and y (CSS pixels from the top-left of the viewport, as reported by the viewport size in snapshots) instead of target.'
/** The migration line every page tool carries. */
const PAGE_CHANGED =
  'Changed: tabId is required (there is no current tab; it may be omitted only while you own exactly one tab), list positions are refused, and a tab outside your groups needs allowForeign: true.'

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  // Deliberately not `additionalProperties: false`: a client that validates would then reject
  // the aliases above before the server can understand them.
  return { type: 'object', properties, required }
}

/** A page tool's properties: its own first, then the tab it acts on. */
function pageSchema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return schema({ ...properties, tabId: TAB_ID, allowForeign: ALLOW_FOREIGN }, required)
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
  page: FramePage
}

function yourTabs(ctx: ToolContext): string {
  const own = ctx.agents.ownedTabs(ctx.session)
  return own.length
    ? `Your tabs: ${own.map((t) => `${t.id} ${JSON.stringify(titleOf(t).slice(0, 40))}`).join(', ')}.`
    : 'You have no tabs yet.'
}

/**
 * The tab a tool acts on: the `tabId` the agent named (id or unique prefix; foreign only with
 * `allowForeign`), or – the compatibility path – the one tab the session owns when it owns
 * exactly one. Anything else is an error that lists the session's tabs with their ids.
 */
export function targetTab(ctx: ToolContext, args: Record<string, unknown>): Tab {
  const raw = pick(args, 'tabId')
  if (raw !== undefined) return ctx.agents.resolveTab(ctx.session, raw, bool(args, 'allowForeign'))
  const own = ctx.agents.ownedTabs(ctx.session)
  if (own.length === 1) return own[0]
  if (!own.length)
    throw new RpcError(
      -32602,
      'You have no tab yet – browser_tabs {"action":"new","url":"…"} opens one in your group and returns its id; pass that id as tabId. (browser_navigate opens one for you as well.)'
    )
  throw new RpcError(
    -32602,
    `tabId is required: you own ${own.length} tabs and there is no current tab. ${yourTabs(ctx)}`
  )
}

async function actOn(ctx: ToolContext, args: Record<string, unknown>): Promise<Target> {
  const tab = targetTab(ctx, args)
  const view = await ctx.agents.prepare(ctx.session, tab.id)
  return { tab, view, page: framePage(ctx, tab.id, view) }
}

/**
 * The page as the frame orchestration (`frames.ts`) sees it: the top document is reached the
 * usual way (the isolated world where the host has one), a sub-frame through the host's
 * frame-addressed `executeJavaScript`, and the agent's frame bookkeeping for the tab comes along.
 */
export function framePage(ctx: ToolContext, tabId: string, view: TabView): FramePage {
  return {
    eval: (frameId, code) =>
      frameId === 0 ? ctx.agents.evalPage(view, code) : view.executeJavaScript(code, frameId),
    frames: () => view.frames?.() ?? null,
    agent: ctx.session.id,
    state: ctx.agents.frameState(ctx.session, tabId)
  }
}

async function snapshot(page: FramePage, opts: SnapshotOpts = {}): Promise<DeepSnapshot> {
  return deepSnapshot(page, {
    filter: opts.filter ?? null,
    interactiveOnly: Boolean(opts.interactiveOnly),
    boxes: Boolean(opts.boxes),
    maxChars: Math.min(Math.max(opts.maxChars ?? SNAPSHOT_MAX_CHARS, 500), 200_000)
  })
}

interface SnapshotOpts {
  filter?: string | null
  interactiveOnly?: boolean
  boxes?: boolean
  maxChars?: number
}

function describeTab(ctx: ToolContext, tab: Tab): string {
  const s = ctx.session
  const owner = ctx.agents.describeOwner(s, tab) ?? "the user's, with allowForeign"
  const why = ctx.agents.degradedBecause(s)
  const how =
    s.mode === 'background'
      ? 'background mode'
      : why === 'lease'
        ? 'foreground mode, acted in background – another agent holds the screen'
        : why === 'screen'
          ? 'foreground mode, acted in background – the screen was not taken'
          : 'foreground mode'
  return `${tab.id} (${owner}; ${how})`
}

/** The standard answer after an action: what happened, then a fresh snapshot of the page. */
async function pageResult(
  ctx: ToolContext,
  tab: Tab,
  view: TabView,
  headline: string,
  opts: SnapshotOpts = {}
): Promise<ToolResult> {
  let snap: DeepSnapshot
  try {
    snap = await snapshot(framePage(ctx, tab.id, view), opts)
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

/**
 * Where a target is, in top-viewport coordinates, whichever frame it lives in (a ref goes to
 * the frame that issued it; selectors and text are looked up in every frame of the last
 * snapshot). Throws a clear error when nothing matches.
 */
function locate(page: FramePage, target: string): Promise<Located> {
  return locateTarget(page, target, true)
}

/** `target` or a point: what the tool should act on, with a helpful error when neither is given. */
async function locateArg(
  page: FramePage,
  args: Record<string, unknown>,
  tool: string
): Promise<{ loc: Located; target: string | null }> {
  const target = str(args, 'target')
  if (target) return { loc: await locate(page, target), target }
  const p = point(args)
  if (p) return { loc: await locateAtPoint(page, p), target: null }
  throw new RpcError(
    -32602,
    `${tool} needs a "target" (a ref like "e12" from browser_snapshot, a CSS selector, or "text=Visible label") or viewport coordinates "x" and "y"`
  )
}

function describeElement(loc: PageLocation & { frameLabel?: string | null }): string {
  const frame = loc.frameLabel ? ` in frame ${JSON.stringify(cutName(loc.frameLabel))}` : ''
  return `${loc.role}${loc.name ? ` "${cutName(loc.name)}"` : ''}${loc.ref ? ` [ref=${loc.ref}]` : ''}${frame}`
}

function cutName(name: string): string {
  return name.length > 60 ? name.slice(0, 59) + '…' : name
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
 * How long a foreground tool waits for the page to come on screen before it degrades: long
 * enough for a cold start's first layout report to place the view (the sign-in smoke of #151
 * saw it arrive late on a busy runner), short enough not to stall an agent on a tab the user
 * keeps covered.
 */
export const ON_SCREEN_WAIT_MS = 2000
let onScreenWaitMs = ON_SCREEN_WAIT_MS

/** Test seam: the degraded path without a real two-second wait. */
export function setOnScreenWaitMsForTests(ms: number): void {
  onScreenWaitMs = ms
}

/**
 * Whether the tab's view is placed where the user sees it: shown, placed by the chrome's last
 * layout report, and with no chrome covering the content area (the URL bar, a menu, a dialog –
 * anything the report flags as `contentHidden`). Only such a view hit-tests real input – and only
 * once its page has painted, which is the host's to know (`waitInputReady`).
 */
function isOnScreen(win: ZenWindow, view: TabView, tabId: string): boolean {
  return view.isVisible() && !win.contentHidden && win.viewRect(tabId) !== null
}

/** What keeps a page from taking real input, or null when nothing does. */
type NotReady = 'off screen' | 'unpainted'

/**
 * Waits, within `ON_SCREEN_WAIT_MS`, for the page to take real input: its view on screen, and
 * its renderer past its first paint (`TabView.hasPainted`, asked only once the view is placed).
 * The second matters because Chromium holds a new page's first frame back until it has content
 * or 500 ms of frames have gone by, and while it does its renderer drops presses and keys but
 * acknowledges them – a click sent to a loaded, placed, unpainted page is lost without a trace.
 * On a cold runner without a GPU the display compositor takes seconds to start, no frame moves
 * the 500 ms along, and that is what the sign-in smoke's `browser_click` ran into: "Clicked",
 * and the button's handler never ran.
 */
async function waitInputReady(
  ctx: ToolContext,
  tabId: string,
  view: TabView
): Promise<NotReady | null> {
  const win = ctx.browser.tabs.windowFor(tabId)
  const deadline = Date.now() + onScreenWaitMs
  for (;;) {
    const placed = isOnScreen(win, view, tabId)
    if (placed && (!view.hasPainted || (await view.hasPainted()))) return null
    if (Date.now() >= deadline) return placed ? 'unpainted' : 'off screen'
    await sleep(Math.min(60, Math.max(1, deadline - Date.now())))
  }
}

/** The way a tool delivers input, decided before it acts (see `routeInput`). */
export interface InputRouting {
  /** Real, trusted input through the host; false is the synthetic in-page path. */
  trusted: boolean
  /** The warning the tool result carries when the input was synthetic, else null. */
  note: string | null
}

export function syntheticInputNote(cause: string): string {
  return `input: synthetic – ${cause}, so the event was dispatched as a scripted DOM event instead of real input. It is untrusted (isTrusted: false) and armed no user gesture: a pop-up, download or permission prompt it would have opened did not fire. Real input needs the tab on screen and painted: foreground mode with the screen lease, no URL bar or other chrome overlay covering the page, and the page's first frame shown.`
}

/**
 * Real input – a trusted OS-level event Chromium routes to the frame under the point, cross-origin
 * iframes included, that counts as a user gesture – only works on a painted, on-screen view. This
 * decides the path once per tool call and never degrades silently: background mode is synthetic
 * by design (the agent asked to keep the tab off screen), and so is a foreground call that had to
 * run in the background because another agent holds the screen lease; otherwise the tool waits
 * up to `ON_SCREEN_WAIT_MS` for the chrome to place the view and drop any overlay and for the
 * page to paint its first frame, and if the page is still not on screen or still unpainted – or
 * another element covers the point, where a real click would hit that element instead – it takes
 * the synthetic path and says so in the result.
 *
 * Both paths reach into cross-origin iframes: trusted input is sent at top-viewport coordinates
 * and the host routes it to the frame under the point; synthetic input runs the page runtime
 * inside the frame the element belongs to (`Located.frameId`).
 */
export async function routeInput(
  ctx: ToolContext,
  tabId: string,
  view: TabView,
  loc?: PageLocation
): Promise<InputRouting> {
  if (!view.sendInput)
    return { trusted: false, note: syntheticInputNote('this browser cannot send real input') }
  if (ctx.session.mode === 'background')
    return {
      trusted: false,
      note: syntheticInputNote('you are in background mode and the tab is kept off screen')
    }
  const why = ctx.agents.degradedBecause(ctx.session)
  if (why === 'lease')
    return {
      trusted: false,
      note: syntheticInputNote(
        'another agent holds the screen, so this call ran in the background and the tab stayed off screen'
      )
    }
  if (why === 'screen')
    return {
      trusted: false,
      note: syntheticInputNote(
        'the tab is not what the user is looking at and you have not taken the screen (zen_mode {"mode":"foreground","takeScreen":true}), so this call ran in the background and the tab stayed off screen'
      )
    }
  const notReady = await waitInputReady(ctx, tabId, view)
  const seconds = Math.round(onScreenWaitMs / 1000)
  if (notReady === 'off screen')
    return {
      trusted: false,
      note: syntheticInputNote(
        `the tab did not come on screen within ${seconds} s (chrome such as the URL bar covers the page, or another tab is in front)`
      )
    }
  if (notReady === 'unpainted')
    return {
      trusted: false,
      note: syntheticInputNote(
        `the page had not painted its first frame within ${seconds} s (its renderer drops real clicks and keys until it has; give it a moment and try again)`
      )
    }
  if (loc?.covered)
    return {
      trusted: false,
      note: syntheticInputNote(
        'another element covers this point, so real input would have hit that element'
      )
    }
  return { trusted: true, note: null }
}

/** The tool's headline plus the synthetic-input warning line when the input was not real. */
function withInputNote(headline: string, routing: InputRouting): string {
  return routing.trusted || !routing.note ? headline : `${headline}\n${routing.note}`
}

async function clickAt(
  page: FramePage,
  view: TabView,
  loc: Located,
  target: string,
  opts: { button: 'left' | 'right' | 'middle'; count: number; modifiers: InputModifier[] },
  trusted: boolean
): Promise<'trusted' | 'synthetic'> {
  if (trusted && view.sendInput) {
    await view.sendInput({
      type: 'click',
      x: loc.x,
      y: loc.y,
      button: opts.button,
      clickCount: opts.count,
      modifiers: opts.modifiers
    })
    return 'trusted'
  }
  const r = await frameAction(
    page,
    loc.frameId,
    pageCall('clickJs', page.agent, target, opts.count)
  )
  if (!r.ok) throw new RpcError(-32602, r.error ?? 'Click failed')
  return 'synthetic'
}

/** Move the pointer over an element: real input when routed so, synthetic in-page events otherwise. */
async function hoverAt(
  page: FramePage,
  view: TabView,
  loc: Located,
  target: string | null,
  trusted: boolean
): Promise<'trusted' | 'synthetic'> {
  if (trusted && view.sendInput) {
    await view.sendInput({ type: 'mouseMove', x: loc.x, y: loc.y })
    return 'trusted'
  }
  // The frame's runtime speaks its own viewport: hand it the point in those coordinates.
  const r = await frameAction(
    page,
    loc.frameId,
    pageCall('hoverJs', page.agent, target, loc.local.x, loc.local.y)
  )
  if (!r.ok) throw new RpcError(-32602, r.error ?? 'Hover failed')
  return 'synthetic'
}

/** The frame holding the keyboard focus (the top document when the host cannot tell). */
function focusedFrame(page: FramePage): number {
  return page.frames()?.find((f) => f.focused)?.id ?? 0
}

async function pressKey(
  page: FramePage,
  view: TabView,
  key: string,
  mods: InputModifier[],
  trusted: boolean
): Promise<void> {
  if (trusted && view.sendInput) {
    await view.sendInput({ type: 'key', key, modifiers: mods })
    return
  }
  const r = await frameAction(page, focusedFrame(page), pageCall('keyJs', key, mods))
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
  return buildSearchUrl(ctx.browser.state.defaultSearchEngine(), input.trim())
}

function folderOf(ctx: ToolContext, t: Tab): Folder | null {
  return t.folderId ? (ctx.browser.state.model.folders[t.folderId] ?? null) : null
}

function spaceOf(ctx: ToolContext, spaceId: string | null): Space | undefined {
  return spaceId ? ctx.browser.state.model.spaces.find((sp) => sp.id === spaceId) : undefined
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

const NO_GROUPS =
  '(no groups yet – browser_tabs {"action":"new","url":"…"} makes your home group and opens a tab in it)'

/** One tab, as listings show it: id, title, URL and what matters about it in brackets. */
function tabLine(ctx: ToolContext, t: Tab, scope: 'own' | 'all'): string {
  const flags: string[] = []
  if (t.essential) flags.push('essential')
  else if (t.pinned) flags.push('pinned')
  const folder = folderOf(ctx, t)
  if (folder && scope === 'all') flags.push(`group: ${JSON.stringify(folder.name)}`)
  if (t.discarded) flags.push('unloaded')
  if (scope === 'all') {
    const owner = ctx.agents.describeOwner(ctx.session, t)
    if (owner) flags.push(owner)
    if (ctx.browser.tabs.activeTabFor(ctx.agents.agentWindow())?.id === t.id)
      flags.push("user's active tab")
  }
  return `- ${t.id} ${JSON.stringify(titleOf(t).slice(0, 80))} ${t.url}${flags.length ? ` [${flags.join(', ')}]` : ''}`
}

/** Who a group belongs to, as listings say it; null for the caller's own. */
function groupOwnerLabel(ctx: ToolContext, g: Folder): string | null {
  const owner = ctx.agents.groupOwner(g.id)
  if (owner)
    return owner.id === ctx.session.id
      ? 'yours'
      : `owned by ${JSON.stringify(owner.name)}${ctx.agents.ghostLabel(owner)}`
  if (ctx.agents.isOrphan(g.id)) {
    const was = ctx.agents.orphanWas(g.id)
    return was ? `orphaned, was ${JSON.stringify(was)}` : 'orphaned'
  }
  return "the user's"
}

function groupHeader(ctx: ToolContext, g: Folder, scope: 'own' | 'all'): string {
  const m = ctx.browser.state.model
  const flags: string[] = []
  if (g.id === ctx.session.homeGroupId) flags.push('home')
  if (scope === 'all') {
    const owner = groupOwnerLabel(ctx, g)
    if (owner) flags.push(owner)
  }
  const n = folderTabs(m, g.id).length
  return `Group ${JSON.stringify(g.name)} (${g.id})${flags.length ? ` [${flags.join(', ')}]` : ''} in space ${JSON.stringify(spaceOf(ctx, g.spaceId)?.name ?? '?')} – ${n} tab${n === 1 ? '' : 's'}:`
}

function groupMembers(ctx: ToolContext, g: Folder): Tab[] {
  return folderTabs(ctx.browser.state.model, g.id).filter((t) => !ctx.browser.tabs.isPrivate(t))
}

/** The session's groups with their tabs, the home group first. */
export function listOwnTabs(ctx: ToolContext): string {
  const groups = ctx.agents.groupsOf(ctx.session)
  if (!groups.length) return NO_GROUPS
  const lines: string[] = []
  for (const g of groups) {
    lines.push(groupHeader(ctx, g, 'own'))
    const tabs = groupMembers(ctx, g)
    if (!tabs.length) lines.push('  (empty)')
    for (const t of tabs) lines.push(tabLine(ctx, t, 'own'))
  }
  return lines.join('\n')
}

/** One group's tabs under its header. */
export function listGroupTabs(ctx: ToolContext, g: Folder): string {
  const lines = [groupHeader(ctx, g, 'all')]
  const tabs = groupMembers(ctx, g)
  if (!tabs.length) lines.push('  (empty)')
  for (const t of tabs) lines.push(tabLine(ctx, t, 'all'))
  return lines.join('\n')
}

/** Every tab agents may see, the way the sidebar shows them: Essentials, then each space. */
export function listAllTabs(ctx: ToolContext): string {
  const tabs = ctx.agents.sidebarOrder(ctx.agents.visibleTabs())
  if (!tabs.length)
    return '(no tabs – open one with browser_tabs {"action":"new","url":"…"} or browser_navigate)'
  const m = ctx.browser.state.model
  const win = ctx.agents.agentWindow()
  const lines: string[] = []
  const essentials = tabs.filter((t) => t.essential)
  if (essentials.length) {
    lines.push('Essentials:')
    for (const t of essentials) lines.push(tabLine(ctx, t, 'all'))
  }
  for (const sp of m.spaces) {
    const inSpace = tabs.filter((t) => !t.essential && t.spaceId === sp.id)
    if (!inSpace.length && m.spaces.length === 1) continue
    lines.push(
      `Space ${JSON.stringify(sp.name)} (${sp.id})${sp.id === win.activeSpaceId ? ' [shown to the user]' : ''}:`
    )
    if (!inSpace.length) lines.push('  (empty)')
    for (const t of inSpace) lines.push(tabLine(ctx, t, 'all'))
  }
  const rest = tabs.filter((t) => !t.essential && !m.spaces.some((sp) => sp.id === t.spaceId))
  if (rest.length) {
    lines.push('Other tabs:')
    for (const t of rest) lines.push(tabLine(ctx, t, 'all'))
  }
  if (!lines.length) for (const t of tabs) lines.push(tabLine(ctx, t, 'all'))
  return lines.join('\n')
}

function listSpaces(ctx: ToolContext): string {
  const win = ctx.agents.agentWindow()
  return ctx.browser.state.model.spaces
    .map(
      (sp) =>
        `- ${sp.id} ${JSON.stringify(sp.name)} ${sp.icon} – ${sp.tabIds.length} tab(s)${sp.id === win.activeSpaceId ? ' [shown to the user]' : ''}${ctx.agents.isAgentSpace(sp.id) ? ' [agents]' : ''}`
    )
    .join('\n')
}

/** How the screen lease stands for the session, in a sentence. */
function leaseLine(ctx: ToolContext): string {
  const s = ctx.session
  const holder = ctx.agents.leaseHolder(ctx.agents.agentWindow())
  if (s.mode === 'background')
    return holder
      ? `Agent ${JSON.stringify(holder.name)} holds the screen; you work in the background.`
      : 'You work in the background; no agent holds the screen.'
  const screen = ctx.agents.mayTakeScreen(s)
    ? s.takeScreen
      ? 'You took the screen: your actions bring their tab in front of the user.'
      : 'The user set foreground as the default, so your actions bring their tab in front.'
    : 'You have not taken the screen: your actions run in front only on a tab the user is already looking at, otherwise in the background (the result says so) – zen_mode {"mode":"foreground","takeScreen":true} if the user wants your tab in front.'
  if (holder?.id === s.id) return `You hold the screen lease. ${screen}`
  if (holder)
    return `Agent ${JSON.stringify(holder.name)} holds the screen: your foreground actions run in the background until it has been quiet for ${LEASE_SECONDS} s. ${screen}`
  return `No agent holds the screen lease; your first foreground action takes it. ${screen}`
}

/** Orphaned groups a session of the same client name left, for the status and the notices. */
function ownOrphansLine(ctx: ToolContext): string[] {
  const mine = ctx.agents.ownOrphans(ctx.session)
  if (!mine.length) return []
  const m = ctx.browser.state.model
  return [
    '',
    `Orphaned groups left by a session named ${JSON.stringify(ctx.session.name)} – yours from before, most likely: ${mine.map((g) => `${g.id} ${JSON.stringify(g.name)} (${folderTabs(m, g.id).length} tabs)`).join(', ')}. zen_groups {"action":"adopt"} takes them all back; with groupId one of them. Do not open their pages again.`
  ]
}

// ---------------------------------------------------------------------------
// Tools: status, session, groups
// ---------------------------------------------------------------------------

function statusText(ctx: ToolContext): string {
  const s = ctx.session
  const others = ctx.agents.list().filter((a) => a.id !== s.id)
  const server = ctx.agents.serverStatus()
  const own = ctx.agents.ownedTabs(s).length
  const groups = ctx.agents.groupsOf(s).length
  return [
    `You are ${JSON.stringify(s.name)} (session ${s.id}, colour ${s.color}) in ${s.mode} mode. ${leaseLine(ctx)}`,
    '',
    `Your groups (${groups}) and tabs (${own}) – id "title" url [flags]:`,
    listOwnTabs(ctx),
    ...ownOrphansLine(ctx),
    '',
    `Other agents (${others.length}):`,
    ...(others.length
      ? others.map(
          (a) =>
            `- ${JSON.stringify(a.name)} – ${a.mode}, ${a.groupIds.length} group${a.groupIds.length === 1 ? '' : 's'}${a.pending ? ', waiting for approval' : ''}${Date.now() - a.lastActiveAt >= GHOST_IDLE_MS ? `, quiet ${describeIdle(Date.now() - a.lastActiveAt)} – its groups are adoptable` : ''}`
        )
      : ['(none)']),
    '',
    'Spaces:',
    listSpaces(ctx),
    '',
    `Server: ${server.url ?? 'stdio'}${server.running ? '' : ' (not listening)'}; ${summarize(ctx.agents.diagnosticsSnapshot())} (zenium://diagnostics has the JSON). The user's tabs are not listed here: browser_tabs {"action":"list","scope":"all"} shows every tab with its owner.`
  ].join('\n')
}

const zenStatus: AgentTool = {
  definition: {
    name: 'zen_status',
    title: 'Browser status',
    description:
      'Who you are in this browser (name, session id, colour, foreground/background mode, whether you hold the screen), your groups with their tabs (id, title, URL), the other connected agents (name, mode, number of groups), the spaces and the server. Call this first. Changed: it no longer lists the user\'s tabs or a "current tab" – browser_tabs {"action":"list","scope":"all"} shows every tab with its owner, and every page tool takes a tabId.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx) {
    return text(statusText(ctx))
  }
}

const SESSION_ACTIONS = ['status', 'end', 'rename'] as const
type SessionAction = (typeof SESSION_ACTIONS)[number]
const SESSION_ACTION_ALIASES: Record<string, SessionAction> = {
  status: 'status',
  info: 'status',
  whoami: 'status',
  get: 'status',
  end: 'end',
  close: 'end',
  quit: 'end',
  stop: 'end',
  disconnect: 'end',
  finish: 'end',
  rename: 'rename',
  name: 'rename',
  setname: 'rename'
}

const zenSession: AgentTool = {
  definition: {
    name: 'zen_session',
    title: 'Your session',
    description:
      'Your session in this browser. action "status": the same as zen_status. "end": end your session – with closeTabs: true your groups and every tab in them are closed (do this when you are done, unless the user wants the results kept); without it they stay open as orphaned groups another agent can adopt (zen_groups adopt). "rename": change the name shown on your cursor, badges and home group (name).',
    inputSchema: schema(
      {
        action: { type: 'string', enum: [...SESSION_ACTIONS] },
        closeTabs: {
          type: 'boolean',
          description:
            'end: close your groups and their tabs (default: leave them as orphaned groups)'
        },
        name: { type: 'string', description: 'rename: your new name' }
      },
      ['action']
    ),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const raw = (str(args, 'action') ?? 'status').toLowerCase().trim()
    const action = SESSION_ACTION_ALIASES[raw]
    if (!action)
      throw new RpcError(
        -32602,
        `Unknown action ${JSON.stringify(raw)} – use one of ${SESSION_ACTIONS.map((a) => `"${a}"`).join(', ')}`
      )
    const s = ctx.session
    if (action === 'status') return text(statusText(ctx))
    if (action === 'rename') {
      const name = need(args, 'name', 'the new name, e.g. "Research bot"')
      const before = s.name
      ctx.agents.rename(s, name)
      const home = s.homeGroupId ? ctx.browser.state.model.folders[s.homeGroupId] : undefined
      return text(
        `You are ${JSON.stringify(s.name)} now (was ${JSON.stringify(before)}; session ${s.id}).${home ? ` Your home group is ${JSON.stringify(home.name)} (${home.id}).` : ''}`
      )
    }
    const closeTabs = bool(args, 'closeTabs')
    const groups = ctx.agents.groupsOf(s)
    const { groups: n, tabs } = ctx.agents.endSession(s, closeTabs)
    const stays =
      'Your connection stays open: the next call starts a fresh session under the same id (a new home group on first use), so there is nothing to reconnect.'
    if (!n) return text(`Session ended. You had no groups; nothing was left behind. ${stays}`)
    return text(
      closeTabs
        ? `Session ended: your ${n} group${n === 1 ? '' : 's'} and ${tabs} tab${tabs === 1 ? '' : 's'} were closed. ${stays}`
        : `Session ended: your ${n} group${n === 1 ? '' : 's'} with ${tabs} tab${tabs === 1 ? '' : 's'} stay open as orphaned groups (${groups.map((g) => `${g.id} ${JSON.stringify(g.name)}`).join(', ')}) – a later session can take them back with zen_groups {"action":"adopt","groupId":"…"}, or the user closes them. ${stays}`
    )
  }
}

const GROUP_ACTIONS = ['list', 'create', 'rename', 'close', 'adopt'] as const
type GroupAction = (typeof GROUP_ACTIONS)[number]
const GROUP_ACTION_ALIASES: Record<string, GroupAction> = {
  list: 'list',
  ls: 'list',
  show: 'list',
  get: 'list',
  create: 'create',
  new: 'create',
  add: 'create',
  make: 'create',
  open: 'create',
  rename: 'rename',
  name: 'rename',
  close: 'close',
  delete: 'close',
  remove: 'close',
  destroy: 'close',
  adopt: 'adopt',
  claim: 'adopt',
  take: 'adopt',
  takeover: 'adopt',
  resume: 'adopt'
}

const zenGroups: AgentTool = {
  definition: {
    name: 'zen_groups',
    title: 'Your tab groups',
    description: `Your tab groups (Zen folders): every tab of yours sits in one, and a tab is yours because it does. action "list" (scope "own" = your groups with their tabs; "all" = every agent group with its owner and the user's folders); "create" a group (name optional; space: "agents" = the shared Agents space, default; "own" = a new space of your own named after you; a space id opens it in that space – the user's spaces only with allowForeign: true) and get its groupId; "rename" {groupId, name}; "close" {groupId} closes every tab in one of your groups and removes it; "adopt" {groupId} takes over an orphaned group (its agent is gone) with all its tabs – also a group of an agent quiet for over ${Math.round(GHOST_IDLE_MS / 60_000)} min (its client dropped, most likely), and with force: true any other agent's group when the user asked you to take it over (that agent is told); adopt without groupId takes back every orphaned group a session with your name left. Changed: new tool – replaces guessing folders by name; browser_tabs group/ungroup are aliases onto it.`,
    inputSchema: schema(
      {
        action: { type: 'string', enum: [...GROUP_ACTIONS] },
        scope: {
          type: 'string',
          enum: ['own', 'all'],
          description: 'list: "own" (default) or "all"'
        },
        groupId: {
          ...GROUP_ID,
          description:
            'rename / close / adopt: the group (adopt without it: every orphaned group left by a session with your name)'
        },
        force: {
          type: 'boolean',
          description:
            "adopt: take over a connected agent's group because the user asked you to (the agent is told)"
        },
        name: { type: 'string', description: 'create / rename: the group name' },
        space: {
          type: 'string',
          description:
            'create: "agents" (default), "own" (a new space of yours), or a space id (the user\'s spaces need allowForeign: true)'
        },
        allowForeign: {
          ...ALLOW_FOREIGN,
          description: "create: allow the group in one of the user's spaces because the user asked"
        }
      },
      ['action']
    ),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const raw = (str(args, 'action') ?? 'list').toLowerCase().trim()
    const action = GROUP_ACTION_ALIASES[raw]
    if (!action)
      throw new RpcError(
        -32602,
        `Unknown action ${JSON.stringify(raw)} – use one of ${GROUP_ACTIONS.map((a) => `"${a}"`).join(', ')}`
      )
    const s = ctx.session
    const m = ctx.browser.state.model
    if (action === 'list') {
      const scope = (str(args, 'scope') ?? 'own').toLowerCase()
      if (scope === 'all' || scope === 'everyone' || scope === 'everything') {
        const agentGroups = ctx.agents.agentGroups()
        const users = Object.values(m.folders).filter((f) => !agentGroups.includes(f))
        const lines = [
          `Agent groups (${agentGroups.length}):`,
          ...(agentGroups.length
            ? agentGroups.map((g) => listGroupTabs(ctx, g))
            : ['(none – no agent has made a group yet)'])
        ]
        if (users.length) {
          lines.push('', `The user's folders (${users.length}; not yours to use):`)
          for (const f of users) lines.push(groupHeader(ctx, f, 'all'))
        }
        return text(lines.join('\n'))
      }
      return text(`Your groups – id "title" url [flags]:\n${listOwnTabs(ctx)}`)
    }
    if (action === 'create') {
      const groups = ctx.agents.groupsOf(s)
      const name = str(args, 'name') ?? `${s.name} · ${s.id.slice(-4)} · ${groups.length + 1}`
      const where = (str(args, 'space') ?? 'agents').trim()
      let space: Space
      if (where.toLowerCase() === 'agents' || where.toLowerCase() === 'shared')
        space = ctx.agents.agentsSpace()
      else if (where.toLowerCase() === 'own' || where.toLowerCase() === 'mine' || where === 'new')
        space = ctx.agents.createOwnSpace(s)
      else {
        const found =
          m.spaces.find((sp) => sp.id === where) ??
          m.spaces.find((sp) => sp.name.toLowerCase() === where.toLowerCase())
        if (!found)
          throw new RpcError(
            -32602,
            `Unknown space ${JSON.stringify(where)} – use "agents", "own", or an id from zen_spaces list:\n${listSpaces(ctx)}`
          )
        if (!ctx.agents.isAgentSpace(found.id) && !bool(args, 'allowForeign'))
          throw new RpcError(
            UNAUTHORIZED,
            `Space ${found.id} ${JSON.stringify(found.name)} is the user's: a group there is a foreign act. Pass allowForeign: true if the user asked for it, or use space "agents" (the shared Agents space) or "own" (a space of yours).`
          )
        space = found
      }
      const group = ctx.agents.createGroup(s, name, space.id)
      return text(
        `Created group ${group.id} ${JSON.stringify(group.name)} in space ${JSON.stringify(space.name)}. browser_tabs {"action":"new","groupId":"${group.id}","url":"…"} opens tabs in it; browser_tabs move puts tabs of yours into it.\n\nYour groups:\n${listOwnTabs(ctx)}`
      )
    }
    if (action === 'rename') {
      const group = ctx.agents.resolveGroup(s, need(args, 'groupId', 'the group to rename'))
      const name = need(args, 'name', 'the new name')
      const before = group.name
      ctx.agents.renameGroup(s, group, name)
      return text(
        `Renamed group ${group.id} from ${JSON.stringify(before)} to ${JSON.stringify(group.name)}.`
      )
    }
    if (action === 'close') {
      const group = ctx.agents.resolveGroup(s, need(args, 'groupId', 'the group to close'))
      const name = group.name
      const n = ctx.agents.closeGroup(s, group)
      return text(
        `Closed group ${group.id} ${JSON.stringify(name)} and its ${n} tab${n === 1 ? '' : 's'}.\n\nYour groups:\n${listOwnTabs(ctx)}`
      )
    }
    const ref = pick(args, 'groupId')
    if (typeof ref !== 'string' || !ref.trim()) {
      // No group named: every orphaned group a session of this name left is meant.
      const mine = ctx.agents.ownOrphans(s)
      if (mine.length) {
        const taken = mine.map((g) => {
          ctx.agents.adopt(s, g)
          return `${g.id} ${JSON.stringify(g.name)} (${groupMembers(ctx, g).length} tabs)`
        })
        return text(
          `Adopted the ${taken.length} orphaned group${taken.length === 1 ? '' : 's'} a session named ${JSON.stringify(s.name)} left: ${taken.join(', ')}. Refs from before are stale: browser_snapshot before acting.\n\nYour groups:\n${listOwnTabs(ctx)}`
        )
      }
    }
    const force = bool(args, 'force')
    const { folder: group, from } = ctx.agents.resolveOrphan(s, ref, { force })
    const was = from ? ctx.agents.takeOver(s, from, group, force) : ctx.agents.adopt(s, group)
    const n = groupMembers(ctx, group).length
    return text(
      `Adopted group ${group.id} ${JSON.stringify(group.name)}${was ? ` (was ${JSON.stringify(was)}'s${from ? `, ${force ? "taken over with the user's permission" : `an agent quiet for ${describeIdle(ctx.agents.idleFor(from))}`}; it has been told` : ''})` : ''} with ${n} tab${n === 1 ? '' : 's'}${s.homeGroupId === group.id ? '; it is your home group now' : ''}.\n\nYour groups:\n${listOwnTabs(ctx)}`
    )
  }
}

// ---------------------------------------------------------------------------
// Tools: mode and spaces
// ---------------------------------------------------------------------------

const zenMode: AgentTool = {
  definition: {
    name: 'zen_mode',
    title: 'Set your operating mode',
    description: `foreground: your actions happen in front of the user – your cursor shows what you do and input is real – on a tab the user is looking at. With takeScreen: true your actions also bring their tab in front first (the user's space and active tab change – only when the user asked for your work on screen); without it a foreground action on a tab the user is not looking at runs in the background and the result says so. The screen is a lease: the first foreground action takes it, and while another agent holds the lease (active within ${LEASE_SECONDS} s) your calls run in the background and say so. background: you work in your own tabs without changing what the user sees; recommended whenever other agents are connected or the user is browsing. Changed: foreground no longer brings your tab in front by itself – pass takeScreen: true for that (a foreground default the user set in Settings counts as taken).`,
    inputSchema: schema(
      {
        mode: { type: 'string', enum: ['foreground', 'background'] },
        takeScreen: {
          type: 'boolean',
          description:
            'foreground: bring your tab in front of the user before each action (switches the user to its space and tab) – pass true only when the user wants your work on screen'
        }
      },
      ['mode']
    ),
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
    const s = ctx.session
    s.mode = mode
    s.takeScreen = mode === 'foreground' && bool(args, 'takeScreen')
    return text(`You are now in ${mode} mode. ${leaseLine(ctx)}`)
  }
}

const zenSpaces: AgentTool = {
  definition: {
    name: 'zen_spaces',
    title: 'Spaces',
    description: `List, create or switch Zenium spaces (workspaces that group tabs). Your tabs live in your groups in the shared "Agents" space unless you make a space of your own (create – it is not shown to the user until they or you switch to it). switch changes what the user sees and needs the screen lease: foreground mode, with no other agent holding the screen. Changed: create no longer switches the user's window to the new space; switch requires the foreground lease.`,
    inputSchema: schema(
      {
        action: { type: 'string', enum: ['list', 'create', 'switch'] },
        name: { type: 'string', description: 'create: the new space name (default: your name)' },
        icon: { type: 'string', description: 'create: an emoji for the space' },
        spaceId: { type: 'string', description: 'switch: the space to show (id or name)' }
      },
      ['action']
    ),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const action = need(args, 'action', 'use "list", "create" or "switch"').toLowerCase()
    const win = ctx.agents.agentWindow()
    const m = ctx.browser.state.model
    if (action === 'list') return text(`Spaces:\n${listSpaces(ctx)}`)
    if (action === 'create' || action === 'new') {
      const space = ctx.agents.createOwnSpace(ctx.session, {
        name: str(args, 'name'),
        icon: str(args, 'icon')
      })
      return text(
        `Created space ${space.id} ${JSON.stringify(space.name)} (yours; the user's window was not switched to it). zen_groups {"action":"create","space":"${space.id}"} makes a group in it.\n\nSpaces:\n${listSpaces(ctx)}`
      )
    }
    if (action === 'switch' || action === 'select' || action === 'activate') {
      const wanted = need(args, 'spaceId', 'the id (or name) of the space to show')
      const space =
        m.spaces.find((sp) => sp.id === wanted) ??
        m.spaces.find((sp) => sp.name.toLowerCase() === wanted.toLowerCase())
      if (!space)
        throw new RpcError(-32602, `Unknown space ${wanted}.\n\nSpaces:\n${listSpaces(ctx)}`)
      if (ctx.session.mode !== 'foreground')
        throw new RpcError(
          UNAUTHORIZED,
          'Switching the space the user sees needs the screen: you are in background mode. zen_mode {"mode":"foreground","takeScreen":true} first (only if the user wants that) – or leave the user\'s view alone and work in your groups.'
        )
      if (!ctx.agents.mayTakeScreen(ctx.session))
        throw new RpcError(
          UNAUTHORIZED,
          'Switching the space the user sees needs the screen, and you have not taken it: zen_mode {"mode":"foreground","takeScreen":true} first (only if the user wants that) – or leave the user\'s view alone and work in your groups.'
        )
      if (!ctx.agents.foreground(ctx.session, win)) {
        const holder = ctx.agents.leaseHolder(win)
        throw new RpcError(
          UNAUTHORIZED,
          `Switching the space the user sees needs the screen lease, and agent ${JSON.stringify(holder?.name ?? 'another agent')} holds it – try again once it has been quiet for ${LEASE_SECONDS} s, or work in your groups without switching.`
        )
      }
      ctx.browser.tabs.switchSpace(space.id, win)
      return text(
        `Switched to space ${space.id} ${JSON.stringify(space.name)}.\n\nSpaces:\n${listSpaces(ctx)}`
      )
    }
    throw new RpcError(
      -32602,
      `action must be "list", "create" or "switch" (got ${JSON.stringify(action)})`
    )
  }
}

// ---------------------------------------------------------------------------
// Tools: tabs
// ---------------------------------------------------------------------------

const TAB_ACTIONS = ['list', 'new', 'close', 'move', 'select', 'group', 'ungroup'] as const
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
      'Your tabs. action "list": your groups with their tabs (scope "own", default); scope "group" with groupId lists one group; scope "all" lists every tab agents may see – the user\'s, marked [user\'s active tab], other agents\' marked [owned by "name"], and [orphaned] groups whose agent is gone. "new" opens a tab (url optional) in one of your groups – groupId, default your home group, made on first use in the shared Agents space – and returns its id; background: true keeps it out of the user\'s sight; spaceId opens it in the user\'s space and needs allowForeign: true. "close" {tabId} closes a tab of yours (a foreign one only with allowForeign, never an Essential or pinned tab of the user\'s). "move" {tabId, groupId?, index?} moves a tab of yours into another of your groups and/or to a 1-based slot in it. Deprecated aliases: "select" is browser_snapshot {tabId} (there is no current tab); "group" {tabIds, name} makes a group of yours and moves your tabs into it; "ungroup" {tabId} moves a tab of yours to your home group. To change the page a tab shows, call browser_navigate with that tabId. Changed: list has no positions and shows only your tabs by default; new opens in your group (not the user\'s space) and returns the id you pass to every page tool; select no longer sets a current tab.',
    inputSchema: schema(
      {
        action: { type: 'string', enum: [...TAB_ACTIONS] },
        scope: {
          type: 'string',
          enum: ['own', 'group', 'all'],
          description: 'list: "own" (default), "group" (with groupId) or "all"'
        },
        url: { type: 'string', description: 'new: URL (or search words) to open' },
        tabId: {
          ...TAB_ID,
          description:
            'close / move / select / ungroup: the tab (id or unique id prefix from list; positions are refused)'
        },
        tabIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'group: the tabs of yours to put together (ids)'
        },
        groupId: {
          ...GROUP_ID,
          description:
            'new: the group to open the tab in (default: your home group); move: the group to move it into; list with scope "group": the group to list'
        },
        index: {
          type: 'number',
          description: 'move: the new 1-based slot within the group (1 = first)'
        },
        name: { type: 'string', description: 'group: the name of the new group' },
        spaceId: {
          type: 'string',
          description:
            "new: open in this space of the user's instead of your group – needs allowForeign: true"
        },
        background: {
          type: 'boolean',
          description: 'new: never bring the new tab in front of the user, even in foreground mode'
        },
        allowForeign: ALLOW_FOREIGN
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
      else if (pick(args, 'groupId') !== undefined)
        args = { ...args, action: 'list', scope: 'group' }
      else return text(`Your tabs – id "title" url [flags]:\n${listOwnTabs(ctx)}`)
    }
    const action = TAB_ACTION_ALIASES[(str(args, 'action') ?? 'list').toLowerCase().trim()]
    if (!action)
      throw new RpcError(
        -32602,
        `Unknown action ${JSON.stringify(rawAction)} – use one of ${TAB_ACTIONS.map((a) => `"${a}"`).join(', ')}`
      )
    const s = ctx.session
    const tabs = ctx.browser.tabs
    const foreign = bool(args, 'allowForeign')
    const own = (): string => `Your tabs – id "title" url [flags]:\n${listOwnTabs(ctx)}`
    if (action === 'list') {
      const groupRef = pick(args, 'groupId')
      const scope = (str(args, 'scope') ?? (groupRef !== undefined ? 'group' : 'own')).toLowerCase()
      if (scope === 'all' || scope === 'everyone' || scope === 'everything')
        return text(`All tabs – id "title" url [flags]:\n${listAllTabs(ctx)}`)
      if (scope === 'group' || scope === 'folder') {
        if (groupRef === undefined)
          throw new RpcError(
            -32602,
            `scope "group" needs groupId (one of your groups from zen_groups list).\n\n${own()}`
          )
        const group = ctx.agents.resolveGroup(s, groupRef, foreign)
        return text(listGroupTabs(ctx, group))
      }
      if (scope !== 'own' && scope !== 'mine' && scope !== 'yours')
        throw new RpcError(
          -32602,
          `scope must be "own", "group" or "all" (got ${JSON.stringify(scope)})`
        )
      return text(own())
    }
    if (action === 'new') {
      const win = ctx.agents.agentWindow()
      const rawUrl = str(args, 'url')
      const url = rawUrl ? resolveUrl(ctx, rawUrl) : undefined
      const groupRef = pick(args, 'groupId')
      const spaceId = str(args, 'spaceId')
      // The screen and its lease decide whether the user sees the new tab (`background: true` never asks).
      const active = !bool(args, 'background') && ctx.agents.openInFront(s, win)
      let tab: Tab
      let where: string
      if (groupRef !== undefined) {
        const group = ctx.agents.resolveGroup(s, groupRef)
        tab = ctx.agents.openTab(s, group, { url, active }, win)
        where = `in your group ${JSON.stringify(group.name)} (${group.id})`
      } else if (spaceId) {
        const space =
          ctx.browser.state.model.spaces.find((sp) => sp.id === spaceId) ??
          ctx.browser.state.model.spaces.find(
            (sp) => sp.name.toLowerCase() === spaceId.toLowerCase()
          )
        if (!space)
          throw new RpcError(
            -32602,
            `Unknown space ${spaceId} – zen_spaces {"action":"list"} shows the ids (or omit spaceId to open in your group)`
          )
        if (ctx.agents.isAgentSpace(space.id)) {
          const group = ctx.agents.groupIn(s, space.id)
          tab = ctx.agents.openTab(s, group, { url, active }, win)
          where = `in your group ${JSON.stringify(group.name)} (${group.id}) in space ${JSON.stringify(space.name)}`
        } else {
          if (!foreign)
            throw new RpcError(
              UNAUTHORIZED,
              `Opening a tab in the user's space ${JSON.stringify(space.name)} is a foreign act – pass allowForeign: true if the user asked for it; otherwise omit spaceId (your tabs live in your groups in the "Agents" space) or make a space of your own with zen_groups {"action":"create","space":"own"}.`
            )
          tab = tabs.createTab({ url, spaceId: space.id, active, load: false }, win)
          where = `in the user's space ${JSON.stringify(space.name)} – it is not in one of your groups, so every later call on it needs allowForeign: true`
        }
      } else {
        const group = ctx.agents.homeGroup(s)
        tab = ctx.agents.openTab(s, group, { url, active }, win)
        where = `in your home group ${JSON.stringify(group.name)} (${group.id})`
      }
      const view = await ctx.agents.prepare(s, tab.id, { activate: active })
      if (url) await ctx.agents.waitForLoad(tab.id, LOAD_TIMEOUT_MS, { expectNavigation: true })
      return pageResult(
        ctx,
        tab,
        view,
        `Opened tab ${tab.id} ${where}${url ? ` at ${url}` : ' (blank – browser_navigate loads a page in it)'}. Pass tabId: ${JSON.stringify(tab.id)} to page tools.`
      )
    }
    if (action === 'select') {
      if (pick(args, 'tabId') === undefined && ctx.agents.ownedTabs(s).length !== 1)
        throw new RpcError(
          -32602,
          `select needs tabId. Deprecated: there is no current tab any more – browser_tabs select is browser_snapshot {"tabId":"…"}; pass tabId to every page tool.\n\n${own()}`
        )
      const tab = targetTab(ctx, args)
      const view = await ctx.agents.prepare(s, tab.id)
      return pageResult(
        ctx,
        tab,
        view,
        `Deprecated: there is no current tab any more – "select" only took this snapshot of tab ${tab.id}; pass tabId: ${JSON.stringify(tab.id)} to every page tool instead.`
      )
    }
    if (action === 'close') {
      if (pick(args, 'tabId') === undefined && ctx.agents.ownedTabs(s).length !== 1)
        throw new RpcError(-32602, `close needs tabId (the tab to close).\n\n${own()}`)
      const tab = targetTab(ctx, args)
      const owner = ctx.agents.owner(s, tab)
      if (owner.kind === 'user' && (tab.essential || tab.pinned))
        throw new RpcError(
          UNAUTHORIZED,
          `Tab ${tab.id} is ${tab.essential ? 'an Essential' : 'a pinned tab'} of the user's – agents never close, move or group the user's Essentials and pinned tabs, not even with allowForeign.`
        )
      const title = titleOf(tab)
      tabs.closeTab(tab.id, true, ctx.agents.agentWindow())
      const whose =
        owner.kind === 'you'
          ? ''
          : owner.kind === 'orphaned'
            ? ' (a tab of an orphaned agent group, with allowForeign)'
            : " (a tab of the user's, with allowForeign)"
      return text(`Closed tab ${tab.id} ${JSON.stringify(title)}${whose}.\n\n${own()}`)
    }
    if (action === 'move') {
      // `index` is the slot here, not a tab reference: keep the alias out of the tab lookup.
      const ref = pick({ ...args, index: undefined, tabIndex: undefined }, 'tabId')
      if (ref === undefined)
        throw new RpcError(
          -32602,
          `move needs tabId (the tab of yours to move) and groupId and/or index.\n\n${own()}`
        )
      const groupRef = pick(args, 'groupId')
      const index = num(args, 'index') ?? num(args, 'position') ?? num(args, 'to')
      if (groupRef === undefined && index === undefined)
        throw new RpcError(
          -32602,
          'move needs groupId (one of your groups to move the tab into) and/or index (its new 1-based slot in the group)'
        )
      // Resolved with foreign tabs in scope so the refusal can say why a foreign one is not
      // movable at all: into one of your groups it would become yours, and allowForeign never
      // transfers ownership. Another live agent's tab still fails inside resolveTab.
      const tab = ctx.agents.resolveTab(s, ref, true)
      if (tab.folderId === null || !s.groupIds.has(tab.folderId)) {
        const whose = ctx.agents.describeOwner(s, tab) ?? "the user's"
        throw new RpcError(
          UNAUTHORIZED,
          `Tab ${tab.id} is not one of yours (${whose}) – browser_tabs move works on your own tabs only, with or without allowForeign: moving a foreign tab into one of your groups would make it yours, and allowForeign never transfers ownership. An orphaned group is taken over whole with zen_groups {"action":"adopt","groupId":"…"}; the user's tabs stay where the user put them.\n\n${own()}`
        )
      }
      const current = folderOf(ctx, tab)
      const group = groupRef !== undefined ? ctx.agents.resolveGroup(s, groupRef) : current
      if (!group) throw new RpcError(-32002, `Tab ${tab.id} is in no group of yours any more`)
      ctx.agents.moveToGroup(s, tab, group, index)
      const slot = index === undefined ? '' : ` to slot ${Math.max(1, Math.round(index))}`
      return text(
        `Moved tab ${tab.id}${group.id !== current?.id ? ` into your group ${JSON.stringify(group.name)} (${group.id})` : ` within your group ${JSON.stringify(group.name)}`}${slot}.\n\n${own()}`
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
          `group needs tabIds (the tabs of yours to put together) and name (the group name). Deprecated alias: zen_groups create + browser_tabs move do the same.\n\n${own()}`
        )
      const members = refs.map((r) => ctx.agents.resolveTab(s, r))
      const name = str(args, 'name')
      const existing = name
        ? ctx.agents.groupsOf(s).find((g) => g.name.toLowerCase() === name.toLowerCase())
        : undefined
      const group =
        existing ??
        ctx.agents.createGroup(
          s,
          name ?? `${s.name} · ${s.id.slice(-4)} · ${ctx.agents.groupsOf(s).length + 1}`,
          ctx.agents.agentsSpace().id
        )
      for (const t of members) ctx.agents.moveToGroup(s, t, group)
      return text(
        `${existing ? 'Added' : 'Created group'} ${JSON.stringify(group.name)} (${group.id}) ${existing ? 'got' : 'with'} ${members.length} tab${members.length === 1 ? '' : 's'}: ${members.map((t) => t.id).join(', ')}. (Deprecated alias of zen_groups create + browser_tabs move.)\n\n${own()}`
      )
    }
    if (action === 'ungroup') {
      const ref = pick(args, 'tabId')
      if (ref === undefined) throw new RpcError(-32602, `ungroup needs tabId.\n\n${own()}`)
      const tab = ctx.agents.resolveTab(s, ref)
      const home = ctx.agents.homeGroup(s)
      if (tab.folderId === home.id)
        return text(
          `Tab ${tab.id} is already in your home group ${JSON.stringify(home.name)}. A tab of yours always sits in one of your groups; zen_groups close removes a whole group.\n\n${own()}`
        )
      ctx.agents.moveToGroup(s, tab, home)
      return text(
        `Moved tab ${tab.id} to your home group ${JSON.stringify(home.name)} (a tab of yours always sits in one of your groups). (Deprecated alias of browser_tabs move.)\n\n${own()}`
      )
    }
    throw new RpcError(-32602, `action must be one of ${TAB_ACTIONS.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Tools: navigation and the page
// ---------------------------------------------------------------------------

const browserNavigate: AgentTool = {
  definition: {
    name: 'browser_navigate',
    title: 'Navigate',
    description: `Load a URL in the tab tabId (this is also how you change the URL of an existing tab of yours). Plain words are searched with the user's default search engine. When you own no tab yet, one is opened for you in your home group and the result names it. Returns a snapshot of the loaded page. Related: browser_navigate_back, browser_navigate_forward, browser_reload. ${PAGE_CHANGED}`,
    inputSchema: pageSchema(
      { url: { type: 'string', description: 'Full URL (https://…) or search words' } },
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
    let tab: Tab
    let opened = ''
    if (pick(args, 'tabId') === undefined && !ctx.agents.ownedTabs(s).length) {
      const win = ctx.agents.agentWindow()
      const group = ctx.agents.homeGroup(s)
      tab = ctx.agents.openTab(s, group, { active: ctx.agents.openInFront(s, win) }, win)
      opened = ` Opened tab ${tab.id} in your home group ${JSON.stringify(group.name)} for it – pass tabId: ${JSON.stringify(tab.id)} to page tools.`
    } else tab = targetTab(ctx, args)
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
      `Navigated to ${url}${loaded ? '' : ' (still loading after 15 s – browser_wait_for can wait for content)'}.${opened}`
    )
  }
}

const browserNavigateBack: AgentTool = {
  definition: {
    name: 'browser_navigate_back',
    title: 'Go back',
    description: `Go back one page in the tab's history (like the Back button) and return a snapshot. Undo with browser_navigate_forward. ${PAGE_CHANGED}`,
    inputSchema: pageSchema({}),
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
    description: `Go forward one page in the tab's history (like the Forward button, after browser_navigate_back) and return a snapshot. ${PAGE_CHANGED}`,
    inputSchema: pageSchema({}),
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
    description: `Reload the current page of the tab (like the Reload button) and return a snapshot. ignoreCache: true forces a fresh download of every resource. ${PAGE_CHANGED}`,
    inputSchema: pageSchema({
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
    description: `Read the page as an accessibility-style tree (roles, names, values, links). Each element carries a [ref=eN] handle: pass the eN as target to browser_click / browser_type / browser_hover / browser_select_option / browser_take_screenshot. Prefer this over screenshots for finding things to act on; refs stay valid until the element leaves the page. For long pages use filter or interactiveOnly; boxes adds each element's viewport rectangle when you need coordinates. ${PAGE_CHANGED}`,
    inputSchema: pageSchema({
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
    description: `Click an element (target) or a point (x, y). Scrolls the element into view, moves your cursor there and clicks; returns a snapshot afterwards. ${XY_NOTE} ${PAGE_CHANGED}`,
    inputSchema: pageSchema({
      target: TARGET,
      x: { type: 'number', description: 'Viewport x in CSS px (with y, instead of target)' },
      y: { type: 'number', description: 'Viewport y in CSS px (with x, instead of target)' },
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
    const { tab, view, page } = await actOn(ctx, args)
    const { loc, target } = await locateArg(page, args, 'browser_click')
    if (loc.disabled)
      return textError(`${describeElement(loc)} is disabled, so it cannot be clicked`)
    const routing = await routeInput(ctx, tab.id, view, loc)
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'move')
    await sleep(ctx.agents.settings.showCursor ? 260 : 30)
    const button =
      (str(args, 'button')?.toLowerCase() as 'left' | 'right' | 'middle' | undefined) ?? 'left'
    await clickAt(
      page,
      view,
      loc,
      target ?? loc.ref ?? '',
      { button, count: bool(args, 'doubleClick') ? 2 : 1, modifiers: modifiers(args) },
      routing.trusted
    )
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'click')
    await settle(ctx, tab.id)
    const current = ctx.browser.tabs.view(tab.id) ?? view
    const where = target ? '' : ` at (${loc.x}, ${loc.y})`
    return pageResult(
      ctx,
      tab,
      current,
      withInputNote(`Clicked ${describeElement(loc)}${where}.`, routing)
    )
  }
}

const browserHover: AgentTool = {
  definition: {
    name: 'browser_hover',
    title: 'Hover',
    description: `Move the mouse over an element (target) or to a point (x, y) without clicking – opens hover menus, shows tooltips – and return a snapshot with whatever appeared. ${XY_NOTE} ${PAGE_CHANGED}`,
    inputSchema: pageSchema({
      target: TARGET,
      x: { type: 'number', description: 'Viewport x in CSS px (with y, instead of target)' },
      y: { type: 'number', description: 'Viewport y in CSS px (with x, instead of target)' }
    }),
    annotations: { openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view, page } = await actOn(ctx, args)
    const { loc, target } = await locateArg(page, args, 'browser_hover')
    const routing = await routeInput(ctx, tab.id, view, loc)
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'move')
    await hoverAt(page, view, loc, target, routing.trusted)
    await sleep(350)
    const where = target ? '' : ` at (${loc.x}, ${loc.y})`
    return pageResult(
      ctx,
      tab,
      view,
      withInputNote(`Hovering ${describeElement(loc)}${where}.`, routing)
    )
  }
}

const browserType: AgentTool = {
  definition: {
    name: 'browser_type',
    title: 'Type text',
    description: `Type text into an editable element (text field, textarea, rich editor): clicks it, then enters the text. Replaces the current value unless clear is false. submit: true presses Enter afterwards. Returns a snapshot. Use browser_click for checkboxes and browser_select_option for <select> menus. ${PAGE_CHANGED}`,
    inputSchema: pageSchema(
      {
        target: TARGET,
        text: { type: 'string', description: 'The text to enter' },
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
    const { tab, view, page } = await actOn(ctx, args)
    const loc = await locate(page, target)
    if (!loc.editable)
      return textError(
        `${describeElement(loc)} is not an editable field${loc.role === 'combobox' ? ' – use browser_select_option to choose an option' : loc.role === 'checkbox' || loc.role === 'radio' ? ' – use browser_click to toggle it' : ''}`
      )
    if (loc.disabled) return textError(`${describeElement(loc)} is disabled`)
    const routing = await routeInput(ctx, tab.id, view, loc)
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'move')
    await sleep(ctx.agents.settings.showCursor ? 220 : 20)
    // Focus the way a person would, so focus handlers and autocomplete popups behave.
    await clickAt(
      page,
      view,
      loc,
      target,
      { button: 'left', count: 1, modifiers: [] },
      routing.trusted
    )
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'click')
    await sleep(60)
    // The field's own frame runs the fill: that is where the ref (and the element) lives.
    const filled = await frameAction(
      page,
      loc.frameId,
      pageCall('fill', ctx.session.id, target, value, bool(args, 'clear', true))
    )
    if (!filled.ok) return textError(filled.error ?? 'Could not type into the element')
    let headline = `Typed ${JSON.stringify(value)} into ${describeElement(loc)}`
    if (bool(args, 'submit')) {
      await sleep(80)
      if (routing.trusted && view.sendInput)
        await view.sendInput({ type: 'key', key: 'Enter', modifiers: [] })
      else await frameAction(page, loc.frameId, pageCall('submit', ctx.session.id, target))
      headline += ' and pressed Enter'
    }
    await settle(ctx, tab.id)
    return pageResult(
      ctx,
      tab,
      ctx.browser.tabs.view(tab.id) ?? view,
      withInputNote(`${headline}.`, routing)
    )
  }
}

const browserPressKey: AgentTool = {
  definition: {
    name: 'browser_press_key',
    title: 'Press a key',
    description: `Press one keyboard key in the page (Enter, Tab, Escape, ArrowDown, PageDown, a, …) with optional modifiers; it goes to the focused element. Returns a snapshot. To enter a whole text use browser_type. ${PAGE_CHANGED}`,
    inputSchema: pageSchema(
      {
        key: { type: 'string', description: 'Key name (Enter, Escape, ArrowDown, Tab, a, …)' },
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
    const { tab, view, page } = await actOn(ctx, args)
    const routing = await routeInput(ctx, tab.id, view)
    await pressKey(page, view, key, modifiers(args), routing.trusted)
    await settle(ctx, tab.id)
    return pageResult(
      ctx,
      tab,
      ctx.browser.tabs.view(tab.id) ?? view,
      withInputNote(`Pressed ${key === ' ' ? 'Space' : key}.`, routing)
    )
  }
}

const browserScroll: AgentTool = {
  definition: {
    name: 'browser_scroll',
    title: 'Scroll',
    description: `Scroll the page: by a viewport in a direction (default: down), by amount pixels, to an element (target), or to: "top" / "bottom". Returns a snapshot that states the new scroll position. Content that only loads when scrolled into view appears after scrolling. ${PAGE_CHANGED}`,
    inputSchema: pageSchema({
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
    const { tab, view, page } = await actOn(ctx, args)
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
    const target = str(args, 'target') ?? null
    // A target inside a cross-origin frame is scrolled into view by the frame's own runtime
    // (Chromium carries scrollIntoView across frame boundaries); the top document then says where
    // the page stands.
    let frameId = 0
    if (target) {
      try {
        frameId = (await locateTarget(page, target, false)).frameId
      } catch (error) {
        if (error instanceof RpcError) return textError(error.message)
        throw error
      }
    }
    const r = await frameAction(
      page,
      frameId,
      pageCall('scroll', ctx.session.id, {
        target,
        direction,
        amount: num(args, 'amount') ?? null,
        to
      })
    )
    if (!r.ok) return textError(r.error ?? 'Could not scroll')
    await sleep(250)
    const scrollY =
      frameId === 0
        ? r.scrollY
        : ((await page.eval(0, 'Math.round(scrollY)').catch(() => r.scrollY)) as number | undefined)
    return pageResult(ctx, tab, view, `Scrolled (now at ${scrollY ?? 0}px from the top).`)
  }
}

const browserSelectOption: AgentTool = {
  definition: {
    name: 'browser_select_option',
    title: 'Select option',
    description: `Choose option(s) of a <select> drop-down (role combobox in snapshots) by value or visible label. Returns a snapshot. ${PAGE_CHANGED}`,
    inputSchema: pageSchema(
      {
        target: TARGET,
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Option value(s) or visible label(s); a single string is accepted too'
        }
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
    const { tab, view, page } = await actOn(ctx, args)
    const loc = await locate(page, target)
    await ctx.agents.cursor(ctx.session, tab.id, view, loc.x, loc.y, 'click')
    const r = await frameAction(
      page,
      loc.frameId,
      pageCall('select', ctx.session.id, target, values)
    )
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
    description: `Take a screenshot and return it as an image. Default: the visible viewport. fullPage: true captures the whole scrollable page in one image; target captures just that element (a ref from browser_snapshot or a CSS selector). Use browser_snapshot to find elements to act on; screenshots are for checking layout and images. ${PAGE_CHANGED}`,
    inputSchema: pageSchema({
      fullPage: { type: 'boolean', description: 'Capture the entire page, not only the viewport' },
      target: { ...TARGET, description: 'Capture only this element (ref, CSS selector or text=…)' },
      type: { type: 'string', enum: ['jpeg', 'png'], description: 'Image format (default jpeg)' }
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  async run(ctx, args) {
    const { tab, view, page } = await actOn(ctx, args)
    const format = str(args, 'type')?.toLowerCase() === 'png' ? 'png' : 'jpeg'
    const target = str(args, 'target')
    const fullPage = bool(args, 'fullPage')
    const current = ctx.browser.tabs.tab(tab.id) ?? tab
    let cap: (AgentCapture & { kind: string }) | null = null
    let kind = 'viewport'
    let note = ''
    // A tab just brought in front has no frame to copy until its renderer painted at the new
    // size: the switch to foreground used to fail the first screenshot for exactly that, and
    // succeed once some other action had waited for the paint. Wait for it here, as input does.
    const inFront = ctx.session.mode === 'foreground' && !ctx.agents.degraded(ctx.session)
    const notReady = inFront ? await waitInputReady(ctx, tab.id, view) : null
    // The agent's own cursor overlay is UI for the user, not page content: keep it out of the image.
    const overlays = (visible: boolean): Promise<unknown> =>
      ctx.agents
        .evalPage(
          view,
          `(() => { for (const el of document.querySelectorAll('[data-zen-agent="cursor"],[data-zen-agent="ripple"]')) el.style.visibility = ${visible ? "''" : "'hidden'"}; return true })()`
        )
        .catch(() => undefined)
    await overlays(false)
    try {
      cap = await captureFor(ctx, view, page, { target, fullPage, format })
      if (cap) kind = cap.kind
      else if (!view.capture && (target || fullPage))
        note = ` Note: this host can only capture the visible viewport, so the ${target ? 'target' : 'fullPage'} option was ignored${target ? ' – browser_scroll {"target":…} brings it into view first' : ''}.`
    } finally {
      await overlays(true)
    }
    if (!cap) {
      const dataUrl = await view.snapshot()
      if (!dataUrl) return textError(captureFailure(ctx, current, notReady))
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

/**
 * Why no image came back, by what the tool knows: the mode, whether the call had to act in the
 * background and why, and whether the tab came on screen and painted. The old text blamed a
 * hidden tab and told the agent to "try zen_mode foreground" – also to an agent already in
 * foreground mode whose tab simply had not painted yet.
 */
function captureFailure(ctx: ToolContext, tab: Tab, notReady: NotReady | null): string {
  const seconds = Math.round(onScreenWaitMs / 1000)
  const readers = 'browser_snapshot and browser_read_page read the page without a picture.'
  const why = ctx.agents.degradedBecause(ctx.session)
  if (ctx.session.mode === 'background')
    return `The page could not be captured: tab ${tab.id} is off screen (you are in background mode) and no frame of it has been painted yet. Wait a moment and retry; ${readers} If it keeps failing, the tab needs the screen: zen_mode {"mode":"foreground","takeScreen":true} – only if the user wants your tab in front.`
  if (why === 'lease') {
    const holder = ctx.agents.leaseHolder(ctx.agents.agentWindow())
    return `The page could not be captured: tab ${tab.id} stayed off screen because agent ${JSON.stringify(holder?.name ?? 'another agent')} holds the screen, and no frame of it has been painted. Retry once that agent has been quiet for ${LEASE_SECONDS} s; ${readers}`
  }
  if (why === 'screen')
    return `The page could not be captured: tab ${tab.id} is not what the user is looking at and you have not taken the screen, so it stayed off screen with no frame painted. zen_mode {"mode":"foreground","takeScreen":true} brings it in front (only if the user wants that); ${readers}`
  if (notReady === 'off screen')
    return `The page could not be captured: tab ${tab.id} did not come on screen within ${seconds} s (the URL bar or another chrome overlay covers the page, or another tab is in front). Retry in a moment; ${readers}`
  if (notReady === 'unpainted')
    return `The page could not be captured: tab ${tab.id} came on screen but had not painted its first frame within ${seconds} s. Wait a moment and retry; ${readers}`
  return `The page could not be captured: the browser returned no image for tab ${tab.id} although it is on screen and painted. Retry; if it keeps failing, ${readers}`
}

/** Capture what the agent asked for through the host's `capture`, if it has one. */
async function captureFor(
  ctx: ToolContext,
  view: TabView,
  page: FramePage,
  opts: { target?: string; fullPage: boolean; format: 'jpeg' | 'png' }
): Promise<(AgentCapture & { kind: string }) | null> {
  if (!view.capture) return null
  const { target, fullPage, format } = opts
  if (target) {
    const loc = await locate(page, target)
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
    description: `The readable text of the page as plain text: the article (title, byline, body) when the page looks like one, otherwise all visible text. Much cheaper than a snapshot when you only need to read or answer questions about the content; use browser_snapshot when you need to click or type. ${PAGE_CHANGED}`,
    inputSchema: pageSchema({
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
    description: `Wait until text appears (text) or disappears (textGone), until a CSS selector matches (selector), or simply for a number of seconds (time). Returns a snapshot. ${PAGE_CHANGED}`,
    inputSchema: pageSchema({
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

/**
 * Told to agents that call `browser_evaluate` while scripting is off, and used as the tool's own
 * preamble, so both explain where the user turns it on.
 */
export const SCRIPTING_DISABLED =
  'Running JavaScript in pages is disabled until the user enables "Allow agents to run JavaScript in pages" in Zenium Settings → AI Agents. Use browser_snapshot, browser_read_page and the interaction tools instead.'

const browserEvaluate: AgentTool = {
  scripting: true,
  definition: {
    name: 'browser_evaluate',
    title: 'Run JavaScript',
    description: `Run JavaScript in the page and return the JSON-serialised result: an expression ("document.title"), or a function ("() => document.body.dataset.build"). Use it to read attributes, computed values or anything the snapshot does not show. Off by default: the tool only works after the user enables "Allow agents to run JavaScript in pages" in Zenium Settings → AI Agents. ${PAGE_CHANGED}`,
    inputSchema: pageSchema(
      {
        expression: {
          type: 'string',
          description:
            'JavaScript expression or arrow function, e.g. "document.querySelectorAll(\'p\').length"'
        }
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
        { ok: true; value: string } | { ok: false; error: string } | null | undefined
      // The wrapper always answers with an object; nothing at all means the host could not even
      // parse the script (only possible where the shape had to be guessed, see wrapScript).
      if (!result)
        return textError(
          'Script has a syntax error – give a single expression (document.title), an arrow function (() => …) or statements ending in a value'
        )
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
 *
 * `parse` only checks syntax. Where the core itself may not compile code – the Android chrome's
 * Content-Security-Policy forbids eval – it throws an EvalError, and the shape is guessed from
 * the source instead: statement keywords or several `;`-separated statements mean statements,
 * anything else is an expression (the page tells us if that was wrong, see browser_evaluate).
 */
export function wrapScript(
  source: string,
  parse: (code: string) => void = (code) => new Function(code)
): { code: string } | { error: string } {
  const body = (inner: string): string =>
    `(async () => { try { ${inner} const __v = typeof __r === 'function' ? await __r() : await __r; let __s; try { __s = JSON.stringify(__v) } catch (e) { __s = String(__v) } return { ok: true, value: __s === undefined ? 'undefined' : __s } } catch (e) { return { ok: false, error: String((e && e.message) || e) } } })()`
  const asExpression = `const __r = (${source}\n);`
  const asStatements = `const __r = await (async () => { ${source}\n })();`
  let canParse = true
  for (const inner of [asExpression, asStatements]) {
    try {
      // Parsing only: the function is never called here.
      parse(`return ${body(inner)}`)
      return { code: body(inner) }
    } catch (error) {
      if (
        error instanceof EvalError ||
        /unsafe-eval|Content Security Policy/i.test(String(error))
      ) {
        canParse = false
        break
      }
      /* try the next shape */
    }
  }
  if (!canParse) return { code: body(looksLikeStatements(source) ? asStatements : asExpression) }
  try {
    parse(source)
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
      "Search the user's browsing history by title or URL (empty query: most recent pages). " +
      'Every word of the query matches at word starts, as Chrome\'s history search does: "docs" ' +
      'finds "Team docs" and "/docs/intro", not "Googledocs".',
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
  zenGroups,
  zenSession,
  zenSpaces,
  zenMode,
  zenHistory
]

/**
 * The server's `instructions`: how to behave in a browser the user and other agents share. `others`
 * is how many other agents are connected right now – with any, background mode is the
 * recommendation.
 */
export function agentInstructions(mode: AgentMode, allowScripts: boolean, others = 0): string {
  const company =
    others > 0
      ? `${others} other agent${others === 1 ? ' is' : 's are'} connected right now`
      : 'no other agent is connected right now, but one may join at any time'
  return [
    "You are controlling the user's Zenium browser (Chromium) through its built-in MCP server. The user and other agents share this browser, and every agent works in tab groups of its own, so:",
    '- Address everything by id. Every page tool takes tabId – a tab id from browser_tabs (a unique prefix is enough); there is no current tab, and list positions are refused because they shift whenever another agent or the user opens or closes a tab. Only while you own exactly one tab may you omit tabId.',
    '- Create your group and stay inside it. browser_tabs {"action":"new","url":"…"} makes your home group (in the shared "Agents" space, never in the user\'s spaces) and opens a tab in it – copy the id it returns. zen_groups create makes more groups (space: "own" gives you a space of your own); browser_tabs move moves your tabs between your groups. Call zen_status first: it shows your groups and tabs, the other agents and the spaces.',
    `- Others exist (${company}). Another live agent's tabs cannot be addressed at all. The user's tabs are theirs: act on one only when the user asked you to work on their page, and then pass allowForeign: true (browser_tabs {"action":"list","scope":"all"} shows every tab with its owner). It never makes the tab yours, and the user's Essentials and pinned tabs are never closed, moved or grouped.`,
    `- Never close, move or navigate what you did not create. A group whose agent is gone is orphaned: adopt it with zen_groups {"action":"adopt","groupId":"…"} if you are continuing that work, otherwise leave it. zen_groups {"action":"adopt"} without a groupId takes back every orphaned group a session with your name left (after a reconnect or an end without closeTabs). An agent quiet for over ${Math.round(GHOST_IDLE_MS / 60_000)} min counts as gone; a working agent's group is taken only with force: true, when the user asked you to.`,
    '- Clean up. When you are done, zen_session {"action":"end","closeTabs":true} closes your groups and tabs – unless the user wants the results kept; then end without closeTabs and your groups stay as orphaned groups.',
    '- Expect notices. When the user or another agent closes or moves one of your tabs or groups, a "Notice:" line tops your next result: read it and re-list (browser_tabs list) instead of retrying blindly.',
    '- browser_snapshot returns the page as an accessibility tree whose elements carry [ref=eN] handles; pass the eN as target to browser_click, browser_type, browser_hover, browser_select_option and browser_take_screenshot. target also takes a CSS selector or text=Visible label, and browser_click / browser_hover take x,y viewport coordinates instead. Every action returns a fresh snapshot.',
    '- Navigation: browser_navigate (also changes the URL of a tab of yours via tabId; opens a tab in your home group when you have none), browser_navigate_back, browser_navigate_forward, browser_reload. Tabs: browser_tabs list / new / close / move. Groups: zen_groups list / create / rename / close / adopt (browser_tabs group / ungroup are deprecated aliases).',
    '- browser_read_page is the cheap way to read an article; browser_take_screenshot (viewport, fullPage: true, or target for one element) only when the layout or an image matters.',
    `- You start in ${mode.toUpperCase()} mode. Foreground: your actions happen in front of the user on a tab they are looking at – a cursor with your name shows what you do, and clicks, hovers and keys are real input (trusted user gestures: pop-ups and downloads open). Your tab is brought in front first only when you took the screen – zen_mode {"mode":"foreground","takeScreen":true}, which switches the user's space and active tab, so only when the user wants your work on screen – or the user made foreground the default; otherwise an action on a tab the user is not looking at runs in the background and the result says so. The screen is a lease: your first foreground action takes it, and while another agent holds it (active within the last ${LEASE_SECONDS} s) your call runs in the background and the result says so. Background: you work in your tabs without changing what the user sees, and input is synthetic – the result says "input: synthetic" whenever that happened, also in foreground when the page could not be brought on screen or had not painted its first frame yet (then wait a moment and retry). Background is the recommended mode whenever other agents are connected or the user is browsing; switch with zen_mode.`,
    '- browser_navigate accepts URLs or search words. zen_spaces lists and creates spaces; switching the space the user sees (zen_spaces switch) needs the foreground lease.',
    allowScripts
      ? '- browser_evaluate runs JavaScript in the page (an expression or an arrow function) when nothing else does the job, e.g. to read attributes.'
      : `- ${SCRIPTING_DISABLED}`
  ].join('\n')
}
