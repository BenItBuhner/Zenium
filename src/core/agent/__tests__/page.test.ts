// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { PAGE_RUNTIME_SOURCE, pageCall, type PageLocation, type PageRuntime } from '../page'

/**
 * The runtime is shipped as source text and evaluated inside pages; here it runs against
 * happy-dom. happy-dom has no layout, so element boxes come from a `data-box="x,y,w,h"`
 * attribute and `elementFromPoint` is derived from those boxes.
 */

function box(el: Element): DOMRect {
  const spec = el.getAttribute('data-box')
  if (!spec) return new DOMRect(0, 0, 0, 0)
  const [x, y, w, h] = spec.split(',').map(Number)
  return new DOMRect(x, y, w, h)
}

/** Give `doc` (the top document or a frame's) the box-attribute layout above. */
function installLayoutIn(doc: Document, size = { width: 1000, height: 800 }): void {
  const win = doc.defaultView as (Window & typeof globalThis) | null
  const proto = (win?.Element ?? Element).prototype
  proto.getBoundingClientRect = function (this: Element) {
    return box(this)
  }
  ;(
    doc as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
  ).elementFromPoint = (x: number, y: number) => {
    let hit: Element | null = null
    for (const el of Array.from(doc.querySelectorAll('[data-box]'))) {
      const r = box(el)
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) hit = el
    }
    return hit ?? doc.body
  }
  if (win) {
    Object.defineProperty(win, 'innerWidth', { value: size.width, configurable: true })
    Object.defineProperty(win, 'innerHeight', { value: size.height, configurable: true })
  }
}

function installLayout(): void {
  installLayoutIn(document)
}

function runtime(): PageRuntime {
  return new Function(`return (${PAGE_RUNTIME_SOURCE})()`)() as PageRuntime
}

function isLocation(v: PageLocation | { error: string }): v is PageLocation {
  return !('error' in v)
}

describe('page runtime', () => {
  let rt: PageRuntime

  beforeEach(() => {
    installLayout()
    document.body.innerHTML = `
      <h1 data-box="20,20,400,40">Products</h1>
      <button id="menu-trigger" data-box="40,120,160,40">Products menu</button>
      <div id="menu" style="display:none">Hidden menu</div>
      <div id="coord-box" data-box="300,200,200,100">Hover box</div>
      <label for="name" data-box="40,370,60,20">Name</label><input id="name" data-box="40,400,300,30" placeholder="Your name">
    `
    rt = runtime()
  })

  it('snapshots the page with stable refs', () => {
    const snap = rt.snapshot({ agent: 'a' })
    expect(snap.tree).toMatch(/- heading "Products" \[level=1\] \[ref=e\d+\]/)
    expect(snap.tree).toMatch(/- button "Products menu" \[ref=e\d+\]/)
    expect(snap.tree).not.toContain('Hidden menu')
    const again = rt.snapshot({ agent: 'a' })
    expect(again.tree).toBe(snap.tree)
  })

  it('accepts refs in every shape agents copy them', () => {
    const snap = rt.snapshot({ agent: 'a' })
    const ref = /button "Products menu" \[ref=(e\d+)\]/.exec(snap.tree)![1]
    for (const form of [ref, `[ref=${ref}]`, `ref=${ref}`, `@${ref}`, ` ${ref} `]) {
      const loc = rt.locate('a', form, false)
      expect(isLocation(loc) && loc.tag).toBe('button')
    }
  })

  it('locates by CSS selector and by quoted or unquoted text', () => {
    for (const target of [
      '#menu-trigger',
      'text=Products menu',
      'text="Products menu"',
      "text='products menu'"
    ]) {
      const loc = rt.locate('a', target, false)
      expect(isLocation(loc) && loc.name).toBe('Products menu')
    }
    const label = rt.locate('a', 'text=Name', false)
    expect(isLocation(label) && label.tag).toBe('input')
  })

  it('reports a ref for selector and text targets so agents can reuse it', () => {
    const loc = rt.locate('a', '#coord-box', false)
    expect(isLocation(loc) && loc.ref).toMatch(/^e\d+$/)
  })

  it('explains unknown refs, stale refs, bad selectors and missing text', () => {
    expect(rt.locate('a', 'e999', false)).toMatchObject({
      error: expect.stringMatching(/Unknown ref e999.*browser_snapshot/)
    })
    const snap = rt.snapshot({ agent: 'a' })
    const ref = /div|"Hover box" \[ref=(e\d+)\]/.exec(snap.tree)?.[1]
    if (ref) {
      document.getElementById('coord-box')!.remove()
      expect(rt.locate('a', ref, false)).toMatchObject({ error: expect.stringMatching(/stale/) })
    }
    expect(rt.locate('a', '#nope', false)).toMatchObject({
      error: expect.stringMatching(/No element matches the CSS selector "#nope".*text=/)
    })
    expect(rt.locate('a', 'text=Nowhere', false)).toMatchObject({
      error: expect.stringMatching(/No visible element with text "Nowhere"/)
    })
    expect(rt.locate('a', '<<<', false)).toMatchObject({
      error: expect.stringMatching(/not a ref \(e12\), a text=… label or a valid CSS selector/)
    })
  })

  it('locates the element under viewport coordinates and keeps the point', () => {
    const loc = rt.locateAt('a', 400, 250)
    expect(isLocation(loc)).toBe(true)
    if (isLocation(loc)) {
      expect(loc.tag).toBe('div')
      expect(loc.name).toBe('Hover box')
      expect(loc.x).toBe(400)
      expect(loc.y).toBe(250)
      expect(loc.ref).toMatch(/^e\d+$/)
    }
    expect(rt.locateAt('a', 5000, 5)).toMatchObject({
      error: expect.stringMatching(/outside the viewport, which is 1000×800/)
    })
    expect(rt.locateAt('a', Number.NaN, 5)).toMatchObject({
      error: expect.stringMatching(/x and y must be numbers/)
    })
  })

  it('dispatches synthetic hover events to a target or a point', () => {
    const seen: string[] = []
    const box = document.getElementById('coord-box')!
    for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove'])
      box.addEventListener(type, (e) =>
        seen.push(`${type}@${(e as MouseEvent).clientX},${(e as MouseEvent).clientY}`)
      )
    expect(rt.hoverJs('a', '#coord-box', 400, 250)).toEqual({ ok: true })
    expect(seen).toEqual(
      expect.arrayContaining(['mouseover@400,250', 'mouseenter@400,250', 'mousemove@400,250'])
    )
    seen.length = 0
    expect(rt.hoverJs('a', null, 350, 210)).toEqual({ ok: true })
    expect(seen).toContain('mouseover@350,210')
    expect(rt.hoverJs('a', '#nope', 0, 0)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/No element matches/)
    })
  })

  it('pageCall builds a self-installing invocation', () => {
    const code = pageCall('locateAt', 'agent', 1, 2)
    expect(code).toContain('__zenAgentRuntime_v1')
    expect(code).toContain('rt.locateAt("agent",1,2)')
    expect(PAGE_RUNTIME_SOURCE).not.toMatch(/\brequire\(|\bimport\s/)
  })
})

/**
 * Frames. happy-dom gives a `srcdoc` iframe a same-origin document and leaves `contentDocument`
 * null for another origin's `src` – the two cases the runtime distinguishes: the first is walked
 * as part of the page, the second reported as a slot for the host to fill.
 */
describe('page runtime and frames', () => {
  let rt: PageRuntime
  let same: HTMLIFrameElement
  let inner: Document

  beforeEach(async () => {
    installLayout()
    document.body.innerHTML = `
      <h1 data-box="20,20,400,40">Shop</h1>
      <iframe id="same" title="Same-origin widget" data-box="100,100,400,300"
        srcdoc="&lt;button id='inner' data-box='10,10,100,30'&gt;Inner&lt;/button&gt;&lt;input id='field' data-box='10,60,200,30' placeholder='Inner field'&gt;"></iframe>
      <iframe id="other" title="Sign in with Google" name="gsi" data-box="100,500,400,200"></iframe>
      <button id="pay" data-box="20,750,100,30">Pay</button>
    `
    await new Promise((r) => setTimeout(r, 20))
    same = document.getElementById('same') as HTMLIFrameElement
    inner = same.contentDocument!
    installLayoutIn(inner, { width: 400, height: 300 })
    // happy-dom does not link a frame's window back to its element; the runtime needs that link
    // to place the frame's content in the top viewport.
    Object.defineProperty(inner.defaultView, 'frameElement', { value: same, configurable: true })
    // The other frame stands for a cross-origin one: its document is out of reach (a `src` on
    // another origin would make happy-dom fetch it – this keeps the test off the network).
    const other = document.getElementById('other')!
    Object.defineProperty(other, 'contentDocument', { get: () => null, configurable: true })
    Object.defineProperty(other, 'src', { value: 'https://other.example/gsi', configurable: true })
    rt = runtime()
  })

  it('walks same-origin frames in place, with boxes in top-viewport coordinates', () => {
    const snap = rt.snapshot({ agent: 'a', boxes: true })
    expect(snap.tree).toMatch(/- iframe "Same-origin widget" \[box=100,100,400,300\] \[ref=e\d+\]/)
    // The frame's elements sit one level under the iframe line.
    expect(snap.tree).toContain('\n  - button "Inner" [box=110,110,100,30] [ref=e')
    expect(snap.tree).toContain('\n  - textbox "Inner field" [box=110,160,200,30] [ref=e')
    expect(snap.frames.map((f) => f.title)).toEqual(['Sign in with Google'])
  })

  it('locates elements of same-origin frames in top-viewport coordinates, by ref, text and point', () => {
    const snap = rt.snapshot({ agent: 'a' })
    const ref = /button "Inner" \[ref=(e\d+)\]/.exec(snap.tree)![1]
    const byRef = rt.locate('a', ref, false)
    expect(isLocation(byRef) && [byRef.x, byRef.y]).toEqual([160, 125])
    const byText = rt.locate('a', 'text=Inner', false)
    expect(isLocation(byText) && byText.ref).toBe(ref)
    const at = rt.locateAt('a', 160, 125)
    expect(isLocation(at) && at.tag).toBe('button')
    expect(isLocation(at) && at.name).toBe('Inner')
    expect(isLocation(at) && at.ref).toBe(ref)
  })

  it('reports a cross-origin iframe as a slot right after its line, at its top-viewport box', () => {
    const snap = rt.snapshot({ agent: 'a' })
    const lines = snap.tree.split('\n')
    const frameLine = lines.findIndex((l) => l.includes('- iframe "Sign in with Google"'))
    expect(frameLine).toBeGreaterThan(0)
    expect(snap.frames).toHaveLength(1)
    const slot = snap.frames[0]
    expect(slot).toMatchObject({
      index: frameLine + 1,
      contentDepth: 1,
      x: 100,
      y: 500,
      width: 400,
      height: 200,
      src: 'https://other.example/gsi',
      name: 'gsi',
      title: 'Sign in with Google'
    })
    expect(lines[frameLine]).toContain(`[ref=${slot.ref}]`)
    // The same element, the same ref, when asked for the frames alone.
    expect(rt.frames('a').map((f) => f.ref)).toEqual([slot.ref])
    // A point inside the opaque frame is the frame itself: the host asks the frame's runtime.
    const hit = rt.locateAt('a', 200, 600)
    expect(isLocation(hit) && hit.tag).toBe('iframe')
    expect(isLocation(hit) && hit.ref).toBe(slot.ref)
  })

  it('numbers refs from the host floor, reports its counter and a stable document token', () => {
    const snap = rt.snapshot({ agent: 'a', minSeq: 50 })
    const refs = [...snap.tree.matchAll(/\[ref=e(\d+)\]/g)].map((m) => Number(m[1]))
    expect(Math.min(...refs)).toBe(50)
    expect(snap.seq).toBe(Math.max(...refs))
    expect(snap.docToken).toMatch(/^[a-z0-9]+$/)
    expect(rt.snapshot({ agent: 'a' }).docToken).toBe(snap.docToken)
    // Raising the floor later does not renumber what was handed out…
    const again = rt.snapshot({ agent: 'a', minSeq: 90 })
    expect(again.tree).toBe(snap.tree)
    const pay = /button "Pay" \[ref=(e\d+)\]/.exec(snap.tree)![1]
    expect(rt.locateAt('a', 30, 760)).toMatchObject({ ref: pay })
    // …while an element seen for the first time is numbered above the new floor.
    document.body.insertAdjacentHTML('beforeend', '<button data-box="500,750,80,30">New</button>')
    const fresh = rt.locateAt('a', 510, 760)
    expect(isLocation(fresh) && Number(fresh.ref!.slice(1))).toBeGreaterThanOrEqual(90)
  })

  it('offsets every box and slot into the top viewport when it runs inside a frame', () => {
    const snap = rt.snapshot({ agent: 'a', boxes: true, offset: { x: 1000, y: 20 } })
    expect(snap.tree).toMatch(/- heading "Shop" \[level=1\] \[box=1020,40,400,40\]/)
    expect(snap.frames[0]).toMatchObject({ x: 1100, y: 520 })
  })

  it('leaves the iframe line out under interactiveOnly but keeps the slot at its place', () => {
    const snap = rt.snapshot({ agent: 'a', interactiveOnly: true })
    expect(snap.tree).not.toContain('- iframe')
    expect(snap.tree).toContain('- button "Inner"')
    const lines = snap.tree.split('\n')
    const slot = snap.frames[0]
    expect(slot.contentDepth).toBe(0)
    // Between the same-origin frame's field and the Pay button, where the iframe stands.
    expect(lines[slot.index - 1]).toContain('Inner field')
    expect(lines[slot.index]).toContain('"Pay"')
  })
})
