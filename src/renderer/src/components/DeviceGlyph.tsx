/* eslint-disable react-refresh/only-export-components -- the glyph ships with the one predicate that says whether a list draws it at all (`anyDeviceKind`): the rule and the picture belong to one module so no consumer can take one without the other */
import type { JSX } from 'react'
import { Laptop, MonitorSmartphone, Smartphone, Tablet } from 'lucide-react'
import type { SyncDeviceKind } from '@shared/types'
import { cn } from '@renderer/lib/utils'

/**
 * The one glyph for another device, wherever a row or heading names one (services pass 4; the
 * #418 ruling 4 and design language v2 §10.4: a kind glyph is the row's subject and stands in
 * the leading slot at the full ink): Settings › Sync's device rows, the phone's Send to your
 * devices sheet, the History page's device headings on both layouts, and the desktop app menu's
 * Send to Your Devices rows. The kind is the one the device announced (`SyncDevice.kind`,
 * `SyncDeviceTabs.deviceKind`): a laptop for a desktop OF ANY OS, a laptop, a phone, a tablet –
 * Chrome's mapping (`DeviceInfo::FormFactor` → `GetIconType`, `stts_button.cc` 35-47: phone,
 * tablet, and for every desktop OS the one "computer" glyph, Material's laptop shape). The
 * `desktop` and `laptop` kinds draw the same picture on purpose (the #453 lead check): no host
 * can yet tell a laptop from a tower – Electron has no signal, so every desktop announces
 * `desktop` – and a monitor drawn for the class would claim a tower for every laptop. Lucide's
 * `Monitor` is not imported here; it waits for a host that can make the distinction, and then
 * the `desktop` entry alone changes. A device that announced no kind – an older build's file –
 * shows the stand-in: the monitor-and-phone pair at 69 %, the deemphasis a missing favicon's
 * globe takes (`.zen-list-standin`). The pair is chosen because it is none of the four kinds –
 * it cannot be read as a claim about the device – and at 69 % it reads as the absence it is
 * beside the full glyphs around it; a list in which no device announced a kind draws no glyph
 * at all (`anyDeviceKind`). Sized by the tokens (`--v2-icon`, `--v2-icon-stroke`: 16 on a
 * mouse, 20 on a phone) through `.zen-device-glyph`, so one component serves every layout.
 * Decorative: the row's name is its accessible name, as a favicon's is (`alt=""`).
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
  desktop: Laptop,
  laptop: Laptop,
  phone: Smartphone,
  tablet: Tablet
} as const satisfies Record<SyncDeviceKind, typeof Laptop>

/**
 * Whether a list of devices draws a glyph column at all – §10.4's condition as the #453 lead
 * check put it: a device that announced no kind keeps the stand-in BESIDE devices that did, but
 * a list in which NO record carries a kind – every peer an older build – draws no glyph, its
 * labels at the gutter, as any list whose rows have nothing to lead with (§10.4: a column of
 * deemphasised nothing is still a column). The one predicate for every surface that lists
 * devices, so the rule cannot drift between them: Settings › Sync's device rows, the phone's
 * Send to your devices sheet, the History page's device groups on both layouts, the app menu's
 * Send to Your Devices rows. A record's kind is read under whichever name it carries it –
 * `SyncDevice.kind`, `RemoteDevice.kind`, `MenuDeviceMark.kind`, `SyncDeviceTabs.deviceKind`.
 */
export function anyDeviceKind(
  devices: readonly { kind?: SyncDeviceKind | null; deviceKind?: SyncDeviceKind | null }[]
): boolean {
  return devices.some((device) => Boolean(device.kind ?? device.deviceKind))
}
