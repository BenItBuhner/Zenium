import type { CSSProperties, JSX, MouseEvent, ReactNode, RefObject } from 'react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react'
import type { Rect } from '@shared/types'
import { useEscape } from '@renderer/hooks/useEscape'
import { usePopover } from '@renderer/hooks/usePopover'
import { useSpringPresence } from '@renderer/hooks/useSpringPresence'
import { useBackSurface } from '@renderer/lib/back'
import { focusableIn } from '@renderer/lib/popover'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  openPopover,
  placePopover,
  popoverStyle,
  useFrameDialog,
  viewportSize,
  type PopoverBox,
  type PopoverWidth
} from '@renderer/lib/portals'
import { REDUCED_FADE_MS } from '@renderer/lib/motion/fade'
import { SPRING_GENTLE, SpringAnimation, reducedMotion } from '@renderer/lib/motion/spring'
import { usePhone, type DataAttributes } from '@renderer/lib/surfaces'
import { contentAreaStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { V2Menulist, type MenulistOption } from '../extensions/V2Menulist'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { V2_GLYPH, V2Button, type V2ButtonProps } from '../v2/controls'

/**
 * The chassis the site-control surfaces share, on the design language v2 draft: the desktop
 * popover (§9.20) through the chrome layer and the dialog (§9.5) through the frame dialog host
 * (lib/portals.tsx), the phone sheet on the shared `BottomSheet` – the v2 sheet chassis with its
 * 48 header, title block, footer and separators (§6, §9.9, §9.16, §9.23, §9.25; the
 * `.zen-sheet-*` rules in main.css) – the title block for a popover (§9.23), rows (§9.2, §9.18,
 * §9.21), footers (§9.11) and the shared menulist (§9.13, `extensions/V2Menulist`). Everything
 * reads the `--v2-*` tokens only; nothing here defines a colour. The chrome layer, the frame
 * dialog host and the bottom sheet all carry `data-surface="page"`, so every surface here draws
 * in the page family (§9.29). The keyboard is the chassis's too: `usePopover` (§9.22: focus in
 * on open, Tab wraps, Escape closes, focus back to the opener on close) and `useEscape` (§9.24:
 * the key goes to the top popup only); nothing here keeps a focus trap or a surface stack of
 * its own. The form factor and the site chip these share live in lib/surfaces.
 */

// ---------------------------------------------------------------------------
// Busy
// ---------------------------------------------------------------------------

/** A 16 / 20 px spinner (§9.30): the row glyph size, turning. */
export function Spinner({ className }: { className?: string }): JSX.Element {
  return <LoaderCircle className={cn(V2_GLYPH, 'animate-spin', className)} aria-hidden />
}

/**
 * A button at work (§9.30): busy is not disabled – it keeps its opacity and its width, swaps its
 * label for the spinner and says `aria-busy`; a second press while it works does nothing.
 */
export function BusyButton({
  busy = false,
  children,
  className,
  onClick,
  ...props
}: V2ButtonProps & { busy?: boolean }): JSX.Element {
  return (
    <V2Button
      {...props}
      className={cn('relative', className)}
      aria-busy={busy || undefined}
      onClick={busy ? undefined : onClick}
    >
      <span className={cn('inline-flex items-center gap-2', busy && 'invisible')}>{children}</span>
      {busy && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </span>
      )}
    </V2Button>
  )
}

// ---------------------------------------------------------------------------
// Desktop popover
// ---------------------------------------------------------------------------

export interface PopoverApi {
  /** Leave on the spring; `onClosed` fires when the motion is done. */
  close: () => void
}

/** Where the keyboard goes as a popover opens (§9.22). */
export type PopoverFocus =
  /** The first row or button: a surface the user opened. */
  | 'first'
  /** The container itself: a title-and-notice panel that is the only affordance, no button armed. */
  | 'container'
  /** Nowhere: a prompt raised by a page event beside a chip in the pill, which stays with the page. */
  | 'none'

/**
 * An anchored desktop popover (§9.20): one of the three fixed widths, placed by `placePopover`
 * – below `bar` (the pill or bar the anchor sits in) with its top border flush to the bar's
 * bottom edge, start-aligned with the anchor, flipped or slid to stay 8 px inside the window,
 * at most 60% of the window tall (the chassis's cap), above the bar when the room below runs
 * out; `--v2-panel` at radius 8 with a hairline and the panel shadow, no scrim (§9.5). It
 * renders through the chrome layer (`ChromePortal`), never inside the frame, and registers with
 * the layer's light dismiss (`lib/popoverStore.ts`, §9.20 amended): a press outside it closes it
 * and is consumed, nothing beneath receives it; a scroll outside it, a window resize, another
 * popover opening and a frame dialog opening close it too. `anchorElement` names what opened
 * it, so a popover opening from inside another (a menulist's list in a level) is its child and
 * leaves it up, a press on the anchor closes without reopening, and the focus goes back there
 * after an outside press. Enter and exit run on the v1 spring out of the anchor; `collapse`
 * reverses the pop toward the anchor instead (§9.22: "Not now" folds a prompt back into its
 * chip). The keyboard is `usePopover`'s (§9.22): focus moves in on open as `focus` says, Tab
 * wraps, Escape closes and focus goes back to the opener when the popover leaves. `follow`: a
 * scroll or a resize leaves the surface up, moving with its anchor (a prompt the page is still
 * waiting on); an outside press still closes it. With `onDismiss` every dismissal calls the
 * owner instead of leaving at once: the owner answers and then sets `closing`.
 */
export function DesktopPopover({
  anchor,
  bar = anchor,
  width = POPOVER_WIDTH.form,
  labelledBy,
  onClosed,
  closing = false,
  collapse = false,
  onDismiss,
  focus = 'first',
  follow = false,
  anchorElement,
  className,
  children,
  ...data
}: {
  anchor: Rect | null
  /** The pill or bar around the anchor; the anchor itself when omitted. */
  bar?: Rect | null
  width?: PopoverWidth
  labelledBy: string
  /** The popover has left; unmount it. `byKey`: Escape closed it (focus went to the anchor). */
  onClosed: (byKey: boolean) => void
  /** The owner wants it gone (its subject vanished, the answer went out): leave now. */
  closing?: boolean
  /** Leave by collapsing into the anchor (the reversed pop, 180 ms) rather than on the spring. */
  collapse?: boolean
  /** Escape, an outside press, a scroll and a resize ask the owner rather than closing outright. */
  onDismiss?: () => void
  focus?: PopoverFocus
  /** Stay up through a scroll or a resize, following the anchor. */
  follow?: boolean
  /** The element that opened the popover, for the light-dismiss registry and the focus return. */
  anchorElement?: () => HTMLElement | null
  className?: string
  children: (api: PopoverApi) => ReactNode
} & DataAttributes): JSX.Element {
  const viewport = viewportSize()
  const placement = anchor
    ? placePopover(anchor, bar ?? anchor, viewport, width)
    : unanchoredPlacement(width, viewport)
  const byKey = useRef(false)
  // The spring runs out of the anchor: from the popover's edge on the bar, under the anchor's
  // middle – the same point the collapse folds back into.
  const originX = anchor ? anchor.x + anchor.width / 2 - placement.left : placement.width / 2
  const origin = `${originX}px ${placement.side === 'below' ? '0%' : '100%'}`
  const { style, close } = useSpringPresence(() => onClosed(byKey.current), origin)
  const dialog = useRef<HTMLDivElement>(null)
  const dismiss = onDismiss ?? close

  usePopover(dialog, {
    onClose: () => {
      byKey.current = true
      dismiss()
    },
    initial: focus,
    // A popover that took no focus of its own hands nothing back; the others return to the
    // element that opened them (the site chip for a popover under the pill).
    returnTo: focus === 'none' ? null : (anchorElement?.() ?? undefined)
  })

  // The collapse (§9.22): the pop reversed toward the anchor – scale .94 from the popover's
  // point on the anchored edge, fading, 180 ms – the transition CSS draws with the `closing`
  // flag while the spring's own leave is held at its shown state. Under reduced motion (§11.3)
  // it is the 120 ms opacity fade in place instead, nothing travels: the component writes
  // opacity alone, and since the reduced-motion stylesheet removes an inline transition like
  // any other, main.css re-declares the fade on `.zen-desktop-popover[data-collapsing]`
  // (`!important`, past the global rule) – either way the popover unmounts on `transitionend`.
  const [collapsing, setCollapsing] = useState<false | 'pop' | 'fade'>(false)
  const collapsed = useRef(false)
  useEffect(() => {
    if (!closing) return
    if (collapse && dialog.current) {
      if (collapsed.current) return
      collapsed.current = true
      setCollapsing(reducedMotion() ? 'fade' : 'pop')
      const el = dialog.current
      let ended = false
      const done = (): void => {
        if (ended) return
        ended = true
        onClosed(byKey.current)
      }
      // The popover's own transition ending, not a child's bubbling up before it.
      const onEnd = (event: Event): void => {
        if (event.target === el) done()
      }
      el.addEventListener('transitionend', onEnd)
      // A compositor that never fires: the fallback lands a frame later.
      const timer = window.setTimeout(done, 240)
      return () => {
        window.clearTimeout(timer)
        el.removeEventListener('transitionend', onEnd)
      }
    }
    close()
    return undefined
  }, [closing, collapse, close, onClosed])

  // The chrome layer's light dismiss, registered once for the popover's life. The registry
  // closes on a scroll and a resize as well as an outside press; a surface that `follow`s its
  // anchor takes those two as no more than a reason to register again (the registry has already
  // let it go by the time it hears), so a press outside it still finds it.
  const latest = useRef({ dismiss, anchorElement, follow })
  useLayoutEffect(() => {
    latest.current = { dismiss, anchorElement, follow }
  })
  useEffect(() => {
    let release: (() => void) | null = null
    const register = (): void => {
      release = openPopover({
        element: () => dialog.current,
        anchor: () => latest.current.anchorElement?.() ?? null,
        close: (reason) => {
          if (latest.current.follow && (reason === 'scroll' || reason === 'resize')) register()
          else latest.current.dismiss()
        }
      })
    }
    register()
    return () => release?.()
  }, [])

  // The same two functions as the spring's shown state, so the transition interpolates each;
  // the reduced-motion fade names opacity alone, at §11.3's one length, and keeps the transform
  // where the spring left it (the computed value stays the shown state's identity matrix rather
  // than going to `none`): nothing travels, and nothing re-rasterises under the fade.
  const motion: CSSProperties =
    collapsing === 'pop'
      ? {
          opacity: 0,
          transform: 'scale(0.94) translateY(0px)',
          transformOrigin: origin,
          transition: 'opacity 180ms var(--zen-ease), transform 180ms var(--zen-ease)',
          pointerEvents: 'none'
        }
      : collapsing === 'fade'
        ? {
            opacity: 0,
            transform: style.transform,
            transformOrigin: style.transformOrigin,
            transition: `opacity ${REDUCED_FADE_MS}ms var(--zen-ease)`,
            pointerEvents: 'none'
          }
        : style

  return (
    <ChromePortal>
      <div
        ref={dialog}
        className={cn(
          'zen-desktop-popover fixed flex flex-col overflow-hidden rounded-[var(--v2-radius-card)] border border-[var(--v2-border)] bg-[var(--v2-panel)] text-[var(--v2-text)] shadow-[var(--v2-shadow-panel)] outline-none',
          className
        )}
        style={{ ...popoverStyle(placement), ...motion }}
        role="dialog"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        data-collapsing={collapsing ? 'true' : undefined}
        {...data}
      >
        {children({ close })}
      </div>
    </ChromePortal>
  )
}

/**
 * Without an anchor (the pill is hidden in compact mode, or the request came without a tab) the
 * popover hangs centred under the top edge of the content frame, 8 px in: `placePopover` with a
 * flat bar along that edge and the anchor the popover's own box on it, so the chassis's margins
 * and its 60% height cap hold here as under a pill.
 */
function unanchoredPlacement(
  width: PopoverWidth,
  viewport: { width: number; height: number }
): PopoverBox {
  const frame = contentAreaStore.get().area ?? { x: 0, y: 0, width: viewport.width, height: 0 }
  const bar: Rect = { x: frame.x, y: frame.y + POPOVER_MARGIN, width: frame.width, height: 0 }
  const anchor: Rect = {
    x: Math.round(frame.x + (frame.width - width) / 2),
    y: bar.y,
    width,
    height: 0
  }
  return placePopover(anchor, bar, viewport, width, undefined, 'start')
}

export type LevelDirection = 'forward' | 'back' | 'none'

/**
 * A level of a popover with detail levels (v1 §7 motion, the site-information target): keyed by
 * the level it shows, it pushes in on `SPRING_GENTLE` – 24 px from the end edge when going
 * deeper, from the start edge when coming back – and fades in with it; `none` (the first level
 * on open) lands at once, as does reduced motion. Keyboard reach moves to the level's first
 * control (its back button) so the arrow of attention follows the push.
 */
export function Level({
  direction,
  className,
  children
}: {
  direction: LevelDirection
  className?: string
  children: ReactNode
}): JSX.Element {
  const [t, setT] = useState(direction === 'none' ? 1 : 0)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (direction === 'none') return
    const spring = new SpringAnimation(
      SPRING_GENTLE,
      (x) => setT(Math.min(1, Math.max(0, x / 100))),
      () => undefined
    )
    spring.start(0, 0, 100)
    const el = root.current
    if (el) (focusableIn(el)[0] ?? el).focus({ preventScroll: true })
    return () => {
      spring.stop()
    }
  }, [direction])
  const offset = direction === 'forward' ? 24 : direction === 'back' ? -24 : 0
  return (
    <div
      ref={root}
      className={cn('flex min-h-0 flex-col outline-none', className)}
      tabIndex={-1}
      style={{ opacity: t, transform: `translateX(${Math.round((1 - t) * offset)}px)` }}
    >
      {children}
    </div>
  )
}

/**
 * A row's trailing value: 15 px at 69% (`muted`), or in ink for a value that counts. It truncates
 * inside the row's trailing slot, which `ListRow` caps at 55% of the row so the label keeps the
 * larger share.
 */
export function RowValue({
  children,
  muted = true,
  className
}: {
  children: ReactNode
  muted?: boolean
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'min-w-0 truncate text-[15px] leading-5',
        muted ? 'text-[var(--v2-text-deemphasized)]' : 'text-[var(--v2-text)]',
        className
      )}
    >
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Desktop dialog
// ---------------------------------------------------------------------------

export interface DialogApi {
  /**
   * Close from a key or a button (Cancel, the primary once it has done its work): the owner's
   * `onCancel` runs; focus goes back to the anchor as the dialog leaves (§9.22, `usePopover`).
   */
  close: () => void
}

/**
 * A dialog's width is one of the popover's (§9.20): 400 for a title block with a form or a
 * choice and its actions, 480 only for two columns or a table – never 320 and never a value
 * between. `frame` is the one dialog that is a workspace rather than a prompt – the print
 * preview, Chrome's constrained window at the tab's size less a margin – which fills the
 * content frame 32 px inside its edges.
 */
export type DialogWidth = typeof POPOVER_WIDTH.form | typeof POPOVER_WIDTH.table | 'frame'

/**
 * A v2 dialog (§2, §3, §9.5): the neutral surface at radius 12 with a hairline at one of the
 * two dialog widths (§9.20), placed in flow through the nearest `FrameDialogHost` (TabDialogs
 * mounts one over the content frame), which centres it and dims only that frame; the sidebar
 * and toolbar stay undimmed and inert. Focus moves into the form and Tab wraps inside it, and
 * when the dialog leaves with focus still inside, focus goes back to the anchor (§9.22, the
 * chassis's `usePopover`). Escape and a press on the scrim are Cancel. Never `fixed`.
 */
export function DesktopDialog({
  labelledBy,
  onCancel,
  api,
  width = POPOVER_WIDTH.form,
  initialFocus = 'first',
  className,
  children,
  ...data
}: {
  labelledBy: string
  onCancel: () => void
  /** Receives the dialog's own close, for footer buttons. */
  api?: RefObject<DialogApi | null>
  width?: DialogWidth
  /**
   * Where focus lands as the dialog paints (§9.22): its first focusable, the dialog itself
   * (`tabIndex -1`), or an element of the caller's choosing – for a form whose rows arrive
   * after the footer, the first field once it is there, the dialog until then – falling back
   * to the dialog when the function finds nothing.
   */
  initialFocus?: 'first' | 'container' | ((root: HTMLElement) => HTMLElement | null)
  className?: string
  children: ReactNode
} & DataAttributes): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  useImperativeHandle(api, () => ({ close: onCancel }), [onCancel])
  useFrameDialog({ onScrimPress: onCancel })
  usePopover(dialog, {
    onClose: onCancel,
    initial:
      typeof initialFocus === 'function' ? (root) => initialFocus(root) ?? root : initialFocus
  })

  return (
    <div
      ref={dialog}
      className={cn(
        'zen-animate-pop flex max-h-[calc(100%-32px)] max-w-[calc(100%-32px)] flex-col overflow-hidden rounded-[var(--v2-radius-sheet)] border border-[var(--v2-border)] bg-[var(--v2-panel)] text-[var(--v2-text)] shadow-[var(--v2-shadow-sheet)] outline-none',
        width === 'frame' && 'h-[calc(100%-64px)] w-[calc(100%-64px)]',
        className
      )}
      style={width === 'frame' ? undefined : { width }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onMouseDown={(e) => e.stopPropagation()}
      {...data}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phone sheet
// ---------------------------------------------------------------------------

export interface SheetApi {
  dismiss: () => void
}

/**
 * The shared bottom sheet, which is the v2 sheet chassis (§6, §9.9, §9.25: the `--v2-panel`
 * surface at radius 12 with a hairline edge and the sheet shadow, the v2 scrim, rows edge to
 * edge, `data-surface="page"`): after the grip strip either the chassis's 48 header with the
 * title centred (§9.16, `.zen-sheet-title`) or – for a prompt – a title block (§9.23) at the top
 * of the body, the glyph on the title's start; `footer` goes in the chassis's footer slot under
 * the scrolling body (§9.11: in reach at every detent). One gutter of 16 from the sheet's edge
 * to every text and control edge. The system back gesture pulls it down with the finger; Escape
 * (the top popup's, `useEscape`), the back button and a scrim tap slide it away. Focus, Tab, the
 * inert chrome behind the scrim and the stack over another sheet (§9.24: one scrim, the lower
 * receded) are the chassis's – nothing to do here. It renders through the chrome layer, so its
 * fixed box is the window wherever it was mounted.
 */
export function V2Sheet({
  name,
  title,
  titleBlock,
  footer,
  onDismissed,
  contentKey,
  handleLabel,
  children,
  api,
  labelledBy,
  ...data
}: {
  /** Back-surface name. */
  name: string
  /** A 48 header with this title centred; omitted for a prompt with a `titleBlock`. */
  title?: string
  titleBlock?: ReactNode
  /**
   * The id of the element that names the dialog: a `titleBlock`'s `TitleBlock` id. A `title`
   * names it by itself (`<name>-title`).
   */
  labelledBy?: string
  /** The footer slot's content: a `Footer`, or the buttons themselves. */
  footer?: ReactNode
  onDismissed: () => void
  contentKey?: string
  handleLabel: string
  children: ReactNode
  /** Receives the sheet's own dismiss, for footer buttons. */
  api?: RefObject<SheetApi | null>
} & DataAttributes): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const dismiss = useCallback((): void => sheet.current?.dismiss(), [])
  useImperativeHandle(api, () => ({ dismiss }), [dismiss])
  useBackSurface({
    name,
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)

  return (
    <ChromePortal>
      <BottomSheet
        ref={sheet}
        onDismissed={onDismissed}
        contentKey={contentKey}
        handleLabel={handleLabel}
        labelledBy={title ? `${name}-title` : labelledBy}
        header={
          title ? (
            <h2 id={`${name}-title`} className="zen-sheet-title">
              {title}
            </h2>
          ) : undefined
        }
        footer={footer}
      >
        <div className="flex flex-col" {...data}>
          {titleBlock}
          {children}
        </div>
      </BottomSheet>
    </ChromePortal>
  )
}

// ---------------------------------------------------------------------------
// Title block, bar header, footer
// ---------------------------------------------------------------------------

/**
 * A title block (§9.23): padding 16, an optional row glyph on the title's start with an 8 px gap
 * and no fill tile, the title 17/600 at line-height 22, an optional description 15 at 69% 4 px
 * under it – one composition on both platforms. In a phone sheet it is the chassis's
 * (`.zen-sheet-title-block`: the description runs under the glyph, as the protocol prompt's
 * does). Sticky in a scrolling popover: `scrolled` draws §9.7's hairline at its bottom edge.
 */
export function TitleBlock({
  id,
  glyph,
  title,
  description,
  scrolled = false,
  className
}: {
  id: string
  glyph?: ReactNode
  title: ReactNode
  description?: ReactNode
  scrolled?: boolean
  className?: string
}): JSX.Element {
  const phone = usePhone()
  if (phone) {
    return (
      <div className={cn('zen-sheet-title-block shrink-0', className)}>
        <h2 id={id}>
          {glyph && (
            <span
              className="mt-[calc((var(--v2-line-heading-box)-var(--v2-icon))/2)] flex shrink-0 self-start"
              aria-hidden
            >
              {glyph}
            </span>
          )}
          <span className="min-w-0 break-words">{title}</span>
        </h2>
        {description && <p className="break-words">{description}</p>}
      </div>
    )
  }
  return (
    <div
      className={cn(
        'flex shrink-0 items-start gap-2 p-4',
        scrolled && 'shadow-[0_1px_0_0_var(--v2-border)]',
        className
      )}
    >
      {glyph && (
        <span
          className="mt-[calc((var(--v2-line-heading-box)-var(--v2-icon))/2)] flex shrink-0"
          aria-hidden
        >
          {glyph}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2
          id={id}
          className="text-[17px] leading-[var(--v2-line-heading)] font-semibold break-words"
        >
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-[15px] leading-[var(--v2-line-body)] text-[var(--v2-text-deemphasized)] break-words">
            {description}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * A bar header for a detail level inside a popover (§9.16): 40 tall on desktop – a 28 px back
 * button at 6 px margins, the title 17/600 after an 8 px gap – and 56 on phones with a 44 px
 * button. `scrolled` draws §9.7's hairline.
 */
export function BarHeader({
  id,
  title,
  onBack,
  backLabel = 'Back',
  scrolled = false
}: {
  id: string
  title: string
  onBack: () => void
  backLabel?: string
  scrolled?: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex h-[calc(var(--v2-icon-button)+12px)] shrink-0 items-center gap-2 px-1.5',
        scrolled && 'shadow-[0_1px_0_0_var(--v2-border)]'
      )}
    >
      <button type="button" className="zen-v2-icon-button" aria-label={backLabel} onClick={onBack}>
        <ChevronLeft aria-hidden />
      </button>
      <h2
        id={id}
        className="min-w-0 flex-1 truncate text-[17px] leading-[var(--v2-line-heading)] font-semibold"
      >
        {title}
      </h2>
    </div>
  )
}

/**
 * Footer actions (§9.11, §9.20). Desktop: hugging, right-aligned at 32 tall with an 8 px gap,
 * the primary last, in one of two forms and no third. A panel whose body is a row list
 * (`hairline`) ends in a hairline in the gutter – 4 under the list, which is the list's own
 * inset – and the buttons at 12 above and below, 16 at the sides. A prompt or a dialog ends in
 * its actions with no hairline: the last body element, 16, the buttons, 16 to the edge; where a
 * title block is all there is, its own 16 below serves, and the footer passes `pt-0`. Phone:
 * the content of the chassis's footer slot (`V2Sheet`'s `footer`, the `.zen-sheet-footer` under
 * the body), full width – one action spans the row, two split it with an 8 px gap, three or
 * more stack full-width with the primary first (pass them in that order), each its 40: the
 * chassis's `flex: 1` shares the row's width between peers and would share a column's height
 * between stacked buttons, so the stack is one column wrapper with `flex: none` children; the
 * slot's 8 under the last button and the sheet's own bottom padding make the 16 to the edge.
 */
export function Footer({
  children,
  count,
  hairline = true,
  className
}: {
  children: ReactNode
  /** How many buttons: on phones, three or more stack. */
  count: number
  /** The panel form (a row list above); `false` is the prompt and dialog form. */
  hairline?: boolean
  className?: string
}): JSX.Element {
  const phone = usePhone()
  if (phone) {
    if (count < 3) return <>{children}</>
    return (
      <div className={cn('flex w-full flex-col gap-2 [&>*]:flex-none', className)} data-stack="">
        {children}
      </div>
    )
  }
  return (
    <div className="shrink-0" data-footer={hairline ? 'panel' : 'prompt'}>
      {hairline && <div className="mx-4 h-px bg-[var(--v2-border)]" aria-hidden />}
      <div
        className={cn(
          'flex items-center justify-end gap-2 px-4',
          hairline ? 'py-3' : 'pt-4 pb-4',
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

/**
 * The checkbox, radio and field are main's shared primitives (§9.34): `.zen-v2-checkbox` (#93's
 * rule), `.zen-v2-radio` and `.zen-v2-field` in main.css – box, hairline, accent fill, glyph,
 * hover, the disabled opacity and the (line − box) / 2 offset onto the label's first line (§6,
 * §9.2, §9.14, §5). These wrappers add only the label beside the box and the text metrics; no
 * rule here restates a control.
 */
type ControlInputProps = Omit<
  JSX.IntrinsicElements['input'],
  'type' | 'className' | 'children' | 'ref'
>

const CONTROL_LABEL = 'flex min-w-0 items-start gap-2.5 text-[15px] leading-5'

/** The `data-*` attributes among a control's props go on its row; the rest on the input. */
function splitData<P extends object>(props: P): { data: DataAttributes; rest: P } {
  const data: DataAttributes = {}
  const rest = {} as P
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('data-')) data[key as `data-${string}`] = value as string | undefined
    else (rest as Record<string, unknown>)[key] = value
  }
  return { data, rest }
}

/**
 * A checkbox with its label to the right; the label may carry a second, deemphasised line. The
 * label is #93's check row (`.zen-v2-check-row`): a box disabled puts the .4 on the row's content
 * and keeps the box itself at 1, so text and box read as one disabled control (§9.30).
 * `data-*` attributes name the row, for tests and drivers.
 */
export function Checkbox({
  label,
  className,
  ...props
}: ControlInputProps & { label: ReactNode; className?: string } & DataAttributes): JSX.Element {
  const { data, rest } = splitData(props)
  return (
    <label
      className={cn(
        'zen-v2-check-row flex min-w-0',
        rest.disabled ? 'cursor-default' : 'cursor-pointer',
        className
      )}
      aria-disabled={rest.disabled || undefined}
      {...data}
    >
      <span className={cn(CONTROL_LABEL, 'flex-1 text-[var(--v2-text)]')}>
        <input type="checkbox" className="zen-v2-checkbox" {...rest} />
        <span className="min-w-0">{label}</span>
      </span>
    </label>
  )
}

/**
 * A plain radio (§9.14) with its label, and a 13 px description under it when given: the row
 * is the target and carries `aria-checked`, which draws the shared `.zen-v2-radio` beside it;
 * the row is its padding around the text lines – (52 − 40) / 2 with a description, (32 − 20) / 2
 * without – scaled by the phone tokens.
 */
export function Radio({
  label,
  description,
  checked,
  disabled = false,
  onSelect,
  className,
  ...data
}: {
  label: ReactNode
  description?: ReactNode
  checked: boolean
  disabled?: boolean
  onSelect: () => void
  className?: string
} & DataAttributes): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className={cn(
        CONTROL_LABEL,
        'w-full text-left text-[var(--v2-text)] outline-none disabled:pointer-events-none disabled:opacity-40',
        description
          ? 'py-[calc((var(--v2-row-two-line)-40px)/2)]'
          : 'py-[calc((var(--v2-row)-20px)/2)]',
        className
      )}
      onClick={onSelect}
      {...data}
    >
      <span className="zen-v2-radio" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="min-w-0">{label}</span>
        {description && (
          <span className="min-w-0 text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-text-deemphasized)]">
            {description}
          </span>
        )}
      </span>
    </button>
  )
}

/** Secret strings are set in the platform monospace, one colour, no ligatures (§4). */
const SECRET_TEXT: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  fontVariantLigatures: 'none'
}

/** A text field (§5); `secret` for a passphrase or key. Fills its line: `.zen-v2-field` is block. */
export function Field({
  secret = false,
  className,
  style,
  ...props
}: Omit<JSX.IntrinsicElements['input'], 'className' | 'children' | 'ref'> & {
  secret?: boolean
  className?: string
}): JSX.Element {
  return (
    <input
      className={cn('zen-v2-field', className)}
      style={secret ? { ...SECRET_TEXT, ...style } : style}
      {...props}
    />
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * A list row (§9.2, §9.18, §9.21): 32 / 44 for one line, 52 / 64 with a description (label 15,
 * description 13 at 69%, both on 20 px lines), growing with its text and never clamping; a row
 * holding a control is at least the control plus 8. A leading glyph aligns with the first text
 * line; whatever trails is centred on the row, except on three text lines, where it centres on
 * the label's line. With `onClick` the whole row is a button with the press fill; `chevron`
 * says it opens a level; `busy` is an action row at work (§9.30): full opacity, the spinner
 * trailing, `aria-busy`, and a press does nothing. Without `onClick` the row is not a target
 * (§9.34): it carries `data-static` – no hover or press fill, no pointer – whether it is a fact
 * or holds a control of its own. Sits edge to edge with its text inset 16 (§9.25).
 */
export function ListRow({
  label,
  description,
  leading,
  trailing,
  chevron = false,
  onClick,
  disabled = false,
  busy = false,
  danger = false,
  control = false,
  className,
  role,
  'aria-label': ariaLabel,
  'aria-checked': ariaChecked,
  'aria-haspopup': ariaHasPopup,
  'aria-expanded': ariaExpanded,
  'aria-controls': ariaControls,
  ...data
}: {
  label: ReactNode
  description?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  chevron?: boolean
  /** The press; its event carries the row for an action that anchors a popover to it. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  busy?: boolean
  danger?: boolean
  /** The trailing slot holds a control: the row is at least control + 8 (§9.21). */
  control?: boolean
  className?: string
  /** The row is itself the control for assistive technology (`SwitchRow`: the whole row toggles). */
  role?: 'switch'
  'aria-label'?: string
  'aria-checked'?: boolean
  /** An action row that opens a picker over the panel (the reader's Translate): the popup's kind. */
  'aria-haspopup'?: 'listbox' | 'dialog'
  /** A disclosure row (Chrome's "More settings"): what it opens, and whether it is open. */
  'aria-expanded'?: boolean
  'aria-controls'?: string
} & DataAttributes): JSX.Element {
  const text = useRef<HTMLDivElement>(null)
  const [wrapped, setWrapped] = useState(false)
  useLayoutEffect(() => {
    const el = text.current
    if (!el || !description) return
    // Two 20 px lines are the row's own; anything taller is a wrapped description.
    const measure = (): void => setWrapped(el.getBoundingClientRect().height > 50)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [description])

  const content = (
    <>
      {leading && (
        <span
          className="mt-[calc((var(--v2-line-body-box)-var(--v2-icon))/2)] flex shrink-0 self-start"
          aria-hidden
        >
          {leading}
        </span>
      )}
      <div ref={text} className="min-w-0 flex-1">
        <div
          className={cn(
            'truncate text-[15px] leading-5',
            danger ? 'text-[var(--v2-danger)]' : 'text-[var(--v2-text)]'
          )}
        >
          {label}
        </div>
        {description && (
          <div className="line-clamp-2 text-[13px] leading-[var(--v2-line-small)] text-[var(--v2-text-deemphasized)]">
            {description}
          </div>
        )}
      </div>
      {(trailing || chevron || busy) && (
        <div
          className={cn(
            'flex max-w-[55%] shrink-0 items-center gap-3',
            wrapped && 'mt-[calc((20px-var(--v2-control))/2)] self-start'
          )}
        >
          {busy ? <Spinner /> : trailing}
          {chevron && (
            <ChevronRight
              className={cn(V2_GLYPH, 'text-[var(--v2-text-deemphasized)]')}
              aria-hidden
            />
          )}
        </div>
      )}
    </>
  )
  // Both forms carry `zen-v2-row`: the button for the shared focus ring, and either so a
  // `Rows` group can move the text inset of every row it holds. The row's height and padding
  // are the primitive's (`.zen-v2-row`, main.css, §9.34): the base row on `--v2-row-pad`, and
  // for a one-line row holding a control, `data-control` – the control plus 8 (§9.21). A
  // two-line row (§9.2) already holds a control inside its lines and takes no mark.
  const layout = cn('zen-v2-row flex w-full items-center gap-2.5 px-4 text-left', className)
  const controlRow = control && !description ? '' : undefined
  if (onClick) {
    return (
      <button
        type="button"
        className={cn(
          'outline-none transition-colors duration-[120ms] hover:bg-[var(--v2-fill)] active:bg-[var(--v2-fill-hover)] disabled:pointer-events-none disabled:opacity-40',
          layout
        )}
        disabled={disabled}
        role={role}
        aria-label={ariaLabel}
        aria-checked={role === 'switch' ? ariaChecked : undefined}
        aria-busy={busy || undefined}
        aria-haspopup={ariaHasPopup}
        aria-expanded={ariaExpanded}
        aria-controls={ariaExpanded ? ariaControls : undefined}
        onClick={busy ? undefined : onClick}
        data-control={controlRow}
        {...data}
      >
        {content}
      </button>
    )
  }
  return (
    <div
      className={cn(layout, disabled && 'opacity-40')}
      aria-disabled={disabled || undefined}
      data-static=""
      data-control={controlRow}
      {...data}
    >
      {content}
    </div>
  )
}

/**
 * A hairline between groups of rows, in the gutter: 4 px margins in a desktop popover (§6
 * menus), the chassis's `.zen-sheet-sep` at 8 in a phone sheet.
 */
export function Separator(): JSX.Element {
  const phone = usePhone()
  return (
    <div
      className={phone ? 'zen-sheet-sep shrink-0' : 'mx-4 my-1 h-px shrink-0 bg-[var(--v2-border)]'}
      aria-hidden
    />
  )
}

/** An empty state in a popover or sheet (§9.17): one centred sentence, 32 / 48 below the header. */
export function EmptyLine({ children }: { children: ReactNode }): JSX.Element {
  const phone = usePhone()
  return (
    <p
      className={cn(
        'px-8 pb-4 text-center text-[15px] leading-5 text-[var(--v2-text-deemphasized)]',
        phone ? 'pt-12' : 'pt-8'
      )}
    >
      {children}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Menulist
// ---------------------------------------------------------------------------

export type { MenulistOption }

/**
 * The menulist (§6, §9.13) is the shared `V2Menulist` (`extensions/V2Menulist`, the
 * `.zen-v2-menulist` rules): the 32 px control with its chevron, the `--v2-panel` popover of 28 px
 * rows flush under it on a mouse – its own light dismiss, arrow keys, Escape back to the control
 * – and a sheet of radio rows under a finger. This wrapper only sizes it for a row's trailing
 * slot: its own width, no less than 140, where the shared control fills its line. `readOnly`
 * is a busy form's (§9.30): the value in place at full opacity, opening nothing. `autoFocus`
 * takes the keyboard as the control mounts (a form's first field arriving after its dialog).
 */
export function Menulist<V extends string>({
  className,
  ...props
}: {
  value: V
  options: ReadonlyArray<MenulistOption<V>>
  onChange: (value: V) => void
  /** Accessible name of the control (the row's label). */
  label: string
  disabled?: boolean
  readOnly?: boolean
  autoFocus?: boolean
  className?: string
  /** A class on the popup's panel (`V2Menulist`'s `popupClassName`). */
  popupClassName?: string
}): JSX.Element {
  return <V2Menulist {...props} className={cn('w-auto min-w-[140px] shrink-0', className)} />
}

/**
 * A setting with a choice on a mouse (§10.4, §9.13): a row with the menulist trailing it (40
 * tall, the control plus 8) and the row's explanation as its description. The phone's form of
 * the same setting is a value row of the Settings builder (`pages/settings`), which opens the
 * chassis's picker sheet.
 */
export function ChoiceRow<V extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled = false,
  readOnly = false,
  autoFocus = false,
  controlClassName,
  popupClassName,
  leading
}: {
  label: string
  description?: string
  value: V
  options: ReadonlyArray<MenulistOption<V>>
  onChange: (value: V) => void
  disabled?: boolean
  /** A busy form's row (§9.30): the menulist keeps its value at full opacity and opens nothing. */
  readOnly?: boolean
  /** The form's first field: takes the keyboard as it mounts (§9.22). */
  autoFocus?: boolean
  /** The menulist's own classes – a column that gives every control one width (§9.13). */
  controlClassName?: string
  /** A class on the menulist's popup panel: a surface's own width floor for a long list. */
  popupClassName?: string
  leading?: ReactNode
}): JSX.Element {
  return (
    <ListRow
      label={label}
      description={description}
      leading={leading}
      disabled={disabled}
      control
      trailing={
        <Menulist
          value={value}
          options={options}
          onChange={onChange}
          label={label}
          disabled={disabled}
          readOnly={readOnly}
          autoFocus={autoFocus}
          className={controlClassName}
          popupClassName={popupClassName}
        />
      }
    />
  )
}

/**
 * A setting that takes effect the moment it is flipped, in a control panel (§9.13, §10.4): the
 * row is the switch – `role="switch"` with `aria-checked`, the whole row its target with the
 * press fill – and the shared 36 × 20 `.zen-v2-switch` trails it, drawn on from the row's
 * `aria-checked`. Disabled, the row stays laid out at .4 and takes no press (§9.30).
 */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  leading,
  ...data
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  leading?: ReactNode
} & DataAttributes): JSX.Element {
  return (
    <ListRow
      label={label}
      description={description}
      leading={leading}
      disabled={disabled}
      control
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      trailing={<span className="zen-v2-switch" aria-hidden />}
      {...data}
    />
  )
}

/** Re-export for surfaces that only need the button next to these primitives. */
export { V2Button }
