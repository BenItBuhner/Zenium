import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center', className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[var(--zen-element-bg-active)]">
      <SliderPrimitive.Range className="absolute h-full bg-[var(--zen-accent)]" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-black/10 bg-white shadow outline-none transition-transform focus-visible:ring-2 focus-visible:ring-[var(--zen-accent)]/40 active:scale-110" />
  </SliderPrimitive.Root>
))
Slider.displayName = 'Slider'

export { Slider }
