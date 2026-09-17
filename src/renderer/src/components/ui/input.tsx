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
        'zen-input flex h-7 w-full rounded-lg bg-[var(--zen-element-bg)] px-3 text-[13px] text-[var(--zen-fg)] outline-none placeholder:text-[var(--zen-faint)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--zen-accent)] disabled:opacity-40',
        className
      )}
      {...props}
    />
  )
})

export { Input }
