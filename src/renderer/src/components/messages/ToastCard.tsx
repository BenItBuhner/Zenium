import type { JSX } from 'react'
import { Star } from 'lucide-react'
import type { DismissDirections } from '@renderer/lib/gestures/dismiss'
import { dismissToast, forgetToast, holdToast, pickToastAction, type Toast } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useMessageMotion } from './useMessageMotion'

/** A toast goes down, back where it came from, or off to either side. */
const TOAST_DIRS: DismissDirections = { x: [-1, 1], y: [1] }

interface Props {
  toast: Toast
  /** Desktop sidebar: a tighter card at the sidebar's type size. */
  compact?: boolean
  /** Report the card's height once laid out (the phone layer sizes the page's cover from it). */
  onMeasure?: (id: number, height: number) => void
}

/**
 * One toast: the message, its one action if it has one, riding the shared message motion. It
 * comes up from the bottom edge and goes down (or sideways) when swiped, timed out or replaced.
 * A leading glyph when the message names one: the star that just filled pops in ahead of
 * "Saved to Bookmarks" (the phone's star, v1 §7 motion).
 */
export function ToastCard({ toast, compact, onMeasure }: Props): JSX.Element {
  const { ref, handlers } = useMessageMotion({
    home: 1,
    slot: 0,
    dirs: TOAST_DIRS,
    leaving: Boolean(toast.leaving),
    onHold: (held) => holdToast(toast.id, held),
    onSwipe: () => dismissToast(toast.id),
    onGone: () => forgetToast(toast.id)
  })
  return (
    <div
      ref={(el) => {
        ref.current = el
        if (el && onMeasure) onMeasure(toast.id, el.offsetHeight)
      }}
      className={cn('zen-message zen-message-toast', compact && 'zen-message-compact')}
      data-surface="page"
      data-kind={toast.kind}
      data-action={toast.action ? '' : undefined}
      data-glyph={toast.icon ? '' : undefined}
      role="status"
      {...handlers}
    >
      {toast.icon === 'star' && (
        <Star className="zen-message-glyph zen-message-glyph-pop" fill="currentColor" aria-hidden />
      )}
      <span className="zen-message-text">{toast.message}</span>
      {toast.action && (
        // The `zen-v2-` alias is how main.css's shared focus ring reaches the action on a coarse
        // pointer, where the chrome's generic suppressor drops a button's ring (the card's own
        // layered rule loses to it).
        <button
          type="button"
          className="zen-message-button zen-v2-message-action"
          onClick={() => pickToastAction(toast.id)}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  )
}
