import type { JSX } from 'react'
import { Puzzle } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/**
 * An extension's icon at `size` inside a `box` (32 in the management cards, 16 in the toolbar).
 * The manifest icon when there is one, otherwise the puzzle glyph in the deemphasised ink of
 * the surface it sits on – the theme's foreground at 69% in the toolbar, `--v2-text-deemphasized`
 * on a page, read from the surface root's `data-surface` (v2 §9.29); the image's corners are on
 * the v2 scale (6 for an inner box, 4 for a control-sized one).
 */
export function ExtensionIcon({
  icon,
  size = 32,
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
          className={cn('zen-ext-icon-glyph', glyphClassName)}
          style={{ width: size, height: size }}
        />
      )}
    </span>
  )
}
