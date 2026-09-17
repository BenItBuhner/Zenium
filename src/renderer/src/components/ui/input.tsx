import * as React from 'react'
import { cn } from '@renderer/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string
}

/** A quiet field: a fill of the ink, no border, the focus ring its only line (styles in main.css). */
const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref
) {
  return <input ref={ref} className={cn('zen-input', className)} {...props} />
})

export { Input }
