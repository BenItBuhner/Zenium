import type { JSX } from 'react'
import { useBackSurface } from '@renderer/lib/back'
import { bandStore, chooseBand, dismissBand } from '@renderer/lib/band'
import { useAndroidBand } from '@renderer/lib/band/mount'
import { closeAllPopovers, openPopoverCount } from '@renderer/lib/popoverStore'
import { PageEdgeBand } from './PageEdgeBand'

/**
 * The page-edge band on the touch hosts (motion spec §3.4 Android): the shared content
 * (`PageEdgeBand`, which reads the model's choice itself) at the content frame's top edge, in
 * the chrome's document under the page's WebView – which the Android host moves down by the
 * band's height through the pull channel (`lib/band/androidHost.ts`), so the band shows in the
 * gap the page leaves, as the pull's disc does. The layer has no height of its own: nothing in
 * the chrome's document lays out for the band (§6); the band is absolute at the frame's top.
 *
 * Mounting the layer mounts the Android host and the tenants' door (`lib/band/mount.ts`): the
 * install offer, the reader offer, the connectivity state and the phone's default-browser
 * reminder are the band's while the layer stands, and the banner stack's again when it goes.
 *
 * The band's tenants are unasked offers and notices: the band takes no focus on open (nothing
 * here or in the content moves it; TalkBack hears the title through `role="status"` alone), and
 * the system Back gesture is its Escape (spec §9 item 6) – a standing band is the chrome's
 * topmost back surface and Back puts it away UNANSWERED (`escape`: no cooldown, no campaign
 * dismissal; `lib/band/tenants.ts`). A §9.20 popover over the page is lighter still and goes
 * first, as the plain back chain has it.
 */
export function TouchBandLayer(): JSX.Element | null {
  const host = useAndroidBand()
  const entry = bandStore.use(chooseBand)
  useBackSurface(
    host && entry
      ? {
          name: 'band',
          onCommit: () => {
            if (openPopoverCount() > 0) closeAllPopovers()
            else dismissBand(entry.id, 'escape')
          }
        }
      : null
  )
  if (!host) return null
  return (
    <div className="absolute inset-x-0 top-0 z-[6]" data-touch-band>
      <PageEdgeBand host={host} />
    </div>
  )
}
