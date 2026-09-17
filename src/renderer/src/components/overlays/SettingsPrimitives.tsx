import type { JSX, ReactNode } from 'react'
import { hasElementOfType } from '@renderer/lib/children'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'

/**
 * Building blocks shared by the Settings sections and every settings-like surface. Rows sit
 * straight on the panel: a heading and a gap tell groups apart, a press or hover fill tells rows
 * apart, and nothing is boxed or underlined. Phone sizing lives under `.zen-row`, `.zen-group`
 * in main.css.
 */

export function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="zen-group">
      <h3 className="zen-group-title mb-1.5 px-2.5 text-[13px] font-semibold leading-[1.4] tracking-[-0.006em] text-[var(--zen-fg)]">
        {title}
      </h3>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

/**
 * Label and optional hint on the left, the control on the right. A row that holds a Switch is a
 * `<label>`, so the whole row toggles it and names it. On phones a row holding a select or a
 * text field stacks: text full width, control full width below (`.zen-row:has(...)` in main.css).
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
  const Tag = hasElementOfType(children, [Switch]) ? 'label' : 'div'
  return (
    <Tag className="zen-row flex min-h-9 items-center gap-4 rounded-md px-2.5 py-1.5 transition-[background-color] duration-[120ms] ease-[var(--zen-ease)] hover:bg-[var(--zen-element-bg)] active:bg-[var(--zen-element-bg)]">
      <span className="min-w-0 flex-1">
        <span className="zen-row-label block text-[13px] leading-[1.4]">{label}</span>
        {hint && (
          <span className="zen-row-hint mt-0.5 block text-[11.5px] leading-[1.4] text-[var(--zen-muted)]">
            {hint}
          </span>
        )}
      </span>
      <span className="zen-row-control flex shrink-0 flex-wrap items-center justify-end gap-2">
        {children}
      </span>
    </Tag>
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
