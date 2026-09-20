import { Component, createRef, useLayoutEffect, useRef } from 'react'
import type { JSX, ReactNode, RefObject } from 'react'
import type { Rect } from '@shared/types'
import { REDUCED_FADE_MS } from '@renderer/lib/motion/flip'

/** How long a pane switch's cross-fade runs, each way (v2 §11.4); the same under reduced motion. */
export const PANE_FADE_MS = REDUCED_FADE_MS
/** `--zen-ease`, for the Web Animations API (which cannot read a custom property). */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/**
 * A pane on its way out: a still of it – its DOM, copied – drawn where it stood while the next
 * pane comes up in the slot; `scrollTop` is where the pane's grid was scrolled to.
 */
export interface PaneStill {
  key: number
  node: HTMLElement
  rect: Rect
  scrollTop: number
}

interface SlotProps {
  pane: string
  /** The overview root: the slot's box is taken in its layout space, the entrance scale divided out. */
  root: RefObject<HTMLElement | null>
  onLeave: (still: PaneStill) => void
  className: string
  children: ReactNode
}

/**
 * The slot the overview's pane fills. A pane switch is a cross-fade (v2 §11.4): the pane that
 * leaves stays in view 120 ms fading out while the next fades in over the same slot, the way
 * `Departures` keeps a closed card in view while the grid closes its gap. React takes the old
 * pane out of the document in the commit that brings the new one, so its still is taken just
 * before, in `getSnapshotBeforeUpdate` – the one read of the DOM as it stood before a commit,
 * which only a class component has (and which StrictMode does not replay).
 */
export class PaneSlot extends Component<SlotProps> {
  private readonly el = createRef<HTMLDivElement>()

  getSnapshotBeforeUpdate(prev: SlotProps): PaneStill | null {
    const el = this.el.current
    const root = this.props.root.current
    if (prev.pane === this.props.pane || !el || !root) return null
    return takeStill(el, root)
  }

  componentDidUpdate(_prev: SlotProps, _state: unknown, still: PaneStill | null): void {
    if (still) this.props.onLeave(still)
  }

  render(): JSX.Element {
    const { pane, className, children } = this.props
    // A key per pane: the pane comes up fresh, its cells and its fade with it.
    return (
      <div key={pane} ref={this.el} className={className}>
        {children}
      </div>
    )
  }
}

let stillSeq = 0

/** The pane's box in the root's layout space, and a copy of its DOM that nothing finds or touches. */
function takeStill(el: HTMLElement, root: HTMLElement): PaneStill {
  const r = el.getBoundingClientRect()
  const rr = root.getBoundingClientRect()
  const scale = root.offsetWidth ? rr.width / root.offsetWidth : 1
  const scrollTop = el.querySelector<HTMLElement>('.zen-overview-grid')?.scrollTop ?? 0
  const node = el.cloneNode(true) as HTMLElement
  // A still is a picture, not the pane: its cells belong to no FLIP set, its hooks to no one,
  // and its own entrance fade must not play again over the fade out. The pane's content keeps
  // its `data-pane`, by which the still finds its scroller.
  node.classList.remove('zen-overview-pane')
  for (const hook of node.querySelectorAll('[data-cell], [data-testid], .zen-overview-grid')) {
    hook.removeAttribute('data-cell')
    hook.removeAttribute('data-testid')
    hook.classList.remove('zen-overview-grid')
  }
  return {
    key: ++stillSeq,
    node,
    rect: {
      x: (r.left - rr.left) / scale,
      y: (r.top - rr.top) / scale,
      width: r.width / scale,
      height: r.height / scale
    },
    scrollTop
  }
}

/** The panes on their way out, each fading over the slot it left (v2 §11.4). */
export function PaneStills({
  stills,
  onDone
}: {
  stills: PaneStill[]
  onDone: (key: number) => void
}): JSX.Element | null {
  if (stills.length === 0) return null
  return (
    <>
      {stills.map((still) => (
        <Still key={still.key} still={still} onDone={onDone} />
      ))}
    </>
  )
}

function Still({
  still,
  onDone
}: {
  still: PaneStill
  onDone: (key: number) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.replaceChildren(still.node)
    const scroller = el.querySelector<HTMLElement>('[data-pane]')
    if (scroller) scroller.scrollTop = still.scrollTop
    // 1 → 0 over the same 120 ms the pane coming up takes 0 → 1, reduced motion included (v2
    // §11.4 as amended: content changing in place on a window strip fades the same there).
    const fade = el.animate?.([{ opacity: 1 }, { opacity: 0 }], {
      duration: PANE_FADE_MS,
      easing: EASE,
      fill: 'forwards'
    })
    // A cancelled animation rejects its `finished` promise, which nobody awaits.
    fade?.finished?.catch(() => undefined)
    const done = (): void => onDone(still.key)
    if (fade) fade.onfinish = done
    const timer = fade ? null : setTimeout(done, PANE_FADE_MS)
    return () => {
      fade?.cancel()
      if (timer !== null) clearTimeout(timer)
    }
  }, [still, onDone])
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-10 flex flex-col overflow-hidden"
      aria-hidden
      inert
      data-testid="overview-pane-still"
      style={{
        left: still.rect.x,
        top: still.rect.y,
        width: still.rect.width,
        height: still.rect.height,
        willChange: 'opacity'
      }}
    />
  )
}
