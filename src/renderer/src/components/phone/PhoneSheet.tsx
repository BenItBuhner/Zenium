import type { JSX, ReactNode, RefObject } from 'react'
import { useEffect, useId, useRef } from 'react'
import { useEscape } from '@renderer/hooks/useEscape'
import { useBackSurface } from '@renderer/lib/back'
import { FrameDialogPortal, useFrameDialog } from '@renderer/lib/portals'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { takeSheetOpener } from './phonePanel'

/**
 * A v2 sheet the phone panels open (the bookmark editor, the clear-history prompt), on the
 * shared `BottomSheet` chassis and in the frame's dialog host (lib/portals.tsx, reached with
 * `FrameDialogPortal`): a modal dialog, so it mounts over the content frame rather than inside
 * a panel that the frame's recede would shrink, and the host makes the window chrome inert and
 * closes every popover while it is up. The sheet draws the stack's one scrim itself
 * (`ownScrim`, §9.24, §9.28), fading with its motion, and a press on that scrim is the consumed
 * dismiss of §9.20. The system back gesture and Escape dismiss it; focus moves into it as it
 * opens (§9.22) and, once it has gone, returns to the row that opened it (§9.24). The same
 * pattern as the Settings tab's sheets (#134), to be folded into one once that lands.
 */

/**
 * What takes the focus as the sheet opens (§9.22):
 *  - `first`: the first button of the body (a prompt's Cancel);
 *  - `dialog`: the sheet itself, for a form – its field is first in the order but a text field
 *    never takes the focus on its own on a phone (the keyboard would come up with the sheet), so
 *    the dialog does, named by its title.
 */
export type SheetFocus = 'first' | 'dialog'

interface Props {
  /** For the back registry's logs. */
  name: string
  title: string
  /**
   * A prompt (title, one paragraph, actions) opens on a title block instead of the 48 header
   * (§9.23): the glyph on the title's start, the description 4 below.
   */
  prompt?: { icon?: ReactNode; description: string }
  focus: SheetFocus
  /** The sheet has left the screen. */
  onClose(): void
  children: ReactNode
  /** Change it when the body is swapped, so the detents are measured again. */
  contentKey?: string
  handleLabel?: string
  sheetRef?: RefObject<BottomSheetHandle | null>
}

export function PhoneSheet(props: Props): JSX.Element {
  return (
    <FrameDialogPortal>
      <HostedSheet {...props} />
    </FrameDialogPortal>
  )
}

/** The sheet inside the host: registered with it as a dialog that draws its own scrim. */
function HostedSheet({
  name,
  title,
  prompt,
  focus,
  onClose,
  children,
  contentKey,
  handleLabel = 'Resize sheet',
  sheetRef
}: Props): JSX.Element {
  const own = useRef<BottomSheetHandle>(null)
  const sheet = sheetRef ?? own
  const body = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name,
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useReturnFocus()
  useFocusOnOpen(body, focus)
  // Escape is the top popup's (§9.24): a sheet under another (the Extensions sheet under a
  // row's long-press menu) leaves the key to the one on top until it has gone.
  useEscape(dismiss)
  return (
    <BottomSheet
      ref={sheet}
      hosted
      onDismissed={onClose}
      contentKey={contentKey}
      handleLabel={handleLabel}
      labelledBy={titleId}
      header={
        prompt ? undefined : (
          <h2 id={titleId} className="zen-sheet-title">
            {title}
          </h2>
        )
      }
    >
      <div ref={body}>
        {prompt && (
          <div className="zen-sheet-title-block">
            <h2 id={titleId}>
              {prompt.icon}
              <span className="min-w-0 truncate">{title}</span>
            </h2>
            <p>{prompt.description}</p>
          </div>
        )}
        {children}
      </div>
    </BottomSheet>
  )
}

/**
 * Focus returns to the row that opened the sheet once the sheet is gone (§9.24): the element
 * focused as the sheet mounted or, when a menu sheet stood between the row and this one and
 * took the focus with it, the opener the panel noted (`noteSheetOpener`). Restored after the
 * commit that removes the sheet; not restored when focus has since gone somewhere else that is
 * still on screen.
 */
function useReturnFocus(): void {
  useEffect(() => {
    const active = document.activeElement
    const opener =
      active instanceof HTMLElement && active !== document.body ? active : takeSheetOpener()
    return () => {
      queueMicrotask(() => {
        if (!opener?.isConnected) return
        const now = document.activeElement
        if (now && now !== document.body && now.isConnected) return
        opener.focus()
      })
    }
  }, [])
}

/**
 * Focus moves into the sheet as it opens (§9.22), after {@link useReturnFocus} has noted the
 * opener: the chosen element per {@link SheetFocus}, without scrolling anything to reach it
 * (the sheet is still on its way up).
 */
function useFocusOnOpen(body: RefObject<HTMLElement | null>, focus: SheetFocus): void {
  useEffect(() => {
    const el = body.current
    if (!el) return
    const target =
      focus === 'dialog'
        ? el.closest<HTMLElement>('[role="dialog"]')
        : el.querySelector<HTMLElement>('button:not(:disabled), a[href]')
    target?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on open only
  }, [])
}
