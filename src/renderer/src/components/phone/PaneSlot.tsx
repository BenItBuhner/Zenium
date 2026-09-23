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
 * pane comes up in the slot; `scrollTop` is where the pane's grid was scrolled to; `theme` the
 * window's polarity (the root's `data-theme`) as the still was taken, the one it is drawn under.
 */
export interface PaneStill {
  key: number
  node: HTMLElement
  rect: Rect
  scrollTop: number
  theme: string
}

interface SlotProps {
  pane: string
  /** The overview root: the slot's box is taken in its layout space, the entrance scale divided out. */
  root: RefObject<HTMLElement | null>
  onLeave: (still: PaneStill) => void
  className: string
  /**
   * A still of the pane before is up over the slot: `data-switching` on the slot, for a surface
   * whose fade in is the switch's alone and not its entrance (the sidebar's pose; the overview's
   * pane fades in on its own class whenever it comes up).
   */
  switching?: boolean
  children: ReactNode
}

/**
 * The slot the overview's pane fills – and the tablet sidebar's pose (`Sidebar`), which switches
 * the same way. A pane switch is a cross-fade (v2 §11.4): the pane that leaves stays in view
 * 120 ms fading out while the next fades in over the same slot, the way `Departures` keeps a
 * closed card in view while the grid closes its gap. React takes the old pane out of the
 * document in the commit that brings the new one, so its still is taken just before, in
 * `getSnapshotBeforeUpdate` – the one read of the DOM as it stood before a commit, which only a
 * class component has (and which StrictMode does not replay).
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
    const { pane, className, switching, children } = this.props
    // A key per pane: the pane comes up fresh, its cells and its fade with it.
    return (
      <div key={pane} ref={this.el} className={className} data-switching={switching || undefined}>
        {children}
      </div>
    )
  }
}

let stillSeq = 0

/**
 * The hooks a still sheds. A still is a picture, not the pane: its cells belong to no FLIP set
 * (`data-cell`), its rows to no strip – lib/tabStrip.ts finds the strip's items by
 * `data-strip-item`, lib/drag.ts its lists by `data-tab-scroller` / `data-tab-list` and its
 * targets by `data-drop`, lib/dnd.ts the New Tab row, the Essentials and a space's target – and
 * its hooks to no test; its own entrance fade must not play again over the fade out
 * (`zen-overview-pane`). The pane's content keeps its `data-pane`.
 */
const HOOKS = [
  'data-cell',
  'data-testid',
  'data-strip-item',
  'data-strip-parent',
  'data-tab-id',
  'data-tab-scroller',
  'data-tab-list',
  'data-tab-folder',
  'data-new-tab',
  'data-drop',
  'data-essentials',
  'data-space-target',
  'data-strip-empty'
]

/** The pane's scroller, whose place the still keeps: the overview's grid, or the sidebar's list in view. */
const SCROLLER = '.zen-overview-grid, [data-tab-scroller][data-active="true"]'

/** The pane's box in the root's layout space, and a copy of its DOM that nothing finds or touches. */
function takeStill(el: HTMLElement, root: HTMLElement): PaneStill {
  const r = el.getBoundingClientRect()
  const rr = root.getBoundingClientRect()
  const scale = root.offsetWidth ? rr.width / root.offsetWidth : 1
  const scrollTop = el.querySelector<HTMLElement>(SCROLLER)?.scrollTop ?? 0
  const node = el.cloneNode(true) as HTMLElement
  // The copy's scroller is marked before the hooks go, so the still finds it to scroll it.
  node.querySelector<HTMLElement>(SCROLLER)?.setAttribute('data-still-scroller', '')
  node.classList.remove('zen-overview-pane')
  for (const hook of node.querySelectorAll(
    [...HOOKS.map((attr) => `[${attr}]`), '.zen-overview-grid'].join(', ')
  )) {
    for (const attr of HOOKS) hook.removeAttribute(attr)
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
    scrollTop,
    theme: el.ownerDocument.documentElement.dataset.theme ?? ''
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
    const scroller = el.querySelector<HTMLElement>('[data-still-scroller]')
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
  // A still is a picture of the pane under the polarity it left in: its rows read the window's
  // live tokens, and §11.6's blend cuts the ink at its midpoint – a still outliving the cut (a
  // slow frame, reduced motion's cut at once) would draw the rows that left in the other pose's
  // ink. main.css draws no still whose `data-still-theme` is not the root's.
  return (
    <div
      ref={ref}
      className="zen-pane-still pointer-events-none absolute z-10 flex flex-col overflow-hidden"
      aria-hidden
      inert
      data-testid="pane-still"
      data-still-theme={still.theme || undefined}
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
