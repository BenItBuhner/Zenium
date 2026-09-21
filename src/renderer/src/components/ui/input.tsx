import * as React from 'react'
import { cn } from '@renderer/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string
}

/**
 * The text field as a component: behaviour only (design language v2 §9.34). Its look is the
 * shared `.zen-v2-field` rule in main.css – the control height, a hairline, the page behind it,
 * the accent border on focus, `aria-invalid` in the danger ink, `.4` when disabled – so nothing
 * here sizes or colours it; a `className` may place the field, not restyle it.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref
) {
  return <input ref={ref} className={cn('zen-v2-field', className)} {...props} />
})

export { Input }
