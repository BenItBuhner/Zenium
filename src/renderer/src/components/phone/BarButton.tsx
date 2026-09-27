import type { JSX } from 'react'
import type { PhoneBarItemId } from '@shared/types'
import { barItem, barItemEnabled, type BarItemContext } from './barItems'

/**
 * One control of the phone's bar, drawn from the catalogue: a 44 px target with the item's
 * 20 px glyph, dimmed while the item has nothing to do. The same element serves the live bar
 * and the editor's preview (`inert`: drawn, never pressed, out of the tab order). While an
 * in-product help bubble about the control stands, the bubble's id is its description
 * (`describedBy`; TB-19, the lead's (j) on #641).
 */
export function BarButton({
  id,
  ctx,
  inert,
  describedBy
}: {
  id: PhoneBarItemId
  ctx: BarItemContext
  inert?: boolean
  describedBy?: string
}): JSX.Element {
  const item = barItem(id)
  const enabled = barItemEnabled(id, ctx)
  const pressed = item.pressed?.(ctx)
  return (
    <button
      type="button"
      className="zen-toolbar-button h-11 w-11 shrink-0"
      data-bar-item={id}
      data-disabled={!enabled || undefined}
      aria-label={item.name?.(ctx) ?? item.label}
      aria-pressed={pressed}
      aria-disabled={inert ? undefined : !enabled || undefined}
      aria-describedby={describedBy}
      tabIndex={inert ? -1 : undefined}
      onPointerDown={() => {
        if (!inert && enabled) item.press?.(ctx)
      }}
      onClick={(e) => {
        if (!inert && enabled) item.run(ctx, e.currentTarget)
      }}
    >
      {item.glyph(ctx)}
    </button>
  )
}
