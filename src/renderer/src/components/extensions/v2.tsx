import type { ButtonHTMLAttributes, InputHTMLAttributes, JSX, ReactNode, Ref } from 'react'
import { CircleAlert, type LucideIcon } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/**
 * The extension surfaces' controls, to the design-language v2 draft (§6, §9): 32 buttons and
 * fields at radius 4, 16 checkboxes at radius 2, moz-toggle's 26×14 switch, 28/16 icon buttons,
 * bordered cards with 17/600 titles and two-line rows. Styles live in `assets/extensions.css`.
 * The shipped `ui/*` primitives stay as they are until the v2 pass restyles them.
 */

type Variant = 'primary' | 'secondary' | 'danger'

/**
 * main.css's `.zen-v2-button` (the secondary; `data-primary` for the accent fill) plus a danger
 * variant, the hover fills and icon sizing from `extensions.css`. `busy` is §9.30's working
 * state, which is not disabled: full opacity and the same width, a 16 spinner in the label's
 * place, `aria-busy`; a press while busy does nothing.
 */
export function V2Button({
  variant = 'secondary',
  busy = false,
  className,
  ref,
  type = 'button',
  onClick,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  busy?: boolean
  ref?: Ref<HTMLButtonElement>
}): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('zen-v2-button', className)}
      data-primary={variant === 'primary' || undefined}
      data-variant={variant === 'danger' ? 'danger' : undefined}
      aria-busy={busy || undefined}
      onClick={busy ? undefined : onClick}
      {...props}
    >
      {busy ? (
        <>
          {/* Still the button's name and width; only its paint goes. */}
          <span className="zen-v2-button-label">{children}</span>
          <span className="zen-v2-spinner" aria-hidden />
        </>
      ) : (
        children
      )}
    </button>
  )
}

/** A 28 icon button (44 on a phone) with a 16 (20) glyph; the label is the tooltip too. */
export function V2IconButton({
  icon: Icon,
  label,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: LucideIcon
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn('zen-v2-icon-button', className)}
      title={props.title ?? label}
      aria-label={label}
      {...props}
    >
      <Icon />
    </button>
  )
}

export function V2Field({
  lead: Lead,
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  lead?: LucideIcon
  ref?: Ref<HTMLInputElement>
}): JSX.Element {
  return (
    <span className="relative block min-w-0 flex-1">
      {Lead && <Lead className="zen-v2-field-lead" />}
      <input
        ref={ref}
        className={cn('zen-v2-field', className)}
        data-lead={Lead ? '' : undefined}
        {...props}
      />
    </span>
  )
}

/** What a `V2FormField` hands its field: the id its label points at and the message's wiring. */
export interface FieldAria {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
}

/**
 * A form field (§9.12): the label above the field at 15/400, tied to it with `<label for>` and
 * 4px away; under the field a description at 13 in the deemphasised ink, or, while the value is
 * wrong, the validation text at 13 in the danger ink behind a 16 glyph. Actions that belong to
 * the field sit after it on a desktop and as a full-width row under the message on a phone
 * (§9.11). The placeholder is the caller's example text, never the label.
 */
export function V2FormField({
  id,
  label,
  description,
  error,
  actions,
  className,
  children
}: {
  id: string
  label: string
  description?: string
  error?: string
  actions?: ReactNode
  className?: string
  children: (field: FieldAria) => ReactNode
}): JSX.Element {
  const message = error ?? description
  const messageId = message ? `${id}-message` : undefined
  return (
    <div className={cn('zen-v2-form-field', className)}>
      <label htmlFor={id} className="zen-v2-field-label">
        {label}
      </label>
      <div className="zen-v2-form-control">
        {children({ id, 'aria-describedby': messageId, 'aria-invalid': error ? true : undefined })}
      </div>
      {actions && <div className="zen-v2-form-actions">{actions}</div>}
      {message && (
        <p
          id={messageId}
          className="zen-v2-field-message"
          data-tone={error ? 'danger' : undefined}
          role={error ? 'alert' : undefined}
        >
          {error && <CircleAlert />}
          {message}
        </p>
      )}
    </div>
  )
}

/**
 * A plain radio glyph (§9.14): a 16 circle (20 on a phone) with a 1px border at text 45%; when
 * checked an accent ring around a 6 dot of the page colour. Presentational: the row that holds
 * it carries the state (`aria-selected` or `aria-checked`).
 */
export function V2Radio({
  checked,
  className
}: {
  checked: boolean
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn('zen-v2-radio', className)}
      data-checked={checked || undefined}
      aria-hidden
    />
  )
}

/** moz-toggle: the 26×14 track inside a 28 (44) hit area. */
export function V2Switch({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="zen-v2-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="zen-v2-toggle" />
    </button>
  )
}

export function V2Card({
  title,
  icon: Icon,
  children,
  className
}: {
  title?: string
  icon?: LucideIcon
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <section className={cn('zen-v2-card', className)}>
      {title && (
        <h3 className="zen-v2-card-title">
          {Icon && <Icon />}
          {title}
        </h3>
      )}
      {children}
    </section>
  )
}

/**
 * A title block (§9.23): the first content of a popover, dialog or sheet, with no bar and no
 * control – padding 16, an optional 16 glyph at the title's start with an 8 gap, the title
 * 17/600 at line-height 22, an optional description 15 at 69% 4 under it, then 16 to the body.
 * In a scrolling popover or dialog it stays put and takes §9.7's hairline once the body has
 * scrolled under it (`scrolled`).
 */
export function V2TitleBlock({
  id,
  title,
  description,
  glyph,
  scrolled,
  surface,
  className
}: {
  id?: string
  title: ReactNode
  description?: ReactNode
  /** A 16 glyph (an icon, an extension's own) at the title's start. */
  glyph?: ReactNode
  scrolled?: boolean
  /** Set when the block is itself the surface root (a sheet's header), §9.29. */
  surface?: 'page'
  className?: string
}): JSX.Element {
  return (
    <div
      className={cn('zen-v2-title-block', className)}
      data-surface={surface}
      data-scrolled={scrolled || undefined}
    >
      <h2 id={id} className="zen-v2-title-block-title">
        {glyph}
        <span className="min-w-0 flex-1">{title}</span>
      </h2>
      {description && <p className="zen-v2-title-block-description">{description}</p>}
    </div>
  )
}

/**
 * A two-line row (§9.2, §9.18): the leading glyph and the text travel together and sit on the
 * first text line – the glyph (line − glyph) / 2 below the line's top – while whatever trails
 * the text centres on the row's height.
 */
export function V2Row({
  label,
  description,
  lead: Lead,
  children,
  className,
  tone
}: {
  label: ReactNode
  description?: ReactNode
  lead?: LucideIcon
  children?: ReactNode
  className?: string
  tone?: 'warn' | 'danger'
}): JSX.Element {
  return (
    <div className={cn('zen-v2-row', className)} data-lines={description ? '2' : undefined}>
      <span className="zen-v2-row-body">
        {Lead && <Lead className="zen-v2-row-lead" />}
        <span className="zen-v2-row-text">
          <span className="zen-v2-label">{label}</span>
          {description && (
            <span className="zen-v2-description" data-tone={tone}>
              {description}
            </span>
          )}
        </span>
      </span>
      {children}
    </div>
  )
}

/** A checkbox row: 16 box at radius 2 (20 on a phone), label to its right, a description under. */
export function V2CheckRow({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <label className="zen-v2-row zen-v2-check-row" data-lines={description ? '2' : undefined}>
      <span className="zen-v2-row-body">
        <input
          type="checkbox"
          className="zen-v2-checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="zen-v2-row-text">
          <span className="zen-v2-label">{label}</span>
          {description && <span className="zen-v2-description">{description}</span>}
        </span>
      </span>
    </label>
  )
}
