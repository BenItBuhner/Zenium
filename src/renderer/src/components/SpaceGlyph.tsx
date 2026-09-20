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
  return (
    <span
      className={cn('inline-block rounded-full border border-[rgb(var(--zen-fg-rgb)/0.2)]', className)}
      style={{ width: size * 0.7, height: size * 0.7, background: dotColor }}
      aria-hidden
    />
  )
}
