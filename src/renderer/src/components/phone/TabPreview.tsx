import type { CSSProperties, JSX } from 'react'
import { isChromePageUrl } from '@shared/internalPages'
import type { Tab } from '@shared/types'
import { getHost, isEmptyTabUrl } from '@shared/url'
import { tabTitle } from '@renderer/lib/selectors'
import { useThumbnail } from '@renderer/lib/thumbnails'
import { cn } from '@renderer/lib/utils'
import { CoverImage } from '../content/CoverImage'
import { SettingsPreview } from '../pages/settings/SettingsPreview'
import { Favicon } from '../sidebar/Favicon'

interface Props {
  tab: Tab
  /** Scale of the placeholder typography (1 = a full-size page). */
  scale?: number
  /**
   * This card stands in for the live page (the hero of the overview, the current tab's card in
   * a switch): the page is kept until the card's picture is painted (see `lib/cover.ts`).
   */
  cover?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * What a tab looks like when its live page is not available to draw: the last picture the host
 * has of it (`lib/thumbnails.ts`: the card picture it keeps across restarts, or the full cover
 * the chrome captured), or – for pages it has none of – a quiet placeholder page carrying the
 * tab's identity.
 */
export function TabPreview({
  tab,
  scale = 1,
  cover = false,
  className,
  style
}: Props): JSX.Element {
  const thumbnail = useThumbnail(tab.id, cover)
  // A chrome page is never captured: its card shows the page drawn small (v2 §10.1).
  if (isChromePageUrl(tab.url)) {
    return (
      <div className={cn('h-full w-full', className)} style={style}>
        <SettingsPreview />
      </div>
    )
  }
  if (thumbnail) {
    return (
      <CoverImage
        tabId={tab.id}
        src={thumbnail}
        cover={cover}
        className={cn('block h-full w-full object-cover object-top', className)}
        style={style}
      />
    )
  }
  const host = getHost(tab.url).replace(/^www\./, '')
  const blank = isEmptyTabUrl(tab.url)
  return (
    <div
      className={cn(
        'zen-tab-placeholder flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center',
        className
      )}
      style={style}
    >
      <Favicon tab={tab} size={Math.round(36 * scale)} />
      <div className="flex min-w-0 max-w-full flex-col items-center gap-1">
        <span
          className="max-w-full truncate font-semibold"
          style={{ fontSize: Math.round(15 * scale) }}
        >
          {blank ? 'New Tab' : tabTitle(tab) || host}
        </span>
        {!blank && host && (
          <span
            className="max-w-full truncate text-[var(--zen-muted)]"
            style={{ fontSize: Math.round(12 * scale) }}
          >
            {host}
          </span>
        )}
      </div>
    </div>
  )
}
