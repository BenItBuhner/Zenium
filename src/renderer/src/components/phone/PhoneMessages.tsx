import type { CSSProperties, JSX } from 'react'
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { PhoneBarPosition } from '@shared/types'
import { useRecedeSurface } from '@renderer/hooks/useRecedeSurface'
import {
  recedeDepth,
  recedeFooter,
  subscribeRecedeDepth,
  subscribeRecedeFooter
} from '@renderer/lib/motion/recede'
import { uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { toastSeat } from '../messages/lift'
import { MessageLayer } from '../messages/MessageLayer'

interface Props {
  /** The edge the bar is docked at: the frame's box is the content column's (main.css). */
  edge: PhoneBarPosition
  /**
   * The window chrome is held inert by something that is not a sheet – a page's fullscreen
   * (MOT-32, the shell's own hold) or the capture overlay (`CaptureOverlay`'s) – so the toast
   * frame at the normal seat goes inert as the message frame does (`holdChromeInert` reaches
   * `data-shell-chrome` alone, and the toast frame is none). Never while lifted: a sheet standing
   * has the toast above it and in reach (§9.33, Q3), whatever else holds the chrome.
   */
  inert?: boolean
}

/** A sheet is on the chassis's stack right now (registered at its mount, released at its landing). */
function useSheetStands(): boolean {
  return useSyncExternalStore(
    subscribeRecedeDepth,
    () => recedeDepth() > 0,
    () => false
  )
}

/** The top sheet's footer band (px over the inset's line), 0 with none: what the registry says. */
function useSheetFooter(): number {
  return useSyncExternalStore(subscribeRecedeFooter, recedeFooter, () => 0)
}

/**
 * The phone's messages, on the content frame's box over the bar and the stage but under sheets
 * (main.css sets the box by the bar's edge, `data-edge`, and the root's `data-bar-away`, with
 * the cards on the bar's edge riding the bar by transform – so a toast showing mid-gesture moves
 * with the bar instead of jumping the band at the rest, and nothing in the frame is laid out per
 * frame). Two frames of that one box: the message frame – the banner stack, the gesture hint,
 * a screenshot's preview – is shell chrome (`data-shell-chrome`: inert under a sheet, §9.22)
 * and recedes with the page; the toast frame holds the toast's slot (portalled from the layer,
 * so the cards never remount) and is seated by §9.33 (`messages/lift.ts`): while a sheet stands
 * and the slot holds a card – one the sheet's act raised, or one up before the sheet opened,
 * as Chrome re-parents whatever snackbar is showing into an open bottom sheet – the frame lifts
 * above the sheet host (`data-lifted`: z 60 over the host's 50, no recede), its bottom edge at
 * the inset's line where the sheet's own edge is, the card 8 over it, or on the top edge of the
 * sheet's footer band where the sheet publishes one (`--zen-sheet-footer`, the registry's
 * field), so the toast and its Undo stand over the sheet's content and never over its actions.
 * Otherwise it is the message frame's twin at the normal seat. Once no sheet stands the frame
 * comes back there, the toast still up on its clock; the stylesheet has it ride the sheet's own
 * progress (`--zen-recede`, written on the frame as on the message frame), so at the landing
 * the re-seat moves nothing. Never `inert` while lifted: nothing in it stands under a sheet. At
 * the normal seat it takes the chrome's non-sheet hold the shell passes (`inert`: a page's
 * fullscreen, the capture overlay), as the message frame takes it through `data-shell-chrome`,
 * so a toast under a fullscreen page is no TalkBack stop and takes no focus.
 */
export function PhoneMessages({ edge, inert = false }: Props): JSX.Element {
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

  const held = uiStore.use((s) => s.toasts.length > 0 || s.screenshotCards.length > 0)
  const sheetStands = useSheetStands()
  const footer = useSheetFooter()
  const { lifted, foot } = toastSeat(held, sheetStands, footer)

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
        inert={(inert && !lifted) || undefined}
        className={cn(
          'zen-message-frame zen-toast-frame pointer-events-none absolute',
          lifted ? 'z-[60]' : 'z-[36]'
        )}
        style={lifted ? ({ '--zen-sheet-footer': `${foot}px` } as CSSProperties) : undefined}
      />
    </>
  )
}
