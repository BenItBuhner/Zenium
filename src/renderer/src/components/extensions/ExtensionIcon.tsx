import type { JSX } from 'react'
import { Puzzle } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/**
 * An extension's icon at `size` inside a `box` (design-language.md §8.2: icon 20 in a 32 box).
 * The manifest icon when there is one, otherwise the puzzle glyph in the secondary ink.
 */
export function ExtensionIcon({
  icon,
  size = 20,
  box = 32,
  className,
  glyphClassName
}: {
  icon: string | null
  size?: number
  box?: number
  className?: string
  glyphClassName?: string
}): JSX.Element {
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center', className)}
      style={{ width: box, height: box }}
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          width={size}
          height={size}
          draggable={false}
          style={{ width: size, height: size, borderRadius: size >= 24 ? 6 : 4 }}
        />
      ) : (
        <Puzzle
          className={cn('text-[var(--zen-muted)]', glyphClassName)}
          style={{ width: size, height: size }}
        />
      )}
    </span>
  )
}
