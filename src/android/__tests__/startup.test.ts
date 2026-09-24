import { describe, expect, it } from 'vitest'
import type { Bridge } from '../bridge'
import { ChromeReady, type ReadyInsets, type ReadyStore } from '../startup'

/*
 * The chrome's READY for the host's splash and startup mark (OS-26, OS-27; `startup.ts`): one
 * `chrome.ready` post, on the frame after the last of four facts – the core started, the theme
 * painted, the host's insets applied, the page slot placed under those insets – and never before
 * any of them, never twice, never on a timer.
 */

const ZERO: ReadyInsets = { top: 0, right: 0, bottom: 0, left: 0 }
const BARS: ReadyInsets = { top: 24, right: 0, bottom: 48, left: 0 }

class FakeStore implements ReadyStore {
  private insets: ReadyInsets = { ...ZERO }
  private readonly listeners = new Set<() => void>()
  get(): { insets: ReadyInsets } {
    return { insets: this.insets }
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  get subscribers(): number {
    return this.listeners.size
  }
  /** `applyHostInsets`: the store takes the numbers, and its subscribers hear of it. */
  apply(insets: ReadyInsets): void {
    this.insets = { ...insets }
    for (const listener of this.listeners) listener()
  }
}

function harness(bootInsets: ReadyInsets = BARS): {
  ready: ChromeReady
  store: FakeStore
  posts: string[]
  frames: Array<() => void>
  paint(): void
  /** Run every animation frame callback queued so far. */
  tick(): void
} {
  const posts: string[] = []
  const frames: Array<() => void> = []
  const bridge = {
    post: (method: string) => {
      posts.push(method)
    },
    send: () => {},
    call: async () => undefined,
    callSync: () => undefined,
    batched: () => {}
  } as unknown as Bridge
  const store = new FakeStore()
  const target = new EventTarget()
  const ready = new ChromeReady(bridge, {
    insets: bootInsets,
    store,
    paintTarget: target,
    paintEvent: 'zen-theme-painted',
    frame: (callback) => {
      frames.push(callback)
    }
  })
  return {
    ready,
    store,
    posts,
    frames,
    paint: () => target.dispatchEvent(new Event('zen-theme-painted')),
    tick: () => {
      const due = frames.splice(0)
      for (const callback of due) callback()
    }
  }
}

describe('ChromeReady', () => {
  it('posts chrome.ready on the frame after the core started, the theme painted, the insets applied and the slot placed', () => {
    const h = harness()
    h.ready.arm(true)
    expect(h.posts).toEqual([])
    h.paint()
    expect(h.posts).toEqual([])
    // The inset-less first layout places the slot: not under the host's insets, does not count.
    h.ready.placed()
    expect(h.ready.state.placed).toBe(false)
    h.store.apply(BARS)
    expect(h.ready.state.insetsApplied).toBe(true)
    expect(h.posts).toEqual([])
    // The re-measure after the insets places it again: this one counts.
    h.ready.placed()
    expect(h.posts).toEqual([])
    expect(h.frames).toHaveLength(1)
    h.tick()
    expect(h.posts).toEqual(['chrome.ready'])
  })

  it('waits for the paint however late it comes, and posts once', () => {
    const h = harness()
    h.store.apply(BARS)
    h.ready.placed()
    h.ready.arm(true)
    expect(h.frames).toHaveLength(0)
    h.paint()
    h.tick()
    expect(h.posts).toEqual(['chrome.ready'])
    // Nothing after the post: not a second placement, not a repaint, not a new arm.
    h.ready.placed()
    h.ready.arm(true)
    h.store.apply(BARS)
    h.tick()
    expect(h.posts).toEqual(['chrome.ready'])
    expect(h.store.subscribers).toBe(0)
  })

  it('needs no placement when the boot has no page to place (a chrome page active)', () => {
    const h = harness()
    h.paint()
    h.store.apply(BARS)
    h.ready.arm(false)
    h.tick()
    expect(h.posts).toEqual(['chrome.ready'])
  })

  it('counts the insets applied when the host measured none (nothing for the chrome to apply)', () => {
    const h = harness(ZERO)
    h.ready.arm(true)
    h.paint()
    h.ready.placed()
    h.tick()
    expect(h.posts).toEqual(['chrome.ready'])
  })

  it('follows the host to new insets: a placement under the old ones stops counting', () => {
    const h = harness(BARS)
    h.ready.arm(true)
    h.paint()
    h.store.apply(BARS)
    h.ready.placed()
    // Before the frame runs, the host measures again (a turn, the bars' way back): the chrome
    // has not applied these yet – but READY is already on its way, and stays sent once.
    h.tick()
    expect(h.posts).toEqual(['chrome.ready'])
    // The same sequence with the host's second measurement landing before the placement:
    const g = harness(BARS)
    g.ready.arm(true)
    g.paint()
    g.store.apply(BARS)
    g.ready.hostInsets({ top: 24, right: 0, bottom: 0, left: 0 })
    g.ready.placed()
    g.tick()
    expect(g.posts).toEqual([])
    g.store.apply({ top: 24, right: 0, bottom: 0, left: 0 })
    g.tick()
    expect(g.posts).toEqual([])
    g.ready.placed()
    g.tick()
    expect(g.posts).toEqual(['chrome.ready'])
  })

  it('never posts on its own: no fact, no frame', () => {
    const h = harness()
    h.ready.arm(true)
    h.paint()
    h.store.apply(BARS)
    h.tick()
    expect(h.frames).toHaveLength(0)
    expect(h.posts).toEqual([])
  })
})
