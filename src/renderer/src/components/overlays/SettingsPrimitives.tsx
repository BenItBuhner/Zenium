import type { JSX, ReactNode } from 'react'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { rowControl, rowIsLabel, rowStacks, type ControlTypes } from './settingsRow'

/**
 * Building blocks shared by the Settings sections. Rows sit directly on the panel; a group is a
 * sentence-case heading and the air around it, never a card or a rule (design-language.md §8.2).
 * The styles live under `.zen-settings-*` in main.css, with the phone metrics keyed on the form
 * factor there.
 */

export function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="zen-settings-group">
      <h3 className="zen-settings-heading">{title}</h3>
      <div className="zen-settings-rows">{children}</div>
    </section>
  )
}

/** The controls a row recognises as its single child (see settingsRow.ts). */
const CONTROL_TYPES: ControlTypes = [
  [Switch, 'switch'],
  [Choice, 'select'],
  [Input, 'input'],
  [Segmented, 'segmented']
]

/**
 * A row whose only child is a switch, a select or a field is labelled by its text, so the whole
 * row toggles, opens or focuses it; wide controls stack under the label in a narrow column.
 */
export function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  const control = rowControl(children, CONTROL_TYPES)
  const Tag = rowIsLabel(control) ? 'label' : 'div'
  return (
    <Tag
      className="zen-settings-row"
      data-control={control ?? undefined}
      data-stack={rowStacks(control, children) || undefined}
    >
      <div className="zen-settings-text">
        <div className="zen-settings-label">{label}</div>
        {hint && <div className="zen-settings-hint">{hint}</div>}
      </div>
      <div className="zen-settings-control">{children}</div>
    </Tag>
  )
}

/** Centred muted text where a list would be: no routes yet, nothing to show. */
export function Note({ children }: { children: ReactNode }): JSX.Element {
  return <div className="zen-settings-note">{children}</div>
}

/** Two or three options as one pill; the picked one wears the accent tint. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  /** Name of the choice for assistive tech (the row label is not associated). */
  label: string
}): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="zen-segmented flex shrink-0 items-center rounded-full p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-active={o.value === value}
          className="zen-segment h-8 min-w-[72px] rounded-full px-3.5 text-[13px] font-medium"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A long list of options (engines, spaces, colours); short sets use `Segmented`. */
export function Choice<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
