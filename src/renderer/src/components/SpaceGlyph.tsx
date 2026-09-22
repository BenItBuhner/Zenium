import type { JSX } from 'react'
import { SPACE_SYMBOLS, SYMBOL_PREFIX, isSymbolIcon } from '@renderer/lib/spaceIcons'
import { cn } from '@renderer/lib/utils'

/** Renders a space icon: emoji as text, `sym:<name>` as a monochrome glyph, empty as a dot. */
export function SpaceGlyph({
  icon,
  size = 15,
  className,
  dotColor
}: {
  icon: string
  size?: number
  className?: string
  dotColor?: string
}): JSX.Element {
  if (isSymbolIcon(icon)) {
    const Icon = SPACE_SYMBOLS[icon.slice(SYMBOL_PREFIX.length)]
    return (
      <Icon
        className={cn('shrink-0', className)}
        style={{ width: size, height: size }}
        aria-hidden
      />
    )
  }
  if (icon) {
    return (
      <span className={cn('leading-none', className)} style={{ fontSize: size }} aria-hidden>
        {icon}
      </span>
    )
  }
  // A swatch of the space's colour with a 1 px hairline of the ink at 20 % (a11y-30; design
  // language v2 §9.14): the hairline gives the colour an edge on a like-coloured window, where a
  // ring drawn in the colour itself sat at 1.5:1, and keeps the dot a swatch, not a badge.
  const d = size * 0.7
  if (dotColor) {
    return (
      <span
        className={cn(
          'inline-block rounded-full border border-[rgb(var(--zen-fg-rgb)/0.2)]',
          className
        )}
        style={{ width: d, height: d, background: dotColor }}
        aria-hidden
      />
    )
  }
  // With no colour to show (the strip's space header, the pickers) the dot is a ring of the ink:
  // the glyph itself, so it draws as the symbol glyphs beside it do – in the current ink at §9.3's
  // glyph stroke (`--v2-icon-stroke`: 1.5 on desktop, 1.75 on the phone), not the 2 px it had
  // (the lead on #226). The circle is inset by the wider stroke's half so neither stroke clips.
  return (
    <svg
      className={cn('shrink-0 overflow-visible [stroke-width:var(--v2-icon-stroke)]', className)}
      width={d}
      height={d}
      viewBox={`0 0 ${d} ${d}`}
      fill="none"
      stroke="currentColor"
      data-space-dot
      aria-hidden
    >
      <circle cx={d / 2} cy={d / 2} r={(d - 1.75) / 2} />
    </svg>
  )
}
