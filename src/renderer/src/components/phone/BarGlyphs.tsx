import type { JSX } from 'react'
import { RotateCw, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { RollingCount } from './RollingCount'

const glyph = 'h-5 w-5'

/**
 * Reload and Stop share one slot: the glyph that is not current fades out as the other fades in
 * (120 ms), a swap rather than a flip, so the button never jumps mid-load.
 */
export function ReloadStopGlyph({ loading }: { loading: boolean }): JSX.Element {
  return (
    <span className="zen-glyph-swap relative flex h-5 w-5 items-center justify-center">
      <RotateCw className={cn(glyph, 'absolute')} data-shown={!loading} aria-hidden />
      <X className={cn(glyph, 'absolute')} data-shown={loading} aria-hidden />
    </span>
  )
}

/** The tab count in its rounded square; the number rolls when it changes. */
export function TabCountBadge({ count, active }: { count: number; active: boolean }): JSX.Element {
  return (
    <span
      className={cn(
        'flex h-[22px] min-w-[22px] items-center justify-center rounded-[6px] border-2 border-current px-1 text-[11px] font-semibold leading-none transition-colors',
        active && 'bg-[var(--zen-fg)] text-[var(--zen-bg-solid)]'
      )}
    >
      <RollingCount value={count > 99 ? '∞' : String(count)} />
    </span>
  )
}
