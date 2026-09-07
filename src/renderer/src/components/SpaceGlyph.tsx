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
  return (
    <span
      className={cn('inline-block rounded-full border-2', className)}
      style={{ width: size * 0.7, height: size * 0.7, borderColor: dotColor ?? 'var(--zen-fg)' }}
      aria-hidden
    />
  )
}
