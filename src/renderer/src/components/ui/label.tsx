import * as React from 'react'
import { cn } from '@renderer/lib/utils'

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  className?: string
}

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { className, ...props },
  ref
) {
  return (
    <label ref={ref} className={cn('text-[13px] font-medium leading-none', className)} {...props} />
  )
})

export { Label }
