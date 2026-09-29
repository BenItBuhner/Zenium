import type { JSX } from 'react'
import { useState } from 'react'
import { Globe } from 'lucide-react'
import { useFaviconSrc } from '@renderer/lib/favicons'
import { cn } from '@renderer/lib/utils'

/**
 * A new tab page tile's icon (§9.29; the type and ink are the shared `zen-ntp-*` rules', the
 * desktop document's too): the site's icon at the layout's size – the phone page's 24, the
 * large layouts' 32 – fading in once it has loaded; a letter in the deemphasised ink when the
 * site has none (or it failed), and the globe when there is no letter to show either. The icon
 * is the core's cached copy where it holds one (HB-47); a tile asks the network for an uncached
 * icon only while its site is open in a tab, and is its letter otherwise – the new tab page
 * makes no request to every top site each time it opens. The omnibox's tile row (OMN-04) draws
 * the same icon in the same tile.
 */
export function TileIcon({
  favicon,
  url,
  label,
  size = 24
}: {
  favicon: string | null
  url: string
  label: string
  /** The icon's square: the phone page's 24, the tablet's and the desktop document's 32. */
  size?: 24 | 32
}): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [broken, setBroken] = useState<string | null>(null)
  const resolved = useFaviconSrc(favicon, url)
  const src = resolved && broken !== resolved ? resolved : null
  const box = size === 32 ? 'h-8 w-8' : 'h-6 w-6'
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
        className={cn('zen-ntp-icon', box, 'object-contain', loaded && 'zen-ntp-icon-loaded')}
        onLoad={() => setLoaded(true)}
        onError={() => setBroken(src)}
      />
    )
  }
  const letter = label.trim().charAt(0).toUpperCase()
  if (!letter) return <Globe className={box} strokeWidth={1.5} />
  return (
    <span className={cn('zen-ntp-letter flex', box, 'items-center justify-center')} aria-hidden>
      {letter}
    </span>
  )
}
