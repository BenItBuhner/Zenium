import type { JSX } from 'react'
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
      data-kind={toast.kind}
      data-action={toast.action ? '' : undefined}
      role="status"
      aria-live="polite"
      {...handlers}
    >
      <span className="zen-message-text">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="zen-message-button"
          onClick={() => pickToastAction(toast.id)}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  )
}
