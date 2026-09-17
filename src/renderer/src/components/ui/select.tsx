import * as React from 'react'
import { Select as SelectPrimitive } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

const Select = SelectPrimitive.Root
const SelectValue = SelectPrimitive.Value

/**
 * The trigger is a fill, not an outlined box: fg 7% at rest, 12% under the pointer, and the
 * accent ring only on keyboard focus. It is as wide as its value, 160 at least; phones size it
 * up through `.zen-select-trigger` in main.css.
 */
const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'zen-select-trigger flex h-7 min-w-40 max-w-full items-center justify-between gap-2 rounded-lg bg-[var(--zen-element-bg)] px-3 text-[13px] text-[var(--zen-fg)] transition-[background-color] duration-[120ms] ease-[var(--zen-ease)] hover:bg-[var(--zen-element-bg-hover)] disabled:opacity-40 [&>span]:truncate',
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = 'SelectTrigger'

/** A menu panel: radius 12 with 6 of padding, so the 6-radius rows inside sit concentrically. */
const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      className={cn(
        'zen-panel zen-select-content zen-animate-pop relative z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl p-1.5 text-[13px]',
        className
      )}
      {...props}
    >
      <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
))
SelectContent.displayName = 'SelectContent'

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'zen-select-item relative flex h-7 cursor-default select-none items-center rounded-md pl-7 pr-2 outline-none data-[highlighted]:bg-[var(--zen-element-bg-hover)] data-[disabled]:opacity-40',
      className
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-3.5 w-3.5" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
))
SelectItem.displayName = 'SelectItem'

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem }
