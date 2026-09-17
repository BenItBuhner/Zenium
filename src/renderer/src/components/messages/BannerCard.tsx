import type { JSX } from 'react'
import { useLayoutEffect, useRef } from 'react'
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
  const titleRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  // The action and the close centre on the card, unless the text runs past two lines: then they
  // centre on the title (v2 §9.18). Counted from the laid-out heights, again whenever the text
  // reflows; the title's height goes to the stylesheet, which sizes their slot with it.
  useLayoutEffect(() => {
    const card = ref.current
    const title = titleRef.current
    if (!card || !title) return undefined
    const fit = (): void => {
      if (textLines(title) + textLines(detailRef.current) > 2) card.dataset.wrapped = ''
      else delete card.dataset.wrapped
      card.style.setProperty('--zen-banner-title-height', `${title.offsetHeight}px`)
      onMeasure(banner.id, card.offsetHeight)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(title)
    if (detailRef.current) observer.observe(detailRef.current)
    return () => observer.disconnect()
  }, [ref, banner.id, banner.title, banner.detail, onMeasure])

  const Icon = banner.icon
  return (
    <div
      ref={(el) => {
        ref.current = el
        if (el) onMeasure(banner.id, el.offsetHeight)
      }}
      className="zen-message zen-banner"
      data-glyph={Icon ? '' : undefined}
      role="status"
      {...handlers}
    >
      <div className="zen-message-text">
        <div ref={titleRef} className="zen-banner-title">
          {Icon && <Icon className="zen-message-glyph" aria-hidden />}
          <span>{banner.title}</span>
        </div>
        {banner.detail && (
          <div ref={detailRef} className="zen-banner-detail">
            {banner.detail}
          </div>
        )}
      </div>
      <div className="zen-message-trailing">
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
    </div>
  )
}

/** How many lines a block of text is laid out on: its height against its line-height. */
function textLines(el: HTMLElement | null): number {
  if (!el) return 0
  const style = getComputedStyle(el)
  const line = parseFloat(style.lineHeight)
  const text = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  return line > 0 ? Math.max(1, Math.round(text / line)) : 1
}
