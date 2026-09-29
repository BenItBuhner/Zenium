import type { JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { HINT_BUBBLE_ID, type HintBubble } from '@renderer/lib/iph'
import { holdTouch } from './holdTouch'
import { hintBubbleLeft, hintBubbleOnCard } from './stack'

interface Props {
  bubble: HintBubble
  /** On its way out: the stylesheet fades it (Chrome's `textbubble_out`, 200 ms). */
  leaving: boolean
  /** Report the card's height once laid out (the layer sizes the page's cover from it). */
  onMeasure?: (height: number) => void
}

/**
 * The in-product help bubble (TB-19): one sentence in §9.33's third kind of message – the one
 * anchored panel the phone chrome has, in §9.20's pose and without Chrome's arrow (the lead's
 * (a) on #641): flush against the bar band's inner edge at gap 0 – the layer's edge on the
 * bar's side is that edge – end-aligned with the button it is about, clamped 8 inside the frame;
 * the flush edge, the alignment and the button's pulse point at the button. It is placed once,
 * as it goes up: the anchor's box was read by the hook that showed it, the layer's and the
 * card's own here in one layout effect – the only layout read of the whole education – and
 * written as `left`; nothing tracks the anchor after that, because whatever moves the anchor
 * (a touch, a scroll, a rotation, the keyboard) takes the bubble down first
 * (`useTabSwitcherHint`). A status region – a screen reader hears the sentence as it arrives –
 * and, by `HINT_BUBBLE_ID`, the description the Tabs button carries while the bubble stands
 * (`aria-describedby`, PhoneShell.tsx; the lead's (j)); the card takes no focus, as Chrome's
 * popup is not focusable.
 *
 * The second kind stands on a tab card in the overview (`OverviewHintBubble`, the drag-to-group
 * teaching): the same card, the same one layout read, placed by `hintBubbleOnCard` – flush under
 * the card at gap 0, start-aligned, flipped above when the room below runs out – and written as
 * `left` and `top`; `data-side` turns its arrival round so it comes out of the card. It sits on
 * no bar edge (`data-edge` absent) and covers no page: the overview is under it, not a page.
 *
 * A touch that begins on the bubble ends on it: the first touch anywhere takes the bubble down
 * and passes through, but the one `click` a touch on the bubble itself becomes lands on nothing
 * under it, arrive it after the fade has swept the node away (`holdTouch`).
 */
export function HintBubbleCard({ bubble, leaving, onMeasure }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const layer = el?.parentElement
    if (!el || !layer) return
    const box = layer.getBoundingClientRect()
    if (bubble.at === 'overview') {
      const card = {
        x: bubble.anchor.x - box.left,
        y: bubble.anchor.y - box.top,
        width: bubble.anchor.width,
        height: bubble.anchor.height
      }
      const size = { width: el.offsetWidth, height: el.offsetHeight }
      const at = hintBubbleOnCard(card, size, { width: box.width, height: box.height })
      el.style.left = `${at.left}px`
      el.style.top = `${at.top}px`
      el.dataset.side = at.side
    } else {
      const anchorEnd = bubble.anchor.x + bubble.anchor.width - box.left
      el.style.left = `${hintBubbleLeft(anchorEnd, el.offsetWidth, box.width)}px`
    }
    onMeasure?.(el.offsetHeight)
  }, [bubble, onMeasure])
  const overview = bubble.at === 'overview'
  return (
    <div
      ref={ref}
      id={HINT_BUBBLE_ID}
      className="zen-message zen-hint-bubble"
      data-surface="page"
      data-at={overview ? 'overview' : undefined}
      data-edge={overview ? undefined : bubble.edge}
      data-anchor={overview ? bubble.tabId : bubble.anchorItem}
      data-leaving={leaving ? '' : undefined}
      role="status"
      onPointerDown={(e) => holdTouch(e.pointerId)}
    >
      <span className="zen-message-text">{bubble.text}</span>
    </div>
  )
}
