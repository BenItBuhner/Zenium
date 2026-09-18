import type { JSX, ReactNode } from 'react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { CircleAlert, ExternalLink, LoaderCircle } from 'lucide-react'
import { useViewport } from '@renderer/lib/formFactor'
import { cn } from '@renderer/lib/utils'
import { PickerSheet } from './PickerSheet'

/*
 * Building blocks of the protection groups in Settings > Privacy and Security (design-language-
 * v2-draft §4, §6, §9.2, §9.12–9.14, §9.17–9.18, §9.21, §9.23, §9.26–9.27, §9.30, §10.3–10.4).
 * They draw with the classes the pane already has – `.zen-privacy-*` for the section, headings,
 * rows, cards, fields and validation, `.zen-v2-check` / `.zen-v2-radio` / `.zen-v2-field` /
 * `.zen-v2-icon-button` for the controls – so the blocking groups (#115) and these read as one
 * pane; `.zen-protection-*` adds only what those lack: the 22 section's title block, a
 * sub-heading's description, a card's title block, the phone's switch, value and action rows,
 * the picker sheet, the busy button and the menulist.
 *
 * Two layouts from one tree. On a desktop a group is Zen's: checkboxes to the left of their
 * labels, plain radios with their descriptions, cards where a group has its own actions
 * (§10.5). On a phone a group is rows under its 15/600 heading and nothing else (§9.17, §10.3):
 * booleans are switch rows, a choice is a value row that opens a picker sheet, an action is a
 * row, and no card is drawn (§10.4).
 */

/** The pane is on a phone: the §10 rows rather than Zen's desktop controls. */
export function usePhone(): boolean {
  return useViewport().formFactor === 'phone'
}

/**
 * A 22/600 section of the pane (§9.26): its title on the 28 px line, an optional description 15
 * at 69% 4 px under it, 16 px to the first group, groups 32 apart (24 on phones). On a phone the
 * title block is not drawn: groups stand under their own 15/600 headings alone (§10.3).
 */
export function Part({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="zen-protection-part">
      <div className="zen-protection-part-title">
        <h2 className="zen-privacy-title">{title}</h2>
        {description && <p className="zen-privacy-muted">{description}</p>}
      </div>
      <div className="zen-protection-groups">{children}</div>
    </section>
  )
}

/**
 * A group under a 15/600 sub-heading (§9.27): the heading, its description 4 px under it, then
 * the first row's box 8 px below the block (8 from the heading itself without a description).
 */
export function Group({
  heading,
  description,
  children
}: {
  heading: string
  description?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="zen-privacy-section">
      <div className="zen-protection-heading">
        <h3 className="zen-privacy-heading">{heading}</h3>
        {description && <p className="zen-privacy-muted">{description}</p>}
      </div>
      {children}
    </section>
  )
}

/**
 * Rows that carry their own actions: a flat card on a desktop (§6, §10.5), the rows themselves
 * on a phone, where a new group draws no card (§9.17, §10.3).
 */
export function List({ children, label }: { children: ReactNode; label?: string }): JSX.Element {
  const phone = usePhone()
  return (
    <div
      className={phone ? 'zen-privacy-rows' : 'zen-privacy-card'}
      role={label ? 'group' : undefined}
      aria-label={label}
    >
      {children}
    </div>
  )
}

/**
 * A card's title block (§9.23, §9.27): a 16 px glyph 8 px before a 17/600 title on the 22 px
 * line, the description 15 at 69% under it, an action trailing and centred on the block
 * (§9.18), 16 px to the first row. Desktop only: `List` is rows on a phone.
 */
export function CardTitle({
  icon,
  title,
  description,
  action
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="zen-protection-card-title" aria-live="polite">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="zen-privacy-card-title">{title}</div>
        <div className="zen-privacy-muted">{description}</div>
      </div>
      {action}
    </div>
  )
}

/**
 * A boolean row: on a desktop Zen's leading 16 px checkbox on the first text line (§6, §9.2), on
 * a phone the trailing 36 × 20 switch centred on the row with the whole row as its target
 * (§10.4, `role="switch"`). Disabled dims the row's text with the control (§9.30).
 */
export function BoolRow({
  label,
  description,
  checked,
  disabled = false,
  onChange
}: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  if (usePhone()) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className="zen-privacy-row zen-protection-switch-row"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="zen-privacy-row-text">
          <span className="zen-privacy-row-label block">{label}</span>
          {description && <span className="zen-privacy-row-desc">{description}</span>}
        </span>
        <span className="zen-v2-switch" aria-hidden />
      </button>
    )
  }
  return (
    <label className="zen-privacy-row">
      <input
        type="checkbox"
        className="zen-v2-check"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="zen-privacy-row-text">
        <span className="zen-privacy-row-label block">{label}</span>
        {description && <span className="zen-privacy-row-desc">{description}</span>}
      </span>
    </label>
  )
}

/** One option of a plain radio list (§9.14): the circle on the first text line, name, description. */
export function RadioRow({
  name,
  value,
  label,
  description,
  checked,
  disabled = false,
  onPick,
  children
}: {
  name: string
  value: string
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onPick: () => void
  /** A trailing control the option carries (a menulist), centred on the row (§9.18). */
  children?: ReactNode
}): JSX.Element {
  const id = useId()
  return (
    <div className="zen-privacy-row">
      <input
        id={id}
        type="radio"
        className="zen-v2-radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onPick}
      />
      <label htmlFor={id} className="zen-privacy-row-text">
        <span className="zen-privacy-row-label block">{label}</span>
        {description && <span className="zen-privacy-row-desc">{description}</span>}
      </label>
      {children && <div className="zen-privacy-row-actions">{children}</div>}
    </div>
  )
}

export interface ChoiceOption<V extends string> {
  value: V
  label: string
  description?: string
}

/**
 * Mutually exclusive options. On a desktop the plain radios of §9.14 in a `radiogroup`, each
 * with its description. On a phone one value row (§10.4): the label on the first line, the
 * current option as its description, the whole row a button that opens the picker sheet, whose
 * title block is the label and `description`.
 */
export function Choice<V extends string>({
  name,
  label,
  description,
  value,
  options,
  disabled = false,
  onChange
}: {
  name: string
  /** The `radiogroup`'s name, the value row's label and the sheet's title. */
  label: string
  /** The sheet's description on a phone; a desktop group says it in its heading instead. */
  description?: string
  value: V
  options: ReadonlyArray<ChoiceOption<V>>
  disabled?: boolean
  onChange: (value: V) => void
}): JSX.Element {
  const phone = usePhone()
  const [open, setOpen] = useState(false)
  if (phone) {
    const current = options.find((o) => o.value === value)
    return (
      <>
        <button
          type="button"
          className="zen-privacy-row zen-protection-action-row"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <span className="zen-privacy-row-text">
            <span className="zen-privacy-row-label block">{label}</span>
            <span className="zen-privacy-row-desc">{current?.label}</span>
          </span>
        </button>
        {open && (
          <PickerSheet
            title={label}
            description={description}
            value={value}
            options={options}
            onPick={onChange}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    )
  }
  return (
    <div className="zen-privacy-rows" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <RadioRow
          key={option.value}
          name={name}
          value={option.value}
          label={option.label}
          description={option.description}
          checked={option.value === value}
          disabled={disabled}
          onPick={() => onChange(option.value)}
        />
      ))}
    </div>
  )
}

/**
 * An action row (§10.4): the whole row is a button – label, optional description, a trailing 16
 * / 20 px external-link glyph only when it leaves the app, the spinner while it works (§9.30,
 * `aria-busy`; a second press does nothing). Disabled is .4 on the row.
 */
export function ActionRow({
  label,
  description,
  external = false,
  busy = false,
  disabled = false,
  onClick
}: {
  label: string
  description?: string
  external?: boolean
  busy?: boolean
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-privacy-row zen-protection-action-row"
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={busy ? undefined : onClick}
    >
      <span className="zen-privacy-row-text">
        <span className="zen-privacy-row-label block">{label}</span>
        {description && <span className="zen-privacy-row-desc">{description}</span>}
      </span>
      {busy ? <Spinner /> : external && <ExternalLink aria-hidden />}
    </button>
  )
}

/**
 * A row with a label, a description and trailing controls (§9.2, §9.18). The controls centre on
 * the row until the description wraps: on three text lines they centre on the label's line
 * instead, which the row learns by measuring its text block. `disabled` dims the text (§10.4's
 * dependent row); the controls carry their own `disabled`.
 */
export function Row({
  label,
  description,
  disabled = false,
  children
}: {
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  children?: ReactNode
}): JSX.Element {
  const text = useRef<HTMLDivElement>(null)
  const [wrapped, setWrapped] = useState(false)
  useLayoutEffect(() => {
    const el = text.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // Two 20 px lines are the row's own; anything taller is a wrapped description.
    const measure = (): void => setWrapped(el.getBoundingClientRect().height > 50)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      className="zen-privacy-row"
      data-wrapped={wrapped || undefined}
      data-disabled={disabled || undefined}
    >
      <div ref={text} className="zen-privacy-row-text">
        <div className="zen-privacy-row-label">{label}</div>
        {description && <div className="zen-privacy-row-desc">{description}</div>}
      </div>
      {children && <div className="zen-privacy-row-actions">{children}</div>}
    </div>
  )
}

export function IconButton({
  title,
  disabled,
  busy = false,
  onClick,
  children
}: {
  title: string
  disabled?: boolean
  /** At work (§9.30): full opacity, the glyph turning, `aria-busy`, a press does nothing. */
  busy?: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-v2-icon-button"
      title={title}
      aria-label={title}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={busy ? undefined : onClick}
    >
      {children}
    </button>
  )
}

/** A 16 / 20 px spinner (§9.30): the row glyph size, turning. */
export function Spinner({ className }: { className?: string }): JSX.Element {
  return <LoaderCircle className={cn('zen-protection-spinner zen-spin', className)} aria-hidden />
}

/**
 * The v2 button at work (§9.30): busy is not disabled – it keeps its opacity and its width, swaps
 * its label for the spinner and says `aria-busy`; a second press while it works does nothing.
 */
export function BusyButton({
  busy = false,
  disabled = false,
  primary = false,
  className,
  onClick,
  children
}: {
  busy?: boolean
  disabled?: boolean
  primary?: boolean
  className?: string
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn('zen-v2-button zen-protection-busy', className)}
      data-primary={primary || undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={busy ? undefined : onClick}
    >
      <span className={cn('zen-protection-busy-label', busy && 'invisible')}>{children}</span>
      {busy && (
        <span className="zen-protection-busy-spinner">
          <Spinner />
        </span>
      )}
    </button>
  )
}

/** Validation text (§9.12): 13 px in the danger ink with a 16 px glyph, under the field it is about. */
export function Invalid({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="zen-privacy-invalid" role="alert">
      <CircleAlert aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
