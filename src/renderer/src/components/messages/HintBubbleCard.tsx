import type { JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
import type { HintBubble } from '@renderer/lib/iph'
import { hintArrowX, hintBubbleLeft } from './stack'

interface Props {
  bubble: HintBubble
  /** On its way out: the stylesheet fades it (Chrome's `textbubble_out`, 200 ms). */
  leaving: boolean
  /** Report the card's height once laid out (the layer sizes the page's cover from it). */
  onMeasure?: (height: number) => void
}

/**
 * The in-product help bubble (TB-19): one sentence in a card with an arrow at the bar control it
 * points at, at the message layer's edge on the bar's side, as Chrome's `TextBubble` sits at
 * its anchor with a 4 dp margin (`text_bubble_margin`). It is placed once, as it goes up: the
 * anchor's box was read by the hook that showed it, the layer's and the card's own here in one
 * layout effect – the only layout read of the whole education – and written as `left` and the
 * arrow's offset; nothing tracks the anchor after that, because whatever moves the anchor (a
 * touch, a scroll, a rotation, the keyboard) takes the bubble down first
 * (`useTabSwitcherHint`). A status region: a screen reader hears the sentence as it arrives,
 * and the card takes no focus, as Chrome's popup is not focusable.
 */
export function HintBubbleCard({ bubble, leaving, onMeasure }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const layer = el?.parentElement
    if (!el || !layer) return
    const box = layer.getBoundingClientRect()
    const width = el.offsetWidth
    const anchorX = bubble.anchor.x + bubble.anchor.width / 2 - box.left
    const left = hintBubbleLeft(anchorX, width, box.width)
    el.style.left = `${left}px`
    el.style.setProperty('--zen-hint-arrow-x', `${hintArrowX(anchorX, left, width)}px`)
    onMeasure?.(el.offsetHeight)
  }, [bubble, onMeasure])
  return (
    <div
      ref={ref}
      className="zen-message zen-hint-bubble"
      data-surface="page"
      data-edge={bubble.edge}
      data-anchor={bubble.anchorItem}
      data-leaving={leaving || undefined}
      role="status"
    >
      <span className="zen-message-text">{bubble.text}</span>
    </div>
  )
}
