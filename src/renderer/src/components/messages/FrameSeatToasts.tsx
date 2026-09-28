import type { JSX } from 'react'
import { createPortal } from 'react-dom'
import { useFrameToastSeat } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'
import { ToastCard } from './ToastCard'

/**
 * The desktop's toasts on the frame (v2 draft §9.33, the lead's picks for W8-F16): a toast
 * raised while a frame dialog stood – the Site permissions review's "Permissions allowed again
 * for <host> · Undo" on Allow again – is seated on the frame at its push (`Toast.seat`,
 * lib/ui.ts) and drawn here, as a card in the frame dialog host's toast seat
 * (`useFrameToastSeat`, lib/portals.tsx), which the host lifts above the dialog and its scrim
 * for as long as the dialog stands and the seat holds a card: the card 8 inside the content
 * frame's bottom edge, undimmed, its Undo in reach by pointer and as the last stop of the
 * dialog's Tab cycle. When the dialog closes the seat drops its lift and the card stays where
 * it is on its clock (the orphan case): a framed toast keeps its seat, its element and its one
 * `role="status"` announcement for its whole life, and never moves to the sidebar's rows. The
 * sidebar's plain column (`SidebarBottom`) skips the framed toasts, and every other toast is
 * the column's, as it always was.
 *
 * The desktop has no `MessageLayer` (its banners are the sidebar's and its toasts the rows),
 * so this draws the slot the layer would portal into the seat on the tablet – the same
 * `.zen-message-layer` and `.zen-message-toasts` boxes, so the seat's rules read the same –
 * and nothing else: no claim on the cards' semantics (`claimMessageCards`), so the column's
 * rule holds (every toast up joins, a dismissed one goes at once) and two framed toasts stand
 * one over the other (`.zen-frame-toasts`, main.css). The tablet and the phone have the layer,
 * and this renders nothing there (the seat is never published on a phone; the tablet's shell
 * does not mount this).
 */
export function FrameSeatToasts(): JSX.Element | null {
  const seat = useFrameToastSeat().element
  const toasts = uiStore.use((s) => s.toasts)
  const framed = toasts.filter((t) => t.seat === 'frame')
  if (!seat || framed.length === 0) return null
  return createPortal(
    <div className="zen-message-layer" data-surface="page">
      <div className="zen-message-toasts zen-frame-toasts">
        {framed.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </div>
    </div>,
    seat
  )
}
