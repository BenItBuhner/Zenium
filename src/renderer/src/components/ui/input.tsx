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
        'flex h-8 w-full rounded-lg border border-[var(--zen-border)] bg-[var(--zen-element-bg)] px-2.5 text-[13px] text-[var(--zen-fg)] outline-none placeholder:text-[var(--zen-muted)] focus-visible:border-[var(--zen-accent)] focus-visible:ring-2 focus-visible:ring-[var(--zen-accent)]/30 disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
})

export { Input }
