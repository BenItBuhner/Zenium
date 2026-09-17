import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/lib/utils'
import { useEscapeTrap } from './escape'

/** In-place title editor: Enter or blur commits, Escape restores the old title. */
export function RenameField({
  title,
  onDone,
  className
}: {
  title: string
  onDone: (title: string) => void
  className?: string
}): JSX.Element {
  const [value, setValue] = useState(title)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const finish = (next: string): void => {
    if (done.current) return
    done.current = true
    onDone(next)
  }
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  useEscapeTrap(true, () => finish(title))
  return (
    <input
      ref={ref}
      className={cn(
        'h-6 min-w-0 flex-1 rounded-md bg-[var(--zen-element-bg)] px-1.5 text-[13px] text-[var(--zen-fg)] outline-none ring-1 ring-[var(--zen-accent)]/60',
        className
      )}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value.trim())}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(value.trim())
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(title)
        }
      }}
    />
  )
}
