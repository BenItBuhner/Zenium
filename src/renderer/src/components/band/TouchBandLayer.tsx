import type { JSX } from 'react'
import { bandStore, chooseBand } from '@renderer/lib/band'
import { useAndroidBand } from '@renderer/lib/band/mount'
import { PageEdgeBand } from './PageEdgeBand'

/**
 * The page-edge band on the touch hosts (motion spec §3.4 Android): the shared content
 * (`PageEdgeBand`) at the content frame's top edge, in the chrome's document under the page's
 * WebView – which the Android host moves down by the band's height through the pull channel
 * (`lib/band/androidHost.ts`), so the band shows in the gap the page leaves, as the pull's disc
 * does. The layer has no height of its own: nothing in the chrome's document lays out for the
 * band (§6); the band is absolute at the frame's top.
 *
 * Mounting the layer mounts the Android host and the tenants' door (`lib/band/mount.ts`): the
 * install offer, the reader offer, the connectivity state and the phone's default-browser
 * reminder are the band's while the layer stands, and the banner stack's again when it goes.
 */
export function TouchBandLayer(): JSX.Element | null {
  const host = useAndroidBand()
  const entry = bandStore.use(chooseBand)
  if (!host) return null
  return (
    <div className="absolute inset-x-0 top-0 z-[6]" data-touch-band>
      <PageEdgeBand entry={entry} host={host} />
    </div>
  )
}
