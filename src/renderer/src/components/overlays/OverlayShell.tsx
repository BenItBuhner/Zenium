import { X } from 'lucide-react'
import type { CSSProperties, ReactNode, JSX } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef } from 'react'
import { useBackDismissal } from '@renderer/lib/back'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { placeUnder, popOrigin, type Anchor } from '@renderer/lib/anchor'
import { useViewport } from '@renderer/lib/formFactor'
import { returnFocusTo } from '@renderer/lib/popover'
import {
  ChromePortal,
  measuringStyle,
  popoverStyle,
  useMeasuredHeight
} from '@renderer/lib/portals'
import { closeOverlay } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useScrolled } from '../bookmarks/popover'

/** The control an overlay panel hangs from (§9.20), and the width the panel takes there. */
export interface OverlayAnchor {
  at: Omit<Anchor, 'element'>
  width: number
}

interface Props {
  title: string
  /**
   * §9.23's optional line under the title – 15 at 69 %, 4 below it – naming what the panel is
   * about where the title is one word (the theme picker's "Theme" over "<space> space").
   */
  description?: string
  children: ReactNode
  /** `dock` → left-docked sidebar panel; `dialog` → centred card; `full` → fills the content area. */
  variant?: 'dock' | 'dialog' | 'full'
  actions?: ReactNode
  className?: string
  /**
   * The control the panel was opened from, when it hangs from one (the theme picker from the
   * Settings theme row's Change… button; `UiState.overlayAnchor`): on a mouse the panel leaves
   * its seat (`variant`, `className`) for §9.20's place under the control – flush under its box,
   * end-aligned when the control stands in the trailing half of its bar or column, flipped
   * above when the room below runs out, never past the window's 8 px margin – rendered in the
   * chrome layer (lib/portals.tsx: never `fixed` inside the frame) and growing out of the
   * control with the pop (§7). Its height is its content's, measured once before the first
   * paint (`useMeasuredHeight`), capped at 60 % of the window with the body scrolling under
   * the header. Placed once on open, as popovers are; a resize closes it. The scrim stays the
   * content area's: a press on the page under the panel closes it as at the seat. A phone
   * ignores it – its panel is the bottom sheet.
   *
   * Hanging there the panel IS a §9.20 popover and wears the popover's chrome, the chassis's
   * `.zen-v2-panel` (extensions.css: the card radius 8 at §2's squircle, the opaque `--v2-panel`
   * fill, `--v2-border`, `--v2-shadow-panel`), at one of the three popover widths (`width`, the
   * caller's `POPOVER_WIDTH`) – not the seat's `.zen-panel`, the sidebar's 16-radius
   * translucent card, which the seated panel keeps exactly. §9.20 as the lead amended it on
   * #572: the chrome is the seat's, never the content's – one picker, two seats, two chromes.
   * Its header is the same §9.7 block without the close: a popover closes by Escape, by a
   * press outside it or by its anchor's, and carries no X (§9.20); the block's height is the
   * title's own (main.css: the 28 close equals the 3 + 22 + 3 the title block stands in, so
   * a title with a description measures 78 with or without it). And it takes the focus as a
   * popover does (§9.22): the container holds it as it opens – a picker is a choice, not a
   * form: no control is preselected, the first Tab enters it – and gives it back to the
   * control it hung from as it leaves, however it leaves, unless something else took it
   * meanwhile (`returnFocusTo`). The seated panel moves no focus, as it never did.
   */
  anchor?: OverlayAnchor
  /** Stable hook for the desktop boot smoke (`data-testid` on the panel). */
  testId?: string
  /** Stands in for the default header (a phone panel's 56 header, or its selection header). */
  header?: ReactNode
  /**
   * The shell scrolls the children (default). Off, the children fill the panel as a column and
   * scroll whatever part of themselves they want to – a list under a pinned search field.
   */
  scroll?: boolean
}

/** Common chrome for panels that open over the content area. */
export function OverlayShell({
  title,
  description,
  children,
  variant = 'dock',
  actions,
  className,
  testId,
  header,
  scroll = true,
  anchor
}: Props): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  // The system back gesture: the panel recedes towards the bottom edge, shrinking and fading
  // with the finger; commit closes it, cancel springs it back.
  const panelRef = useRef<HTMLDivElement>(null)
  // Hanging from a control (§9.20): the panel's content is measured once, unplaced and unseen
  // (`measuringStyle`), then the one placement puts it under the anchor – the pop plays as it
  // lands. The box is the anchor's and the measure's alone: nothing re-places it, and the
  // window changing size closes it as it does every popover (`useLightDismiss`'s resize).
  const anchored = anchor !== undefined && !phone
  const measured = useMeasuredHeight(panelRef, anchored)
  const at = anchor?.at
  const width = anchor?.width
  const placed = useMemo<CSSProperties | undefined>(() => {
    if (!anchored || at === undefined || width === undefined) return undefined
    if (measured === null) return measuringStyle(width)
    const box = placeUnder(at, { measured: width }, measured || undefined)
    return { ...popoverStyle(box), transformOrigin: popOrigin(at, box) }
  }, [anchored, at, width, measured])
  useEffect(() => {
    if (!anchored) return
    const onResize = (): void => closeOverlay()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [anchored])
  // The popover's focus (§9.22; the confirm dialog's pattern, dialogs/ConfirmDialog.tsx): the
  // opener is whatever held the focus as the panel came – the Settings row's button under the
  // press that opened it – and not `body`; the container takes the focus; as the panel leaves
  // the opener gets it back, but only a focus the leave loses – one still on the panel, fallen
  // to `body`, or under an `inert` – and never one the user or a dialog opened over the way
  // out has already placed. The seat does none of this: the space menu's and the palette's
  // picker leave the focus where it was, as they always did.
  const titleId = useId()
  useEffect(() => {
    if (!anchored) return
    const root = panelRef.current
    if (!root) return
    const active = document.activeElement
    const opener =
      active instanceof HTMLElement && active !== document.body && !root.contains(active)
        ? active
        : null
    root.focus({ preventScroll: true })
    return () => {
      if (!opener?.isConnected) return
      const now = document.activeElement
      const lost =
        !now ||
        now === document.body ||
        root.contains(now) ||
        now.closest('[inert], [data-leaving]') !== null
      if (lost) returnFocusTo(opener)
    }
  }, [anchored])
  useBackDismissal('overlay', {
    travel: 360,
    render: (v) => {
      const el = panelRef.current
      if (!el) return
      el.style.transform = `translateY(${30 * v}%) scale(${1 - 0.1 * v})`
      el.style.opacity = String(1 - v)
    },
    dismissed: () => closeOverlay()
  })
  // The header marks content scrolled under it with the §9.7 hairline (`data-scrolled`), so the
  // body fades its end edge only; the ref is shared between the fade and the scroll watcher.
  const bodyRef = useRef<HTMLDivElement>(null)
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'y', edges: 'end' })
  const scrolled = useScrolled(bodyRef)
  const attachBody = useCallback(
    (el: HTMLDivElement | null) => {
      bodyRef.current = el
      return fade(el)
    },
    [fade]
  )
  // A panel is a page surface (design language v2 §9.29): its controls draw in the page family.
  // Hanging from a control it is a `fixed` box in the chrome layer at the place `placeUnder`
  // gave it, with the pop, in the popover's chrome (`.zen-v2-panel`) and holding the focus as
  // a dialog does – `role="dialog"` named by its title, `tabindex="-1"` so the held container
  // draws no ring (main.css's container rule) while its controls keep theirs; at its seat it
  // drops in where its variant puts it, in the sidebar card's chrome (`.zen-panel`), as today.
  const panel = (
    <div
      ref={panelRef}
      data-surface="page"
      data-anchored={anchored || undefined}
      role={anchored ? 'dialog' : undefined}
      aria-labelledby={anchored ? titleId : undefined}
      tabIndex={anchored ? -1 : undefined}
      style={anchored ? placed : { transformOrigin: '50% 100%' }}
      className={
        anchored
          ? 'zen-v2-panel zen-animate-pop fixed z-[70] flex flex-col overflow-hidden'
          : cn(
              'zen-panel zen-animate-in flex flex-col overflow-hidden',
              // Docked panels take the whole content card on phones; dialogs hug the bottom edge.
              variant === 'dock' && (phone ? 'm-2 flex-1' : 'm-3 w-[380px] max-w-full'),
              variant === 'dialog' &&
                (phone
                  ? 'mx-2 mb-2 mt-auto w-auto max-h-[calc(100%-16px)]'
                  : 'm-auto w-[560px] max-w-[calc(100%-32px)] max-h-[calc(100%-32px)]'),
              variant === 'full' && (phone ? 'm-2 flex-1' : 'm-3 flex-1'),
              className
            )
      }
      data-testid={testId}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {header ?? (
        // The overlay header (§9.7): the title 22/600 on a page (`full`) or 17/600 on a panel,
        // no line at rest, 16 from the title's line box to the first content box; the hairline
        // at its bottom edge only while the body is scrolled under it. On a phone it is the
        // §9.16 bar header, 56 tall with the 44 close at a 6 margin. The close is the §9.3
        // icon button, named for the screen reader without the keyboard hint a tooltip carries
        // on a phone (§9.31). With a `description` the title is a §9.23 block – the line 4
        // under it – and the close stays on the title's line (main.css). Hanging from a control
        // the header keeps the block and drops the close: a popover has none (§9.20) – Escape,
        // a press outside and the anchor's own press close it – and the block's 78 with a
        // description is the title's, not the button's (the `anchor` doc).
        <header
          className="zen-overlay-header"
          data-size={variant === 'full' ? 'page' : 'panel'}
          data-scrolled={scrolled || undefined}
        >
          {description ? (
            <div className="zen-overlay-title-block">
              <h2 id={anchored ? titleId : undefined} className="zen-overlay-title">
                {title}
              </h2>
              <p className="zen-overlay-description">{description}</p>
            </div>
          ) : (
            <h2 id={anchored ? titleId : undefined} className="zen-overlay-title">
              {title}
            </h2>
          )}
          {actions}
          {!anchored && (
            <button
              type="button"
              className="zen-v2-icon-button"
              title={phone ? undefined : 'Close (Esc)'}
              aria-label="Close"
              onClick={() => closeOverlay()}
            >
              <X aria-hidden />
            </button>
          )}
        </header>
      )}
      {scroll ? (
        <div ref={attachBody} className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      )}
    </div>
  )
  // The scrim is the content area's either way: a press on the page under the panel closes it.
  // The panel's own press stops there (React's propagation follows the tree, portal or not).
  return (
    <div className="absolute inset-0 z-30 flex" onMouseDown={() => closeOverlay()}>
      {anchored ? <ChromePortal>{panel}</ChromePortal> : panel}
    </div>
  )
}

export function EmptyNote({ children }: { children: ReactNode }): JSX.Element {
  return <p className="px-4 py-10 text-center text-[13px] text-[var(--zen-muted)]">{children}</p>
}
