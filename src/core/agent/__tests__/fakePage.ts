import type { AgentFrame } from '../../platform'
import type { FramePage } from '../frames'
import type { PageFrameSlot, PageLocation, PageSnapshot, PageSnapshotOptions } from '../page'
import { TabFrames } from '../frames'

/**
 * A page made of fake frames for testing the frame orchestration and the tools without a DOM:
 * every frame answers the page-runtime calls (`pageCall` strings are parsed back into method and
 * arguments) from a list of elements with frame-local boxes, numbering refs like the real runtime
 * does (from the host's `minSeq` floor, stable per element).
 */

export interface FakeElement {
  id: string
  tag: string
  role: string
  name: string
  /** Frame-local viewport box. */
  box: { x: number; y: number; width: number; height: number }
  editable?: boolean
  disabled?: boolean
  /** For `<iframe>` elements: what the runtime reports about the frame element. */
  iframe?: { src: string; name: string; title: string }
}

export interface FakeFrameSpec {
  id: number
  parentId: number | null
  url: string
  origin: string
  name: string
  title?: string
  viewport?: { width: number; height: number }
  elements: FakeElement[]
  focused?: boolean
}

export class FakeFrame {
  readonly spec: FakeFrameSpec
  readonly log: Array<{ method: string; args: unknown[] }> = []
  readonly docToken: string
  private seq = 0
  private readonly byRef = new Map<string, FakeElement>()
  private readonly byEl = new Map<FakeElement, string>()

  constructor(spec: FakeFrameSpec, docToken = `doc-${spec.id}`) {
    this.spec = spec
    this.docToken = docToken
  }

  get viewport(): { width: number; height: number } {
    return this.spec.viewport ?? { width: 1000, height: 800 }
  }

  refFor(el: FakeElement, minSeq?: number): string {
    if (minSeq && this.seq < minSeq - 1) this.seq = minSeq - 1
    const existing = this.byEl.get(el)
    if (existing) return existing
    const ref = `e${++this.seq}`
    this.byRef.set(ref, el)
    this.byEl.set(el, ref)
    return ref
  }

  private resolve(target: string): FakeElement | { error: string } {
    let t = target.trim()
    const bracket = /^\[(.*)\]$/.exec(t)
    if (bracket) t = bracket[1].trim()
    t = t.replace(/^(ref=|ref:|@)/i, '').trim()
    if (/^e\d+$/.test(t)) {
      const el = this.byRef.get(t)
      return el ?? { error: `Unknown ref ${t} – refs come from your latest browser_snapshot` }
    }
    if (t.startsWith('text=')) {
      const needle = t.slice(5).toLowerCase()
      const el = this.spec.elements.find((e) => e.name.toLowerCase() === needle)
      return el ?? { error: `No visible element with text ${JSON.stringify(t.slice(5))}` }
    }
    if (t.startsWith('#')) {
      const el = this.spec.elements.find((e) => e.id === t.slice(1))
      return el ?? { error: `No element matches the CSS selector ${JSON.stringify(t)}` }
    }
    return {
      error: `${JSON.stringify(t)} is not a ref (e12), a text=… label or a valid CSS selector`
    }
  }

  private location(el: FakeElement, x: number, y: number, ref: string | null): PageLocation {
    return {
      ref,
      x,
      y,
      width: el.box.width,
      height: el.box.height,
      tag: el.tag,
      role: el.role,
      name: el.name,
      disabled: Boolean(el.disabled),
      editable: Boolean(el.editable),
      covered: false,
      inViewport: true
    }
  }

  private slot(
    el: FakeElement,
    minSeq: number | undefined,
    index: number,
    contentDepth: number,
    offset: { x: number; y: number }
  ): PageFrameSlot {
    return {
      ref: this.refFor(el, minSeq),
      index,
      contentDepth,
      x: el.box.x + offset.x,
      y: el.box.y + offset.y,
      width: el.box.width,
      height: el.box.height,
      src: el.iframe?.src ?? '',
      name: el.iframe?.name ?? '',
      title: el.iframe?.title ?? ''
    }
  }

  snapshot(opts: PageSnapshotOptions): PageSnapshot {
    const offset = opts.offset ?? { x: 0, y: 0 }
    const lines: string[] = []
    const slots: PageFrameSlot[] = []
    let refs = 0
    for (const el of this.spec.elements) {
      if (opts.interactiveOnly && !['button', 'textbox', 'link'].includes(el.role)) continue
      const ref = this.refFor(el, opts.minSeq)
      let line = `- ${el.role}${el.name ? ` ${JSON.stringify(el.name)}` : ''}`
      if (opts.boxes)
        line += ` [box=${el.box.x + offset.x},${el.box.y + offset.y},${el.box.width},${el.box.height}]`
      line += ` [ref=${ref}]`
      if (opts.filter && !line.toLowerCase().includes(opts.filter.toLowerCase())) continue
      lines.push(line)
      refs++
      if (el.iframe) slots.push(this.slot(el, opts.minSeq, lines.length, 1, offset))
    }
    return {
      url: this.spec.url,
      title: this.spec.title ?? '',
      viewport: this.viewport,
      scroll: { x: 0, y: 0, height: this.viewport.height },
      tree: lines.join('\n'),
      refs,
      truncated: false,
      frames: slots,
      seq: this.seq,
      docToken: this.docToken
    }
  }

  locate(
    _agent: string,
    target: string,
    _scroll: boolean,
    minSeq?: number
  ): PageLocation | { error: string } {
    const el = this.resolve(target)
    if ('error' in el) return el
    const x = Math.round(el.box.x + el.box.width / 2)
    const y = Math.round(el.box.y + el.box.height / 2)
    return this.location(el, x, y, this.refFor(el, minSeq))
  }

  locateAt(
    _agent: string,
    x: number,
    y: number,
    minSeq?: number
  ): PageLocation | { error: string } {
    const v = this.viewport
    if (x < 0 || y < 0 || x >= v.width || y >= v.height)
      return {
        error: `(${x}, ${y}) is outside the viewport, which is ${v.width}×${v.height} CSS px`
      }
    let hit: FakeElement | null = null
    for (const el of this.spec.elements) {
      const b = el.box
      if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) hit = el
    }
    if (!hit) return { error: `Nothing is rendered at (${x}, ${y})` }
    return this.location(hit, x, y, this.refFor(hit, minSeq))
  }

  frames(_agent: string, minSeq?: number): PageFrameSlot[] {
    return this.spec.elements
      .filter((el) => el.iframe)
      .map((el) => this.slot(el, minSeq, -1, 0, { x: 0, y: 0 }))
  }

  /** Every other runtime method: an action that is logged and succeeds. */
  call(method: string, args: unknown[]): unknown {
    this.log.push({ method, args })
    switch (method) {
      case 'snapshot':
        return this.snapshot(args[0] as PageSnapshotOptions)
      case 'locate':
        return this.locate(
          args[0] as string,
          args[1] as string,
          args[2] as boolean,
          args[3] as number
        )
      case 'locateAt':
        return this.locateAt(
          args[0] as string,
          args[1] as number,
          args[2] as number,
          args[3] as number
        )
      case 'frames':
        return this.frames(args[0] as string, args[1] as number)
      case 'clickJs':
      case 'hoverJs':
      case 'select':
      case 'submit':
      case 'keyJs': {
        const target = args[1]
        if (method !== 'keyJs' && typeof target === 'string' && target) {
          const el = this.resolve(target)
          if ('error' in el) return { ok: false, error: el.error }
        }
        return { ok: true }
      }
      case 'fill': {
        const el = this.resolve(args[1] as string)
        if ('error' in el) return { ok: false, error: el.error }
        return { ok: true, value: args[2] }
      }
      case 'scroll':
        return { ok: true, scrollY: 0 }
      case 'cursor':
        return undefined
      case 'info':
        return { url: this.spec.url, title: this.spec.title ?? '', readyState: 'complete' }
      default:
        throw new Error(`fake runtime has no ${method}`)
    }
  }
}

/** Method and arguments of a `pageCall` script. */
export function parsePageCall(code: string): { method: string; args: unknown[] } | null {
  const m = /return rt\.(\w+)\(([\s\S]*)\) \}\)\(\)$/.exec(code)
  if (!m) return null
  return { method: m[1], args: JSON.parse(`[${m[2]}]`) as unknown[] }
}

/** A whole page: frames by id, evaluated like the host would evaluate them. */
export class FakePage implements FramePage {
  readonly frameMap = new Map<number, FakeFrame>()
  readonly state = new TabFrames()
  readonly agent = 'agent1'
  /** Frames the host reports (null: a host that cannot address frames). */
  hostFrames: AgentFrame[] | null

  constructor(specs: FakeFrameSpec[], hostCanAddressFrames = true) {
    for (const spec of specs) this.frameMap.set(spec.id, new FakeFrame(spec))
    this.hostFrames = hostCanAddressFrames
      ? specs.map((s) => ({
          id: s.id,
          parentId: s.parentId,
          url: s.url,
          origin: s.origin,
          name: s.name,
          focused: Boolean(s.focused)
        }))
      : null
  }

  frame(id: number): FakeFrame {
    const f = this.frameMap.get(id)
    if (!f) throw new Error(`no fake frame ${id}`)
    return f
  }

  /** Detach a frame: the host no longer lists it and scripts in it fail. */
  detach(id: number): void {
    this.frameMap.delete(id)
    if (this.hostFrames) this.hostFrames = this.hostFrames.filter((f) => f.id !== id)
  }

  frames(): AgentFrame[] | null {
    return this.hostFrames
  }

  async eval(frameId: number, code: string): Promise<unknown> {
    const frame = this.frameMap.get(frameId)
    if (!frame) throw new Error(`Frame ${frameId} is no longer part of the page`)
    const call = parsePageCall(code)
    if (call) return frame.call(call.method, call.args)
    if (code === '[innerWidth, innerHeight]') return [frame.viewport.width, frame.viewport.height]
    if (code.includes('innerWidth') && code.includes('innerHeight')) return frame.viewport
    if (code === 'Math.round(scrollY)') return 0
    if (code.includes('scrollX') && code.includes('scrollY')) return { x: 0, y: 0 }
    if (code === 'document.readyState') return 'complete'
    return undefined
  }
}

/** A page with a cross-origin sign-in iframe: a button and a text field inside it. */
export function signInPage(hostCanAddressFrames = true): FakePage {
  return new FakePage(
    [
      {
        id: 0,
        parentId: null,
        url: 'https://shop.example/checkout',
        origin: 'https://shop.example',
        name: '',
        title: 'Checkout',
        elements: [
          {
            id: 'title',
            tag: 'h1',
            role: 'heading',
            name: 'Checkout',
            box: { x: 20, y: 20, width: 400, height: 40 }
          },
          {
            id: 'gis',
            tag: 'iframe',
            role: 'iframe',
            name: 'Sign in with Google',
            box: { x: 100, y: 150, width: 400, height: 300 },
            iframe: {
              src: 'https://accounts.google.example/gsi/button',
              name: 'gsi_button',
              title: 'Sign in with Google'
            }
          },
          {
            id: 'pay',
            tag: 'button',
            role: 'button',
            name: 'Pay now',
            box: { x: 20, y: 600, width: 200, height: 40 }
          }
        ]
      },
      {
        id: 7,
        parentId: 0,
        url: 'https://accounts.google.example/gsi/button',
        origin: 'https://accounts.google.example',
        name: 'gsi_button',
        viewport: { width: 400, height: 300 },
        elements: [
          {
            id: 'signin',
            tag: 'button',
            role: 'button',
            name: 'Sign in with Google',
            box: { x: 20, y: 60, width: 200, height: 40 }
          },
          {
            id: 'email',
            tag: 'input',
            role: 'textbox',
            name: 'Email',
            box: { x: 20, y: 120, width: 300, height: 30 },
            editable: true
          }
        ]
      }
    ],
    hostCanAddressFrames
  )
}
