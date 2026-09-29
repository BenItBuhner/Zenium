import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { MoreHorizontal, RotateCw, Star, X } from 'lucide-react'
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

/**
 * The bar's Menu glyph: the "⋯", and at its corner – while an update is downloaded and waiting
 * (TB-12) – the 6 px accent dot the desktop's ⋯ wears (`SidebarTop`, shortcuts-menus-101), the
 * mark Chrome's ⋮ carries for its "Update Chrome" row (Chrome's badge is a red disc over the
 * glyph; Zenium's is the one dot its menu buttons already wear, §9.19's marker form). The glyph
 * is the dot's box, so it sits against the glyph's corner whatever the button's size
 * (`.zen-glyph-dot` in main.css); the button's name says it for the tree (`barItems`).
 */
export function MenuGlyph({ updateReady }: { updateReady: boolean }): JSX.Element {
  return (
    <span className="zen-glyph-dot relative flex h-5 w-5 items-center justify-center">
      <MoreHorizontal className={glyph} aria-hidden />
      {updateReady && <span className="zen-mhub-dot" data-testid="update-ready-dot" aria-hidden />}
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

/** The pop's top: the star grows a fifth (1.0 → 1.2 → 1.0) before it settles where it was. */
const POP_PEAK = 0.2

/**
 * `SPRING_SNAPPY` for the pop's displacement – the star's scale less one, a value on the unit's
 * scale. The shared spring's rest thresholds are in px and px/s (`restDelta` .4, `restSpeed`
 * 8), so on a unit value they would call the motion settled at its first frames and snap it to
 * the end – a ramp and a cut, not a spring; a hundredth of each lets it run to rest as a position
 * does (a .2 pop tops out in three frames at 60 Hz and is at rest by frame 21, 336 ms, no frame
 * stepping the scale more than .13). `BarPreview`'s presence spring takes the same numbers.
 */
const SPRING_POP: SpringConfig = { ...SPRING_SNAPPY, restDelta: 0.004, restSpeed: 0.08 }

/**
 * The velocity that strikes a spring at rest so it rises to `peak` and turns back: the spring's
 * own answer to an impulse (`stepSpring`'s closed form with no displacement), its top where the
 * velocity crosses zero – tan(ωd t) = ωd / (ζ ω0) under the house's damping, t = 1 / ω0 at the
 * critical – and its height there per unit of velocity. One spring struck once is the whole
 * pop: no keyframes, no second motion to keep in step.
 */
function impulseFor(peak: number, { stiffness, damping, mass }: SpringConfig): number {
  const w0 = Math.sqrt(stiffness / mass)
  const zeta = damping / (2 * Math.sqrt(stiffness * mass))
  if (zeta >= 1) return peak * w0 * Math.E
  const wd = w0 * Math.sqrt(1 - zeta * zeta)
  const t = Math.atan(wd / (zeta * w0)) / wd
  return (peak * wd) / (Math.exp(-zeta * w0 * t) * Math.sin(wd * t))
}

const POP_IMPULSE = impulseFor(POP_PEAK, SPRING_POP)

/** One pop under way: the fill at the strike, where it is heading, and the top reached so far. */
interface PopRun {
  from: number
  to: number
  peak: number
  opacity: number
}

/**
 * The bookmark star as a stateful glyph, shared by the phone app menu's icon row and the bar's
 * optional Bookmark (#236's star, the lead's ruling for both): the outline, and over it a filled
 * star. A change of state pops the whole glyph – its scale 1.0 → 1.2 → 1.0, Chrome's form (the
 * MOT-20 row) – on one `SPRING_SNAPPY` spring (`SPRING_POP`, at rest on the unit's scale) struck
 * with `POP_IMPULSE` from wherever it stands, and the fill rides the same value: an outline still
 * at the top of the pop, it fills (or empties) as the star settles back, in step with the
 * displacement's return, so no frame moves the fill's opacity further than the spring moves the
 * scale and the fill lands where the pop does (design language v2 §11: transform and opacity
 * only, one interruptible spring – a change of mind before it lands strikes the same motion
 * again from where it is, the fill carrying on from its own; reduced motion is a cut, §11.3).
 * It opens at rest where the bookmark is, with no motion of its own; the flip runs in parallel
 * with whatever the press opened (the menu's leave, the bar's saved toast or editor). Not a
 * toggle: nothing here reports a pressed state, the name of the button around it says Bookmark
 * or Edit Bookmark.
 *
 * The rest state is written in a layout effect, before the browser paints the mount: a passive
 * effect would leave the first frame of a fresh glyph (the bar's first mount, a bar edge switch)
 * showing the filled star at full opacity over the outline, which nothing hides in the bar. The
 * strikes ride the same effect; the spring itself runs on animation frames.
 */
export function StarGlyph({ filled }: { filled: boolean }): JSX.Element {
  const glyph = useRef<HTMLSpanElement>(null)
  const fill = useRef<HTMLSpanElement>(null)
  const spring = useRef<SpringAnimation | null>(null)
  const run = useRef<PopRun>({ from: 0, to: 0, peak: 0, opacity: 0 })
  useLayoutEffect(() => {
    const el = glyph.current
    const fillEl = fill.current
    if (!el || !fillEl) return
    const to = filled ? 1 : 0
    const paint = (d: number, v = 0): void => {
      const pop = run.current
      pop.peak = Math.max(pop.peak, d)
      // Past the top (the velocity has turned), the fill follows the displacement home.
      if (v <= 0) {
        pop.opacity =
          pop.peak > 0 ? pop.to - (pop.to - pop.from) * Math.min(1, d / pop.peak) : pop.to
      }
      el.style.transform = `scale(${1 + d})`
      fillEl.style.opacity = String(pop.opacity)
    }
    if (!spring.current) {
      spring.current = new SpringAnimation(SPRING_POP, paint, paint)
      run.current = { from: to, to, peak: 0, opacity: to }
      paint(0)
      return
    }
    if (run.current.to === to) return
    const { x } = spring.current.stop()
    run.current = { from: run.current.opacity, to, peak: x, opacity: run.current.opacity }
    spring.current.start(x, POP_IMPULSE, 0)
  }, [filled])
  useEffect(() => () => void spring.current?.stop(), [])
  return (
    <span ref={glyph} className="zen-star-glyph" data-filled={filled} aria-hidden>
      <span>
        <Star />
      </span>
      <span ref={fill} className="zen-star-glyph-fill">
        <Star fill="currentColor" />
      </span>
    </span>
  )
}
