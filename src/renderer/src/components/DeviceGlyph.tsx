import type { JSX } from 'react'
import { Laptop, Monitor, MonitorSmartphone, Smartphone, Tablet } from 'lucide-react'
import type { SyncDeviceKind } from '@shared/types'
import { cn } from '@renderer/lib/utils'

/**
 * The one glyph for another device, wherever a row or heading names one (services pass 4; the
 * #418 ruling 4 and design language v2 §10.4: a kind glyph is the row's subject and stands in
 * the leading slot at the full ink): Settings › Sync's device rows, the phone's Send to your
 * devices sheet, the History page's device headings on both layouts, and the desktop app menu's
 * Send to Your Devices rows. The kind is the one the device announced (`SyncDevice.kind`,
 * `SyncDeviceTabs.deviceKind`): a monitor for a desktop, a laptop, a phone, a tablet – Chrome's
 * mapping (`DeviceInfo::FormFactor` → `GetIconType`: phone, tablet, and one computer glyph for
 * every desktop OS). A device that announced no kind – an older build's file – shows the
 * stand-in: the monitor-and-phone pair at 69 %, the deemphasis a missing favicon's globe takes
 * (`.zen-list-standin`). The pair is chosen because it is none of the four kinds – it cannot be
 * read as a claim about the device – and at 69 % it reads as the absence it is beside the full
 * glyphs around it. Sized by the tokens (`--v2-icon`, `--v2-icon-stroke`: 16 on a mouse, 20 on a
 * phone) through `.zen-device-glyph`, so one component serves every layout. Decorative: the
 * row's name is its accessible name, as a favicon's is (`alt=""`).
 */
export function DeviceGlyph({
  kind,
  className
}: {
  kind: SyncDeviceKind | null | undefined
  className?: string
}): JSX.Element {
  const Glyph = kind ? GLYPHS[kind] : MonitorSmartphone
  return (
    <Glyph
      className={cn('zen-device-glyph', !kind && 'zen-list-standin', className)}
      data-testid="device-glyph"
      data-kind={kind ?? 'none'}
      aria-hidden
    />
  )
}

const GLYPHS = {
  desktop: Monitor,
  laptop: Laptop,
  phone: Smartphone,
  tablet: Tablet
} as const satisfies Record<SyncDeviceKind, typeof Monitor>
