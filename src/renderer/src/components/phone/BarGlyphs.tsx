import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { RotateCw, Star, X } from 'lucide-react'
import { SPRING_SNAPPY, SpringAnimation, type SpringConfig } from '@renderer/lib/motion/spring'
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

/**
 * `SPRING_SNAPPY` for the fill's 0…1 value. The shared spring's rest thresholds are in px and
 * px/s (`restDelta` .4, `restSpeed` 8), so on a unit value they would call the fill settled at
 * 60 percent and snap it to the end – a five-frame ramp and a cut, not a spring; a hundredth of
 * each lets the fill run to rest as a position does (22 frames at 60 Hz, .9 at 200 ms, at rest
 * by 370 ms, no frame stepping more than .13). `BarPreview`'s presence spring takes the same
 * numbers.
 */
const SPRING_FILL: SpringConfig = { ...SPRING_SNAPPY, restDelta: 0.004, restSpeed: 0.08 }

/**
 * The bookmark star as a stateful glyph, shared by the phone app menu's icon row and the bar's
 * optional Bookmark (#236's star, the lead's ruling for both): the outline, and over it a filled
 * star whose opacity and scale one `SPRING_SNAPPY` spring (`SPRING_FILL`, its rest at the unit's
 * scale) writes per frame (design language v2 §11: transform and opacity only, one interruptible
 * spring – a change of mind before it lands retargets the same motion; reduced motion jumps to
 * the end). It opens at rest where the bookmark is, with no motion of its own; `filled` turning
 * true runs the fill, in parallel with whatever the press opened (the menu's leave, the bar's
 * saved toast or editor). Not a toggle: nothing here reports a pressed state, the name of the
 * button around it says Bookmark or Edit Bookmark.
 */
export function StarGlyph({ filled }: { filled: boolean }): JSX.Element {
  const fill = useRef<HTMLSpanElement>(null)
  const spring = useRef<SpringAnimation | null>(null)
  useEffect(() => {
    const el = fill.current
    if (!el) return
    const paint = (x: number): void => {
      el.style.opacity = String(Math.max(0, Math.min(1, x)))
      el.style.transform = `scale(${0.6 + 0.4 * x})`
    }
    const to = filled ? 1 : 0
    if (!spring.current) {
      spring.current = new SpringAnimation(SPRING_FILL, paint, paint)
      paint(to)
      spring.current.start(to, 0, to)
    } else spring.current.retarget(to)
  }, [filled])
  useEffect(() => () => void spring.current?.stop(), [])
  return (
    <span className="zen-star-glyph" data-filled={filled} aria-hidden>
      <span>
        <Star />
      </span>
      <span ref={fill} className="zen-star-glyph-fill">
        <Star fill="currentColor" />
      </span>
    </span>
  )
}
