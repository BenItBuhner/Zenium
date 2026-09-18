import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WebAppBanner } from '@shared/types'
import {
  acceptInstallBanner,
  dismissInstallBanner,
  retireInstallBanner
} from '@renderer/lib/installBanner'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import { AppIcon } from './InstallSheet'

/** Travel (px) or release speed (px/s, away from home) that turns a drag into a dismissal. */
const DISMISS_DISTANCE = 56
const DISMISS_VELOCITY = 600
/** Travel at which the card has faded out, and the point past it where an exit comes to rest. */
const FADE_DISTANCE = 220
const EXIT_DISTANCE = 260
/** Finger slop before a touch counts as a drag. */
const SLOP = 4

/**
 * The ambient install prompt (PWA-03), a v2 panel above the page: "Add <app> to Home screen"
 * with the app's icon and one primary "Add", raised by the core once a site has earned it. It
 * is a sibling of the content frame, so the page gets a little shorter while it is up (on
 * Android the page is a native view above the chrome; nothing floating over it would show). It
 * follows a finger that pushes it up or to either side; let go past the threshold or thrown fast
 * enough it leaves on a spring at the speed it was thrown (the core starts the cooldown), else it
 * springs back – and a finger can catch it anywhere on the way. It goes away on its own when the
 * core's timer runs out, the page leaves the app or another tab comes to the front.
 */
export function InstallBanner({
  banner,
  activeTabId
}: {
  banner: WebAppBanner | null
  activeTabId: string | null
}): JSX.Element | null {
  const current = banner && banner.tabId === activeTabId ? banner : null
  // The last banner stays mounted until its card has slid out once the core takes it down.
  const [shown, setShown] = useState<WebAppBanner | null>(current)
  if (current && current !== shown) setShown(current)
  const leaving = current === null && shown !== null

  if (!shown) return null
  return (
    <div className="flex shrink-0 justify-center pb-2">
      <BannerCard
        key={`${shown.tabId}:${shown.name}`}
        banner={shown}
        leaving={leaving}
        onGone={() => setShown(null)}
      />
    </div>
  )
}

/**
 * The card's motion is one distance along one line. A finger places the card at `(x, y)`; on
 * release a spring runs on the distance along that displacement – back to 0, or out past
 * `EXIT_DISTANCE` – starting at the speed the finger had along it, so a fling leaves as fast as
 * it was thrown and a slow let-go settles back (v1 §7.1). Opacity follows the same distance.
 * A finger can catch the card mid-flight: `catch()` stops the spring and hands back the live
 * translate, and the drag carries on from there instead of snapping to the new touch point.
 */
class BannerMotion {
  private pos = { x: 0, y: 0 }
  /** Unit vector the spring moves along, set from the displacement at release. */
  private dir = { x: 0, y: -1 }
  private out = false
  private readonly spring: SpringAnimation

  constructor(
    private readonly element: () => HTMLElement | null,
    private readonly onGone: () => void
  ) {
    this.spring = new SpringAnimation(
      SPRING_SNAPPY,
      (s) => this.place(this.dir.x * s, this.dir.y * s, this.out ? 0 : 0.2),
      () => {
        if (this.out) this.onGone()
        else this.moving(false)
      }
    )
  }

  /** Distance from home (px). */
  get travel(): number {
    return Math.hypot(this.pos.x, this.pos.y)
  }

  /** Speed (px/s) of `(vx, vy)` away from home along the card's displacement. */
  speedAway(vx: number, vy: number): number {
    const travel = this.travel
    if (travel === 0) return Math.hypot(vx, vy)
    return (vx * this.pos.x + vy * this.pos.y) / travel
  }

  /** A finger lands on the card: freeze whatever motion it had and report where it is. */
  catch(): { x: number; y: number } {
    this.spring.stop()
    const el = this.element()
    // The entrance keyframe would otherwise hold the transform for its first frames.
    if (el) el.style.animation = 'none'
    this.moving(true)
    return { ...this.pos }
  }

  /** The finger carries the card to `(x, y)`; it stays a little visible however far it goes. */
  drag(x: number, y: number): void {
    this.place(x, y, 0.2)
  }

  /**
   * The finger lets go moving at `(vx, vy)` px/s: the spring runs along the card's displacement
   * (up, when it has none) – home, or off the edge when `out` – from the speed along that line.
   */
  release(vx: number, vy: number, out: boolean): void {
    const travel = this.travel
    this.dir = travel > 0 ? { x: this.pos.x / travel, y: this.pos.y / travel } : { x: 0, y: -1 }
    this.out = out
    this.moving(true)
    this.spring.start(travel, vx * this.dir.x + vy * this.dir.y, out ? EXIT_DISTANCE : 0)
  }

  dispose(): void {
    this.spring.stop()
  }

  private place(x: number, y: number, floor: number): void {
    this.pos = { x, y }
    const el = this.element()
    if (!el) return
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`
    el.style.opacity = String(Math.max(floor, 1 - Math.hypot(x, y) / FADE_DISTANCE))
  }

  /** `will-change` only while the card is in motion (main.css), never at rest. */
  private moving(on: boolean): void {
    const el = this.element()
    if (!el) return
    if (on) el.dataset.moving = ''
    else delete el.dataset.moving
  }
}

function BannerCard({
  banner,
  leaving,
  onGone
}: {
  banner: WebAppBanner
  leaving: boolean
  onGone: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; x0: number; y0: number; moved: boolean } | null>(null)
  const [tracker] = useState(() => new VelocityTracker())
  /** The card is on its way out (either reason); touches no longer catch it. */
  const exiting = useRef(false)
  /** The user swiped it away: the banner is retired once the card has left. */
  const swiped = useRef(false)
  const onGoneRef = useRef(onGone)
  useEffect(() => {
    onGoneRef.current = onGone
  })
  // The motion lives as long as the card; it reaches the element and the callbacks through refs.
  const motion = useRef<BannerMotion | null>(null)
  useLayoutEffect(() => {
    const m = new BannerMotion(
      () => ref.current,
      () => {
        if (swiped.current) retireInstallBanner(banner.tabId)
        onGoneRef.current()
      }
    )
    motion.current = m
    return () => {
      m.dispose()
      motion.current = null
    }
  }, [banner.tabId])

  // The core took the banner down (timeout, navigation, the sheet opened): it leaves the way it
  // came, from wherever it is.
  useEffect(() => {
    if (!leaving || exiting.current) return
    exiting.current = true
    drag.current = null
    motion.current?.release(0, 0, true)
  }, [leaving])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const m = motion.current
    if (!m || e.button !== 0 || drag.current || exiting.current) return
    if ((e.target as HTMLElement).closest('button')) return
    // Caught mid-flight, the card keeps its live offset under the finger rather than snapping.
    const at = m.catch()
    drag.current = { id: e.pointerId, x0: e.clientX - at.x, y0: e.clientY - at.y, moved: false }
    tracker.reset()
    tracker.add(e.timeStamp, e.clientX, e.clientY)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    tracker.add(e.timeStamp, e.clientX, e.clientY)
    const x = e.clientX - d.x0
    // The banner lives at the top edge: it only ever leaves upwards or sideways.
    const y = Math.min(0, e.clientY - d.y0)
    if (!d.moved && Math.abs(x) < SLOP && Math.abs(y) < SLOP) return
    d.moved = true
    motion.current?.drag(x, y)
  }
  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const d = drag.current
    const m = motion.current
    if (!d || d.id !== e.pointerId || !m) return
    drag.current = null
    const { vx, vy } = cancelled ? { vx: 0, vy: 0 } : tracker.velocity(e.timeStamp)
    const travel = m.travel
    const flung = m.speedAway(vx, vy) > DISMISS_VELOCITY && travel > 16
    if (!cancelled && d.moved && (travel > DISMISS_DISTANCE || flung)) {
      swiped.current = true
      exiting.current = true
      dismissInstallBanner(banner)
      m.release(vx, vy, true)
      return
    }
    m.release(vx, vy, false)
  }

  return (
    <div
      ref={ref}
      role="status"
      className="zen-install-banner pointer-events-auto flex w-full max-w-[520px] items-center gap-3"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
    >
      <AppIcon icon={banner.icon} name={banner.name} tint={banner.tint} size={40} />
      <div className="min-w-0 flex-1">
        <div className="zen-install-body truncate">Add {banner.name} to Home screen</div>
        <div className="zen-install-detail truncate">{banner.origin}</div>
      </div>
      <button
        type="button"
        className="zen-v2-button shrink-0"
        data-primary
        onClick={() => acceptInstallBanner(banner)}
      >
        Add
      </button>
    </div>
  )
}
