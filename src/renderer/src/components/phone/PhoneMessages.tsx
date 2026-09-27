import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PhoneBarPosition } from '@shared/types'
import { useRecedeSurface } from '@renderer/hooks/useRecedeSurface'
import { recedeDepth, subscribeRecedeDepth } from '@renderer/lib/motion/recede'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { createLiftLedger, toastsLifted } from '../messages/lift'
import { MessageLayer } from '../messages/MessageLayer'

interface Props {
  /** The edge the bar is docked at: the frame's box is the content column's (main.css). */
  edge: PhoneBarPosition
}

/** A sheet is on the chassis's stack right now (registered at its mount, released at its landing). */
function useSheetStands(): boolean {
  return useSyncExternalStore(
    subscribeRecedeDepth,
    () => recedeDepth() > 0,
    () => false
  )
}

/**
 * The phone's messages, on the content frame's box over the bar and the stage but under sheets
 * (main.css sets the box by the bar's edge, `data-edge`, and the root's `data-bar-away`, with
 * the cards on the bar's edge riding the bar by transform – so a toast showing mid-gesture moves
 * with the bar instead of jumping the band at the rest, and nothing in the frame is laid out per
 * frame). Two frames of that one box: the message frame – the banner stack, the gesture hint,
 * a screenshot's preview – is shell chrome (`data-shell-chrome`: inert under a sheet, §9.22)
 * and recedes with the page; the toast frame holds the toast's slot (portalled from the layer,
 * so the cards never remount) and is seated here by §9.33: while a sheet stands and the toast
 * up was raised by an act taken in it – born under the sheet, `messages/lift.ts` – the frame
 * lifts above the sheet host (`data-lifted`: z 60 over the host's 50, its edge at the inset
 * where the sheet's is, 8 over it for the card, no recede) so the toast and its Undo stand over
 * the sheet, as Chrome re-parents a snackbar into an open bottom sheet. Otherwise it is the
 * message frame's twin: a toast raised before the sheet keeps its place under it, inert with
 * the rest of the chrome (`inert`, this frame's own: the hold on the window chrome must never
 * mark it, or a lift could not free it mid-hold). Once no sheet stands the frame comes back to
 * the normal seat, the toast still up on its clock; the stylesheet has it ride the sheet's own
 * progress down (`--zen-recede`, written on the frame as on the message frame), so at the
 * landing the re-seat moves nothing.
 */
export function PhoneMessages({ edge }: Props): JSX.Element {
  const messageFrameRef = useRef<HTMLDivElement>(null)
  useRecedeSurface(messageFrameRef)
  const toastFrameRef = useRef<HTMLDivElement>(null)
  useRecedeSurface(toastFrameRef)
  // The seat as state, so the layer's portal follows the element up after the first commit.
  const [seat, setSeat] = useState<HTMLDivElement | null>(null)
  const seatRef = useCallback((el: HTMLDivElement | null): void => {
    toastFrameRef.current = el
    setSeat(el)
  }, [])

  const toasts = uiStore.use((s) => s.toasts)
  const sheetStands = useSheetStands()
  // Each toast is stamped as it is raised – the store tells its listeners in the same call
  // that pushed it, so the depth read is the depth of the act – and, should one be up before
  // the frame mounts, at the first render that shows it (a stamp is taken once per toast, so
  // the render's is a no-op for a toast the listener saw).
  const [ledger] = useState(createLiftLedger)
  useEffect(() => {
    const stamp = (): void => ledger.stamp(uiStore.get().toasts, recedeDepth() > 0)
    stamp()
    const unsubscribeToasts = uiStore.subscribe(stamp)
    // The stack emptied: whatever is up is seated normally from here, and a sheet that opens
    // next did not cause it. Heard at the release itself, so a stack that empties and fills
    // again before the next render grounds the toast all the same.
    const unsubscribeDepth = subscribeRecedeDepth((depth) => {
      if (depth === 0) ledger.ground()
    })
    return () => {
      unsubscribeToasts()
      unsubscribeDepth()
    }
  }, [ledger])
  ledger.stamp(toasts, sheetStands)
  const lifted = toastsLifted(toasts, ledger.bornUnder, sheetStands)

  return (
    <>
      <div
        ref={messageFrameRef}
        data-shell-chrome
        data-edge={edge}
        className="zen-message-frame pointer-events-none absolute z-[36]"
      >
        <MessageLayer toastSeat={seat} />
      </div>
      <div
        ref={seatRef}
        data-edge={edge}
        data-lifted={lifted || undefined}
        inert={sheetStands && !lifted}
        className={cn(
          'zen-message-frame zen-toast-frame pointer-events-none absolute',
          lifted ? 'z-[60]' : 'z-[36]'
        )}
      />
    </>
  )
}
