import * as React from 'react'
import { cn } from '@renderer/lib/utils'

/**
 * Controls from the design language v2 draft (§2, §5, §6): rectangular 32 px buttons and fields
 * at radius 4 (40 px and radius 6 on phones), 16 px checkboxes at radius 2 (20 px on phones),
 * weights 400 and 500 only. Sizes come from the `--v2-*` tokens, which scale per form factor;
 * the `zen-v2-` class prefix gives every control the shared focus ring. Shipped surfaces keep the
 * v1 primitives until the proof mock is approved; surfaces still in development build on these.
 *
 * One definition per control (§9.34): the button is the `.zen-v2-button` rule, and the checkbox,
 * radio, field, icon button, switch and row are main's shared `.zen-v2-checkbox`, `.zen-v2-radio`,
 * `.zen-v2-field`, `.zen-v2-icon-button`, `.zen-v2-switch` and `.zen-v2-row` rules in main.css;
 * `siteControls/primitives.tsx` wraps those with their labels and text metrics. Nothing here
 * restates a control in utilities.
 */

/**
 * A row or list glyph (§9.3): 16 px at stroke 1.5 on desktop, 20 px at 1.75 on phones, from the
 * density tokens. The stroke is set as a CSS property so it outranks Lucide's attribute.
 */
export const V2_GLYPH =
  'h-[var(--v2-icon)] w-[var(--v2-icon)] shrink-0 [stroke-width:var(--v2-icon-stroke)]'

export type V2ButtonVariant = 'primary' | 'secondary' | 'danger'

export interface V2ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: V2ButtonVariant
}

/**
 * The `.zen-v2-button` rule in main.css is the button (box, fill, ink, weight, press); it sits
 * outside the cascade layers and beats utilities, so nothing here restates it: `data-primary`
 * picks the accent fill and `data-danger` the secondary in the danger ink (§6), both the rule's.
 */
export const V2Button = React.forwardRef<HTMLButtonElement, V2ButtonProps>(function V2Button(
  { className, variant = 'secondary', type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      data-primary={variant === 'primary' ? '' : undefined}
      data-danger={variant === 'danger' ? '' : undefined}
      className={cn(
        'zen-v2-button shrink-0 gap-2 outline-none disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0',
        className
      )}
      {...props}
    />
  )
})
