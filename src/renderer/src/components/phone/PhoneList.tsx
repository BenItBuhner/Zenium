import type { JSX, MouseEvent, ReactNode, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Search, Trash2, X } from 'lucide-react'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { swipeOutcome, swipeRestTarget, swipeReveal } from '@renderer/lib/gestures/swipeDelete'
import { cn } from '@renderer/lib/utils'
import { useRowGestures } from './useRowGestures'

/**
 * The phone panels' list vocabulary (design-language v2 draft, sections 5, 6 and 9): a 56 header
 * with a 17/600 title and 44 icon buttons at 6 px margins, the selection header that stands in
 * for it, the search field, day and folder headings, and rows of 44 (64 with a description)
 * that grow with their content, running edge to edge with their text at the 16 gutter –
 * swipeable to delete where the list allows it. The row is the shared `.zen-v2-row` and the icon
 * button the shared `.zen-v2-icon-button` (main.css, v2 draft 9.34); what the rows hold lives
 * under `.zen-list-*`, with `.zen-phone-field` and `.zen-swipe`, in `phonePanels.css`, and the
 * `.zen-phone-row` modifier there adds what these rows need beyond the primitive. The panels'
 * shared behaviour (undoable deletes, the in-panel back step, the header's scrolled line) is in
 * `phonePanel.ts`.
 */

/** A 44 icon button with a 20 glyph at stroke 1.75: the shared `.zen-v2-icon-button` (9.3, 9.34). */
export function PhoneIconButton({
  label,
  onClick,
  disabled,
  children
}: {
  label: string
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-v2-icon-button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function PhoneHeader({
  title,
  leading,
  actions,
  onClose
}: {
  title: string
  /** A back button when the surface was pushed (a folder inside the bookmarks). */
  leading?: ReactNode
  /** At most two. */
  actions?: ReactNode
  onClose: () => void
}): JSX.Element {
  // 56 tall (9.16): 44 controls at 6 px margins; the title 8 after a leading control, else at
  // the 16 gutter.
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 px-1.5">
      {leading}
      <h2 className={cn('zen-phone-title min-w-0 flex-1 truncate', leading ? 'pl-1' : 'pl-2.5')}>
        {title}
      </h2>
      {actions}
      <PhoneIconButton label="Close" onClick={onClose}>
        <X className="h-5 w-5" strokeWidth={1.75} />
      </PhoneIconButton>
    </header>
  )
}

/**
 * The header while rows are being picked: how many, a way out, and what can be done to them.
 * With `total` (how many rows the list shows) the header also picks or unpicks them all: the
 * mode's one bulk action, a trailing §9.18 secondary `zen-v2-button` after the list's own
 * actions (§9.6's contextual bar, the overview's select-tabs header the same), reading "Select
 * all" until every shown row is picked and "Deselect all" then. The list decides what each
 * means for it (`multiSelect.selectAll` / `deselectAll`).
 */
export function PhoneSelectionHeader({
  count,
  total,
  onSelectAll,
  actions,
  onExit
}: {
  count: number
  /** The rows the list shows; with it the header offers Select all / Deselect all. */
  total?: number
  /** Select all (`true`) or deselect all (`false`) of the shown rows. */
  onSelectAll?: (all: boolean) => void
  actions: ReactNode
  onExit: () => void
}): JSX.Element {
  const all = total !== undefined && total > 0 && count >= total
  return (
    <header className="zen-animate-fade flex h-14 shrink-0 items-center gap-1 px-1.5">
      <PhoneIconButton label="Stop selecting" onClick={onExit}>
        <X className="h-5 w-5" strokeWidth={1.75} />
      </PhoneIconButton>
      <h2 className="zen-phone-title min-w-0 flex-1 truncate pl-1 tabular-nums" aria-live="polite">
        {count} selected
      </h2>
      {actions}
      {total !== undefined && onSelectAll && (
        <button
          type="button"
          className="zen-v2-button ml-1 mr-0.5"
          disabled={total === 0}
          onClick={() => onSelectAll(!all)}
        >
          {all ? 'Deselect all' : 'Select all'}
        </button>
      )}
    </header>
  )
}

/**
 * The search field pinned above a list, in the 16 gutter with 8 to the list below (the first
 * heading or row sits 8 under it, 10.2). It is the bottom of what stays put, so it carries the
 * hairline that appears once the list has scrolled under it (v2 draft 9.7). It never takes the
 * focus on its own: the keyboard would come up with the panel.
 */
export function PhoneSearchField({
  value,
  onChange,
  placeholder,
  autoFocus,
  scrolled = false
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  autoFocus?: boolean
  /** The list below has moved off its top. */
  scrolled?: boolean
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div className="zen-phone-top shrink-0 px-4 pb-2" data-scrolled={scrolled}>
      <div className="zen-phone-field">
        <Search className="zen-phone-field-icon h-5 w-5" strokeWidth={1.75} aria-hidden />
        <input
          ref={ref}
          type="search"
          value={value}
          // The placeholder names the field (A11Y-01): the WebView reads a text field's label
          // and its placeholder both, so a label with the same words was heard twice.
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(e) => onChange(e.target.value)}
        />
        {value && (
          <button
            type="button"
            className="zen-phone-field-clear zen-v2-field-clear"
            aria-label="Clear search"
            onClick={() => {
              onChange('')
              ref.current?.focus()
            }}
          >
            <X className="h-5 w-5" strokeWidth={1.75} />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * A group's heading (a day, a folder section): the shared `.zen-v2-heading` (15/600, 9.26, 9.34),
 * sentence case, with this list's beat – 20 above and 8 to its first row (9.27). A heading, not
 * a row: it is not a target and has none of a row's layout, so it is not a `data-static` row.
 */
export function PhoneGroupHeading({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="zen-v2-heading zen-list-heading">{children}</h3>
}

/**
 * What a list says when it has nothing to show (9.17): one sentence, sentence case, no full
 * stop, anchored 48 below what stays put above the list; and, only where there is one obvious
 * next step, a secondary button 16 beneath it.
 */
export function PhoneEmptyNote({
  children,
  action
}: {
  children: ReactNode
  action?: { label: string; onSelect: () => void }
}): JSX.Element {
  return (
    <div className="zen-phone-empty">
      <p>{children}</p>
      {action && (
        <button
          type="button"
          className="zen-v2-button zen-phone-empty-action"
          onClick={action.onSelect}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

/** A favicon in the row's leading box, or the fallback glyph. */
export function RowFavicon({
  src,
  fallback
}: {
  src: string | null | undefined
  fallback: ReactNode
}): JSX.Element {
  // Remembering *which* address failed makes a new one try again without an effect.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  if (!src || brokenSrc === src) return <>{fallback}</>
  return (
    <img
      src={src}
      alt=""
      className="zen-list-favicon"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setBrokenSrc(src)}
    />
  )
}

export interface PhoneListRowProps {
  /**
   * The 20 glyph or favicon of the leading box. A list whose rows have none (the Send to your
   * devices picker: a device's kind is not known) draws no box at all – the text from the
   * gutter – rather than an empty column (§10.4: a list in which only some rows would have a
   * leading element has none).
   */
  icon?: ReactNode
  title: string
  subtitle?: ReactNode
  /** A 44 control, or a 13 deemphasised value; hidden while selecting. */
  trailing?: ReactNode
  /** Selection mode is on for the list. */
  selecting?: boolean
  selected?: boolean
  onTap: () => void
  onLongPress?: () => void
  /** Sideways swipes delete the row (the callback runs once it has left the screen). */
  onSwipeDelete?: () => void
  /** A destructive action row (v2 draft §10.4): label and glyph in the danger ink. */
  danger?: boolean
  /**
   * The row stays, laid out at full size, at the one disabled number (§9.30) and takes no tap;
   * a hold still opens its menu (an extension's action turned off for this tab keeps its
   * context menu, as the desktop button does). `aria-disabled`, so it stays reachable.
   */
  disabled?: boolean
  ariaLabel?: string
}

/**
 * One row of a phone list: 44 tall, 64 with a subtitle, growing with its content.
 *
 * The row is the shared `.zen-v2-row` (9.34) with the `.zen-phone-row` modifier: a plain box
 * that takes the touches (tap, hold, swipe) and draws the press (the primitive's fill) and the
 * selection (`--v2-selected`, 9.6). Every row here is a target, so none is `data-static`. The
 * accessible row is its first child, a button (a checkbox while selecting) named
 * by the label and holding the leading box and the text, and the trailing control is that
 * button's sibling. A control inside a button is not valid ARIA, and Android's accessibility
 * tree makes every button a leaf – TalkBack would never reach a row's Remove or 3-dot button
 * nested in it. Focus lands on the accessible row; the ring is drawn around the whole box.
 * While rows are being picked, the leading box is the shared `.zen-v2-checkbox` in its span
 * form (9.34): a presentational span, drawn checked by the `aria-checked` on the accessible row
 * that is the checkbox (`[aria-checked='true'] > .zen-v2-checkbox`, main.css) – no input, no
 * copy of the box.
 */
export function PhoneListRow({
  icon,
  title,
  subtitle,
  trailing,
  selecting = false,
  selected = false,
  onTap,
  onLongPress,
  onSwipeDelete,
  danger = false,
  disabled = false,
  ariaLabel
}: PhoneListRowProps): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null)
  const underRef = useRef<HTMLDivElement>(null)
  const glyphRef = useRef<SVGSVGElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const swipe = useSwipeToDelete({ frameRef, underRef, glyphRef, contentRef }, onSwipeDelete)
  const { onKeyDown, ...pointer } = useRowGestures({
    onTap: () => {
      if (!disabled) onTap()
    },
    onLongPress,
    swipe: onSwipeDelete && !selecting ? swipe : null
  })
  const row = (
    <div
      data-selected={selected}
      data-two-line={Boolean(subtitle)}
      data-danger={danger || undefined}
      data-disabled={disabled || undefined}
      className="zen-v2-row zen-phone-row select-none"
      style={{ touchAction: onSwipeDelete && !selecting ? 'pan-y' : undefined }}
      {...pointer}
    >
      <div
        role={selecting ? 'checkbox' : 'button'}
        aria-checked={selecting ? selected : undefined}
        aria-disabled={disabled || undefined}
        aria-label={ariaLabel ?? title}
        tabIndex={0}
        className="zen-list-main"
        onKeyDown={onKeyDown}
      >
        {selecting ? (
          <span className="zen-v2-checkbox" aria-hidden />
        ) : (
          icon != null && (
            <span className="zen-list-lead" aria-hidden>
              {icon}
            </span>
          )
        )}
        <span className="zen-list-text">
          <span className="zen-list-title truncate">{title}</span>
          {subtitle && <span className="zen-list-subtitle truncate">{subtitle}</span>}
        </span>
      </div>
      {!selecting && trailing && <span className="zen-list-trailing">{trailing}</span>}
    </div>
  )
  if (!onSwipeDelete) return row
  return (
    <div ref={frameRef} className="zen-swipe">
      <div ref={underRef} className="zen-swipe-under" data-side="right" aria-hidden>
        <Trash2 ref={glyphRef} className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <div ref={contentRef} className="zen-swipe-content">
        {row}
      </div>
    </div>
  )
}

interface SwipeParts {
  frameRef: RefObject<HTMLDivElement | null>
  underRef: RefObject<HTMLDivElement | null>
  glyphRef: RefObject<SVGSVGElement | null>
  contentRef: RefObject<HTMLDivElement | null>
}

/**
 * The swipe's motion: the row content follows the finger (transform only), the trash glyph
 * behind it fades and grows towards the commit point, and a release springs the row home or
 * off the edge it was heading for – then the delete runs. A finger landing mid-spring catches it.
 */
function useSwipeToDelete(
  { frameRef, underRef, glyphRef, contentRef }: SwipeParts,
  onDelete: (() => void) | undefined
): { onMove(dx: number): void; onEnd(dx: number, velocity: number): void } {
  const latest = useRef(onDelete)
  useEffect(() => {
    latest.current = onDelete
  })
  const spring = useRef<SpringAnimation | null>(null)
  const width = (): number => frameRef.current?.clientWidth ?? 0

  const paint = (x: number): void => {
    const content = contentRef.current
    const under = underRef.current
    const glyph = glyphRef.current
    if (!content || !under || !glyph) return
    content.style.transform = `translate3d(${x}px, 0, 0)`
    under.dataset.side = x < 0 ? 'right' : 'left'
    under.style.opacity = Math.min(1, Math.abs(x) / 24).toFixed(3)
    const reveal = swipeReveal(x, width())
    glyph.style.opacity = (0.4 + 0.6 * reveal).toFixed(3)
    glyph.style.transform = `scale(${(0.8 + 0.3 * reveal).toFixed(3)})`
  }
  const motion = (): SpringAnimation =>
    (spring.current ??= new SpringAnimation(
      SPRING_SNAPPY,
      (x) => paint(x),
      (x) => {
        frameRef.current?.removeAttribute('data-moving')
        if (x !== 0) latest.current?.()
      }
    ))
  useEffect(
    () => () => {
      spring.current?.stop()
    },
    []
  )

  return {
    onMove: (dx) => {
      motion().stop()
      frameRef.current?.setAttribute('data-moving', 'true')
      paint(dx)
    },
    onEnd: (dx, velocity) => {
      const w = width()
      const outcome = swipeOutcome(dx, velocity, w)
      motion().start(dx, velocity, swipeRestTarget(outcome, dx, velocity, w))
    }
  }
}
