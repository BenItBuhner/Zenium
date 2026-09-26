import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>

/**
 * The accessible slider is Radix's thumb (`role="slider"`, the value in `aria-valuenow`), not
 * the root – a plain box that draws the track – so the name and the spoken value go to the thumb
 * (A11Y-01: an unnamed slider is "slider" and a number to TalkBack), and so does the disabled
 * state: Radix puts `aria-disabled` on the root alone and leaves the thumb only unfocusable, so
 * a held slider (a setting an extension controls, §10.5) would read as one that still moves.
 * The thumb's 16 box is the design's; a press anywhere on the root's 44 row moves it, which is
 * the finger's target.
 *
 * `onValueCommit` receives the value `onValueChange` last reported, and a change is always
 * reported before its commit. Radix (react-slider 1.4.7) commits the value it last *rendered*:
 * `handleSlideEnd` reads `values` from the render closure while every pointer move goes through
 * `setValues(prev => …)`, and a move is a continuous update React may not have drawn when the
 * pointer lifts (a slow renderer holds a frame of moves back). So the commit lands short of
 * where the pointer let go, and when the only move of the slide is the undrawn one Radix's
 * "has it changed" check fails and it commits nothing at all. Keyboard steps commit from the
 * updater and are right, but commit first and report their change after. Here: the value
 * reported during a slide is kept and handed to the consumer's commit in place of Radix's; when
 * Radix is about to skip its commit – its check compares the rendered value with the one at
 * pointerdown, both known here – the release commits from the wrapper, once (`lostpointercapture`
 * settles a slide the browser ended some other way); a key's step is reported as a change before
 * its commit, and Radix's own report of it after is swallowed. Radix is always given `value`:
 * for a controlled slider its change reports are synchronous with the pointer, where an
 * uncontrolled one reports after the render, so `defaultValue` is held here.
 */
const Slider = React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
  (
    {
      className,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabelledBy,
      'aria-valuetext': ariaValueText,
      value: valueProp,
      defaultValue,
      min = 0,
      onValueChange,
      onValueCommit,
      onPointerDown,
      onPointerUp,
      onLostPointerCapture,
      ...props
    },
    ref
  ) => {
    const [own, setOwn] = React.useState<number[]>(() => defaultValue ?? [min])
    const value = valueProp ?? own
    /** A pointer is down on the slider: the values reported until it lifts are one slide. */
    const sliding = React.useRef(false)
    /** The value drawn when the pointer went down – what Radix's own commit compares against. */
    const atDown = React.useRef<string | null>(null)
    /** The value last reported during this slide, no commit for it yet. */
    const owed = React.useRef<number[] | null>(null)
    /** A key's step reported here before its commit: Radix's report of it after is no news. */
    const announced = React.useRef<string | null>(null)

    const report = (next: number[]): void => {
      if (valueProp === undefined) setOwn(next)
      onValueChange?.(next)
    }
    const change = (next: number[]): void => {
      if (announced.current !== null && String(next) === announced.current) {
        announced.current = null
        return
      }
      announced.current = null
      if (sliding.current) owed.current = next
      report(next)
    }
    const commit = (next: number[]): void => {
      if (sliding.current) {
        // Radix's slide end: it commits what it drew, the consumer gets what it was told.
        const latest = owed.current ?? next
        owed.current = null
        sliding.current = false
        onValueCommit?.(latest)
        return
      }
      announced.current = String(next)
      report(next)
      onValueCommit?.(next)
    }
    /** The slide is over: what was reported and never committed is committed now. */
    const settle = (): void => {
      const latest = owed.current
      owed.current = null
      sliding.current = false
      if (latest !== null && String(latest) !== atDown.current) onValueCommit?.(latest)
    }

    return (
      <SliderPrimitive.Root
        ref={ref}
        className={cn('relative flex w-full touch-none select-none items-center', className)}
        min={min}
        value={value}
        onValueChange={change}
        onValueCommit={commit}
        onPointerDown={(event) => {
          onPointerDown?.(event)
          if (event.defaultPrevented) return
          sliding.current = true
          atDown.current = String(value)
          owed.current = null
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event)
          // Radix's handler runs after this one and commits only when the drawn value differs
          // from the one at pointerdown; when it will not, the release commits here.
          if (sliding.current && String(value) === atDown.current) settle()
        }}
        onLostPointerCapture={(event) => {
          onLostPointerCapture?.(event)
          settle()
        }}
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
          aria-disabled={props.disabled || undefined}
        />
      </SliderPrimitive.Root>
    )
  }
)
Slider.displayName = 'Slider'

export { Slider }
