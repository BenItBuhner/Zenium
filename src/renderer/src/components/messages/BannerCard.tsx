import type { JSX } from 'react'
import { X } from 'lucide-react'
import type { DismissDirections } from '@renderer/lib/gestures/dismiss'
import {
  dismissBanner,
  forgetBanner,
  holdBanner,
  pickBannerAction,
  type Banner
} from '@renderer/lib/ui'
import { useMessageMotion } from './useMessageMotion'

/** A banner goes back up under the toolbar, or off to either side. */
const BANNER_DIRS: DismissDirections = { x: [-1, 1], y: [-1] }

interface Props {
  banner: Banner
  /** Where the card rests, from the top of the stack (newer banners push older ones down). */
  slot: number
  onMeasure: (id: number, height: number) => void
}

/**
 * One top banner: glyph, title and detail, its one action and a close button, on the shared
 * message motion. It drops from under the toolbar and goes back up (or sideways) when swiped,
 * closed, timed out or replaced.
 */
export function BannerCard({ banner, slot, onMeasure }: Props): JSX.Element {
  const { ref, handlers } = useMessageMotion({
    home: -1,
    slot,
    dirs: BANNER_DIRS,
    leaving: Boolean(banner.leaving),
    onHold: (held) => holdBanner(banner.id, held),
    onSwipe: () => dismissBanner(banner.id, 'swipe'),
    onGone: () => forgetBanner(banner.id)
  })
  const Icon = banner.icon
  return (
    <div
      ref={(el) => {
        ref.current = el
        if (el) onMeasure(banner.id, el.offsetHeight)
      }}
      className="zen-message zen-banner"
      role="status"
      {...handlers}
    >
      {Icon && <Icon className="zen-message-glyph" aria-hidden />}
      <div className="zen-message-text">
        <div className="zen-banner-title">{banner.title}</div>
        {banner.detail && <div className="zen-banner-detail">{banner.detail}</div>}
      </div>
      {banner.action && (
        <button
          type="button"
          className="zen-message-button"
          onClick={() => pickBannerAction(banner.id)}
        >
          {banner.action.label}
        </button>
      )}
      <button
        type="button"
        className="zen-toolbar-button zen-message-close"
        aria-label="Dismiss"
        onClick={() => dismissBanner(banner.id, 'close')}
      >
        <X aria-hidden />
      </button>
    </div>
  )
}
