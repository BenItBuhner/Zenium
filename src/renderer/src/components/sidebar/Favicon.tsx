import { useState, type JSX } from 'react'
import { Frown, Globe, VenetianMask } from 'lucide-react'
import { internalPageOf } from '@shared/internalPages'
import type { Tab } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { getHost, isEmptyTabUrl } from '@shared/url'
import { CRASH_ERROR_CODE } from '@shared/zenPages'
import { useExtensionPage } from '@renderer/lib/extensions/pages'
import { PAGE_GLYPHS } from '@renderer/lib/pageGlyphs'
import { cn } from '@renderer/lib/utils'
import { ExtensionIcon } from '../extensions/ExtensionIcon'

/**
 * Favicon with graceful fallbacks: a user-picked emoji ("Change Icon…"), Zen's loading spinner
 * while loading, a letter tile for pages that never provided an icon (e.g. unloaded Essentials),
 * a globe for blank tabs, and an internal page's registered glyph (the gear for Settings) for a
 * page tab, which never fetches an icon (v2 §10.1); a page with no glyph falls through. A page
 * of an extension that supplies no favicon of its own shows the extension's icon (the puzzle
 * glyph while it has none), never a letter of its id (§10.1 applied to extension pages). A tab
 * whose renderer crashed in front of the user (`errorCode` is the crash code, tabs-44) shows
 * Chrome's crashed favicon, a sad face in the muted ink, until its next load.
 *
 * The spinner is Chrome's two-phase throbber (tabs-41) on one 2 px ring: muted and turning
 * backwards while the load waits for the server's first response (`waiting`), the accent
 * colour turning forwards once the document is coming in; the icon that then takes its place
 * fades back in over 150 ms. An icon that never spun draws at once.
 */
/** What the favicon is drawn from: a tab, or a row that carries the same fields (tab search). */
export type FaviconSource = Pick<
  Tab,
  | 'url'
  | 'title'
  | 'favicon'
  | 'customIcon'
  | 'customTitle'
  | 'loading'
  | 'discarded'
  | 'containerId'
> &
  Partial<Pick<Tab, 'errorCode' | 'waiting'>>

/**
 * Whether this slot has shown the throbber, so the icon replacing it fades back in (tabs-41).
 * State carried from earlier renders, set the moment a load is seen (the React pattern for
 * remembering a previous render's props).
 */
function useSpun(loading: boolean): boolean {
  const [spun, setSpun] = useState(loading)
  if (loading && !spun) setSpun(true)
  return spun
}

export function Favicon({
  tab,
  size = 16,
  className
}: {
  tab: FaviconSource
  size?: number
  className?: string
}): JSX.Element {
  const [broken, setBroken] = useState<string | null>(null)
  const src = tab.favicon && broken !== tab.favicon ? tab.favicon : null
  const extension = useExtensionPage(tab.url)
  const glyph = internalPageOf(tab.url)?.glyph
  const loading = tab.loading && !tab.discarded
  // The class of the icon standing where the throbber was: it fades back in.
  const back = useSpun(loading) && !loading ? 'zen-tab-favicon-in' : undefined
  if (glyph) {
    const Glyph = PAGE_GLYPHS[glyph]
    return (
      <Glyph
        className={cn('zen-tab-favicon shrink-0', className)}
        style={{ width: size, height: size }}
        strokeWidth={size >= 20 ? 1.75 : 2}
        aria-hidden
      />
    )
  }
  if (tab.customIcon) {
    return (
      <span
        className={cn(
          'zen-tab-favicon inline-flex shrink-0 items-center justify-center leading-none',
          className
        )}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.85) }}
        aria-hidden
      >
        {tab.customIcon}
      </span>
    )
  }
  if (loading) {
    // Keyed so the ring is never the icon's own node re-dressed (a letter tile is a span too):
    // its colours start final instead of easing in from the tile's border, and the icon that
    // follows is inserted afresh, which is what its fade-in listens for.
    return (
      <span
        key="throbber"
        className={cn(
          'zen-tab-favicon zen-tab-throbber inline-block shrink-0 rounded-full border-2',
          className
        )}
        style={{ width: size, height: size }}
        data-phase={tab.waiting ? 'waiting' : 'loading'}
        role="img"
        aria-label="Loading"
      />
    )
  }
  if (tab.errorCode === CRASH_ERROR_CODE && !tab.discarded) {
    return (
      <Frown
        className={cn(
          'zen-tab-favicon zen-tab-favicon-crashed shrink-0 text-[var(--zen-muted)]',
          back,
          className
        )}
        style={{ width: size, height: size }}
        strokeWidth={size >= 20 ? 1.75 : 2}
        aria-label="Crashed"
        role="img"
      />
    )
  }
  if (!src) {
    if (extension) {
      return (
        <ExtensionIcon
          icon={extension.icon}
          size={size}
          box={size}
          className={cn('zen-tab-favicon', back, className)}
        />
      )
    }
    const host = getHost(tab.url).replace(/^www\./, '')
    const letter = (tab.customTitle ?? (host || tab.title)).trim().charAt(0).toUpperCase()
    if (!letter || isEmptyTabUrl(tab.url) || tab.url.startsWith('zen://')) {
      // The private marker (v2 §9.19): the mask glyph while the private tab has no page, at the
      // row stroke when drawn at the phone's 20.
      const Icon =
        tab.containerId === PRIVATE_CONTAINER_ID && isEmptyTabUrl(tab.url) ? VenetianMask : Globe
      return (
        <Icon
          className={cn('zen-tab-favicon shrink-0 opacity-60', back, className)}
          style={{ width: size, height: size }}
          strokeWidth={size >= 20 ? 1.75 : 2}
        />
      )
    }
    return (
      <span
        className={cn(
          'zen-tab-favicon zen-squircle inline-flex shrink-0 items-center justify-center rounded-[5px] bg-[var(--zen-element-bg-active)] font-semibold leading-none',
          back,
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
      className={cn('zen-tab-favicon shrink-0 rounded-[4px] object-contain', back, className)}
      style={{ width: size, height: size }}
    />
  )
}
