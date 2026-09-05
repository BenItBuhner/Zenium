import type { JSX } from 'react'
import { useState } from 'react'
import { Globe } from 'lucide-react'
import type { Tab } from '@shared/types'
import { cn } from '@renderer/lib/utils'

/** Favicon with graceful fallback (globe) and Zen's loading spinner. */
export function Favicon({
  tab,
  size = 16,
  className
}: {
  tab: Tab
  size?: number
  className?: string
}): JSX.Element {
  const [broken, setBroken] = useState<string | null>(null)
  const src = tab.favicon && broken !== tab.favicon ? tab.favicon : null
  if (tab.loading && !tab.discarded) {
    return (
      <span
        className={cn(
          'zen-tab-favicon inline-block shrink-0 rounded-full border-2 border-[var(--zen-muted)] border-t-transparent zen-spin',
          className
        )}
        style={{ width: size, height: size }}
        aria-label="Loading"
      />
    )
  }
  if (!src) {
    return (
      <Globe
        className={cn('zen-tab-favicon shrink-0 opacity-60', className)}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      draggable={false}
      referrerPolicy="no-referrer"
      onError={() => setBroken(src)}
      className={cn('zen-tab-favicon shrink-0 rounded-[3px] object-contain', className)}
      style={{ width: size, height: size }}
    />
  )
}
