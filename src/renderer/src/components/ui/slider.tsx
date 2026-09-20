import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

/**
 * The accessible slider is Radix's thumb (`role="slider"`, the value in `aria-valuenow`), not
 * the root – a plain box that draws the track – so the name and the spoken value go to the thumb
 * (A11Y-01: an unnamed slider is "slider" and a number to TalkBack). The thumb's 16 box is the
 * design's; a press anywhere on the root's 44 row moves it, which is the finger's target.
 */
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(
  (
    {
      className,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabelledBy,
      'aria-valuetext': ariaValueText,
      ...props
    },
    ref
  ) => (
    <SliderPrimitive.Root
      ref={ref}
      className={cn('relative flex w-full touch-none select-none items-center', className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-[var(--zen-element-bg-active)]">
        <SliderPrimitive.Range className="absolute h-full bg-[var(--zen-accent)]" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className="block h-4 w-4 rounded-full border border-black/10 bg-white shadow transition-transform focus-visible:outline-offset-2 active:scale-110"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-valuetext={ariaValueText}
      />
    </SliderPrimitive.Root>
  )
)
Slider.displayName = 'Slider'

export { Slider }
