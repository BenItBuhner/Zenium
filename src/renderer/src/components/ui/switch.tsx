import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

/**
 * The switch as a component: Radix for the behaviour (`role="switch"`, `aria-checked`, Space
 * and Enter, `disabled`), the shared `.zen-v2-switch` rule in main.css for the look (design
 * language v2 §9.34, §10.4: the 36 × 20 track, the thumb its `::after`, the accent when on,
 * `.4` when disabled). No thumb element and no utilities: the class is the whole drawing.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root ref={ref} className={cn('zen-v2-switch', className)} {...props} />
))
Switch.displayName = 'Switch'

export { Switch }
