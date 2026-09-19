// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useOnScreen } from '../useOnScreen'

/*
 * The overview grid's word per card on whether it is on screen (hooks/useOnScreen.ts): an
 * `IntersectionObserver` rooted at the card's scroller, not the viewport – the viewport's
 * observer clips a card by the grid's box first, and no margin brings back a card the grid has
 * scrolled away, so a lookahead of a row only works measured against the grid itself.
 */

interface Observed {
  root: Element | Document | null
  rootMargin: string
  target: Element
  fire(isIntersecting: boolean): void
  disconnected: boolean
}

const observers: Observed[] = []

class FakeObserver {
  private readonly record: Observed
  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {}
  ) {
    this.record = {
      root: options.root ?? null,
      rootMargin: options.rootMargin ?? '0px',
      target: document.body,
      fire: (isIntersecting) =>
        this.callback(
          [{ isIntersecting, target: this.record.target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver
        ),
      disconnected: false
    }
  }
  observe(target: Element): void {
    this.record.target = target
    observers.push(this.record)
  }
  disconnect(): void {
    this.record.disconnected = true
  }
  unobserve(): void {
    // The hook disconnects; nothing is unobserved one by one.
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

function Probe({ margin }: { margin?: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const visible = useOnScreen(ref, margin)
  return <div ref={ref} data-visible={String(visible)} />
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const probe = (): HTMLElement => container.querySelector('[data-visible]') as HTMLElement

describe('a card asking whether it is on screen', () => {
  it('watches from its scroller, a row past its edges, and follows what the observer says', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const grid = document.createElement('div')
    scroller.appendChild(grid)
    container.appendChild(scroller)
    const cell = createRoot(grid)
    act(() => cell.render(createElement(Probe, { margin: '35% 0px' })))
    expect(observers).toHaveLength(1)
    const [watch] = observers
    // Rooted at the nearest scroller, with the margin the caller asked for.
    expect(watch!.root).toBe(scroller)
    expect(watch!.rootMargin).toBe('35% 0px')
    expect(watch!.target).toBe(grid.querySelector('[data-visible]'))
    // Unknown until the observer has spoken; then its word, both ways.
    expect(grid.querySelector('[data-visible]')!.getAttribute('data-visible')).toBe('false')
    act(() => watch!.fire(true))
    expect(grid.querySelector('[data-visible]')!.getAttribute('data-visible')).toBe('true')
    act(() => watch!.fire(false))
    expect(grid.querySelector('[data-visible]')!.getAttribute('data-visible')).toBe('false')
    act(() => cell.unmount())
    expect(watch!.disconnected).toBe(true)
  })

  it('watches from the viewport when nothing above it scrolls', () => {
    act(() => root.render(createElement(Probe)))
    expect(observers).toHaveLength(1)
    expect(observers[0]!.root).toBeNull()
    expect(observers[0]!.rootMargin).toBe('0px')
    expect(probe().getAttribute('data-visible')).toBe('false')
  })

  it('is on screen throughout where there is no observer', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    act(() => root.render(createElement(Probe)))
    expect(observers).toHaveLength(0)
    expect(probe().getAttribute('data-visible')).toBe('true')
  })
})
