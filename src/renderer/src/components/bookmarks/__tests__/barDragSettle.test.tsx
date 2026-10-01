// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode } from '@shared/types'
import { BOOKMARKS_BAR_ID, BookmarkTree } from '@shared/bookmarks'
import { MOTION_STATE_MS } from '@renderer/lib/motion/tokens'
import { ChipMotion } from '../chipMotion'
import { useBarDrag } from '../useBarDrag'

/*
 * The end of a bar drag (W8-M1b D6; motion spec §10): the ghost's fade is the drag's last
 * motion, and the drag settles when that ends – on the ghost's own `transitionend` for its
 * opacity, read at 0 – with the timed wait a little past the fade's length kept as the fallback
 * for the ends that never come (reduced motion's cut, a hidden or detached ghost). One settle
 * whichever comes first: the end withdraws the timer, the timer the listener. The drag's
 * geometry is `useBarDrag`'s own concern and the bar's tests'; here the hook runs in a bare
 * harness – a strip of chips, a folder panel's drop zone, the ghost – with no layout to speak
 * of (happy-dom's boxes are all zero), so a pointer off the band cancels and one on the panel's
 * list files into the folder.
 */

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const node = (
  id: string,
  parentId: string,
  index: number,
  type: 'url' | 'folder',
  title: string
): BookmarkNode =>
  ({
    id,
    parentId,
    index,
    type,
    title,
    url: type === 'url' ? `https://${id}.example/` : undefined,
    dateAdded: 0
  }) as BookmarkNode

const tree = new BookmarkTree([
  node(BOOKMARKS_BAR_ID, '0', 0, 'folder', 'Bookmarks bar'),
  node('docs', BOOKMARKS_BAR_ID, 0, 'url', 'Docs'),
  node('reading', BOOKMARKS_BAR_ID, 1, 'folder', 'Reading'),
  node('news', BOOKMARKS_BAR_ID, 2, 'url', 'News')
])
const items = tree.children(BOOKMARKS_BAR_ID)

function Harness({ motion }: { motion: ChipMotion }): ReactElement {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const { drag, startDrag, ghostRef } = useBarDrag({
    tree,
    barId: BOOKMARKS_BAR_ID,
    items,
    visibleCount: items.length,
    stripRef,
    motion,
    onHoldFolder: () => undefined
  })
  return (
    <div>
      <div ref={stripRef} className="strip">
        {items.map((n) => (
          <button
            key={n.id}
            data-bm-id={n.id}
            onPointerDown={(e) => startDrag(e, n, e.currentTarget)}
          >
            {n.title}
          </button>
        ))}
      </div>
      <div data-bar-panel="">
        <div data-bar-drop="list:reading" />
      </div>
      {drag && (
        <div ref={ghostRef} className="ghost" data-settling={drag.settling}>
          <span className="label">{drag.node.title}</span>
        </div>
      )}
    </div>
  )
}

let frames: Array<(now: number) => void> = []
let now = 1000
/** One animation frame `ms` after the last, as the display would raise it. */
const frame = (ms = 16): void => {
  now += ms
  const batch = frames
  frames = []
  act(() => {
    for (const cb of batch) cb(now)
  })
}
/** Frames until nothing asks for another: the springs at rest. */
const rest = (max = 600): void => {
  for (let i = 0; i < max && frames.length; i++) frame()
}

let root: Root | null = null
let mount: HTMLElement | null = null
let motion: ChipMotion

function render(): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<Harness motion={motion} />))
}

const chip = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-bm-id="${id}"]`)!
const ghost = (): HTMLElement | null => document.querySelector<HTMLElement>('.ghost')
const dropZone = (): Element => document.querySelector('[data-bar-drop="list:reading"]')!

const pointer = (
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  target: EventTarget,
  x: number,
  y: number
): void => {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: type === 'pointermove' ? -1 : 0,
        pointerType: 'mouse',
        clientX: x,
        clientY: y
      })
    )
  })
}

/** The mouse picks `id` up and carries it to `x`, `y` (past the 5 px threshold on the way). */
function lift(id: string, x: number, y: number): HTMLElement {
  pointer('pointerdown', chip(id), 20, 4)
  pointer('pointermove', window, 30, 4)
  pointer('pointermove', window, x, y)
  const el = ghost()
  if (!el) throw new Error('no ghost')
  return el
}

/** The ghost's fade reaching its end (happy-dom runs no transitions: the browser's event, by hand). */
function fadeEnds(target: Element, propertyName = 'opacity'): void {
  const e = new Event('transitionend', { bubbles: true })
  Object.defineProperty(e, 'propertyName', { value: propertyName })
  act(() => {
    target.dispatchEvent(e)
  })
}

beforeEach(() => {
  frames = []
  now = 1000
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.splice(id - 1, 1)
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  // Nothing under the pointer: a lift off the band cancels. A test that files into the folder
  // puts the panel's list under it.
  document.elementFromPoint = () => null
  motion = new ChipMotion()
  render()
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  motion.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the end of a bar drag settles on the ghost’s fade (W8-M1b D6)', () => {
  it('into a folder: the fade begins at once, and its end settles the drag before the timer would', () => {
    document.elementFromPoint = () => dropZone()
    const el = lift('docs', 300, 200)
    const removed = vi.spyOn(el, 'removeEventListener')
    pointer('pointerup', window, 300, 200)
    // Settling: the ghost stands, fading, with the fallback armed.
    expect(ghost()).toBe(el)
    expect(el.dataset.settling).toBe('true')
    expect(el.style.transition).toBe(`opacity ${MOTION_STATE_MS}ms var(--zen-ease)`)
    expect(el.style.opacity).toBe('0')
    expect(vi.getTimerCount()).toBe(1)
    // Well before the fallback, the fade ends: the drag is over, the timer withdrawn.
    vi.advanceTimersByTime(MOTION_STATE_MS - 20)
    expect(ghost()).toBe(el)
    fadeEnds(el)
    expect(ghost()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(removed).toHaveBeenCalledWith('transitionend', expect.any(Function))
    // The timer's hour passes with nothing left to do.
    vi.advanceTimersByTime(MOTION_STATE_MS)
    expect(ghost()).toBeNull()
  })

  it('no end comes: the fallback settles the drag a little past the fade, and the listener goes with it', () => {
    document.elementFromPoint = () => dropZone()
    const el = lift('docs', 300, 200)
    const removed = vi.spyOn(el, 'removeEventListener')
    pointer('pointerup', window, 300, 200)
    expect(el.style.opacity).toBe('0')
    act(() => vi.advanceTimersByTime(MOTION_STATE_MS + 9))
    expect(ghost()).toBe(el)
    act(() => vi.advanceTimersByTime(1))
    expect(ghost()).toBeNull()
    expect(removed).toHaveBeenCalledWith('transitionend', expect.any(Function))
    // An end arriving late finds nothing to settle.
    fadeEnds(el)
    expect(ghost()).toBeNull()
  })

  it('home on the gentle spring: the fade begins at rest, and its end settles the drag', () => {
    const el = lift('docs', 300, 200)
    pointer('pointerup', window, 300, 200)
    // Off the band: the ghost springs back to its slot, not yet fading.
    expect(el.dataset.settling).toBe('true')
    expect(el.style.transition).toBe(`opacity ${MOTION_STATE_MS}ms var(--zen-ease)`)
    expect(el.style.opacity).toBe('')
    expect(frames.length).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBe(0)
    frame()
    expect(el.style.opacity).toBe('')
    rest()
    // At rest the fade begins and the fallback is armed; the fade's end settles.
    expect(el.style.opacity).toBe('0')
    expect(vi.getTimerCount()).toBe(1)
    expect(ghost()).toBe(el)
    fadeEnds(el)
    expect(ghost()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('under reduced motion the spring jumps home and the fade is a cut: the fallback settles', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    const el = lift('docs', 300, 200)
    pointer('pointerup', window, 300, 200)
    // Home at once: the fade's opacity is written, no frame asked for, the fallback armed.
    expect(frames.length).toBe(0)
    expect(el.style.opacity).toBe('0')
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(MOTION_STATE_MS + 10))
    expect(ghost()).toBeNull()
  })

  it('an end that is not the fade’s leaves the drag standing: a child’s, another property’s, the tint’s run while the ghost still shows', () => {
    document.elementFromPoint = () => dropZone()
    const el = lift('docs', 300, 200)
    pointer('pointerup', window, 300, 200)
    // The label's own transition ending bubbles up: not the ghost's.
    fadeEnds(el.querySelector('.label')!)
    expect(ghost()).toBe(el)
    // The ghost's, but of another property.
    fadeEnds(el, 'transform')
    expect(ghost()).toBe(el)
    // The ghost's opacity, but still showing: the folder tint's run (`data-into`) ending a
    // frame after the fade began, not the fade.
    el.style.opacity = '0.45'
    fadeEnds(el)
    expect(ghost()).toBe(el)
    el.style.opacity = '0'
    fadeEnds(el)
    expect(ghost()).toBeNull()
  })

  it('a drag begun again while the last one fades is not settled by the last one’s end or timer', () => {
    document.elementFromPoint = () => dropZone()
    const first = lift('docs', 300, 200)
    pointer('pointerup', window, 300, 200)
    expect(first.style.opacity).toBe('0')
    // A new lift before the fade ends: the first ghost goes with its drag, the second stands.
    const second = lift('news', 300, 200)
    expect(second).not.toBe(first)
    expect(second.dataset.settling).toBe('false')
    fadeEnds(first)
    expect(ghost()).toBe(second)
    act(() => vi.advanceTimersByTime(MOTION_STATE_MS + 10))
    expect(ghost()).toBe(second)
  })
})
