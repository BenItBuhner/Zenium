import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { cn } from '@renderer/lib/utils'
import { switchThumbX } from './switchThumb'

/**
 * Moves the thumb on `SPRING_SNAPPY` whenever the track's `data-state` changes. A toggle caught
 * mid-flight retargets from its live position and velocity instead of snapping; reduced motion
 * jumps (the spring handles it). The initial position is placed without animating. Returns the
 * teardown, the way a React 19 ref callback does.
 */
function attachThumbSpring(root: HTMLElement): () => void {
  const thumb = root.querySelector<HTMLElement>('.zen-switch-thumb')
  if (!thumb) return () => {}
  let x = switchThumbX(root.dataset.state === 'checked')
  const place = (next: number): void => {
    x = next
    thumb.style.transform = `translateX(${next}px)`
  }
  const spring = new SpringAnimation(SPRING_SNAPPY, place, () => {
    thumb.style.willChange = ''
  })
  place(x)
  const observer = new MutationObserver(() => {
    const to = switchThumbX(root.dataset.state === 'checked')
    if (to === x && !spring.running) return
    thumb.style.willChange = 'transform'
    if (spring.running) spring.retarget(to)
    else spring.start(x, 0, to)
  })
  observer.observe(root, { attributes: true, attributeFilter: ['data-state'] })
  return () => {
    observer.disconnect()
    spring.stop()
  }
}

/** 44 × 26 pill track, 22 thumb; off is the ink at 16%, on the accent fill (styles in main.css). */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, forwardedRef) => {
  const ref = React.useCallback(
    (node: HTMLButtonElement | null) => {
      if (!node) return
      const detach = attachThumbSpring(node)
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
      return () => {
        detach()
        if (typeof forwardedRef === 'function') forwardedRef(null)
        else if (forwardedRef) forwardedRef.current = null
      }
    },
    [forwardedRef]
  )
  return (
    <SwitchPrimitive.Root ref={ref} className={cn('zen-switch', className)} {...props}>
      <SwitchPrimitive.Thumb className="zen-switch-thumb" />
    </SwitchPrimitive.Root>
  )
})
Switch.displayName = 'Switch'

export { Switch }
