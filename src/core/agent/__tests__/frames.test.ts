import { describe, expect, it } from 'vitest'
import {
  TabFrames,
  assemble,
  childBox,
  deepSnapshot,
  frameAt,
  locateAtPoint,
  locateTarget,
  matchFrames,
  normalizeRef,
  refsIn,
  toFrameLocal,
  toTopViewport,
  topNode,
  type FrameCandidate,
  type FrameNode,
  type FrameTree
} from '../frames'
import type { PageFrameSlot, PageSnapshot } from '../page'
import { signInPage } from './fakePage'

function node(partial: Partial<FrameNode> & { id: number }): FrameNode {
  return {
    ...topNode(),
    parentId: partial.id === 0 ? null : 0,
    depth: partial.id === 0 ? 0 : 1,
    ...partial
  }
}

const TOP = node({ id: 0, box: { x: 0, y: 0, width: 1000, height: 800 } })
const CHILD = node({ id: 7, box: { x: 100, y: 150, width: 400, height: 300 }, ownerRef: 'e2' })
const GRANDCHILD = node({
  id: 9,
  parentId: 7,
  depth: 2,
  box: { x: 120, y: 200, width: 100, height: 100 },
  ownerRef: 'e5'
})

describe('which frame owns a point', () => {
  it('is the deepest frame whose viewport contains it, the top document otherwise', () => {
    const frames = [TOP, CHILD, GRANDCHILD]
    expect(frameAt(frames, 50, 50).id).toBe(0)
    expect(frameAt(frames, 100, 150).id).toBe(7)
    expect(frameAt(frames, 499, 449).id).toBe(7)
    expect(frameAt(frames, 500, 450).id).toBe(0)
    expect(frameAt(frames, 150, 250).id).toBe(9)
  })

  it('ignores frames whose place on the page is not known yet', () => {
    expect(frameAt([TOP, node({ id: 3, box: null })], 10, 10).id).toBe(0)
  })

  it('translates between top-viewport and frame-local coordinates both ways', () => {
    expect(toFrameLocal(CHILD, 130, 180)).toEqual({ x: 30, y: 30 })
    expect(toTopViewport(CHILD, 30, 30)).toEqual({ x: 130, y: 180 })
    expect(toFrameLocal(GRANDCHILD, 120, 200)).toEqual({ x: 0, y: 0 })
    const p = { x: 333, y: 222 }
    const back = toTopViewport(
      CHILD,
      ...(Object.values(toFrameLocal(CHILD, p.x, p.y)) as [number, number])
    )
    expect(back).toEqual(p)
    expect(toFrameLocal(node({ id: 3, box: null }), 5, 6)).toEqual({ x: 5, y: 6 })
  })

  it('clips a child viewport to its parent: what overflows is neither visible nor clickable', () => {
    const parent = { x: 100, y: 100, width: 200, height: 200 }
    expect(childBox(parent, { x: 150, y: 150, width: 400, height: 50 })).toEqual({
      x: 150,
      y: 150,
      width: 150,
      height: 50
    })
    expect(childBox(parent, { x: 50, y: 50, width: 100, height: 100 })).toEqual({
      x: 100,
      y: 100,
      width: 50,
      height: 50
    })
    expect(childBox(parent, { x: 400, y: 400, width: 10, height: 10 })).toMatchObject({
      width: 0,
      height: 0
    })
    expect(childBox(null, { x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4
    })
  })
})

describe('matching host frames to <iframe> elements', () => {
  const slot = (ref: string, extra: Partial<PageFrameSlot> = {}): PageFrameSlot => ({
    ref,
    index: 0,
    contentDepth: 1,
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    src: '',
    name: '',
    title: '',
    ...extra
  })
  const frame = (id: number, extra: Partial<FrameCandidate> = {}): FrameCandidate => ({
    id,
    url: '',
    name: '',
    sameOrigin: false,
    width: null,
    height: null,
    ...extra
  })

  it('pairs by name first, then URL, then size, and leftovers in order', () => {
    const pairs = matchFrames(
      [
        frame(1, { url: 'https://a.example/x', width: 300, height: 200 }),
        frame(2, { name: 'pay', url: 'https://pay.example/form?id=2' }),
        frame(3, { url: 'https://ads.example/', width: 100, height: 50 })
      ],
      [
        slot('e1', { src: 'https://ads.example/', width: 100, height: 50 }),
        slot('e2', { src: 'https://pay.example/form?id=9', name: 'pay' }),
        slot('e3', { src: 'https://a.example/x' })
      ]
    )
    const byOwner = Object.fromEntries(pairs.map((p) => [p.owner.ref, p.frame.id]))
    expect(byOwner).toEqual({ e1: 3, e2: 2, e3: 1 })
  })

  it('never hands a same-origin frame to an unmatched slot (the parent script walked it itself)', () => {
    const pairs = matchFrames([frame(1, { sameOrigin: true }), frame(2)], [slot('e1'), slot('e2')])
    expect(pairs.map((p) => [p.frame.id, p.owner.ref])).toEqual([[2, 'e1']])
  })

  it('uses each frame and each slot at most once', () => {
    const pairs = matchFrames(
      [frame(1, { name: 'same' }), frame(2, { name: 'same' })],
      [slot('e1', { name: 'same' })]
    )
    expect(pairs).toHaveLength(1)
  })
})

describe('assembling one tree from frame snapshots', () => {
  const snap = (tree: string, frames: PageFrameSlot[] = []): PageSnapshot => ({
    url: '',
    title: '',
    viewport: { width: 1000, height: 800 },
    scroll: { x: 0, y: 0, height: 800 },
    tree,
    refs: 0,
    truncated: false,
    frames,
    seq: 0,
    docToken: 'd'
  })

  it('splices each frame under its <iframe> line, one level deeper', () => {
    const slot: PageFrameSlot = {
      ref: 'e2',
      index: 2,
      contentDepth: 2,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      src: '',
      name: '',
      title: ''
    }
    const tree: FrameTree = {
      node: TOP,
      snap: snap(
        '- heading "Top" [ref=e1]\n- group\n  - iframe "Pay" [ref=e2]\n- button "Done" [ref=e3]'
      ),
      slot: null,
      children: [
        {
          node: CHILD,
          snap: snap('- button "Pay now" [ref=e4]\n- text: "Secure"'),
          slot,
          children: []
        }
      ]
    }
    // `index` is the line the frame's content goes before (right after the iframe line).
    tree.children[0].slot!.index = 3
    expect(assemble(tree)).toEqual([
      '- heading "Top" [ref=e1]',
      '- group',
      '  - iframe "Pay" [ref=e2]',
      '    - button "Pay now" [ref=e4]',
      '    - text: "Secure"',
      '- button "Done" [ref=e3]'
    ])
  })

  it('finds every ref in a tree and normalises the shapes agents copy', () => {
    expect(refsIn('- a [ref=e1]\n  - b [ref=e12] x [ref=e3]')).toEqual(['e1', 'e12', 'e3'])
    for (const form of ['e12', '[ref=e12]', 'ref=e12', '@e12', ' ref: e12 '])
      expect(normalizeRef(form)).toBe('e12')
  })
})

describe('TabFrames', () => {
  it('keeps the ref floor above every ref it has seen and remembers frames', () => {
    const s = new TabFrames()
    s.noteRefs(['e1', 'e2'], 0)
    expect(s.nextSeq).toBe(3)
    s.noteRefs(['e3', 'e4'], 7)
    expect(s.nextSeq).toBe(5)
    expect(s.frameOf('e4')).toBe(7)
    expect(s.frameOf('[ref=e4]')).toBe(7)
    expect(s.frameOf('e1')).toBe(0)
    expect(s.frameOf('e99')).toBe(0)
    s.noteRef('e4', 0)
    expect(s.frameOf('e4')).toBe(0)
  })

  it('forgets refs and frames on a new document but never reuses numbers', () => {
    const s = new TabFrames()
    s.onDocument('doc-1')
    s.noteRefs(['e1', 'e2'], 7)
    s.nodes.push(CHILD)
    s.onDocument('doc-1')
    expect(s.frameOf('e2')).toBe(7)
    s.onDocument('doc-2')
    expect(s.frameOf('e2')).toBe(0)
    expect(s.nodes.map((n) => n.id)).toEqual([0])
    expect(s.nextSeq).toBe(3)
  })
})

describe('deep snapshots', () => {
  it('lists the cross-origin frame content under its iframe line with unique refs and top boxes', async () => {
    const page = signInPage()
    const snap = await deepSnapshot(page, { maxChars: 30_000, boxes: true })
    const lines = snap.tree.split('\n')
    expect(lines).toEqual([
      '- heading "Checkout" [box=20,20,400,40] [ref=e1]',
      '- iframe "Sign in with Google" [box=100,150,400,300] [ref=e2]',
      '  - button "Sign in with Google" [box=120,210,200,40] [ref=e4]',
      '  - textbox "Email" [box=120,270,300,30] [ref=e5]',
      '- button "Pay now" [box=20,600,200,40] [ref=e3]'
    ])
    const refs = refsIn(snap.tree)
    expect(new Set(refs).size).toBe(refs.length)
    expect(snap.refs).toBe(5)
    expect(page.state.frameOf('e4')).toBe(7)
    expect(page.state.frameOf('e3')).toBe(0)
    expect(snap.nodes.map((n) => [n.id, n.parentId, n.ownerRef, n.label])).toEqual([
      [0, null, null, ''],
      [7, 0, 'e2', 'Sign in with Google']
    ])
    expect(snap.nodes[1].box).toEqual({ x: 100, y: 150, width: 400, height: 300 })
  })

  it('keeps refs stable across snapshots', async () => {
    const page = signInPage()
    const first = await deepSnapshot(page, { maxChars: 30_000 })
    const second = await deepSnapshot(page, { maxChars: 30_000 })
    expect(second.tree).toBe(first.tree)
  })

  it('shows only the top document on hosts that cannot address frames', async () => {
    const page = signInPage(false)
    const snap = await deepSnapshot(page, { maxChars: 30_000 })
    expect(snap.tree).toContain('- iframe "Sign in with Google"')
    expect(snap.tree).not.toContain('Email')
    expect(snap.nodes).toHaveLength(1)
  })

  it('leaves the frame out when it is gone mid-snapshot', async () => {
    const page = signInPage()
    page.frameMap.delete(7)
    const snap = await deepSnapshot(page, { maxChars: 30_000 })
    expect(snap.tree).not.toContain('Email')
    expect(snap.tree).toContain('Pay now')
  })
})

describe('locating across frames', () => {
  it('resolves a frame ref through its frame and speaks top-viewport coordinates', async () => {
    const page = signInPage()
    await deepSnapshot(page, { maxChars: 30_000 })
    const loc = await locateTarget(page, 'e4')
    expect(loc).toMatchObject({
      ref: 'e4',
      frameId: 7,
      name: 'Sign in with Google',
      x: 100 + 120,
      y: 150 + 80,
      local: { x: 120, y: 80 },
      frameLabel: 'Sign in with Google',
      covered: false
    })
    // The frame's own runtime was asked, not the top document's.
    expect(page.frame(7).log.some((l) => l.method === 'locate' && l.args[1] === 'e4')).toBe(true)
    expect(page.frame(0).log.some((l) => l.method === 'locate')).toBe(false)
  })

  it('finds selectors and text in frames when the top document has no match', async () => {
    const page = signInPage()
    await deepSnapshot(page, { maxChars: 30_000 })
    const byText = await locateTarget(page, 'text=Email')
    expect(byText).toMatchObject({ frameId: 7, tag: 'input', x: 270, y: 285 })
    const top = await locateTarget(page, 'text=Pay now')
    expect(top).toMatchObject({ frameId: 0, frameLabel: null, x: 120, y: 620 })
    await expect(locateTarget(page, 'text=Nowhere')).rejects.toThrow(/No visible element/)
  })

  it('flags a frame element covered by something the top document paints over it', async () => {
    const page = signInPage()
    await deepSnapshot(page, { maxChars: 30_000 })
    page.frame(0).spec.elements.push({
      id: 'overlay',
      tag: 'div',
      role: 'dialog',
      name: 'Cookie banner',
      box: { x: 0, y: 0, width: 1000, height: 800 }
    })
    const loc = await locateTarget(page, 'e4')
    expect(loc.covered).toBe(true)
  })

  it('asks for a new snapshot when the frame behind a ref is gone', async () => {
    const page = signInPage()
    await deepSnapshot(page, { maxChars: 30_000 })
    page.detach(7)
    await expect(locateTarget(page, 'e4')).rejects.toThrow(/take a new browser_snapshot/)
  })

  it('descends into the frame under a point and reports the frame-local point too', async () => {
    const page = signInPage()
    const loc = await locateAtPoint(page, { x: 200, y: 230 })
    expect(loc).toMatchObject({
      frameId: 7,
      tag: 'button',
      name: 'Sign in with Google',
      x: 200,
      y: 230,
      local: { x: 100, y: 80 }
    })
    expect(loc.ref).toMatch(/^e\d+$/)
    expect(page.state.frameOf(loc.ref!)).toBe(7)
    const top = await locateAtPoint(page, { x: 30, y: 610 })
    expect(top).toMatchObject({ frameId: 0, name: 'Pay now', local: { x: 30, y: 610 } })
    await expect(locateAtPoint(page, { x: 5000, y: 5 })).rejects.toThrow(/outside the viewport/)
  })

  it('names the iframe itself when the host cannot reach inside it', async () => {
    const page = signInPage(false)
    const loc = await locateAtPoint(page, { x: 200, y: 230 })
    expect(loc).toMatchObject({ frameId: 0, tag: 'iframe' })
  })
})
