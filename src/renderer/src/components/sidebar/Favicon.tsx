import { useState, type JSX } from 'react'
import { Globe } from 'lucide-react'
import type { Tab } from '@shared/types'
import { BLANK_URL, getHost } from '@shared/url'
import { cn } from '@renderer/lib/utils'

/**
 * Favicon with graceful fallbacks: Zen's loading spinner while loading, a letter tile for
 * pages that never provided an icon (e.g. unloaded Essentials), and a globe for blank tabs.
 */
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
    const host = getHost(tab.url).replace(/^www\./, '')
    const letter = (tab.customTitle ?? (host || tab.title)).trim().charAt(0).toUpperCase()
    if (!letter || tab.url === BLANK_URL || tab.url.startsWith('zen://')) {
      return (
        <Globe
          className={cn('zen-tab-favicon shrink-0 opacity-60', className)}
          style={{ width: size, height: size }}
        />
      )
    }
    return (
      <span
        className={cn(
          'zen-tab-favicon inline-flex shrink-0 items-center justify-center rounded-[4px] bg-[var(--zen-element-bg-active)] font-semibold leading-none',
          className
        )}
        style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.55)) }}
        aria-hidden
      >
        {letter}
      </span>
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
