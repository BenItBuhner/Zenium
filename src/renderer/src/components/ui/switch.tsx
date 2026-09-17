import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { cn } from '@renderer/lib/utils'

/** Track 44×26, thumb 22 with a 2px inset: the thumb travels from 2 to 20. */
const THUMB_OFF = 2
const THUMB_ON = 20

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>

/**
 * Zen's toggle: a pill track that fills with the accent when on, and a thumb that settles on a
 * snappy spring so a quick double toggle carries its momentum instead of restarting.
 */
const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  ({ className, checked, defaultChecked, onCheckedChange, ...props }, ref) => {
    const [inner, setInner] = React.useState(Boolean(defaultChecked))
    const on = checked ?? inner
    const thumb = React.useRef<HTMLSpanElement>(null)
    const spring = React.useRef<SpringAnimation | null>(null)
    const x = React.useRef<number | null>(null)

    React.useEffect(() => {
      const el = thumb.current
      if (!el) return
      const target = on ? THUMB_ON : THUMB_OFF
      const place = (v: number): void => {
        x.current = v
        el.style.transform = `translateX(${v}px)`
      }
      if (x.current === null) {
        place(target)
        return
      }
      if (!spring.current) spring.current = new SpringAnimation(SPRING_SNAPPY, place, place)
      const anim = spring.current
      if (anim.running) anim.retarget(target)
      else anim.start(x.current, 0, target)
    }, [on])
    React.useEffect(
      () => () => {
        spring.current?.stop()
      },
      []
    )

    return (
      <SwitchPrimitive.Root
        ref={ref}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={(v) => {
          setInner(v)
          onCheckedChange?.(v)
        }}
        className={cn('zen-switch peer relative inline-flex h-[26px] w-11 shrink-0', className)}
        {...props}
      >
        <span
          ref={thumb}
          className="zen-switch-thumb pointer-events-none absolute left-0 top-0.5"
        />
      </SwitchPrimitive.Root>
    )
  }
)
Switch.displayName = 'Switch'

export { Switch }
