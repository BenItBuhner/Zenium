import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { cn } from '@renderer/lib/utils'

/** Thumb travel inside the 44 x 26 track: a 22 thumb, inset 2 at either end (`.zen-switch`). */
const THUMB_OFF_X = 2
const THUMB_ON_X = 20

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>

/**
 * A toggle whose thumb rides a spring rather than a CSS transition: flipping it back mid-flight
 * turns the thumb around from its live position and velocity instead of snapping.
 */
const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  ({ className, checked, defaultChecked, onCheckedChange, ...props }, ref) => {
    const [uncontrolled, setUncontrolled] = React.useState(Boolean(defaultChecked))
    const isChecked = checked ?? uncontrolled
    const thumbRef = React.useRef<HTMLSpanElement>(null)
    const springRef = React.useRef<SpringAnimation | null>(null)
    // Where the thumb rests, or is heading. The spring only exists once the state has changed,
    // so a switch that mounts checked sits there rather than sliding in.
    const restRef = React.useRef(isChecked ? THUMB_ON_X : THUMB_OFF_X)
    const initialX = React.useRef(restRef.current).current

    React.useEffect(() => {
      const target = isChecked ? THUMB_ON_X : THUMB_OFF_X
      if (target === restRef.current) return
      const thumb = thumbRef.current
      if (!thumb) return
      let spring = springRef.current
      if (!spring) {
        spring = new SpringAnimation(
          SPRING_SNAPPY,
          (x) => {
            thumb.style.transform = `translateX(${x}px)`
          },
          () => {}
        )
        springRef.current = spring
      }
      if (spring.running) spring.retarget(target)
      else spring.start(restRef.current, 0, target)
      restRef.current = target
    }, [isChecked])

    React.useEffect(
      () => () => {
        springRef.current?.stop()
      },
      []
    )

    return (
      <SwitchPrimitive.Root
        ref={ref}
        className={cn('zen-switch', className)}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={(next) => {
          if (checked === undefined) setUncontrolled(next)
          onCheckedChange?.(next)
        }}
        {...props}
      >
        <SwitchPrimitive.Thumb
          ref={thumbRef}
          className="zen-switch-thumb"
          style={{ transform: `translateX(${initialX}px)` }}
        />
      </SwitchPrimitive.Root>
    )
  }
)
Switch.displayName = 'Switch'

export { Switch }
