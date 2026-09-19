import type { ButtonHTMLAttributes, InputHTMLAttributes, JSX, ReactNode, Ref } from 'react'
import { CircleAlert, type LucideIcon } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/**
 * The extension surfaces' controls, to the design-language v2 draft (§6, §9). The classes are
 * the shared `zen-v2-*` primitives of main.css (§9.34: the row, the field, the icon button,
 * the switch, the radio, the button – one unlayered rule each, tokens only); these wrappers
 * add behaviour – roles, `aria-*`, the busy state – and the extension surfaces' own anatomy
 * (a row's body and text, a card, a title block), styled in `assets/extensions.css`. The
 * shipped `ui/*` primitives stay as they are until the v2 pass restyles them.
 */

type Variant = 'primary' | 'secondary' | 'danger'

/**
 * main.css's `.zen-v2-button` (the secondary; `data-primary` for the accent fill, `data-danger`
 * for the danger ink), with the hover fills and icon sizing from `extensions.css`. `busy` is
 * §9.30's working state, which is not disabled: full opacity and the same width, a 16 spinner
 * in the label's place, `aria-busy`; a press while busy does nothing.
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
      data-danger={variant === 'danger' || undefined}
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

/** main.css's `.zen-v2-icon-button` (§9.3): 28 with a 16 glyph, 44 / 20 on a phone; the label is the tooltip too. */
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
 * main.css's `.zen-v2-radio` (§9.14): a 16 circle (20 on a phone) with a hairline at text 45%;
 * checked, an accent ring around a 6 dot of the page colour. Presentational: its direct parent
 * is the row that is the radio and carries `aria-checked`.
 */
export function V2Radio({ className }: { className?: string }): JSX.Element {
  return <span className={cn('zen-v2-radio', className)} aria-hidden />
}

/**
 * main.css's `.zen-v2-switch` (§10.4): the 36 × 20 track, drawn on from the `aria-checked` of
 * the button around it. That button is the hit area where the switch stands alone – a card's
 * controls, the details header – 28 tall on a desktop and 44 on a phone (`.zen-ext-switch`).
 */
export function V2Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="zen-ext-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="zen-v2-switch" aria-hidden />
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
  className
}: {
  id?: string
  title: ReactNode
  description?: ReactNode
  /** A 16 glyph (an icon, an extension's own) at the title's start. */
  glyph?: ReactNode
  scrolled?: boolean
  className?: string
}): JSX.Element {
  return (
    <div className={cn('zen-v2-title-block', className)} data-scrolled={scrolled || undefined}>
      <h2 id={id} className="zen-v2-title-block-title">
        {glyph}
        <span className="min-w-0 flex-1">{title}</span>
      </h2>
      {description && <p className="zen-v2-title-block-description">{description}</p>}
    </div>
  )
}

/**
 * The static form of main.css's `.zen-v2-row` (§9.34): a row that is not a target – a permission
 * warning, a Source value, an "It can:" line – keeps the primitive for its geometry and carries
 * `data-static`, which turns off the hover fill, the press fill and the pointer cursor; it is a
 * `div` with no role and nothing focusable of its own (a link in a value is the target, not the
 * row). A row that navigates, toggles or opens a menu is a `button.zen-v2-row` instead – see
 * `V2CheckRow` and the menulist's sheet – never this with its fill hidden. Inside, the extension
 * surfaces' anatomy (§9.2, §9.18): the leading glyph and the text travel together and sit on the
 * first text line – the glyph (line − glyph) / 2 below the line's top – while whatever trails the
 * text centres on the row's height.
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
    <div
      className={cn('zen-v2-row', className)}
      data-static=""
      data-lines={description ? '2' : undefined}
    >
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

/**
 * A checkbox row: 16 box at radius 2 (20 on a phone), label to its right, a description under.
 * Disabled, the row says so (`aria-disabled`) as the shared row's fill gate expects (§9.30).
 */
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
    <label
      className="zen-v2-row zen-v2-check-row"
      data-lines={description ? '2' : undefined}
      aria-disabled={disabled || undefined}
    >
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
