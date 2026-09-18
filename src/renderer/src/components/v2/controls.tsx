import * as React from 'react'
import { Check } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/**
 * Controls from the design language v2 draft (§2, §5, §6): rectangular 32 px buttons and fields
 * at radius 4 (40 px and radius 6 on phones), 16 px checkboxes at radius 2 (20 px on phones),
 * weights 400 and 500 only. Sizes come from the `--v2-*` tokens, which scale per form factor;
 * the `zen-v2-` class prefix gives every control the shared focus ring. Disabled is one number
 * (§9.30): opacity .4 on the whole control – box, label and glyph together – laid out at full
 * size, with no other change. Shipped surfaces keep the v1 primitives until the proof mock is
 * approved; surfaces still in development build on these.
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
 * picks the accent fill, and the danger ink (secondary with `--v2-danger`, §6) is set inline,
 * the one place a colour still wins over that rule.
 */
export const V2Button = React.forwardRef<HTMLButtonElement, V2ButtonProps>(function V2Button(
  { className, variant = 'secondary', type = 'button', style, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      data-primary={variant === 'primary' ? '' : undefined}
      className={cn(
        'zen-v2-button shrink-0 gap-2 outline-none disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0',
        className
      )}
      style={variant === 'danger' ? { color: 'var(--v2-danger)', ...style } : style}
      {...props}
    />
  )
})

/**
 * Secret strings (passwords, keys, hashes) are set in the platform monospace, one colour, no
 * ligatures (v2 §4, Firefox's about:logins rule).
 */
const SECRET_TEXT: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  fontVariantLigatures: 'none'
}

export interface V2FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** The value is a secret (rendered in the monospace of §4). */
  secret?: boolean
}

export const V2Field = React.forwardRef<HTMLInputElement, V2FieldProps>(function V2Field(
  { className, secret = false, style, ...props },
  ref
) {
  return (
    <input
      ref={ref}
      className={cn(
        'zen-v2-field h-[var(--v2-control)] w-full min-w-0 rounded-[var(--v2-radius-control)] border border-[var(--v2-border)] bg-[var(--v2-page)] px-3 text-[15px] leading-5 text-[var(--v2-text)] outline-none placeholder:text-[var(--v2-text-deemphasized)] disabled:opacity-40',
        className
      )}
      style={secret ? { ...SECRET_TEXT, ...style } : style}
      {...props}
    />
  )
})

export interface V2CheckboxProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'className'
> {
  label: React.ReactNode
  className?: string
}

/**
 * The box of a checkbox or radio, centred on the label's first line: (line − box) / 2 down,
 * which is 2 px on desktop (16 in 20) and 0 on phones (20 in 20), §9.2 and §9.18.
 */
const V2_BOX =
  'relative mt-[calc((var(--v2-line-body)-var(--v2-checkbox))/2)] flex h-[var(--v2-checkbox)] w-[var(--v2-checkbox)] shrink-0'

/**
 * The label that carries a checkbox or radio: the whole control – box and text – dims to .4
 * together when its input is disabled (§9.30), and the pointer says so.
 */
const V2_LABEL =
  'flex min-w-0 cursor-pointer items-start gap-2.5 text-[15px] leading-5 text-[var(--v2-text)] has-[:disabled]:cursor-default has-[:disabled]:opacity-40'

/** A 16 px checkbox with its label to the right; the box aligns with the label's first line. */
export function V2Checkbox({ className, label, ...props }: V2CheckboxProps): React.JSX.Element {
  return (
    <label className={cn(V2_LABEL, className)}>
      <span className={V2_BOX}>
        <input
          type="checkbox"
          className="zen-v2-checkbox peer h-full w-full cursor-pointer appearance-none rounded-[var(--v2-radius-checkbox)] border border-[var(--v2-border)] bg-[var(--v2-page)] outline-none transition-colors duration-[120ms] checked:border-[var(--v2-accent)] checked:bg-[var(--v2-accent)]"
          {...props}
        />
        <Check
          className="pointer-events-none absolute inset-0 m-auto h-[calc(var(--v2-checkbox)*0.75)] w-[calc(var(--v2-checkbox)*0.75)] text-[var(--v2-on-accent)] opacity-0 peer-checked:opacity-100"
          strokeWidth={2.5}
          aria-hidden
        />
      </span>
      <span className="min-w-0">{label}</span>
    </label>
  )
}

export interface V2RadioProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'className'
> {
  label: React.ReactNode
  /** A second line under the label, 13 px deemphasised (the row grows to 52 / 64, §9.2). */
  description?: React.ReactNode
  className?: string
}

/**
 * A plain radio button (§9.14): a 16 px circle (20 on phones) with a hairline at text 45%,
 * `--v2-accent` filled with a 6 px page-colour dot when checked, label 15/400 to the right. The
 * circle sits centred on the label's first line (§9.2), so a two-line row keeps it at the top.
 * The row is its padding around the 20 px lines: (52 − 40) / 2 = 6 on desktop, 12 on phones.
 */
export function V2Radio({
  className,
  label,
  description,
  ...props
}: V2RadioProps): React.JSX.Element {
  return (
    <label
      className={cn(
        V2_LABEL,
        description
          ? 'py-[calc((var(--v2-row-two-line)-40px)/2)]'
          : 'py-[calc((var(--v2-row)-20px)/2)]',
        className
      )}
    >
      <span className={V2_BOX}>
        <input
          type="radio"
          className="zen-v2-radio peer h-full w-full cursor-pointer appearance-none rounded-full border border-[color-mix(in_srgb,var(--v2-text)_45%,transparent)] bg-[var(--v2-page)] outline-none transition-colors duration-[120ms] checked:border-[var(--v2-accent)] checked:bg-[var(--v2-accent)]"
          {...props}
        />
        <span
          className="pointer-events-none absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-[var(--v2-page)] opacity-0 peer-checked:opacity-100"
          aria-hidden
        />
      </span>
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
