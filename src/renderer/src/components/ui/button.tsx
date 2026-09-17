import * as React from 'react'
import { Slot } from 'radix-ui'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

/**
 * Zen's buttons (design language §8.3): a fill of the ink, or the accent for the one primary
 * action of a view; never an outline. Press shrinks to .98 and the fill answers in 120ms.
 */
const buttonVariants = cva(
  'zen-control zen-button zen-press inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[13px] font-medium disabled:pointer-events-none disabled:opacity-30 outline-none [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--zen-accent-fill)] font-semibold text-[var(--zen-on-accent)] hover:brightness-110',
        secondary: 'bg-[var(--zen-element-bg)] hover:bg-[var(--zen-element-bg-hover)]',
        ghost: 'hover:bg-[var(--zen-element-bg)]',
        outline: 'bg-[var(--zen-element-bg)] hover:bg-[var(--zen-element-bg-hover)]',
        destructive:
          'bg-[var(--zen-element-bg)] text-[var(--zen-danger)] hover:bg-[var(--zen-element-bg-hover)]'
      },
      size: {
        default: 'h-8 px-4',
        sm: 'h-7 px-3 text-[12.5px]',
        lg: 'h-10 px-5 text-sm',
        icon: 'zen-icon-button h-7 w-7 rounded-full'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = 'button', ...props }, ref) => {
    const Comp = asChild ? Slot.Root : 'button'
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : type}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

// eslint-disable-next-line react-refresh/only-export-components -- shadcn exports the variants helper alongside the component
export { Button, buttonVariants }
