import type { JSX } from 'react'
import { X } from 'lucide-react'
import type { DismissDirections } from '@renderer/lib/gestures/dismiss'
import {
  dismissScreenshotCard,
  forgetScreenshotCard,
  holdScreenshotCard,
  pickScreenshotAction,
  type ScreenshotCard as Card
} from '@renderer/lib/ui'
import { formatBytes } from '@renderer/lib/utils'
import { useMessageMotion } from './useMessageMotion'

/** The card goes down, back where it came from, or off to either side, as a toast does. */
const CARD_DIRS: DismissDirections = { x: [-1, 1], y: [1] }

interface Props {
  card: Card
  onMeasure?: (id: number, height: number) => void
}

/**
 * Take Screenshot's preview card (SH-07, Chrome's flow): a message card in the toast's slot
 * (v2 §9.33's anatomy on §9.20's floating panel, 8 px inside the frame) whose glyph is the
 * picture itself – the thumbnail, 64 tall at the start, a button that opens the picture in the
 * system's viewer – with "Screenshot saved" as the title and the picture's size as the detail;
 * Share | Delete as the row's own footer under the sentence they answer (§9.11's decision pair
 * at the text edge; Delete in §6's danger ink, the saved file being the user's data), Capture
 * more as the one trailing secondary action (§9.33) beside the §9.3 close. It rides the shared
 * message motion: up from the frame's bottom edge, off by a swipe, the close, an action or the
 * clock, paused under a finger.
 */
export function ScreenshotCard({ card, onMeasure }: Props): JSX.Element {
  const { ref, handlers } = useMessageMotion({
    home: 1,
    slot: 0,
    dirs: CARD_DIRS,
    leaving: Boolean(card.leaving),
    onHold: (held) => holdScreenshotCard(card.id, held),
    onSwipe: () => dismissScreenshotCard(card.id),
    onGone: () => forgetScreenshotCard(card.id)
  })
  return (
    <div
      ref={(el) => {
        ref.current = el
        if (el && onMeasure) onMeasure(card.id, el.offsetHeight)
      }}
      className="zen-message zen-message-toast zen-screenshot-card"
      data-surface="page"
      data-action=""
      role="status"
      {...handlers}
    >
      <button
        type="button"
        className="zen-screenshot-thumb"
        aria-label="Open the screenshot"
        onClick={() => pickScreenshotAction(card.id, 'open')}
      >
        <img src={card.thumbnail} alt="" draggable={false} />
      </button>
      <div className="zen-message-text zen-screenshot-text">
        <div className="zen-screenshot-title">Screenshot saved</div>
        <div className="zen-banner-detail">{screenshotDetail(card)}</div>
      </div>
      <div className="zen-message-trailing zen-screenshot-trailing">
        {!card.long && (
          <button
            type="button"
            className="zen-message-button zen-v2-message-action"
            onClick={() => pickScreenshotAction(card.id, 'more')}
          >
            Capture more
          </button>
        )}
        <button
          type="button"
          className="zen-message-close"
          aria-label="Dismiss"
          onClick={() => dismissScreenshotCard(card.id)}
        >
          <X aria-hidden />
        </button>
      </div>
      <div className="zen-screenshot-actions">
        <button
          type="button"
          className="zen-message-button zen-v2-message-action"
          onClick={() => pickScreenshotAction(card.id, 'share')}
        >
          Share
        </button>
        <button
          type="button"
          className="zen-message-button zen-v2-message-action"
          data-danger=""
          onClick={() => pickScreenshotAction(card.id, 'delete')}
        >
          Delete
        </button>
      </div>
    </div>
  )
}

/** "1080 × 2280 · 1.2 MB": the picture's pixels and its file's size. */
function screenshotDetail(shot: { width: number; height: number; bytes: number }): string {
  return `${shot.width} × ${shot.height} · ${formatBytes(shot.bytes)}`
}
