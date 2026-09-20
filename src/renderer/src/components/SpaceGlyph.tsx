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
  // A ring of ink, filled with the space's colour when one is given: the ring keeps the dot at
  // the ink's contrast on whatever gradient is under it (a11y-30), where a ring drawn in the
  // colour itself sat at 1.5:1 on a like-coloured window, and the colour still shows.
  return (
    <span
      className={cn('inline-block rounded-full border-2 border-[var(--zen-fg)]', className)}
      style={{ width: size * 0.7, height: size * 0.7, background: dotColor }}
      aria-hidden
    />
  )
}
