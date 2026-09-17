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

export interface PillChipProps extends ChipButtonProps {
  /** The chip's accessible name (`aria-label`); a `title` is the desktop tooltip on top of it. */
  label: string
  /** What the chip opens: a sheet or popover (`dialog`) or a menu. Action and toggle chips omit it. */
  popup?: 'dialog' | 'menu'
  /** The popup is up right now (`aria-expanded`); only read together with `popup`. */
  expanded?: boolean
  /** A toggle chip's state (`aria-pressed`), such as Reader View. */
  pressed?: boolean
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
 * chrome's `:focus-visible` rule like the toolbar buttons around it.
 */
export function PillChip({
  label,
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
      aria-label={label}
      aria-haspopup={popup}
      aria-expanded={popup ? Boolean(expanded) : undefined}
      aria-pressed={pressed}
      className={cn(className)}
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
