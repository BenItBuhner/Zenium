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

function installLayout(): void {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return box(this)
  }
  ;(
    document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
  ).elementFromPoint = (x: number, y: number) => {
    let hit: Element | null = null
    for (const el of Array.from(document.querySelectorAll('[data-box]'))) {
      const r = box(el)
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) hit = el
    }
    return hit ?? document.body
  }
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
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
