import type { FormHTMLAttributes, HTMLAttributes, JSX } from 'react'
import { cn } from '@renderer/lib/utils'

type DivRow = { as?: 'div' } & HTMLAttributes<HTMLDivElement>
type FormRow = { as: 'form' } & FormHTMLAttributes<HTMLFormElement>

/**
 * A static row of a translate surface (`data-static`: the row is not a target, its control is)
 * that holds one of the shared controls – a button, an icon button, a menulist or a field. The
 * wrapper marks the row `data-control` while it holds one, so the primitive grows to the control
 * plus 8 (§9.21: 40 / 48) without the surface setting the mark by hand (§9.34). `as="form"`
 * renders the row as a form for the add rows that submit.
 */
export function ControlRow({
  as = 'div',
  control = true,
  className,
  ...props
}: (DivRow | FormRow) & {
  /** The row holds a shared control; `false` for a row that turned out to carry none. */
  control?: boolean
}): JSX.Element {
  const mark = {
    className: cn('zen-v2-row', className),
    'data-static': '',
    'data-control': control ? '' : undefined
  }
  if (as === 'form') return <form {...mark} {...(props as FormHTMLAttributes<HTMLFormElement>)} />
  return <div {...mark} {...(props as HTMLAttributes<HTMLDivElement>)} />
}
