import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Rect } from '@shared/types'
import {
  HOVER_CARD_DELAY,
  HOVER_CARD_LEAVE_GRACE,
  HoverCardController,
  hoverCardHost,
  placeHoverCard,
  type HoverCardState
} from '../hoverCard'
import { createStore } from '../store'

const viewport = { width: 1600, height: 1000 }
const card = { width: 320, height: 92 }
const sidebarLeft: Rect = { x: 0, y: 0, width: 240, height: 1000 }
const row = (y: number): Rect => ({ x: 8, y, width: 224, height: 36 })

describe('placeHoverCard', () => {
  it('sits flush against a left sidebar, start-aligned with the row', () => {
    expect(placeHoverCard(row(120), sidebarLeft, viewport, card)).toEqual({ left: 240, top: 120 })
  })

  it('goes to the left of a sidebar on the right', () => {
    const sidebarRight: Rect = { x: 1360, y: 0, width: 240, height: 1000 }
    expect(placeHoverCard({ ...row(120), x: 1368 }, sidebarRight, viewport, card)).toEqual({
      left: 1040,
      top: 120
    })
  })

  it('slides up to stay 8 px inside the window for a row near the bottom', () => {
    expect(placeHoverCard(row(960), sidebarLeft, viewport, card).top).toBe(1000 - 92 - 8)
  })

  it('never starts above the margin', () => {
    expect(placeHoverCard(row(2), sidebarLeft, viewport, card).top).toBe(8)
  })

  it('keeps the card inside a narrow window', () => {
    const narrow = { width: 500, height: 600 }
    expect(placeHoverCard(row(100), sidebarLeft, narrow, card).left).toBe(500 - 320 - 8)
  })
})

describe('hoverCardHost', () => {
  it('shows the host of a web page without a leading www', () => {
    expect(hoverCardHost('https://www.example.com/a/b?c#d')).toBe('example.com')
    expect(hoverCardHost('http://docs.example.org:8080/x')).toBe('docs.example.org')
  })

  it('shows the address of a Zenium page, the word for a file, nothing for a blank tab', () => {
    expect(hoverCardHost('zen://settings/?pane=tabs')).toBe('zen://settings')
    expect(hoverCardHost('file:///home/me/notes.html')).toBe('File on this computer')
    expect(hoverCardHost('about:blank')).toBe('')
    expect(hoverCardHost('')).toBe('')
  })
})

describe('HoverCardController', () => {
  const box = (y: number): { anchor: Rect; sidebar: Rect } => ({
    anchor: row(y),
    sidebar: sidebarLeft
  })
  let store: ReturnType<typeof createStore<HoverCardState>>
  let ctl: HoverCardController
  // The card shows once `prepare` (the page capture) has settled: a timer step flushes it.
  const wait = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    store = createStore<HoverCardState>({ tabId: null, anchor: null, sidebar: null, by: null })
    ctl = new HoverCardController(store)
  })
  afterEach(() => vi.useRealTimers())

  it('shows the card once the pointer has rested on the row', async () => {
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY - 1)
    expect(store.get().tabId).toBeNull()
    await wait(1)
    expect(store.get()).toEqual({
      tabId: 'a',
      anchor: row(100),
      sidebar: sidebarLeft,
      by: 'pointer'
    })
  })

  it('a pointer that leaves before the delay shows nothing', async () => {
    ctl.pointerEnter('a', () => box(100))
    await wait(400)
    ctl.pointerLeave('a')
    await wait(HOVER_CARD_DELAY)
    expect(store.get().tabId).toBeNull()
  })

  it('moves to the next row at once while a card is up, and leaves with the pointer', async () => {
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY)
    // The leave of one row fires before the enter of the next: the card holds through the
    // grace and moves to the neighbour without another wait.
    ctl.pointerLeave('a')
    expect(store.get().tabId).toBe('a')
    await wait(HOVER_CARD_LEAVE_GRACE - 1)
    ctl.pointerEnter('b', () => box(138))
    await wait(0)
    expect(store.get().tabId).toBe('b')
    expect(store.get().anchor?.y).toBe(138)
    await wait(HOVER_CARD_DELAY)
    expect(store.get().tabId).toBe('b')
    // Into the gap past the rows: the grace runs out and the card goes.
    ctl.pointerLeave('b')
    await wait(HOVER_CARD_LEAVE_GRACE)
    expect(store.get().tabId).toBeNull()
    // Back on a row: a fresh wait.
    ctl.pointerEnter('c', () => box(176))
    await wait(0)
    expect(store.get().tabId).toBeNull()
    await wait(HOVER_CARD_DELAY)
    expect(store.get().tabId).toBe('c')
  })

  it('keyboard focus shows the card at once and blur takes it down', async () => {
    ctl.focus('a', () => box(100))
    await wait(0)
    expect(store.get()).toMatchObject({ tabId: 'a', by: 'focus' })
    // The pointer leaving a row does not touch a card that focus put up.
    ctl.pointerLeave('a')
    await wait(HOVER_CARD_LEAVE_GRACE)
    expect(store.get().tabId).toBe('a')
    ctl.blur('a')
    await wait(HOVER_CARD_LEAVE_GRACE)
    expect(store.get().tabId).toBeNull()
  })

  it('focus walking to the next row moves the card without taking it down', async () => {
    const seen: Array<string | null> = []
    store.subscribe(() => seen.push(store.get().tabId))
    ctl.focus('a', () => box(100))
    await wait(0)
    // Blur and focus fire in the same turn when focus moves.
    ctl.blur('a')
    ctl.focus('b', () => box(138))
    await wait(HOVER_CARD_LEAVE_GRACE)
    expect(store.get()).toMatchObject({ tabId: 'b', by: 'focus', anchor: row(138) })
    expect(seen).toEqual(['a', 'b'])
  })

  it('hide() drops a pending card as well as a shown one', async () => {
    ctl.pointerEnter('a', () => box(100))
    ctl.hide()
    await wait(HOVER_CARD_DELAY)
    expect(store.get().tabId).toBeNull()
    ctl.focus('a', () => box(100))
    ctl.hide()
    await wait(0)
    expect(store.get().tabId).toBeNull()
    expect(ctl.showing()).toBe(false)
  })

  it('a row that left the DOM before the delay shows nothing', async () => {
    ctl.pointerEnter('a', () => null)
    await wait(HOVER_CARD_DELAY)
    expect(store.get().tabId).toBeNull()
  })

  it('waits for the page capture, and a pointer that leaves meanwhile leaves nothing behind', async () => {
    let release: () => void = () => undefined
    const prepare = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    ctl = new HoverCardController(store, prepare)
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(store.get().tabId).toBeNull()
    ctl.pointerLeave('a')
    release()
    await wait(0)
    expect(store.get().tabId).toBeNull()
    // The pointer that stays gets its card when the capture lands.
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY)
    expect(prepare).toHaveBeenCalledTimes(2)
    release()
    await wait(0)
    expect(store.get().tabId).toBe('a')
  })

  it('the pointer coming back to the shown row drops a card on its way to another', async () => {
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY)
    ctl.pointerLeave('a')
    ctl.pointerEnter('b', () => box(138))
    ctl.pointerLeave('b')
    ctl.pointerEnter('a', () => box(100))
    await wait(HOVER_CARD_DELAY)
    expect(store.get()).toMatchObject({ tabId: 'a', anchor: row(100) })
  })
})
