import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { PhoneBarItemId, PhoneBarLayout } from '@shared/types'
import { PHONE_BAR_ITEM_IDS, phoneBarGeometry } from '@shared/phoneBar'
import { displayUrl } from '@shared/url'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { cn } from '@renderer/lib/utils'
import { BarButton } from './BarButton'
import type { BarItemContext } from './barItems'

/**
 * The bar at real size, as the editor's live preview: the controls of `layout` either side of
 * the address pill, laid out by `phoneBarGeometry` rather than by flex so that every change is
 * a rect the elements can spring to. A control that joins slides its neighbours apart and grows
 * in; one that leaves shrinks away while the rest close up; the pill's left edge and width
 * follow on the same spring. The whole catalogue stays mounted (controls out of the bar sit
 * hidden at presence 0), so styles are written per frame straight to the DOM and nothing has
 * to wait for a render to appear or disappear.
 */
export function BarPreview({
  layout,
  ctx,
  className
}: {
  layout: PhoneBarLayout
  ctx: BarItemContext
  className?: string
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const motion = useRef<PreviewMotion | null>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    setWidth(el.clientWidth)
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!width) return
    const m = (motion.current ??= new PreviewMotion((key) => nodes.current.get(key)))
    m.update(layout, width)
  }, [layout, width])

  useEffect(() => () => motion.current?.stop(), [])

  const url = ctx.tab ? displayUrl(ctx.tab.url) : ''

  return (
    <div
      ref={host}
      className={cn('pointer-events-none relative h-14 select-none', className)}
      aria-hidden
    >
      {PHONE_BAR_ITEM_IDS.map((id) => (
        <div
          key={id}
          ref={(el) => {
            if (el) nodes.current.set(id, el)
            else nodes.current.delete(id)
          }}
          className="absolute left-0 top-1.5 h-11 w-11"
          style={{ opacity: 0, visibility: 'hidden' }}
        >
          <BarButton id={id} ctx={ctx} inert />
        </div>
      ))}
      <div
        ref={(el) => {
          if (el) nodes.current.set('pill', el)
          else nodes.current.delete('pill')
        }}
        className="absolute left-0 top-1.5 flex h-11 items-center gap-2 overflow-hidden rounded-full bg-[var(--zen-element-bg)] px-3.5"
        style={{ width: 0 }}
      >
        {!url && <Search className="h-4 w-4 shrink-0 opacity-60" />}
        <span
          className={cn('min-w-0 flex-1 truncate text-[14px]', !url && 'text-[var(--zen-muted)]')}
        >
          {url || 'Search or enter address'}
        </span>
      </div>
    </div>
  )
}

/** Scale a control is drawn at as it grows in or shrinks away (`presence` 0…1). */
const scaleAt = (presence: number): number => 0.6 + 0.4 * presence

/**
 * The preview's springs: one per control for its left edge and one for its presence (0 = gone,
 * 1 = in place), two for the pill (left, width). Frames write `transform`, `opacity` and
 * `visibility` (and the pill's width, one small element) to the nodes looked up by key.
 */
class PreviewMotion {
  private width = 0
  private readonly left = new Map<string, number>()
  private readonly presence = new Map<string, number>()
  private pillWidth = 0
  private readonly springs = new Map<string, SpringAnimation>()

  constructor(private readonly node: (key: string) => HTMLElement | undefined) {}

  update(layout: PhoneBarLayout, width: number): void {
    // The first paint and a resize place everything at once; edits animate.
    const animate = this.width === width
    this.width = width
    const g = phoneBarGeometry(layout, width)
    for (const id of PHONE_BAR_ITEM_IDS) {
      const target = g.items.get(id)
      const inBar = target !== undefined
      const known = this.presence.has(id)
      if (!known) {
        this.left.set(id, target ?? 0)
        this.presence.set(id, inBar && !animate ? 1 : 0)
        this.paintItem(id)
      } else if (inBar && this.presence.get(id) === 0) {
        // Joining: appear where it will sit and grow in there.
        this.left.set(id, target)
        this.springs.get(`left:${id}`)?.stop()
      }
      if (inBar) {
        this.drive(`left:${id}`, this.left.get(id)!, target, animate, (v) => {
          this.left.set(id, v)
          this.paintItem(id)
        })
      }
      this.drive(`presence:${id}`, this.presence.get(id)!, inBar ? 1 : 0, animate, (v) => {
        this.presence.set(id, v)
        this.paintItem(id)
      })
    }
    if (!this.left.has('pill')) {
      this.left.set('pill', g.pill.left)
      this.pillWidth = g.pill.width
      this.paintPill()
    }
    this.drive('left:pill', this.left.get('pill')!, g.pill.left, animate, (v) => {
      this.left.set('pill', v)
      this.paintPill()
    })
    this.drive('width:pill', this.pillWidth, g.pill.width, animate, (v) => {
      this.pillWidth = v
      this.paintPill()
    })
  }

  stop(): void {
    for (const spring of this.springs.values()) spring.stop()
  }

  /** Bring the value called `name` from `current` to `target`: at once, or on the snappy spring. */
  private drive(
    name: string,
    current: number,
    target: number,
    animate: boolean,
    paint: (value: number) => void
  ): void {
    let spring = this.springs.get(name)
    if (!spring) {
      spring = new SpringAnimation(SPRING_SNAPPY, paint, paint)
      this.springs.set(name, spring)
    }
    if (!animate) {
      spring.stop()
      paint(target)
      return
    }
    if (spring.running) spring.retarget(target)
    else if (current !== target) spring.start(current, 0, target)
  }

  private paintItem(id: PhoneBarItemId): void {
    const el = this.node(id)
    if (!el) return
    const presence = this.presence.get(id) ?? 1
    el.style.transform = `translateX(${(this.left.get(id) ?? 0).toFixed(2)}px) scale(${scaleAt(presence).toFixed(3)})`
    el.style.opacity = presence.toFixed(3)
    el.style.visibility = presence <= 0.001 ? 'hidden' : ''
  }

  private paintPill(): void {
    const el = this.node('pill')
    if (!el) return
    el.style.transform = `translateX(${(this.left.get('pill') ?? 0).toFixed(2)}px)`
    el.style.width = `${Math.max(0, this.pillWidth).toFixed(2)}px`
  }
}
