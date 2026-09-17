import * as React from 'react'
import { Slot } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

/**
 * Buttons (design-language.md §8.3). `secondary` is the default look – the ink fill at 500;
 * `default` is the one primary per view – the accent fill at 600; `destructive` keeps the quiet
 * fill and takes the danger ink; `outline` has no line to draw and is the quiet fill too. The
 * styles live under `.zen-button[data-variant][data-size]` in main.css.
 */
export type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'outline' | 'destructive'
export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon'

const VARIANT_ATTR: Record<ButtonVariant, 'primary' | 'quiet' | 'ghost' | 'danger'> = {
  default: 'primary',
  secondary: 'quiet',
  outline: 'quiet',
  ghost: 'ghost',
  destructive: 'danger'
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | null
  size?: ButtonSize | null
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = 'button', ...props }, ref) => {
    const Comp = asChild ? Slot.Root : 'button'
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : type}
        className={cn('zen-button', className)}
        data-variant={VARIANT_ATTR[variant ?? 'default']}
        data-size={size ?? 'default'}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button }
