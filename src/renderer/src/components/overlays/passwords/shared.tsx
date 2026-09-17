import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  JSX,
  ReactNode,
  Ref,
  TextareaHTMLAttributes
} from 'react'
import { useId, useRef, useState } from 'react'
import { Check, ChevronDown, CircleAlert, Search } from 'lucide-react'
import { Select as SelectPrimitive } from 'radix-ui'
import { useBackSurface } from '@renderer/lib/back'
import { cn } from '@renderer/lib/utils'
import { useEscape } from './lib'

/**
 * The password manager's controls in the v2 vocabulary (`.zen-v2-pw-*` in passwords.css): Firefox
 * Proton buttons, fields, menulists, checkboxes and radios on the neutral page surface, rows that
 * grow with their text, status as ink. Sizes come from the `--v2-*` density tokens, which the
 * root sets per form factor, so no component here asks what it is running on.
 */

type Variant = 'primary' | 'secondary' | 'danger'

/** 32 × radius 4 at 15/500. Primary = accent fill (one per view); secondary = text at 10 %; danger = the danger ink. */
export function Btn({
  variant = 'secondary',
  className,
  type = 'button',
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  ref?: Ref<HTMLButtonElement>
}): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      className={cn('zen-v2-pw-btn', className)}
      {...rest}
    />
  )
}

/** Icon-only button: a 28 box with a 16 glyph on the desktop, 44 with 20 on a phone. */
export function IconBtn({
  label,
  active = false,
  className,
  type = 'button',
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  active?: boolean
  ref?: Ref<HTMLButtonElement>
}): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      data-active={active || undefined}
      className={cn('zen-v2-pw-icon-btn', className)}
      {...rest}
    />
  )
}

export function TextField({
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }): JSX.Element {
  return <input ref={ref} className={cn('zen-v2-pw-field', className)} {...rest} />
}

/** A search field: the glyph inside the field's leading padding, in the deemphasised ink. */
export function SearchField({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <div className={cn('relative', className)}>
      <Search
        aria-hidden
        className="zen-v2-pw-deemphasized pointer-events-none absolute left-3 top-1/2 size-[var(--v2-icon)] -translate-y-1/2"
      />
      <input type="search" data-leading="true" className="zen-v2-pw-field" {...rest} />
    </div>
  )
}

export function TextArea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea className={cn('zen-v2-pw-field', className)} {...rest} />
}

/**
 * A rectangular menulist: the trigger is a field with a chevron, the menu a bordered panel
 * anchored under it (§9.20): gap 0, its start edge on the trigger's – or its end edge, when the
 * trigger sits in the trailing half of its row – kept 8 px inside the window. While it is open it
 * is the topmost surface: Escape and the system back close the menu and return focus to the
 * trigger, and nothing under it (a pane, the overlay) hears the key; opening another closes it.
 */
export function Menulist<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  fill,
  title,
  className
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  /** Name for assistive tech (a row label is not associated with the control). */
  label: string
  disabled?: boolean
  /** Take the row's whole width (a stacked phone row). */
  fill?: boolean
  /** The phone header's category picker: the title itself is the menulist (§6). */
  title?: boolean
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [align, setAlign] = useState<'start' | 'end'>('start')
  const trigger = useRef<HTMLButtonElement>(null)
  // One surface name per instance: with a shared name, the first menulist on the view would
  // claim Escape for a menu that is not its own and the open one would stay open.
  const surface = `passwords-menu-${useId()}`
  useBackSurface(open ? { name: surface, onCommit: () => setOpen(false) } : null)
  useEscape(surface, () => setOpen(false))
  return (
    <SelectPrimitive.Root
      value={value}
      open={open}
      onOpenChange={(next) => {
        if (next) setAlign(inTrailingHalf(trigger.current) ? 'end' : 'start')
        setOpen(next)
      }}
      onValueChange={(v) => onChange(v as T)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        ref={trigger}
        aria-label={label}
        data-fill={fill || undefined}
        data-title={title || undefined}
        className={cn('zen-v2-pw-menulist', className)}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon asChild>
          <ChevronDown />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          side="bottom"
          align={align}
          sideOffset={0}
          collisionPadding={8}
          className="zen-v2-pw-menu zen-animate-pop"
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={o.value} className="zen-v2-pw-menu-item">
                <span>
                  <SelectPrimitive.ItemIndicator>
                    <Check className="size-4" strokeWidth={2} />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/** Whether a menulist's centre lies in the trailing half of the row or header it sits in (§9.20). */
function inTrailingHalf(trigger: HTMLElement | null): boolean {
  if (!trigger) return false
  const bar = trigger.closest('.zen-v2-pw-row, .zen-v2-pw-header-row') ?? trigger.parentElement
  if (!bar) return false
  const t = trigger.getBoundingClientRect()
  const b = bar.getBoundingClientRect()
  return t.left + t.width / 2 > b.left + b.width / 2
}

/** The Proton checkbox glyph: a 16 square (20 on a phone) at radius 2, accent when checked. */
function CheckBox({ checked }: { checked: boolean }): JSX.Element {
  return (
    <span className="zen-v2-pw-check" data-checked={checked} aria-hidden>
      <Check />
    </span>
  )
}

/**
 * A checkbox row: the whole row is the control; the box sits on the first text line with the
 * label to its right and the description under the label, as Firefox lays out its checkboxes.
 */
export function CheckRow({
  checked,
  onChange,
  label,
  description,
  disabled,
  className
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  className?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      className={cn('zen-v2-pw-row w-full text-left', className)}
      data-lead="true"
      onClick={() => onChange(!checked)}
    >
      <CheckBox checked={checked} />
      <span className="zen-v2-pw-row-text">
        <span className="zen-v2-pw-row-label block">{label}</span>
        {description && (
          <span className="zen-v2-pw-row-description" data-clamp="false">
            {description}
          </span>
        )}
      </span>
    </button>
  )
}

/** A radio row inside a `role="radiogroup"`: the ring on the first line, the label beside it. */
export function RadioRow({
  checked,
  onSelect,
  label,
  description,
  className
}: {
  checked: boolean
  onSelect: () => void
  label: ReactNode
  description?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={cn('zen-v2-pw-row w-full text-left', className)}
      data-lead="true"
      onClick={onSelect}
    >
      <span className="zen-v2-pw-radio" data-checked={checked} aria-hidden />
      <span className="zen-v2-pw-row-text">
        <span className="zen-v2-pw-row-label block">{label}</span>
        {description && (
          <span className="zen-v2-pw-row-description" data-clamp="false">
            {description}
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * A settings row: label and description to the left, the control to the right. `stack` drops the
 * control under the text (a phone with a wide menulist or a pair of buttons).
 */
export function SettingRow({
  label,
  description,
  stack = false,
  clamp = true,
  children,
  className
}: {
  label: ReactNode
  description?: ReactNode
  stack?: boolean
  /** Descriptions clamp at two lines unless the row is the explanation itself. */
  clamp?: boolean
  children?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('zen-v2-pw-row', className)} data-stack={stack || undefined}>
      <div className="zen-v2-pw-row-text">
        <div className="zen-v2-pw-row-label">{label}</div>
        {description && (
          <div className="zen-v2-pw-row-description" data-clamp={clamp ? undefined : 'false'}>
            {description}
          </div>
        )}
      </div>
      {children && <div className="zen-v2-pw-row-control">{children}</div>}
    </div>
  )
}

/** A list row on the surface: a fill on hover or press, the accent bar when it is the open one. */
export function ListRow({
  selected = false,
  className,
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }): JSX.Element {
  if (!onClick) {
    return (
      <div className={cn('zen-v2-pw-list-row', className)} aria-current={selected || undefined}>
        {children}
      </div>
    )
  }
  return (
    <button
      type="button"
      className={cn('zen-v2-pw-list-row', className)}
      aria-current={selected || undefined}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  )
}

/** A page or pane title: 22/600. */
export function Title({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return <h2 className={cn('zen-v2-pw-title min-w-0 truncate', className)}>{children}</h2>
}

/**
 * A title block (§9.23): what heads a desktop dialog or popover instead of a bar – no control and
 * no X, since Escape, a click outside and the footer close it. Padding 16, an optional 16 px
 * glyph 8 px before the 17/600 title, an optional description 4 px under it, 16 px to the body;
 * 54 tall on its own, 78 with a one-line description. `id` and `descriptionId` are for the
 * dialog's `aria-labelledby` and `aria-describedby`.
 */
export function TitleBlock({
  id,
  glyph,
  description,
  descriptionId,
  children,
  className
}: {
  id: string
  glyph?: ReactNode
  description?: ReactNode
  descriptionId?: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('zen-v2-pw-title-block shrink-0', className)}>
      <div className="flex items-center gap-2">
        {glyph}
        <h3 id={id} className="zen-v2-pw-block-title min-w-0 flex-1">
          {children}
        </h3>
      </div>
      {description && (
        <p id={descriptionId} className="zen-v2-pw-description">
          {description}
        </p>
      )}
    </div>
  )
}

/** A sub-heading over a group of rows: 15/600, sentence case, an optional count trailing. */
export function Heading({
  children,
  trailing,
  className
}: {
  children: ReactNode
  trailing?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <h3 className={cn('zen-v2-pw-heading flex min-h-8 items-center gap-2', className)}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </h3>
  )
}

/** Deemphasised copy: the body size on its own, 13/18 inside a row, a meta block or a field label. */
export function Description({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return <p className={cn('zen-v2-pw-description', className)}>{children}</p>
}

/** A secret string: the platform monospace at the row-value size, no ligatures, one colour. */
export function Secret({ value, className }: { value: string; className?: string }): JSX.Element {
  return <span className={cn('zen-v2-pw-secret', className)}>{value}</span>
}

/** The site's favicon when history knows one, otherwise its initial on a text-alpha tile. */
export function SiteIcon({
  domain,
  favicon,
  size,
  className
}: {
  domain: string
  favicon: string | null
  size?: 'hero'
  className?: string
}): JSX.Element {
  const letter = (domain.replace(/^www\./, '')[0] ?? '?').toUpperCase()
  return (
    <span className={cn('zen-v2-pw-site', className)} data-size={size} aria-hidden>
      {favicon ? <img src={favicon} alt="" referrerPolicy="no-referrer" /> : letter}
    </span>
  )
}

export type Tone = 'accent' | 'ok' | 'warn' | 'danger' | 'muted'

/** A status glyph in its ink – never on a filled surface. `hero` is the 40 px empty-state glyph. */
export function StatusGlyph({
  tone,
  hero = false,
  children,
  className
}: {
  tone: Tone
  hero?: boolean
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn('zen-v2-pw-status', className)}
      data-tone={tone}
      data-size={hero ? 'hero' : undefined}
      aria-hidden
    >
      {children}
    </span>
  )
}

/** An error under a control: glyph plus text in the danger ink, never bare red text. */
export function ErrorNote({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <p role="alert" className={cn('zen-v2-pw-error', className)}>
      <CircleAlert />
      <span>{children}</span>
    </p>
  )
}

/** A count in a pill – the pill's one use. */
export function Badge({
  children,
  tone,
  className
}: {
  children: ReactNode
  tone?: 'danger'
  className?: string
}): JSX.Element {
  return (
    <span className={cn('zen-v2-pw-badge', className)} data-tone={tone}>
      {children}
    </span>
  )
}

/** A form field: a sentence-case caption over the control. */
export function Field({
  label,
  htmlFor,
  children,
  className
}: {
  label: string
  htmlFor: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="zen-v2-pw-description">
        {label}
      </label>
      {children}
    </div>
  )
}

/** A determinate progress bar; the bar moves on `transform`, never `width`. */
export function Progress({
  value,
  max,
  className
}: {
  value: number
  max: number
  className?: string
}): JSX.Element {
  const share = max > 0 ? value / max : 0
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn('zen-v2-pw-progress', className)}
    >
      <div style={{ transform: `scaleX(${Math.max(0.03, Math.min(1, share))})` }} />
    </div>
  )
}
