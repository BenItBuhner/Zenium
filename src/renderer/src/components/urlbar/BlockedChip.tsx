import type { JSX } from 'react'
import { Shield, ShieldOff } from 'lucide-react'
import type { Tab, UIState } from '@shared/types'
import { blockedChipLabel, chipCount, siteBlockingState } from '@renderer/lib/blockingUi'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import { uiStore } from '@renderer/lib/ui'
import { PillChip } from './PillChip'

/**
 * The URL bar's blocked-count chip: a shield for the page's blocking state and, once the engine
 * stopped something on the page, the count as the shared §9.19 badge (`.zen-v2-badge`, in the
 * window family through the §9.29 control roles like the chip itself). It opens the site
 * information, where the "Ads and trackers" permission is listed and reset (Firefox's shield →
 * protections panel).
 *
 * Geometry is §9.3's icon button: a 28 px box with a 16 px glyph and a radius-6 hover fill on
 * desktop, 44 with 20 and radius 8 on phones. The chassis is the pill's shared `PillChip`
 * (§9.22): a real button in the tab order after the address with its own label, `aria-haspopup`
 * and `aria-expanded`. On desktop it opens the site information itself and hands the keyboard
 * back when the panel closes; on the phone it carries `data-site-info`, which the pill's tap
 * handler routes to the site information (the pill is a gesture surface there, not a button).
 * The ghost pill carried across the screen gets an inert span that keeps the state's look.
 */
export function BlockedChip({
  tab,
  state,
  variant,
  interactive = true
}: {
  tab: Tab
  state: UIState
  variant: 'desktop' | 'phone'
  interactive?: boolean
}): JSX.Element | null {
  const siteState = siteBlockingState(tab, state.blocking, state.settings.blocking)
  const expanded = uiStore.use((s) => s.siteInfoOpen)
  if (siteState === 'no-site') return null
  const label = blockedChipLabel(siteState, tab.blockedCount)
  const Icon = siteState === 'blocking' ? Shield : ShieldOff
  const showCount = siteState === 'blocking' && tab.blockedCount > 0
  const content = (
    <>
      <Icon aria-hidden />
      {showCount && <span className="zen-v2-badge">{chipCount(tab.blockedCount)}</span>}
    </>
  )
  if (variant === 'desktop') {
    return (
      <PillChip
        label={label}
        title={label}
        popup="dialog"
        expanded={expanded}
        data-state={siteState}
        className="zen-v2-blocked-chip -my-1"
        onActivate={(e) => {
          const chip = e.currentTarget
          const r = chip.getBoundingClientRect()
          void openSiteInfo(tab, { x: r.left, y: r.top, width: r.width, height: r.height }, chip)
        }}
      >
        {content}
      </PillChip>
    )
  }
  if (!interactive) {
    return (
      <span aria-hidden data-state={siteState} className="zen-v2-blocked-chip -mx-1">
        {content}
      </span>
    )
  }
  return (
    <PillChip
      label={label}
      popup="dialog"
      expanded={expanded}
      data-site-info
      data-state={siteState}
      className="zen-v2-blocked-chip -mx-1"
    >
      {content}
    </PillChip>
  )
}
