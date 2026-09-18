import type { AgentFrame } from '../platform'
import { RpcError } from './jsonrpc'
import {
  pageCall,
  type PageActionResult,
  type PageFrameSlot,
  type PageLocation,
  type PageSnapshot
} from './page'

/**
 * Agents and the frames of a page. The page runtime (`page.ts`) runs per document and can only
 * see what its script can reach: the top document plus same-origin iframes. Cross-origin
 * iframes – Google's "Sign in with Google" button, embedded players, payment forms – are opaque
 * to it, so the core runs the runtime inside each such frame through the host
 * (`TabView.executeJavaScript(code, frameId)`) and stitches the pieces together here:
 *
 * - `browser_snapshot` splices every frame's tree in under its `<iframe>` line, with boxes
 *   translated into the top viewport, so the agent sees one page;
 * - refs stay unique across frames (each runtime numbers on from where the others stopped, see
 *   `PageSnapshotOptions.minSeq`) and remember which frame they belong to, so a click on `e57`
 *   asks the right frame for the element and then sends real input at its top-viewport point;
 * - clicks and hovers by coordinates that land on an opaque iframe are resolved inside it.
 *
 * Frames are matched to their `<iframe>` elements by name, URL and size (Chromium does not tell
 * which element owns which frame); unmatched frames are left out of the snapshot but real input
 * at their coordinates still reaches them, since the host routes input by position.
 */

export interface FrameRect {
  x: number
  y: number
  width: number
  height: number
}

/** A frame the agent can reach: the top document, or a cross-origin iframe with a runtime of its own. */
export interface FrameNode {
  /** The host's frame id (`AgentFrame.id`); 0 for the top document. */
  id: number
  /** The nearest enclosing frame that has a runtime of its own; null for the top document. */
  parentId: number | null
  url: string
  name: string
  /** A label for messages: the iframe's title, else its name, else its host. */
  label: string
  /** The frame's viewport in top-viewport CSS px; null while its `<iframe>` is not known. */
  box: FrameRect | null
  /** The owning `<iframe>` element's ref in the parent frame's runtime. */
  ownerRef: string | null
  depth: number
}

/** A location the tools act on: a page location plus the frame it lives in. */
export interface Located extends PageLocation {
  /** The frame the element belongs to (0 = top document); `x`/`y` are top-viewport coordinates. */
  frameId: number
  /** The same point in the owning frame's own viewport. */
  local: { x: number; y: number }
  /** Human-readable frame label when the element is inside an iframe. */
  frameLabel: string | null
}

export interface DeepSnapshot extends PageSnapshot {
  /** The frames the snapshot covers, the top document first. */
  nodes: FrameNode[]
}

export interface DeepSnapshotOptions {
  filter?: string | null
  interactiveOnly?: boolean
  boxes?: boolean
  maxChars: number
}

/** What the orchestration needs from a live page. */
export interface FramePage {
  /** Run `code` in frame `frameId` (0 = the top document) and resolve with its value. */
  eval(frameId: number, code: string): Promise<unknown>
  /** The host's frame tree, or null when it cannot address frames. */
  frames(): AgentFrame[] | null
  /** The agent's id (the runtime keeps one ref namespace per agent). */
  agent: string
  state: TabFrames
}

/** How deep frames nest before we stop following them. */
const MAX_DEPTH = 6
const REF_MAP_LIMIT = 20_000

export function topNode(url = '', name = ''): FrameNode {
  return {
    id: 0,
    parentId: null,
    url,
    name,
    label: '',
    box: null,
    ownerRef: null,
    depth: 0
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The deepest frame whose (known) viewport contains the top-viewport point; the top document
 * when none does. Boxes are clipped to their parents, so containment is exact.
 */
export function frameAt(frames: FrameNode[], x: number, y: number): FrameNode {
  let best = frames.find((f) => f.id === 0) ?? topNode()
  for (const f of frames) {
    if (!f.box || f.id === 0) continue
    if (f.depth <= best.depth) continue
    if (contains(f.box, x, y)) best = f
  }
  return best
}

export function contains(r: FrameRect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

/** Top-viewport coordinates → the frame's own viewport. */
export function toFrameLocal(frame: FrameNode, x: number, y: number): { x: number; y: number } {
  if (!frame.box) return { x, y }
  return { x: x - frame.box.x, y: y - frame.box.y }
}

/** The frame's own viewport coordinates → top-viewport coordinates. */
export function toTopViewport(frame: FrameNode, x: number, y: number): { x: number; y: number } {
  if (!frame.box) return { x, y }
  return { x: x + frame.box.x, y: y + frame.box.y }
}

/**
 * A child frame's viewport in top coordinates: the owner `<iframe>`'s content box (already in
 * the parent's coordinates plus the parent's offset, see `PageSnapshotOptions.offset`), clipped
 * to the parent's viewport – what overflows the parent is not visible and not clickable.
 */
export function childBox(parent: FrameRect | null, owner: FrameRect): FrameRect {
  if (!parent) return { ...owner }
  const x = Math.max(owner.x, parent.x)
  const y = Math.max(owner.y, parent.y)
  const right = Math.min(owner.x + owner.width, parent.x + parent.width)
  const bottom = Math.min(owner.y + owner.height, parent.y + parent.height)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

/** A host frame plus what its runtime reports about itself. */
export interface FrameCandidate {
  id: number
  url: string
  name: string
  /** Whether the frame shares its parent's origin (then the parent's script walks it itself). */
  sameOrigin: boolean
  /** The frame's viewport size, when the runtime could be asked. */
  width: number | null
  height: number | null
}

/**
 * Which `<iframe>` element shows which frame. Chromium keeps the two apart (frames know their
 * owner only inside the renderer), so the pairing is inferred: a matching name is decisive, a
 * matching URL next, matching viewport size after that; leftovers pair up in order, since frame
 * tree order is element insertion order. Same-origin frames never show up as opaque owners –
 * the parent's script entered them – so they are only considered when something else points
 * at them (a `file:` page whose frames share its opaque origin).
 */
export function matchFrames<F extends FrameCandidate>(
  candidates: F[],
  owners: PageFrameSlot[]
): Array<{ frame: F; owner: PageFrameSlot }> {
  const out: Array<{ frame: F; owner: PageFrameSlot }> = []
  const usedFrames = new Set<number>()
  const usedOwners = new Set<number>()
  const scored: Array<{ fi: number; oi: number; score: number }> = []
  candidates.forEach((f, fi) => {
    owners.forEach((o, oi) => {
      const score = matchScore(f, o)
      if (score > 0) scored.push({ fi, oi, score })
    })
  })
  scored.sort((a, b) => b.score - a.score || Math.abs(a.fi - a.oi) - Math.abs(b.fi - b.oi))
  for (const s of scored) {
    if (usedFrames.has(s.fi) || usedOwners.has(s.oi)) continue
    usedFrames.add(s.fi)
    usedOwners.add(s.oi)
    out.push({ frame: candidates[s.fi], owner: owners[s.oi] })
  }
  // Leftovers in order, cross-origin frames only.
  const restFrames = candidates
    .map((f, fi) => ({ f, fi }))
    .filter(({ f, fi }) => !usedFrames.has(fi) && !f.sameOrigin)
  const restOwners = owners.map((o, oi) => ({ o, oi })).filter(({ oi }) => !usedOwners.has(oi))
  for (let i = 0; i < Math.min(restFrames.length, restOwners.length); i++) {
    out.push({ frame: restFrames[i].f, owner: restOwners[i].o })
  }
  return out
}

function matchScore(f: FrameCandidate, o: PageFrameSlot): number {
  let score = 0
  if (o.name && f.name === o.name) score += 4
  if (o.src && f.url === o.src) score += 3
  else if (o.src && samePath(f.url, o.src)) score += 1
  if (
    f.width !== null &&
    f.height !== null &&
    o.width > 0 &&
    Math.abs(f.width - o.width) <= 1 &&
    Math.abs(f.height - o.height) <= 1
  )
    score += 2
  return score
}

function samePath(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.origin === ub.origin && ua.pathname === ub.pathname
  } catch {
    return false
  }
}

/** Every `[ref=eN]` handle in a snapshot tree. */
export function refsIn(tree: string): string[] {
  const out: string[] = []
  const re = /\[ref=(e\d+)\]/g
  for (let m = re.exec(tree); m; m = re.exec(tree)) out.push(m[1])
  return out
}

export function refNumber(ref: string): number {
  const m = /^e(\d+)$/.exec(ref)
  return m ? Number(m[1]) : 0
}

export function isRef(target: string): boolean {
  return /^e\d+$/.test(normalizeRef(target))
}

/** `e12`, `[ref=e12]`, `ref=e12`, `@e12` → `e12` (mirrors the runtime's normalisation). */
export function normalizeRef(target: string): string {
  let t = target.trim()
  const bracket = /^\[(.*)\]$/.exec(t)
  if (bracket) t = bracket[1].trim()
  return t.replace(/^(ref=|ref:|@)/i, '').trim()
}

/** One frame's snapshot with the frames found inside it, ready to be flattened. */
export interface FrameTree {
  node: FrameNode
  snap: PageSnapshot
  /** The slot in the parent's tree this frame fills (null for the top document). */
  slot: PageFrameSlot | null
  children: FrameTree[]
}

/**
 * Flatten a frame tree into one snapshot: each child's lines go in right after its `<iframe>`
 * line (or where that line would have been), indented one level deeper.
 */
export function assemble(tree: FrameTree): string[] {
  const lines = tree.snap.tree ? tree.snap.tree.split('\n') : []
  const children = [...tree.children].sort((a, b) => (b.slot?.index ?? 0) - (a.slot?.index ?? 0))
  for (const child of children) {
    const slot = child.slot
    if (!slot) continue
    const indent = '  '.repeat(slot.contentDepth)
    const childLines = assemble(child).map((l) => indent + l)
    if (!childLines.length) continue
    lines.splice(Math.min(slot.index, lines.length), 0, ...childLines)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Per-tab state
// ---------------------------------------------------------------------------

/**
 * What one agent knows about the frames of one tab: the ref floor that keeps refs unique across
 * the frames' runtimes, which frame each ref came from, and the frame tree as of the last
 * snapshot. Lives as long as the agent drives the tab.
 */
export class TabFrames {
  /** Refs handed out from now on are numbered from here. */
  nextSeq = 1
  nodes: FrameNode[] = [topNode()]
  private docToken = ''
  private readonly refFrames = new Map<string, number>()

  /** Note the ref counter a runtime reported. */
  noteSeq(seq: number): void {
    if (Number.isFinite(seq) && seq + 1 > this.nextSeq) this.nextSeq = seq + 1
  }

  /** Remember which frame a ref belongs to (and raise the floor past it). */
  noteRef(ref: string | null | undefined, frameId: number): void {
    if (!ref) return
    this.noteSeq(refNumber(ref))
    if (frameId === 0) {
      this.refFrames.delete(ref)
      return
    }
    if (this.refFrames.size >= REF_MAP_LIMIT) {
      let drop = REF_MAP_LIMIT / 2
      for (const key of this.refFrames.keys()) {
        if (drop-- <= 0) break
        this.refFrames.delete(key)
      }
    }
    this.refFrames.set(ref, frameId)
  }

  noteRefs(refs: Iterable<string>, frameId: number): void {
    for (const r of refs) this.noteRef(r, frameId)
  }

  /** The frame a ref came from; the top document for refs it has not seen. */
  frameOf(target: string): number {
    return this.refFrames.get(normalizeRef(target)) ?? 0
  }

  node(id: number): FrameNode | undefined {
    return this.nodes.find((n) => n.id === id)
  }

  /** The frame shown by the `<iframe>` element `ownerRef` of frame `parentId`, if known. */
  childByOwner(parentId: number, ownerRef: string): FrameNode | undefined {
    return this.nodes.find((n) => n.parentId === parentId && n.ownerRef === ownerRef)
  }

  /**
   * A new top document: every earlier ref is gone with the runtime that issued it. The ref
   * floor keeps rising, so numbers are never reused.
   */
  onDocument(token: string): void {
    if (token === this.docToken) return
    this.docToken = token
    this.refFrames.clear()
    this.nodes = [topNode()]
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function evalError(error: unknown): RpcError {
  const message = (error as Error).message || String(error)
  return new RpcError(-32603, `The page could not be read: ${message}`)
}

function labelOf(url: string, name: string, title: string): string {
  if (title) return title
  if (name) return name
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Run one frame's snapshot and book its refs. */
async function snapshotFrame(
  page: FramePage,
  frameId: number,
  opts: DeepSnapshotOptions,
  offset: { x: number; y: number }
): Promise<PageSnapshot> {
  const snap = (await page.eval(
    frameId,
    pageCall('snapshot', {
      agent: page.agent,
      filter: opts.filter ?? null,
      interactiveOnly: Boolean(opts.interactiveOnly),
      boxes: Boolean(opts.boxes),
      maxChars: opts.maxChars,
      minSeq: page.state.nextSeq,
      offset
    })
  )) as PageSnapshot
  if (!snap || typeof snap !== 'object' || typeof snap.tree !== 'string')
    throw new RpcError(-32603, 'The page did not answer the snapshot')
  if (frameId === 0) page.state.onDocument(snap.docToken)
  page.state.noteSeq(snap.seq)
  page.state.noteRefs(refsIn(snap.tree), frameId)
  for (const s of snap.frames ?? []) page.state.noteRef(s.ref, frameId)
  return snap
}

/** Whether `frame` is below `ancestorId` in the host tree without passing through `stopAt` ids. */
function descendsFrom(
  host: AgentFrame[],
  frame: AgentFrame,
  ancestorId: number,
  stopAt: Set<number>
): boolean {
  let cur = frame
  for (let i = 0; i < 64; i++) {
    if (cur.parentId === null) return false
    if (cur.parentId === ancestorId) return true
    if (stopAt.has(cur.parentId)) return false
    const next = host.find((f) => f.id === cur.parentId)
    if (!next) return false
    cur = next
  }
  return false
}

async function probe(
  page: FramePage,
  f: AgentFrame,
  parentOrigin: string
): Promise<FrameCandidate> {
  let width: number | null = null
  let height: number | null = null
  try {
    const size = (await page.eval(f.id, '[innerWidth, innerHeight]')) as unknown
    if (Array.isArray(size) && size.length === 2) {
      width = Number(size[0])
      height = Number(size[1])
    }
  } catch {
    /* the frame may be gone or not scriptable */
  }
  return {
    id: f.id,
    url: f.url,
    name: f.name,
    sameOrigin: f.origin === parentOrigin,
    width,
    height
  }
}

/**
 * Pair the opaque `<iframe>`s of `parent`'s snapshot with host frames, snapshot each, recurse.
 * `budget` is the number of characters the whole snapshot may still grow by.
 */
async function expand(
  page: FramePage,
  host: AgentFrame[],
  parent: FrameTree,
  nodes: FrameNode[],
  budget: { left: number },
  opts: DeepSnapshotOptions
): Promise<void> {
  const owners = parent.snap.frames ?? []
  if (!owners.length || parent.node.depth >= MAX_DEPTH) return
  const taken = new Set(nodes.map((n) => n.id))
  const parentHost = host.find((f) => f.id === parent.node.id)
  const parentOrigin = parentHost?.origin ?? ''
  const candidates = host.filter(
    (f) => f.id !== 0 && !taken.has(f.id) && descendsFrom(host, f, parent.node.id, taken)
  )
  if (!candidates.length) return
  const probes = await Promise.all(candidates.map((f) => probe(page, f, parentOrigin)))
  const pairs = matchFrames(probes, owners)
  for (const { frame, owner } of pairs) {
    const hostFrame = candidates.find((f) => f.id === frame.id)!
    const node: FrameNode = {
      id: frame.id,
      parentId: parent.node.id,
      url: hostFrame.url,
      name: hostFrame.name,
      label: labelOf(hostFrame.url, hostFrame.name, owner.title),
      box: childBox(parent.node.box, owner),
      ownerRef: owner.ref,
      depth: parent.node.depth + 1
    }
    nodes.push(node)
    if (!node.box || node.box.width < 2 || node.box.height < 2) continue
    if (budget.left < 200) continue
    let snap: PageSnapshot
    try {
      snap = await snapshotFrame(
        page,
        node.id,
        { ...opts, maxChars: Math.max(500, budget.left) },
        { x: node.box.x, y: node.box.y }
      )
    } catch {
      continue // a frame mid-navigation or gone: the rest of the page still counts
    }
    budget.left -= snap.tree.length
    const child: FrameTree = { node, snap, slot: owner, children: [] }
    parent.children.push(child)
    await expand(page, host, child, nodes, budget, opts)
  }
}

/**
 * The page as one tree: the top document's snapshot with every reachable cross-origin frame's
 * content spliced in under its `<iframe>` line.
 */
export async function deepSnapshot(
  page: FramePage,
  opts: DeepSnapshotOptions
): Promise<DeepSnapshot> {
  let main: PageSnapshot
  try {
    main = await snapshotFrame(page, 0, opts, { x: 0, y: 0 })
  } catch (error) {
    throw error instanceof RpcError ? error : evalError(error)
  }
  const top: FrameNode = {
    ...topNode(main.url, ''),
    box: { x: 0, y: 0, width: main.viewport.width, height: main.viewport.height }
  }
  const nodes: FrameNode[] = [top]
  const root: FrameTree = { node: top, snap: main, slot: null, children: [] }
  const host = page.frames()
  if (host && main.frames?.length && !main.truncated) {
    const budget = { left: Math.max(0, opts.maxChars - main.tree.length) }
    await expand(page, host, root, nodes, budget, opts)
  }
  page.state.nodes = nodes
  let refs = main.refs
  let truncated = main.truncated
  const walk = (t: FrameTree): void => {
    for (const c of t.children) {
      refs += c.snap.refs
      truncated = truncated || c.snap.truncated
      walk(c)
    }
  }
  walk(root)
  return { ...main, tree: assemble(root).join('\n'), refs, truncated, nodes }
}

/** The fresh geometry of frame `frameId`'s `<iframe>` in its parent, as the parent sees it now. */
async function ownerSlot(
  page: FramePage,
  node: FrameNode
): Promise<{ slot: PageFrameSlot; parent: FrameNode } | null> {
  if (node.parentId === null || !node.ownerRef) return null
  const parent = page.state.node(node.parentId)
  if (!parent) return null
  const slots = (await page.eval(
    parent.id,
    pageCall('frames', page.agent, page.state.nextSeq)
  )) as PageFrameSlot[]
  if (!Array.isArray(slots)) return null
  page.state.noteRefs(
    slots.map((s) => s.ref),
    parent.id
  )
  const slot = slots.find((s) => s.ref === node.ownerRef)
  return slot ? { slot, parent } : null
}

/**
 * Where frame `frameId`'s viewport sits in the top viewport right now (frames scroll with their
 * parents, so this is asked at action time, not taken from the snapshot). An `<iframe>` that
 * is scrolled out of view is scrolled into it on the way. Throws when the frame is gone.
 */
export async function frameOrigin(
  page: FramePage,
  frameId: number
): Promise<{ x: number; y: number; ownerRef: string | null }> {
  let node = page.state.node(frameId)
  if (!node) throw staleFrame()
  let x = 0
  let y = 0
  let outermostOwner: string | null = null
  for (let i = 0; node.parentId !== null && i <= MAX_DEPTH; i++) {
    let found = await ownerSlot(page, node)
    if (!found) throw staleFrame()
    const parentViewport = found.parent.id === 0 ? await viewportOf(page) : null
    if (parentViewport && !visibleIn(found.slot, parentViewport)) {
      // The frame is scrolled out of the top viewport: bring its element into view first.
      await page
        .eval(found.parent.id, pageCall('scroll', page.agent, { target: node.ownerRef }))
        .catch(() => undefined)
      found = (await ownerSlot(page, node)) ?? found
    }
    x += found.slot.x
    y += found.slot.y
    outermostOwner = node.ownerRef
    node = found.parent
  }
  return { x, y, ownerRef: outermostOwner }
}

function visibleIn(slot: PageFrameSlot, viewport: { width: number; height: number }): boolean {
  return (
    slot.x + slot.width > 0 &&
    slot.y + slot.height > 0 &&
    slot.x < viewport.width &&
    slot.y < viewport.height
  )
}

async function viewportOf(page: FramePage): Promise<{ width: number; height: number }> {
  const v = (await page
    .eval(0, '({ width: innerWidth, height: innerHeight })')
    .catch(() => null)) as {
    width: number
    height: number
  } | null
  return v ?? { width: Infinity, height: Infinity }
}

function staleFrame(): RpcError {
  return new RpcError(
    -32602,
    'The frame that element was in is gone or has moved – take a new browser_snapshot and use its refs'
  )
}

/**
 * Locate a target (ref, CSS selector or `text=`) wherever it is: refs go to the frame they came
 * from; selectors and text are looked up in the top document first, then in each frame of the
 * last snapshot. The result speaks top-viewport coordinates.
 */
export async function locateTarget(
  page: FramePage,
  target: string,
  scroll = true
): Promise<Located> {
  const call = (frameId: number): Promise<PageLocation | { error: string }> =>
    page.eval(
      frameId,
      pageCall('locate', page.agent, target, scroll, page.state.nextSeq)
    ) as Promise<PageLocation | { error: string }>
  let frameId = isRef(target) ? page.state.frameOf(target) : 0
  let loc: PageLocation | { error: string }
  try {
    loc = await call(frameId)
  } catch (error) {
    // The frame that issued the ref is gone (navigated away, removed): its refs went with it.
    if (frameId !== 0) throw staleFrame()
    throw error
  }
  if ('error' in loc && !isRef(target)) {
    for (const node of page.state.nodes) {
      if (node.id === 0) continue
      const inFrame = await call(node.id).catch(() => null)
      if (inFrame && !('error' in inFrame)) {
        loc = inFrame
        frameId = node.id
        break
      }
    }
  }
  if ('error' in loc) throw new RpcError(-32602, loc.error)
  page.state.noteRef(loc.ref, frameId)
  return await intoTop(page, loc, frameId)
}

/** Translate a frame-local location into the top viewport and check what covers it there. */
async function intoTop(page: FramePage, loc: PageLocation, frameId: number): Promise<Located> {
  if (frameId === 0) return { ...loc, frameId: 0, local: { x: loc.x, y: loc.y }, frameLabel: null }
  const origin = await frameOrigin(page, frameId)
  const node = page.state.node(frameId)
  const x = loc.x + origin.x
  const y = loc.y + origin.y
  let covered = loc.covered
  let inViewport = loc.inViewport
  // The frame's own hit test cannot see the parent's content: an overlay in the top document
  // painted over the iframe would take the click instead.
  const hit = (await page
    .eval(0, pageCall('locateAt', page.agent, x, y, page.state.nextSeq))
    .catch(() => null)) as PageLocation | { error: string } | null
  if (hit && 'error' in hit) inViewport = false
  else if (hit) {
    page.state.noteRef(hit.ref, 0)
    if (hit.tag !== 'iframe' || (origin.ownerRef && hit.ref !== origin.ownerRef)) covered = true
  }
  return {
    ...loc,
    x,
    y,
    covered,
    inViewport,
    frameId,
    local: { x: loc.x, y: loc.y },
    frameLabel: node?.label ?? null
  }
}

/**
 * What is under a top-viewport point, entering cross-origin frames: the top document's hit
 * test names the `<iframe>`; the frame behind it is asked about the point in its own viewport,
 * and so on down.
 */
export async function locateAtPoint(
  page: FramePage,
  p: { x: number; y: number }
): Promise<Located> {
  const top = (await page.eval(
    0,
    pageCall('locateAt', page.agent, p.x, p.y, page.state.nextSeq)
  )) as PageLocation | { error: string }
  if ('error' in top) throw new RpcError(-32602, top.error)
  let loc: PageLocation = top
  page.state.noteRef(loc.ref, 0)
  let node = page.state.node(0) ?? topNode()
  let local = { x: p.x, y: p.y }
  for (let i = 0; i < MAX_DEPTH && loc.tag === 'iframe' && loc.ref; i++) {
    const ownerRef = loc.ref
    let child = page.state.childByOwner(node.id, ownerRef)
    if (!child) {
      await discover(page).catch(() => undefined)
      child = page.state.childByOwner(node.id, ownerRef)
    }
    if (!child) break
    const slots = (await page
      .eval(node.id, pageCall('frames', page.agent, page.state.nextSeq))
      .catch(() => [])) as PageFrameSlot[]
    const slot = Array.isArray(slots) ? slots.find((s) => s.ref === ownerRef) : undefined
    if (!slot) break
    local = { x: local.x - slot.x, y: local.y - slot.y }
    const inner = (await page
      .eval(child.id, pageCall('locateAt', page.agent, local.x, local.y, page.state.nextSeq))
      .catch(() => null)) as PageLocation | { error: string } | null
    if (!inner || 'error' in inner) break
    page.state.noteRef(inner.ref, child.id)
    node = child
    loc = inner
  }
  return {
    ...loc,
    x: p.x,
    y: p.y,
    frameId: node.id,
    local,
    frameLabel: node.id === 0 ? null : node.label
  }
}

/**
 * Rebuild the frame tree without a full snapshot: the opaque `<iframe>`s of every reachable
 * frame, matched to host frames. Used when a click lands on an iframe the last snapshot did not
 * know (the page changed since).
 */
export async function discover(page: FramePage): Promise<FrameNode[]> {
  const host = page.frames()
  const viewport = await viewportOf(page)
  const top: FrameNode = { ...topNode(), box: { x: 0, y: 0, ...viewport } }
  const nodes: FrameNode[] = [top]
  if (!host) {
    page.state.nodes = nodes
    return nodes
  }
  const queue: FrameNode[] = [top]
  while (queue.length) {
    const parent = queue.shift()!
    if (parent.depth >= MAX_DEPTH) continue
    const slots = (await page
      .eval(parent.id, pageCall('frames', page.agent, page.state.nextSeq))
      .catch(() => [])) as PageFrameSlot[]
    if (!Array.isArray(slots) || !slots.length) continue
    page.state.noteRefs(
      slots.map((s) => s.ref),
      parent.id
    )
    const taken = new Set(nodes.map((n) => n.id))
    const parentOrigin = host.find((f) => f.id === parent.id)?.origin ?? ''
    const candidates = host.filter(
      (f) => f.id !== 0 && !taken.has(f.id) && descendsFrom(host, f, parent.id, taken)
    )
    const probes = await Promise.all(candidates.map((f) => probe(page, f, parentOrigin)))
    const offset = parent.box ?? { x: 0, y: 0 }
    for (const { frame, owner } of matchFrames(probes, slots)) {
      const hostFrame = candidates.find((f) => f.id === frame.id)!
      const node: FrameNode = {
        id: frame.id,
        parentId: parent.id,
        url: hostFrame.url,
        name: hostFrame.name,
        label: labelOf(hostFrame.url, hostFrame.name, owner.title),
        box: childBox(parent.box, {
          x: owner.x + offset.x,
          y: owner.y + offset.y,
          width: owner.width,
          height: owner.height
        }),
        ownerRef: owner.ref,
        depth: parent.depth + 1
      }
      nodes.push(node)
      queue.push(node)
    }
  }
  page.state.nodes = nodes
  return nodes
}

/** Run a page-runtime action in the frame a located element belongs to. */
export async function frameAction(
  page: FramePage,
  frameId: number,
  code: string
): Promise<PageActionResult> {
  const r = (await page.eval(frameId, code)) as PageActionResult
  if (!r || typeof r !== 'object') return { ok: false, error: 'The page did not answer' }
  return r
}
