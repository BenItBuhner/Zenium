import * as React from 'react'
import { Select as SelectPrimitive } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

const Select = SelectPrimitive.Root
const SelectValue = SelectPrimitive.Value

/** A quiet control: a fill of the ink sized by its content, no border; styles in main.css. */
const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger ref={ref} className={cn('zen-select-trigger', className)} {...props}>
    <span className="zen-select-value">{children}</span>
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="zen-select-icon" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = 'SelectTrigger'

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={4}
      className={cn(
        'zen-panel zen-select-content zen-animate-pop relative z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden',
        className
      )}
      {...props}
    >
      <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
))
SelectContent.displayName = 'SelectContent'

/** A menu row; the chosen one reads heavier and carries a check in the accent ink at its end. */
const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item ref={ref} className={cn('zen-select-item', className)} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator asChild>
      <Check className="zen-select-check" />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
))
SelectItem.displayName = 'SelectItem'

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem }
