import * as React from 'react'
import { cn } from '@renderer/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref
) {
  return (
    <input
      ref={ref}
      className={cn(
        'zen-control zen-input zen-wide-control flex h-7 w-full rounded-lg bg-[var(--zen-element-bg)] px-2.5 text-[13px] text-[var(--zen-fg)] outline-none placeholder:text-[var(--zen-faint)] disabled:opacity-30',
        className
      )}
      {...props}
    />
  )
})

export { Input }
