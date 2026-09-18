import type { CSSProperties, JSX, ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'
import { useViewport } from '@renderer/lib/formFactor'
import { ROW_CONTROL_PADDING, rowMinHeight } from '@renderer/lib/rows'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

/** Building blocks shared by the Settings sections. */

/** Height of the menulist `Choice` renders (the select trigger's `h-8`). */
export const MENULIST_HEIGHT = 32
/** Height of the `Switch` control. */
export const SWITCH_HEIGHT = 20

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
  control,
  children
}: {
  label: string
  hint?: string
  /**
   * Height in px of the trailing control. A row that names it grows around the control (design
   * language §9.21, `lib/rows.ts`): a 32 px menulist makes a 40 px row on a desktop, with 4 px
   * of the row's own padding above and below rather than a list gap, so rows still touch. Rows
   * that leave it out keep the surface's current size.
   */
  control?: number
  children: ReactNode
}): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  const sized: CSSProperties | undefined =
    control === undefined
      ? undefined
      : {
          minHeight: rowMinHeight(control, phone),
          paddingTop: ROW_CONTROL_PADDING,
          paddingBottom: ROW_CONTROL_PADDING
        }
  return (
    <div
      className={cn(
        'flex items-center gap-4 border-b border-[var(--zen-border)] px-4 last:border-b-0',
        control === undefined && 'min-h-12 py-2'
      )}
      style={sized}
    >
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
