import type { JSX, ReactNode } from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { useEscape } from '@renderer/hooks/useEscape'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { usePopover } from '@renderer/hooks/usePopover'
import { placeUnder, popOrigin, type Anchor } from '@renderer/lib/anchor'
import { useBackSurface } from '@renderer/lib/back'
import {
  ChromePortal,
  FrameDialogPortal,
  POPOVER_WIDTH,
  popoverStyle,
  useFrameDialog,
  useLightDismiss
} from '@renderer/lib/portals'
import { V2TitleBlock } from '../extensions/v2'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/**
 * The chassis of a surface opened over a text selection – the selection translation
 * (`translate/SelectionPopover.tsx`, #106) and the definition (`DefinePopover.tsx`, CT-39): on
 * the desktop a §9.20 popover of the form width where the user asked, on a phone a sheet on the
 * shared `BottomSheet`. One chassis for both, so a third selection surface is a body and a
 * footer; the stylesheet's classes stay the translate surfaces' (`translate.css`: `.zen-translate-
 * panel`, `-panel-body`, `-footer`, `-sheet`, `-sheet-body`), which this file alone writes. The
 * anchors a surface hangs from are `lib/selection.ts`'s (`pointAnchor`, `rectAnchor`).
 */

// ---------------------------------------------------------------------------
// Desktop and tablet: a popover where the user asked
// ---------------------------------------------------------------------------

/**
 * The popover (§9.20, §9.23): 400 wide – text that wraps, a row with a control – through the
 * chrome layer, placed once at `anchor` and held to the layer's height cap (60% of the window),
 * its body scrolling under the title block; a title block – `glyph` and `title` – over the body
 * and a footer that hugs its buttons. Focus moves into it when it opens (its first control),
 * Tab wraps inside it, Escape closes it and the page gets focus back (§9.22: the page had it,
 * the request came from its selection); the chrome layer's light dismiss closes it otherwise
 * (§9.20 amended: a press outside it, consumed; a scroll; a resize, which makes the anchor
 * stale). No X. It holds the page's capture behind it while it is up (`useFloatingChrome`).
 * `name` is the back gesture's (a tablet's system back closes it as Escape does).
 */
export function SelectionPopover({
  name,
  anchor,
  title,
  glyph,
  onClose,
  footer,
  children
}: {
  name: string
  anchor: Anchor
  title: string
  glyph: ReactNode
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}): JSX.Element | null {
  const ready = useFloatingChrome()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [scrolled, setScrolled] = useState(false)
  // Placed once for the anchor (§9.20: never re-fitted to its content); a resize closes it.
  const box = useMemo(() => placeUnder(anchor, POPOVER_WIDTH.form), [anchor])

  // The page had focus and gets it back on release (`useFloatingChrome`); no chrome control
  // opened the popover for focus to return to.
  usePopover(ref, { onClose, active: ready, returnTo: null })
  useLightDismiss(ref, onClose)
  useBackSurface({ name, onCommit: () => onClose() })

  if (!ready) return null
  return (
    <ChromePortal>
      <div
        ref={ref}
        role="dialog"
        aria-labelledby={titleId}
        className="zen-v2 zen-v2-panel zen-translate-panel zen-animate-pop fixed"
        style={{ ...popoverStyle(box), transformOrigin: popOrigin(anchor, box) }}
      >
        <V2TitleBlock id={titleId} title={title} glyph={glyph} scrolled={scrolled} />
        <div
          className="zen-translate-panel-body"
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          {children}
        </div>
        <div className="zen-translate-footer">{footer}</div>
      </div>
    </ChromePortal>
  )
}

// ---------------------------------------------------------------------------
// Phone: a sheet
// ---------------------------------------------------------------------------

/**
 * The phone's surface is a modal dialog, so it mounts in the frame's dialog host
 * (lib/portals.tsx, `FrameDialogPortal`) on the shared `BottomSheet`, once the page's capture
 * is in place (`useFloatingChrome`); focus, Tab, the inert chrome behind the scrim and the
 * return of focus are the chassis's (#172).
 */
export function SelectionSheet(props: {
  name: string
  title: string
  onClose: () => void
  /** Changes when the body's height may have: the sheet re-measures for it. */
  contentKey: string
  footer: ReactNode
  children: ReactNode
}): JSX.Element | null {
  const ready = useFloatingChrome()
  if (!ready) return null
  return (
    <FrameDialogPortal>
      <HostedSheet {...props} />
    </FrameDialogPortal>
  )
}

/**
 * The sheet (§9.16, §9.25): the grip strip and the 48 header – `title` centred, no description,
 * so no title block (§9.23) – over a body at the sheet's one 16 gutter, and the chassis footer
 * with its button filling the width (§9.11). A menulist in the body opens its own sheet over
 * this one (§9.24: depth two, the chassis receding this sheet under the top one's scrim);
 * Escape, the scrim and the back gesture close the top sheet only.
 */
function HostedSheet({
  name,
  title,
  onClose,
  contentKey,
  footer,
  children
}: {
  name: string
  title: string
  onClose: () => void
  contentKey: string
  footer: ReactNode
  children: ReactNode
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name,
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)

  return (
    <BottomSheet
      ref={sheet}
      hosted
      className="zen-translate-sheet"
      labelledBy={titleId}
      onDismissed={onClose}
      contentKey={contentKey}
      header={
        <h2 id={titleId} className="zen-sheet-title">
          {title}
        </h2>
      }
      footer={footer}
    >
      <div className="zen-v2 zen-translate-sheet-body">{children}</div>
    </BottomSheet>
  )
}
