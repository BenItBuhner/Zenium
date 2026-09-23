import type { ComponentPropsWithoutRef, JSX, MouseEvent } from 'react'
import { cn } from '@renderer/lib/utils'

type ChipButtonProps = Omit<
  ComponentPropsWithoutRef<'button'>,
  | 'type'
  | 'onClick'
  | 'tabIndex'
  | 'aria-label'
  | 'aria-haspopup'
  | 'aria-expanded'
  | 'aria-pressed'
>

/**
 * What a chip says about itself: it opens something, or it toggles – never both, so no chip can
 * carry `aria-haspopup` and `aria-pressed` together. Action chips (Copy URL) state neither.
 */
type ChipSemantics =
  | {
      /** What the chip opens: a sheet or popover (`dialog`) or a menu. */
      popup: 'dialog' | 'menu'
      /** The popup is up right now (`aria-expanded`). */
      expanded?: boolean
      pressed?: never
    }
  | {
      popup?: never
      expanded?: never
      /** A toggle chip's state (`aria-pressed`), such as Reader View. */
      pressed?: boolean
    }

export type PillChipProps = ChipButtonProps &
  ChipSemantics & {
    /**
     * The chip's accessible name (`aria-label`). A `title` is the chrome tooltip's text on top
     * of it (`data-tooltip`, lib/tooltip.ts – a11y-26: shown on hover and on keyboard focus,
     * never the native one), and, where it says more than the name (the site icon's "Connection
     * is secure", the star's chord), the chip's `aria-description` for a reader on any host.
     */
    label: string
    /**
     * The chip's own action, for a click as well as Enter and Space. When given, the pill does
     * not also see the click; when omitted the click bubbles to the pill, whose gesture
     * recogniser tells taps apart by target (the phone pill, see `PhoneShell`'s `onTap`).
     */
    onActivate?: (e: MouseEvent<HTMLButtonElement>) => void
    /**
     * Draw the chip without semantics or focus: a span, for the ghost pill carried across the
     * screen and the bar preview. Neither the tab order nor a screen reader reaches it.
     */
    inert?: boolean
  }

/**
 * A chip inside the URL pill (site information, the lock, Reader View, Boost, Copy URL, a count
 * that opens something). One chassis for every chip (design language v2 §9.22): a real button
 * in the tab order after the pill's field, with its own label, `aria-haspopup` and
 * `aria-expanded` when it opens a sheet or popover, `aria-pressed` when it toggles. It carries
 * no look of its own – the caller's classes draw it – and takes its focus ring from the
 * chrome's `:focus-visible` rule like the toolbar buttons around it. `data-pill-chip` marks it
 * for tests and accessibility drivers.
 */
export function PillChip({
  label,
  title,
  popup,
  expanded,
  pressed,
  onActivate,
  inert,
  className,
  children,
  ...rest
}: PillChipProps): JSX.Element {
  if (inert) {
    return (
      <span aria-hidden className={cn(className)}>
        {children}
      </span>
    )
  }
  return (
    <button
      type="button"
      tabIndex={0}
      data-pill-chip=""
      data-tooltip={title}
      aria-label={label}
      aria-description={title && title !== label ? title : undefined}
      aria-haspopup={popup}
      aria-expanded={popup ? Boolean(expanded) : undefined}
      aria-pressed={pressed}
      // The keyboard on a chip lifts it to full ink: chips rest at 70 % and a ring drawn at that
      // opacity would not read against the pill (a11y-10).
      className={cn('focus-visible:opacity-100', className)}
      onClick={
        onActivate &&
        ((e) => {
          e.stopPropagation()
          onActivate(e)
        })
      }
      {...rest}
    >
      {children}
    </button>
  )
}
