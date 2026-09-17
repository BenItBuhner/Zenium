import type { JSX, ReactNode } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

/** Building blocks shared by the Settings sections. */

export function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--zen-muted)]">
        {title}
      </h3>
      <div className="overflow-hidden rounded-xl border border-[var(--zen-border)]">{children}</div>
    </section>
  )
}

export function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex min-h-12 items-center gap-4 border-b border-[var(--zen-border)] px-4 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="text-[11.5px] text-[var(--zen-muted)]">{hint}</div>}
      </div>
      {children}
    </div>
  )
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
      <SelectTrigger className="w-56">
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
