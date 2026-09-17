import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

/** Track in the ink at 16%, range in the accent fill, a 16 white thumb like the toggle's. */
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center', className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[rgb(var(--zen-fg-rgb)/0.16)]">
      <SliderPrimitive.Range className="absolute h-full bg-[var(--zen-accent-fill)]" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] outline-none transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--zen-accent)] active:scale-110" />
  </SliderPrimitive.Root>
))
Slider.displayName = 'Slider'

export { Slider }
