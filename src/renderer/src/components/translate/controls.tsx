import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { LanguageOption } from '@renderer/lib/translate'
import { cn } from '@renderer/lib/utils'
import '@renderer/assets/translate.css'

/**
 * The translate surfaces' controls, on the v2 draft's Proton vocabulary (§6): rectangular
 * buttons and menulists at radius 4, 16 px checkboxes, icon buttons in the toolbar box. Sizes
 * come from the density tokens, so the same components are 32 px on the desktop and 40–44 px
 * under a finger. The secondary button is main.css's `.zen-v2-button`; the primary and danger
 * variants and the other controls are styled in `assets/translate.css`.
 */

/** A button: secondary by default (text at 10%), `primary` in the accent, `danger` in danger ink. */
export function TranslateButton({
  primary,
  danger,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean
  danger?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn('zen-v2-button zen-translate-button', className)}
      data-primary={primary || undefined}
      data-danger={danger || undefined}
      {...props}
    />
  )
}

/** A bordered menulist with a chevron, on the platform's own popup. */
export function Menulist({
  value,
  options,
  onChange,
  label,
  placeholder,
  disabled,
  className
}: {
  /** The picked value; null shows `placeholder`. */
  value: string | null
  options: LanguageOption[]
  onChange: (value: string) => void
  /** Accessible name (the visible text is the value). */
  label: string
  placeholder?: string
  disabled?: boolean
  className?: string
}): JSX.Element {
  return (
    <span className={cn('zen-translate-menulist', className)}>
      <select
        className="zen-v2-menulist"
        value={value ?? ''}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value)
        }}
      >
        {(value === null || placeholder) && (
          <option value="" disabled>
            {placeholder ?? ''}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden />
    </span>
  )
}

/** A 16 px checkbox with its label to the right; the whole label is the hit area. */
export function Checkbox({
  checked,
  onChange,
  children,
  description,
  disabled
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
  /** A second, deemphasised line under the label. */
  description?: ReactNode
  disabled?: boolean
}): JSX.Element {
  return (
    <label className="zen-translate-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="zen-translate-checkbox" aria-hidden>
        <Check />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block">{children}</span>
        {description && <span className="zen-translate-row-description">{description}</span>}
      </span>
    </label>
  )
}

/** A row action: a 28 px box (44 on phones) around a 16 (20) glyph. */
export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): JSX.Element {
  return (
    <button
      type="button"
      className={cn('zen-v2-icon-button zen-translate-icon-button', className)}
      title={label}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  )
}
