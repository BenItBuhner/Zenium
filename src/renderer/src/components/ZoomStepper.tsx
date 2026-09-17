import type { JSX } from 'react'
import { Minus, Plus } from 'lucide-react'
import {
  ZOOM_LEVELS,
  ZOOM_MAX,
  ZOOM_MIN,
  formatZoom,
  stepZoom,
  zoomLevelIndex
} from '@shared/pageControls'
import { cn } from '@renderer/lib/utils'
import { Slider } from './ui/slider'

/**
 * Minus, a slider and plus along Chrome's zoom table (50 to 300 percent): the zoom sheet's row
 * and the Accessibility default. The slider's stops are the table's levels, so dragging it lands
 * on the same values the steppers walk; a factor between two levels shows at the nearest one.
 * `stepClassName` and `sliderClassName` let a surface style its own instance (the sheet's v2
 * look) without the other instances following.
 */
export function ZoomStepper({
  value,
  onChange,
  disabled = false,
  className,
  stepClassName,
  sliderClassName
}: {
  value: number
  onChange: (factor: number) => void
  disabled?: boolean
  className?: string
  stepClassName?: string
  sliderClassName?: string
}): JSX.Element {
  const index = zoomLevelIndex(value)
  return (
    <div className={cn('zen-zoom-stepper flex items-center gap-1', className)}>
      <button
        type="button"
        className={cn('zen-toolbar-button shrink-0', stepClassName)}
        aria-label="Zoom out"
        disabled={disabled || value <= ZOOM_MIN}
        onClick={() => onChange(stepZoom(value, -1))}
      >
        <Minus />
      </button>
      <Slider
        className={cn('min-w-0 flex-1', sliderClassName)}
        aria-label="Zoom"
        aria-valuetext={formatZoom(value)}
        min={0}
        max={ZOOM_LEVELS.length - 1}
        step={1}
        value={[index]}
        disabled={disabled}
        onValueChange={([i]) => {
          const level = i === undefined ? undefined : ZOOM_LEVELS[i]
          if (level !== undefined && level !== value) onChange(level)
        }}
      />
      <button
        type="button"
        className={cn('zen-toolbar-button shrink-0', stepClassName)}
        aria-label="Zoom in"
        disabled={disabled || value >= ZOOM_MAX}
        onClick={() => onChange(stepZoom(value, 1))}
      >
        <Plus />
      </button>
    </div>
  )
}
