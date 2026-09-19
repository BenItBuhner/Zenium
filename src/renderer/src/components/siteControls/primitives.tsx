import type { CSSProperties, JSX, ReactNode, RefObject } from 'react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react'
import type { Rect } from '@shared/types'
import { useBackSurface } from '@renderer/lib/back'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  openPopover,
  placePopover,
  popoverStyle,
  toRect,
  useFrameDialog,
  useLightDismiss,
  viewportSize,
  type PopoverBox,
  type PopoverWidth
} from '@renderer/lib/portals'
import { initialFocusIn } from '@renderer/lib/focusReach'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { usePhone, useSurfaceLayer, type DataAttributes } from '@renderer/lib/surfaces'
import { contentAreaStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { useFocusReach } from '@renderer/hooks/useFocusReach'
import { useSpringPresence } from '@renderer/hooks/useSpringPresence'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { V2_GLYPH, V2Button, type V2ButtonProps } from '../v2/controls'

/**
 * The chassis the site-control surfaces share, on the design language v2 draft: the desktop
 * popover (§9.20) through the chrome layer and the dialog (§9.5) through the frame dialog host
 * (lib/portals.tsx), the phone sheet on the shared `BottomSheet` – the v2 sheet chassis with its
 * 48 header, title block, footer and separators (§6, §9.9, §9.16, §9.23, §9.25; the
 * `.zen-sheet-*` rules in main.css) – the title block for a popover (§9.23), rows (§9.2, §9.18,
 * §9.21), footers (§9.11) and the menulist (§9.13) that is a popover on a mouse and a sheet under
 * a finger. Everything reads the `--v2-*` tokens only; nothing here defines a colour. The chrome
 * layer, the frame dialog host and the bottom sheet all carry `data-surface="page"`, so every
 * surface here draws in the page family (§9.29). The hooks and measurements these share
 * (`usePhone`, `useSurfaceLayer`, the site chip) live in lib/surfaces.
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

/**
 * An anchored desktop popover (§9.20): one of the three fixed widths, placed by `placePopover`
 * – below `bar` (the pill or bar the anchor sits in) with its top border flush to the bar's
 * bottom edge, start-aligned with the anchor, flipped or slid to stay 8 px inside the window,
 * at most 60% of the window tall, above the bar when the room below runs out; `--v2-panel` at
 * radius 8 with a hairline and the panel shadow, no scrim (§9.5). It renders through the chrome
 * layer (`ChromePortal`), never inside the frame, and registers with the layer's light dismiss
 * (`lib/popoverStore.ts`, §9.20 amended): a press outside it closes it and is consumed, nothing
 * beneath receives it; a scroll outside it, a window resize, another popover opening and a frame
 * dialog opening close it too. `anchorElement` names what opened it, so a popover opening from
 * inside another (a menulist's list in a level) is its child and leaves it up, a press on the
 * anchor closes without reopening, and the focus goes back there after an outside press. Enter
 * and exit run on the v1 spring out of the anchor. Focus moves in on open and Tab wraps (§9.22):
 * to the first row or button, or – for a title-and-notice panel such as a prompt – to the
 * container. Escape closes and hands focus back to the anchor. `follow`: a scroll or a resize
 * leaves the surface up, moving with its anchor (a prompt the page is still waiting on); an
 * outside press still closes it. With `onDismiss` every dismissal calls the owner instead of
 * leaving at once: the owner answers and then sets `closing`.
 */
export function DesktopPopover({
  anchor,
  bar = anchor,
  width = POPOVER_WIDTH.form,
  labelledBy,
  onClosed,
  closing = false,
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
  /** Escape, an outside press, a scroll and a resize ask the owner rather than closing outright. */
  onDismiss?: () => void
  focus?: 'first' | 'container'
  /** Stay up through a scroll or a resize, following the anchor. */
  follow?: boolean
  /** The element that opened the popover, for the light-dismiss registry. */
  anchorElement?: () => Element | null
  className?: string
  children: (api: PopoverApi) => ReactNode
} & DataAttributes): JSX.Element {
  const viewport = viewportSize()
  const placement = anchor
    ? placePopover(anchor, bar ?? anchor, viewport, width)
    : unanchoredPlacement(width, viewport)
  const byKey = useRef(false)
  // The spring runs out of the anchor: from the popover's edge on the bar, under the anchor's
  // middle.
  const originX = anchor ? anchor.x + anchor.width / 2 - placement.left : placement.width / 2
  const { style, close } = useSpringPresence(
    () => onClosed(byKey.current),
    `${originX}px ${placement.side === 'below' ? '0%' : '100%'}`
  )
  const dialog = useRef<HTMLDivElement>(null)
  // `focus: 'container'`: the panel takes focus here, before `useFocusReach` looks and finds it
  // already inside, so no button is armed for a stray Enter. The hook would then record the
  // panel as the opener, so the element focus came from is kept here for the Escape return.
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (focus !== 'container') return
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null
    dialog.current?.focus()
  }, [focus])
  const { returnFocus: returnToOpener } = useFocusReach(dialog)
  const returnFocus = useCallback((): void => {
    if (focus !== 'container') return returnToOpener()
    const el = opener.current
    if (el?.isConnected) el.focus()
  }, [focus, returnToOpener])
  const isTop = useSurfaceLayer()
  const dismiss = onDismiss ?? close

  useEffect(() => {
    if (closing) close()
  }, [closing, close])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTop()) return
      e.stopPropagation()
      byKey.current = true
      returnFocus()
      dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dismiss, returnFocus, isTop])

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

  return (
    <ChromePortal>
      <div
        ref={dialog}
        className={cn(
          'fixed flex flex-col overflow-hidden rounded-[var(--v2-radius-card)] border border-[var(--v2-border)] bg-[var(--v2-panel)] text-[var(--v2-text)] shadow-[var(--v2-shadow-panel)] outline-none',
          className
        )}
        style={{ ...popoverStyle(placement), ...style }}
        role="dialog"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        {...data}
      >
        {children({ close })}
      </div>
    </ChromePortal>
  )
}

/**
 * Without an anchor (the pill is hidden in compact mode, or the request came without a tab) the
 * popover hangs centred under the top edge of the content frame, 8 px in.
 */
function unanchoredPlacement(
  width: number,
  viewport: { width: number; height: number }
): PopoverBox {
  const frame = contentAreaStore.get().area
  const left = frame
    ? Math.max(POPOVER_MARGIN, Math.round(frame.x + (frame.width - width) / 2))
    : Math.max(POPOVER_MARGIN, Math.round((viewport.width - width) / 2))
  const top = frame ? frame.y + POPOVER_MARGIN : POPOVER_MARGIN
  return { side: 'below', left, top, width, maxHeight: Math.round(viewport.height * 0.6) }
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
    if (el) initialFocusIn(el).focus()
    return () => {
      spring.stop()
    }
  }, [direction])
  const offset = direction === 'forward' ? 24 : direction === 'back' ? -24 : 0
  return (
    <div
      ref={root}
      className={cn('flex min-h-0 flex-col', className)}
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
   * Close from a key or a button (Cancel, the primary once it has done its work): focus goes
   * back to the anchor first (§9.22), then the owner's `onCancel` runs.
   */
  close: () => void
}

/**
 * A dialog's width is one of the popover's (§9.20): 400 for a title block with a form or a
 * choice and its actions, 480 only for two columns or a table – never 320 and never a value
 * between.
 */
export type DialogWidth = typeof POPOVER_WIDTH.form | typeof POPOVER_WIDTH.table

/**
 * A v2 dialog (§2, §3, §9.5): the neutral surface at radius 12 with a hairline at one of the
 * two dialog widths (§9.20), placed in flow through the nearest `FrameDialogHost` (TabDialogs
 * mounts one over the content frame), which centres it and dims only that frame; the sidebar
 * and toolbar stay undimmed and inert. Focus moves into the form and Tab wraps inside it
 * (§9.22). Escape and a press on the scrim are Cancel: Escape hands focus back to the anchor,
 * a press on the scrim leaves it where the press landed. Footer buttons close through
 * `api.close`, which returns focus too. Never `fixed`.
 */
export function DesktopDialog({
  labelledBy,
  onCancel,
  api,
  width = POPOVER_WIDTH.form,
  className,
  children,
  ...data
}: {
  labelledBy: string
  onCancel: () => void
  /** Receives the dialog's own close, for footer buttons. */
  api?: RefObject<DialogApi | null>
  width?: DialogWidth
  className?: string
  children: ReactNode
} & DataAttributes): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null)
  const { returnFocus } = useFocusReach(dialog)
  const close = useCallback((): void => {
    returnFocus()
    onCancel()
  }, [returnFocus, onCancel])
  useImperativeHandle(api, () => ({ close }), [close])
  useFrameDialog({ onScrimPress: onCancel })
  const isTop = useSurfaceLayer()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTop()) return
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close, isTop])

  return (
    <div
      ref={dialog}
      className={cn(
        'zen-animate-pop flex max-h-[calc(100%-32px)] max-w-[calc(100%-32px)] flex-col overflow-hidden rounded-[var(--v2-radius-sheet)] border border-[var(--v2-border)] bg-[var(--v2-panel)] text-[var(--v2-text)] shadow-[var(--v2-shadow-sheet)] outline-none',
        className
      )}
      style={{ width }}
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
  /** Settle on the expanded detent, for content a choice inside the sheet just revealed. */
  expand: () => void
}

/**
 * The shared bottom sheet, which is the v2 sheet chassis (§6, §9.9, §9.25: the `--v2-panel`
 * surface at radius 12 with a hairline edge and the sheet shadow, the v2 scrim, rows edge to
 * edge, `data-surface="page"`): after the grip strip either the chassis's 48 header with the
 * title centred (§9.16, `.zen-sheet-title`) or – for a prompt – a title block (§9.23) at the top
 * of the body, the glyph on the title's start. One gutter of 16 from the sheet's edge to every
 * text and control edge. The system back gesture pulls it down with the finger; Escape, the back
 * button and a scrim tap slide it away. Opened over another sheet (a picker, a confirmation) it
 * is the chassis's upper sheet (§9.24): its scrim is the stack's one, and the sheet under it
 * recedes, dims and goes inert with its progress – nothing to say here. It renders through the
 * chrome layer, so its fixed box is the window wherever it was mounted.
 */
export function V2Sheet({
  name,
  title,
  titleBlock,
  onDismissed,
  contentKey,
  handleLabel,
  children,
  api,
  ...data
}: {
  /** Back-surface name. */
  name: string
  /** A 48 header with this title centred; omitted for a prompt with a `titleBlock`. */
  title?: string
  titleBlock?: ReactNode
  onDismissed: () => void
  contentKey?: string
  handleLabel: string
  children: ReactNode
  /** Receives the sheet's own dismiss, for footer buttons. */
  api?: RefObject<SheetApi | null>
} & DataAttributes): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const dismiss = useCallback((): void => sheet.current?.dismiss(), [])
  const expand = useCallback((): void => sheet.current?.expand(), [])
  useImperativeHandle(api, () => ({ dismiss, expand }), [dismiss, expand])
  useBackSurface({
    name,
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  const isTop = useSurfaceLayer()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isTop()) return
      e.stopPropagation()
      dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dismiss, isTop])

  return (
    <ChromePortal>
      <BottomSheet
        ref={sheet}
        onDismissed={onDismissed}
        contentKey={contentKey}
        handleLabel={handleLabel}
        header={
          title ? (
            <h2 id={`${name}-title`} className="zen-sheet-title">
              {title}
            </h2>
          ) : undefined
        }
      >
        <div className="flex flex-col" {...data}>
          {titleBlock}
          {children}
        </div>
      </BottomSheet>
    </ChromePortal>
  )
}

/**
 * A confirmation sheet (§10.4: a destructive action row confirms in a sheet, never inline): a
 * title block asking the question with the consequence as its description, then the footer's
 * pair – Cancel, and the action in danger ink on the affirmative side. A pull-down, the scrim
 * or Escape is Cancel.
 */
export function ConfirmSheet({
  name,
  title,
  description,
  action,
  onConfirm,
  onDismissed,
  ...data
}: {
  name: string
  title: string
  description?: ReactNode
  /** The action button's label. */
  action: string
  onConfirm: () => void
  onDismissed: () => void
} & DataAttributes): JSX.Element {
  const api = useRef<SheetApi | null>(null)
  const confirmed = useRef(false)
  return (
    <V2Sheet
      name={name}
      api={api}
      handleLabel={`Resize ${title}`}
      onDismissed={() => {
        onDismissed()
        if (confirmed.current) onConfirm()
      }}
      titleBlock={<TitleBlock id={`${name}-title`} title={title} description={description} />}
      {...data}
    >
      <Footer count={2} className="pt-0">
        <V2Button onClick={() => api.current?.dismiss()}>Cancel</V2Button>
        <V2Button
          variant="danger"
          onClick={() => {
            confirmed.current = true
            api.current?.dismiss()
          }}
        >
          {action}
        </V2Button>
      </Footer>
    </V2Sheet>
  )
}

// ---------------------------------------------------------------------------
// Title block, bar header, footer
// ---------------------------------------------------------------------------

/**
 * A title block (§9.23): padding 16, an optional row glyph on the title's start with an 8 px gap,
 * the title 17/600 at line-height 22, an optional description 15 at 69% 4 px under it. In a
 * phone sheet it is the chassis's (`.zen-sheet-title-block`: the description runs under the
 * glyph, as the protocol prompt's does). Sticky in a scrolling popover: `scrolled` draws §9.7's
 * hairline at its bottom edge.
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
              className="mt-[calc((22px-var(--v2-icon))/2)] flex shrink-0 self-start"
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
        <span className="mt-[calc((22px-var(--v2-icon))/2)] flex shrink-0" aria-hidden>
          {glyph}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-[17px] leading-[22px] font-semibold break-words">
          {title}
        </h2>
        {description && (
          <p
            className={cn(
              'mt-1 text-[15px] text-[var(--v2-text-deemphasized)] break-words',
              phone ? 'leading-[22px]' : 'leading-5'
            )}
          >
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
      <h2 id={id} className="min-w-0 flex-1 truncate text-[17px] leading-[22px] font-semibold">
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
 * the chassis footer (`.zen-sheet-footer`), full width – one action spans the row, two split
 * it with an 8 px gap, three or more stack full-width with the primary first (pass them in that
 * order), each its 40 – the chassis's `flex: 1` shares the row's width between peers and would
 * share the column's height between stacked buttons, so the stack takes it off them; its 8
 * under the last button and the sheet's own bottom padding make the 16 to the edge, the inset
 * included.
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
    return (
      <div
        className={cn(
          'zen-sheet-footer shrink-0',
          count >= 3 && 'flex-col [&>*]:flex-none',
          className
        )}
      >
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
 * The checkbox, radio and field are the `.zen-v2-check`, `.zen-v2-radio` and `.zen-v2-field`
 * rules the blocking UI (#115) owns in main.css – box, hairline, accent fill, glyph, hover,
 * disabled opacity and the (line − box) / 2 offset onto the label's first line (§6, §9.2, §9.14,
 * §5). These wrappers add only the label beside the box and the text metrics; no rule here
 * restates the control.
 */
type ControlInputProps = Omit<
  JSX.IntrinsicElements['input'],
  'type' | 'className' | 'children' | 'ref'
>

const CONTROL_LABEL = 'flex min-w-0 cursor-pointer items-start gap-2.5 text-[15px] leading-5'

/** A checkbox with its label to the right; the label may carry a second, deemphasised line. */
export function Checkbox({
  label,
  className,
  ...props
}: ControlInputProps & { label: ReactNode; className?: string }): JSX.Element {
  return (
    <label className={cn(CONTROL_LABEL, 'text-[var(--v2-text)]', className)}>
      <input type="checkbox" className="zen-v2-check" {...props} />
      <span className="min-w-0">{label}</span>
    </label>
  )
}

/**
 * A plain radio (§9.14) with its label, and a 13 px description under it when given; the row
 * is its padding around the text lines: (52 − 40) / 2 with a description, (32 − 20) / 2 without,
 * scaled by the phone tokens.
 */
export function Radio({
  label,
  description,
  className,
  ...props
}: ControlInputProps & {
  label: ReactNode
  description?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <label
      className={cn(
        CONTROL_LABEL,
        'text-[var(--v2-text)]',
        description
          ? 'py-[calc((var(--v2-row-two-line)-40px)/2)]'
          : 'py-[calc((var(--v2-row)-20px)/2)]',
        className
      )}
    >
      <input type="radio" className="zen-v2-radio" {...props} />
      <span className="flex min-w-0 flex-col">
        <span className="min-w-0">{label}</span>
        {description && (
          <span className="min-w-0 text-[13px] leading-5 text-[var(--v2-text-deemphasized)]">
            {description}
          </span>
        )}
      </span>
    </label>
  )
}

/** Secret strings are set in the platform monospace, one colour, no ligatures (§4). */
const SECRET_TEXT: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  fontVariantLigatures: 'none'
}

/** A text field (§5); `secret` for a passphrase or key. Fills its line: `.zen-v2-field` flexes. */
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
      className={cn('zen-v2-field w-full', className)}
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
 * trailing, `aria-busy`, and a press does nothing. Sits edge to edge with its text inset 16
 * (§9.25).
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
  'aria-label': ariaLabel,
  ...data
}: {
  label: ReactNode
  description?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
  chevron?: boolean
  onClick?: () => void
  disabled?: boolean
  busy?: boolean
  danger?: boolean
  /** The trailing slot holds a control: the row is at least control + 8 (§9.21). */
  control?: boolean
  className?: string
  'aria-label'?: string
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
          className="mt-[calc((var(--v2-line-body)-var(--v2-icon))/2)] flex shrink-0 self-start"
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
          <div className="line-clamp-2 text-[13px] leading-5 text-[var(--v2-text-deemphasized)]">
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
  const height = description
    ? 'min-h-[var(--v2-row-two-line)]'
    : control
      ? 'min-h-[max(var(--v2-row),calc(var(--v2-control)+8px))]'
      : 'min-h-[var(--v2-row)]'
  const padding = description ? 'py-[calc((var(--v2-row-two-line)-40px)/2)]' : 'py-1'
  // Both forms carry `zen-v2-row`: the button for the shared focus ring, and either so a
  // `Rows` group can move the text inset of every row it holds.
  const layout = cn(
    'zen-v2-row flex w-full items-center gap-2.5 px-4 text-left',
    height,
    padding,
    className
  )
  if (onClick) {
    return (
      <button
        type="button"
        className={cn(
          'outline-none transition-colors duration-[120ms] hover:bg-[var(--v2-fill)] active:bg-[var(--v2-fill-hover)] disabled:pointer-events-none disabled:opacity-40',
          layout
        )}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-busy={busy || undefined}
        onClick={busy ? undefined : onClick}
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

export interface MenulistOption<V extends string> {
  value: V
  label: string
  /** A second line under the label in the phone picker (13 at 69%). */
  description?: string
}

/**
 * The desktop menulist (§6, §9.13): a 32 px rectangular control at radius 4 with a hairline and
 * a chevron, opening a `--v2-panel` popover flush under itself at radius 12 with 6 px padding and
 * 28 px rows at radius 6, the current option marked with a trailing check. Arrow keys move,
 * Enter picks, Escape closes; a press outside closes and is consumed. Never a native `<select>`.
 */
export function Menulist<V extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className
}: {
  value: V
  options: ReadonlyArray<MenulistOption<V>>
  onChange: (value: V) => void
  /** Accessible name of the control (the row's label). */
  label: string
  disabled?: boolean
  className?: string
}): JSX.Element {
  // The open list's anchor is the control itself, taken from the press that opened it; null while
  // the list is closed.
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const current = options.find((o) => o.value === value) ?? options[0]
  const settle = (byKey: boolean): void => {
    if (byKey) anchor?.focus()
    setAnchor(null)
  }
  return (
    <>
      <button
        type="button"
        className={cn(
          'zen-v2-menulist flex h-[var(--v2-control)] min-w-0 shrink-0 items-center gap-2 rounded-[var(--v2-radius-control)] border border-[var(--v2-border)] bg-[var(--v2-page)] px-3 text-[15px] leading-5 text-[var(--v2-text)] outline-none transition-colors duration-[120ms] hover:bg-[var(--v2-fill)] disabled:pointer-events-none disabled:opacity-40',
          className
        )}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        disabled={disabled}
        onClick={(e) => {
          const el = e.currentTarget
          setAnchor((a) => (a ? null : el))
        }}
      >
        <span className="min-w-0 flex-1 truncate text-left">{current?.label}</span>
        <ChevronDown className={cn(V2_GLYPH, 'text-[var(--v2-text-deemphasized)]')} aria-hidden />
      </button>
      {anchor && (
        <MenulistPopup
          anchor={anchor}
          value={value}
          options={options}
          label={label}
          onPick={(v) => {
            settle(true)
            if (v !== value) onChange(v)
          }}
          onClose={settle}
        />
      )}
    </>
  )
}

function MenulistPopup<V extends string>({
  anchor,
  value,
  options,
  label,
  onPick,
  onClose
}: {
  anchor: HTMLElement
  value: V
  options: ReadonlyArray<MenulistOption<V>>
  label: string
  onPick: (value: V) => void
  onClose: (byKey: boolean) => void
}): JSX.Element {
  // The list hangs flush under its trigger, start-aligned, 8 px inside the window, and flips
  // above it when its rows do not fit below (§9.13, §9.20 through `placePopover`, which knows
  // the list's height: the rows, the padding, the hairlines); it is as wide as the trigger and
  // at least a menu's 160.
  const rect = toRect(anchor.getBoundingClientRect())
  const width = Math.max(rect.width, 160)
  const box = placePopover(
    rect,
    rect,
    viewportSize(),
    { measured: width },
    options.length * 28 + 14
  )
  const list = useRef<HTMLUListElement>(null)
  // The chrome layer's light dismiss (§9.20 amended); the trigger as the anchor makes the list
  // the child of any popover the trigger sits in, so opening it leaves that popover up.
  useLightDismiss(list, () => onClose(false), { anchor: () => anchor })
  const [active, setActive] = useState(
    Math.max(
      0,
      options.findIndex((o) => o.value === value)
    )
  )
  const isTop = useSurfaceLayer()
  useEffect(() => {
    list.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isTop()) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose(true)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => {
          const n = options.length
          return (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
        })
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const option = options[active]
        if (option) onPick(option.value)
      } else if (e.key === 'Tab') {
        onClose(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, options, onPick, onClose, isTop])

  return (
    <ChromePortal>
      <ul
        ref={list}
        role="listbox"
        aria-label={label}
        aria-activedescendant={`menulist-option-${active}`}
        tabIndex={-1}
        className="zen-animate-pop fixed flex flex-col overflow-y-auto rounded-[var(--v2-radius-sheet)] border border-[var(--v2-border)] bg-[var(--v2-panel)] p-1.5 text-[var(--v2-text)] shadow-[var(--v2-shadow-panel)] outline-none"
        style={popoverStyle(box)}
      >
        {options.map((option, i) => (
          <li
            key={option.value}
            id={`menulist-option-${i}`}
            role="option"
            aria-selected={option.value === value}
            className={cn(
              'flex h-7 shrink-0 cursor-default items-center gap-2 rounded-[var(--v2-radius-inner)] px-2 text-[15px] leading-5',
              i === active && 'bg-[var(--v2-fill)]'
            )}
            onPointerMove={() => setActive(i)}
            onClick={() => onPick(option.value)}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.value === value && <CheckGlyph />}
          </li>
        ))}
      </ul>
    </ChromePortal>
  )
}

function CheckGlyph(): JSX.Element {
  return (
    <svg
      className={V2_GLYPH}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/**
 * The phone picker (§9.13, §10.4): a bottom sheet naming the setting in the chassis's 48 header
 * (§9.16) – or, when the row had a description, in a title block with the description under
 * the title (§9.23) – then 44 px radio rows, the current option checked; picking one closes it.
 * Opened over a sheet it is the stack's upper sheet (§9.24; the chassis's business).
 */
export function MenulistSheet<V extends string>({
  name,
  title,
  description,
  value,
  options,
  onPick,
  onDismissed
}: {
  name: string
  title: string
  description?: string
  value: V
  options: ReadonlyArray<MenulistOption<V>>
  onPick: (value: V) => void
  onDismissed: () => void
}): JSX.Element {
  const api = useRef<SheetApi | null>(null)
  const picked = useRef<V | null>(null)
  return (
    <V2Sheet
      name={name}
      api={api}
      handleLabel={`Resize ${title} options`}
      onDismissed={() => {
        const v = picked.current
        onDismissed()
        if (v !== null && v !== value) onPick(v)
      }}
      title={description ? undefined : title}
      titleBlock={
        description ? (
          <TitleBlock
            id={`${name}-title`}
            title={title}
            description={description}
            className="pb-2"
          />
        ) : undefined
      }
    >
      {/* 8 under the last row and the sheet's own bottom padding: 16 to the edge. */}
      <div role="radiogroup" aria-labelledby={`${name}-title`} className="pb-2">
        {options.map((option) => (
          <Radio
            key={option.value}
            name={name}
            className="min-h-[var(--v2-row)] px-4 transition-colors duration-[120ms] active:bg-[var(--v2-fill)]"
            label={option.label}
            description={option.description}
            checked={option.value === value}
            onChange={() => {
              picked.current = option.value
              api.current?.dismiss()
            }}
          />
        ))}
      </div>
    </V2Sheet>
  )
}

/**
 * A setting with a choice (§10.4): on desktop a row with the menulist trailing it (40 tall, the
 * control plus 8); on a phone a value row – label over the current value as its description –
 * that opens the picker sheet. `description` is the desktop row's explanation, which the phone
 * hands to the sheet.
 */
export function ChoiceRow<V extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled = false,
  leading,
  sheetName
}: {
  label: string
  description?: string
  value: V
  options: ReadonlyArray<MenulistOption<V>>
  onChange: (value: V) => void
  disabled?: boolean
  leading?: ReactNode
  /** Back-surface name of the phone picker. */
  sheetName: string
}): JSX.Element {
  const phone = usePhone()
  const [picking, setPicking] = useState(false)
  const current = options.find((o) => o.value === value)
  if (phone) {
    return (
      <>
        <ListRow
          label={label}
          description={current?.label ?? description}
          leading={leading}
          disabled={disabled}
          onClick={() => setPicking(true)}
          aria-label={`${label}: ${current?.label ?? ''}`}
        />
        {picking && (
          <MenulistSheet
            name={sheetName}
            title={label}
            description={description}
            value={value}
            options={options}
            onPick={onChange}
            onDismissed={() => setPicking(false)}
          />
        )}
      </>
    )
  }
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
        />
      }
    />
  )
}

/** Re-export for surfaces that only need the button next to these primitives. */
export { V2Button }
