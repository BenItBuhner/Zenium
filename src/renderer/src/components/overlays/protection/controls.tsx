import type { JSX, KeyboardEvent, ReactNode, RefObject } from 'react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { CircleAlert, ExternalLink } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/*
 * Building blocks of the protection groups in the desktop Settings > Privacy and Security pane
 * (design-language-v2-draft §4, §6, §9.2, §9.12–9.14, §9.17–9.18, §9.21, §9.23, §9.26–9.27,
 * §9.30, §10.5): Zen's about:preferences – checkboxes to the left of their labels, plain radios
 * with their descriptions, a menulist, cards only where a group carries its own actions. They
 * draw with the classes the pane already has – `.zen-privacy-*` for the section, headings, rows,
 * cards, fields and validation (#115's blocking groups share them) – and the shared v2
 * primitives for the controls: `.zen-v2-checkbox`, `.zen-v2-radio`, `.zen-v2-field`,
 * `.zen-v2-icon-button` and `.zen-v2-button` (§9.34). `.zen-protection-*` adds only what those
 * lack: the 22 section's title block, a sub-heading's description, a card's title block, the
 * radio row that is a button, the action row and the menulist.
 *
 * The phone has none of this: its rows are the Settings tab's, built as data by
 * `pages/settings/protectionRows.tsx` and drawn by #134's page.
 */

/**
 * Whether a row's text block runs to three lines (its description wrapped), which the row
 * learns by measuring the block: two 20 px lines are its own, anything taller is a wrap. A row
 * says so with `data-wrapped`, and its trailing control then centres on the label's line instead
 * of the row (§9.18).
 */
function useWrapped<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const text = useRef<T>(null)
  const [wrapped, setWrapped] = useState(false)
  useLayoutEffect(() => {
    const el = text.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setWrapped(el.getBoundingClientRect().height > 50)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [text, wrapped]
}

/**
 * A 22/600 section of the pane (§9.26): its title on the 28 px line, an optional description 15
 * at 69% 4 px under it, 16 px to the first group, groups 32 apart.
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

/** Rows that carry their own actions: a flat card (§6, §10.5). */
export function List({ children, label }: { children: ReactNode; label?: string }): JSX.Element {
  return (
    <div className="zen-privacy-card" role={label ? 'group' : undefined} aria-label={label}>
      {children}
    </div>
  )
}

/**
 * A card's title block (§9.23, §9.27): a 16 px glyph 8 px before a 17/600 title on the 22 px
 * line, the description 15 at 69% 4 px under it, an action trailing and centred on the block
 * (§9.18), 16 px to the first row.
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
      <div className="zen-protection-card-title-text">
        <div className="zen-privacy-card-title">{title}</div>
        <div className="zen-privacy-muted">{description}</div>
      </div>
      {action}
    </div>
  )
}

/**
 * A boolean row: Zen's leading 16 px checkbox on the first text line (§6, §9.2), the whole row
 * its label. Disabled dims the row's text with the control (§9.30).
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
  return (
    <label className="zen-v2-row zen-privacy-row">
      <input
        type="checkbox"
        className="zen-v2-checkbox"
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

/**
 * One option of a plain radio list (§9.14) on the shared `.zen-v2-radio` (§9.34): the row's text
 * side is a `role="radio"` button carrying `aria-checked`, the circle a presentational span on
 * the first text line, the label its name and the description what describes it. Tab reaches
 * the chosen option only; `RadioGroup` moves the choice with the arrow keys. Disabled is .4 on
 * the whole control (§9.30).
 */
export function RadioRow({
  label,
  description,
  checked,
  tabbable = checked,
  disabled = false,
  onPick,
  children
}: {
  label: string
  description?: string
  checked: boolean
  /** The group's one tab stop: its chosen option, or its first while none is. */
  tabbable?: boolean
  disabled?: boolean
  onPick: () => void
  /** A trailing control the option carries (a menulist), centred on the row, or on the label's line when the description wraps (§9.18). */
  children?: ReactNode
}): JSX.Element {
  const labelId = useId()
  const descId = useId()
  const [text, wrapped] = useWrapped<HTMLSpanElement>()
  return (
    <div className="zen-v2-row zen-privacy-row" data-static="" data-wrapped={wrapped || undefined}>
      <button
        type="button"
        role="radio"
        className="zen-protection-radio"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descId : undefined}
        tabIndex={tabbable ? 0 : -1}
        disabled={disabled}
        onClick={onPick}
      >
        <span className="zen-v2-radio" aria-hidden="true" />
        <span ref={text} className="zen-privacy-row-text">
          <span id={labelId} className="zen-privacy-row-label block">
            {label}
          </span>
          {description && (
            <span id={descId} className="zen-privacy-row-desc">
              {description}
            </span>
          )}
        </span>
      </button>
      {children && <div className="zen-privacy-row-actions">{children}</div>}
    </div>
  )
}

/** Arrow keys inside a `radiogroup` of `RadioRow`s move the choice, as the native control does. */
function moveRadio(e: KeyboardEvent<HTMLDivElement>): void {
  const step =
    e.key === 'ArrowDown' || e.key === 'ArrowRight'
      ? 1
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
        ? -1
        : 0
  if (step === 0) return
  const radios = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')
  )
  const at = radios.indexOf(e.target as HTMLButtonElement)
  if (at < 0) return
  e.preventDefault()
  const next = radios[(at + step + radios.length) % radios.length]
  next?.focus()
  next?.click()
}

/** The `radiogroup` around `RadioRow`s: its name, and the arrow keys that move the choice. */
export function RadioGroup({
  label,
  children
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="zen-privacy-rows" role="radiogroup" aria-label={label} onKeyDown={moveRadio}>
      {children}
    </div>
  )
}

export interface ChoiceOption<V extends string> {
  value: V
  label: string
  description?: string
}

/** Mutually exclusive options as the plain radios of §9.14 in a `radiogroup`, each with its description. */
export function Choice<V extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange
}: {
  /** The `radiogroup`'s name. */
  label: string
  value: V
  options: ReadonlyArray<ChoiceOption<V>>
  disabled?: boolean
  onChange: (value: V) => void
}): JSX.Element {
  const tabbable = options.some((o) => o.value === value) ? value : options[0]?.value
  return (
    <RadioGroup label={label}>
      {options.map((option) => (
        <RadioRow
          key={option.value}
          label={option.label}
          description={option.description}
          checked={option.value === value}
          tabbable={option.value === tabbable}
          disabled={disabled}
          onPick={() => onChange(option.value)}
        />
      ))}
    </RadioGroup>
  )
}

/**
 * An action row: the whole row is a button – label, optional description, a trailing 16 px
 * external-link glyph only when it leaves the app; the glyph centres on the row, or on the
 * label's line when the description wraps (§9.18). Disabled is .4 on the row (§9.30).
 */
export function ActionRow({
  label,
  description,
  external = false,
  disabled = false,
  onClick
}: {
  label: string
  description?: string
  external?: boolean
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  const [text, wrapped] = useWrapped<HTMLSpanElement>()
  return (
    <button
      type="button"
      className="zen-v2-row zen-privacy-row zen-protection-action-row"
      data-wrapped={wrapped || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span ref={text} className="zen-privacy-row-text">
        <span className="zen-privacy-row-label block">{label}</span>
        {description && <span className="zen-privacy-row-desc">{description}</span>}
      </span>
      {external && <ExternalLink aria-hidden />}
    </button>
  )
}

/**
 * A row with a label, a description and trailing controls (§9.2, §9.18). The controls centre on
 * the row until the description wraps: on three text lines they centre on the label's line
 * instead (`useWrapped`). `disabled` dims the text (§10.4's dependent row); the controls carry
 * their own `disabled`.
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
  const [text, wrapped] = useWrapped<HTMLDivElement>()
  return (
    <div
      className="zen-v2-row zen-privacy-row"
      data-static=""
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

/**
 * The shared v2 button at work (§9.30, as the extensions UI and the new tab page draw it): busy
 * is not disabled – it keeps its opacity and its width, its label stays in the flow unpainted
 * under the 16 px `.zen-v2-spinner`, and it says `aria-busy`; a second press while it works does
 * nothing.
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
      className={cn('zen-v2-button', className)}
      data-primary={primary || undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={busy ? undefined : onClick}
    >
      {busy ? (
        <>
          <span className="zen-v2-button-label">{children}</span>
          <span className="zen-v2-spinner" aria-hidden />
        </>
      ) : (
        children
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
