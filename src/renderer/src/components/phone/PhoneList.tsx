import type { JSX, MouseEvent, ReactNode, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check, Search, Trash2, X } from 'lucide-react'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { swipeOutcome, swipeRestTarget, swipeReveal } from '@renderer/lib/gestures/swipeDelete'
import { cn } from '@renderer/lib/utils'
import { useRowGestures } from './useRowGestures'

/**
 * The phone panels' list vocabulary (design-language v2 draft, sections 5, 6 and 9): a 56 header
 * with a 17/600 title and 44 icon buttons, the selection header that stands in for it, the
 * search field, day and folder headings, and rows of 44 (64 with a description) that grow with
 * their content – swipeable to delete where the list allows it. Styles live under `.zen-list-*`,
 * `.zen-field` and `.zen-swipe` in `phonePanels.css`; the panels' shared behaviour (undoable
 * deletes, the in-panel back step, the header's scrolled line) is in `phonePanel.ts`.
 */

/** A 44 icon button (glyph 20, stroke 1.75; the box is sized in `phonePanels.css`). */
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
      className="zen-toolbar-button h-11 w-11 shrink-0"
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
  return (
    <header className="flex h-14 shrink-0 items-center gap-1 px-2">
      {leading}
      <h2 className={cn('zen-phone-title min-w-0 flex-1 truncate', !leading && 'px-3')}>{title}</h2>
      {actions}
      <PhoneIconButton label="Close" onClick={onClose}>
        <X className="h-5 w-5" strokeWidth={1.75} />
      </PhoneIconButton>
    </header>
  )
}

/** The header while rows are being picked: how many, a way out, and what can be done to them. */
export function PhoneSelectionHeader({
  count,
  actions,
  onExit
}: {
  count: number
  actions: ReactNode
  onExit: () => void
}): JSX.Element {
  return (
    <header className="zen-animate-fade flex h-14 shrink-0 items-center gap-1 px-2">
      <PhoneIconButton label="Stop selecting" onClick={onExit}>
        <X className="h-5 w-5" strokeWidth={1.75} />
      </PhoneIconButton>
      <h2 className="zen-phone-title min-w-0 flex-1 truncate tabular-nums" aria-live="polite">
        {count} selected
      </h2>
      {actions}
    </header>
  )
}

/**
 * The search field pinned above a list. It is the bottom of what stays put, so it carries the
 * hairline that appears once the list has scrolled under it (v2 draft 9.7).
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
    <div className="zen-phone-top shrink-0 px-4 pb-3" data-scrolled={scrolled}>
      <div className="zen-field">
        <Search className="zen-field-icon h-4 w-4" strokeWidth={1.75} aria-hidden />
        <input
          ref={ref}
          type="search"
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(e) => onChange(e.target.value)}
        />
        {value && (
          <button
            type="button"
            className="zen-field-clear zen-v2-field-clear"
            aria-label="Clear search"
            onClick={() => {
              onChange('')
              ref.current?.focus()
            }}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}

/** A group's heading (a day, a folder section): a 15/600 sub-heading, sentence case, 20 above. */
export function PhoneGroupHeading({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="zen-list-heading">{children}</h3>
}

/** What a list says when it has nothing to show: one deemphasised line, sentence case. */
export function PhoneEmptyNote({ children }: { children: ReactNode }): JSX.Element {
  return <p className="zen-phone-empty">{children}</p>
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
  /** The 20 glyph or favicon of the leading box. */
  icon: ReactNode
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
  ariaLabel?: string
}

/** One row of a phone list: 44 tall, 64 with a subtitle, growing with its content. */
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
  ariaLabel
}: PhoneListRowProps): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null)
  const underRef = useRef<HTMLDivElement>(null)
  const glyphRef = useRef<SVGSVGElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const swipe = useSwipeToDelete({ frameRef, underRef, glyphRef, contentRef }, onSwipeDelete)
  const gestures = useRowGestures({
    onTap,
    onLongPress,
    swipe: onSwipeDelete && !selecting ? swipe : null
  })
  const row = (
    <div
      role={selecting ? 'checkbox' : 'button'}
      aria-checked={selecting ? selected : undefined}
      aria-label={ariaLabel ?? title}
      tabIndex={0}
      data-selected={selected}
      data-two-line={Boolean(subtitle)}
      className="zen-list-row zen-v2-list-row select-none"
      style={{ touchAction: onSwipeDelete && !selecting ? 'pan-y' : undefined }}
      {...gestures}
    >
      <span className="zen-list-lead" aria-hidden>
        {selecting ? (
          <span
            className="zen-list-checkbox flex items-center justify-center"
            data-checked={selected}
          >
            <Check className="h-4 w-4" strokeWidth={2.5} />
          </span>
        ) : (
          icon
        )}
      </span>
      <span className="zen-list-text">
        <span className="zen-list-title truncate">{title}</span>
        {subtitle && <span className="zen-list-subtitle truncate">{subtitle}</span>}
      </span>
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
