import type { JSX, ReactNode } from 'react'
import { Children, isValidElement } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'

/**
 * Building blocks shared by the Settings sections (design language §8.2, §8.5, §8.6): rows sit
 * directly on the panel, told apart by spacing and a press or hover fill, never by lines or
 * boxes. Groups are a sentence-case heading followed by its rows.
 */

export function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="zen-group">
      <h3 className="zen-group-title">{title}</h3>
      <div className="flex flex-col">{children}</div>
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
  // A row that carries a toggle is the toggle's hit area: the label element forwards its click
  // to the first control inside it, so tapping the text flips the switch.
  const toggles = Children.toArray(children).some((c) => isValidElement(c) && c.type === Switch)
  const Tag = toggles ? 'label' : 'div'
  return (
    <Tag className="zen-row">
      <div className="min-w-0 flex-1">
        <div className="zen-row-label truncate">{label}</div>
        {hint && <div className="zen-row-hint">{hint}</div>}
      </div>
      {children}
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
