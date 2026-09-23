import type { JSX } from 'react'
import { BellOff, Camera, CameraOff, MapPinOff, Mic, MicOff, ScreenShare } from 'lucide-react'
import type { TabCapture } from '@shared/captureState'
import type { Tab } from '@shared/types'
import {
  blockedPermissionLabel,
  captureGlyph,
  captureLabel,
  type BlockedPermission
} from '@renderer/lib/siteChips'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import { uiStore } from '@renderer/lib/ui'
import { TOOLBAR_STROKE } from '../v2/controls'
import { PillChip } from './PillChip'

/**
 * The URL pill's word on a site's permissions (omnibox-38; Chrome's location bar): the in-use
 * chip while the page holds the camera, the microphone or the screen – Chrome's camera,
 * microphone or sharing glyph, named for what is held – and, at rest, a crossed-out icon for
 * each permission the user blocked on the site (camera, microphone, location, notifications).
 * Both open the site information on its Permissions level, where the row for the permission
 * is changed (Chrome's page info opens on the same row from either icon).
 *
 * The chassis is the pill's `PillChip` (§9.22: a real button after the address with its own
 * label, `aria-haspopup` and `aria-expanded`), dressed as the shield is – §9.3's 28 px icon
 * button in the window family (`.zen-v2-blocked-chip`: the deemphasised ink at rest, the full
 * ink and the window fill under the pointer or with its popover up), its 16 px glyph at the
 * row's stroke. The tier (`pillChipTiers.ts`) never hides the in-use chip and drops the blocked
 * icons first; a blocked icon whose popover is up stays put until it closes (§9.20). The name
 * is the tooltip for now (`title`); it moves to the chrome tooltip with the tooltip primitive.
 */

const CAPTURE_GLYPHS = { camera: Camera, microphone: Mic, display: ScreenShare } as const
const BLOCKED_GLYPHS = {
  camera: CameraOff,
  microphone: MicOff,
  geolocation: MapPinOff,
  notifications: BellOff
} as const

function openPermissions(tab: Tab, chip: HTMLButtonElement): void {
  const r = chip.getBoundingClientRect()
  void openSiteInfo(tab, { x: r.left, y: r.top, width: r.width, height: r.height }, chip, {
    level: 'permissions'
  })
}

/** The camera / microphone / sharing chip: present only while the page captures. */
export function CaptureChip({ tab, capture }: { tab: Tab; capture: TabCapture }): JSX.Element {
  const expanded = uiStore.use((s) => s.siteInfoOpen)
  const Glyph = CAPTURE_GLYPHS[captureGlyph(capture)]
  const label = captureLabel(capture)
  return (
    <PillChip
      label={label}
      title={label}
      popup="dialog"
      expanded={expanded}
      data-capture-chip={captureGlyph(capture)}
      className="zen-v2-blocked-chip -my-1"
      onActivate={(e) => openPermissions(tab, e.currentTarget)}
    >
      <Glyph aria-hidden strokeWidth={TOOLBAR_STROKE} />
    </PillChip>
  )
}

/** One blocked permission's crossed-out icon, at rest for as long as the site's block stands. */
export function BlockedPermissionChip({
  tab,
  permission,
  collapsed = false
}: {
  tab: Tab
  permission: BlockedPermission
  /**
   * The pill has no room for the icon (`pillChipTiers.ts`): it hides – the block stays in the
   * site information's Permissions – unless the site information is up on it (§9.20).
   */
  collapsed?: boolean
}): JSX.Element | null {
  const expanded = uiStore.use((s) => s.siteInfoOpen)
  if (collapsed && !expanded) return null
  const Glyph = BLOCKED_GLYPHS[permission]
  const label = blockedPermissionLabel(permission)
  return (
    <PillChip
      label={label}
      title={label}
      popup="dialog"
      expanded={expanded}
      data-blocked-permission={permission}
      className="zen-v2-blocked-chip -my-1"
      onActivate={(e) => openPermissions(tab, e.currentTarget)}
    >
      <Glyph aria-hidden strokeWidth={TOOLBAR_STROKE} />
    </PillChip>
  )
}
