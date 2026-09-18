import type { JSX } from 'react'

/**
 * A switch row (design language v2 §10.4): the label, an optional 13/69 % description under it,
 * and a 36 × 20 switch trailing on the row's centre (§9.18). The whole row is the switch
 * (`role="switch"`, `aria-checked`), 44 tall with one line and 64 with a description (§9.2), the
 * press fill on the row. Disabled, it stays laid out at .4 and takes no press (§9.30), keeping
 * `aria-disabled` so the row and its reason can still be reached and read.
 *
 * The Settings tab's primitive (#134, `components/pages/settings/rows.tsx`, its `switch` row),
 * lifted here so the new tab page's customise sheet draws the same control; one of the two adopts
 * the other on the next rebase.
 */
export function SwitchRow({
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
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      className="zen-v2-row"
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
    >
      <span className="zen-v2-row-text">
        <span className="zen-v2-label">{label}</span>
        {description && <span className="zen-v2-description">{description}</span>}
      </span>
      <span className="zen-v2-switch" aria-hidden />
    </button>
  )
}
