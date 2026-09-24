import type { JSX } from 'react'
import { useRef, useState } from 'react'
import type { SyncStatus, Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { SYNC_COPY } from '@renderer/lib/syncSetup'
import { browserStore, closeSendTabSheet, uiStore } from '@renderer/lib/ui'
import { relativeTime } from '@renderer/lib/utils'
import { DeviceGlyph, anyDeviceKind } from '../DeviceGlyph'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneEmptyNote, PhoneListRow } from './PhoneList'
import { PhoneSheet } from './PhoneSheet'

/**
 * Chrome's "Send to your devices" picker on a phone (ID-27, `sendTab.open`): the menu's "Send to
 * Your Devices…" leaves and this §9.13 sheet rises in its place on the frame's dialog host – the
 * 48 header with Chrome's title, then one §10.4 row per other device the sync folder knows,
 * most recently seen first: the device's name over when it was last active (the same age the
 * Settings › Sync device rows trail). A tap sends the tab's page to that device once the sheet
 * has gone (`sync.sendTab`; the engine's toast, "Sent to Laptop", confirms the hand-over, and the
 * target opens it as a tab when it next syncs). Each row leads with the device's kind glyph
 * (`DeviceGlyph`, services pass 4: `devices[].kind` – the laptop, phone or tablet the device
 * announced, as Chrome's picker draws them; the 69 % stand-in for a device whose build
 * announced none), the row's subject in §9.3's leading slot, so the sheet keeps one glyph
 * column as the Settings › Sync device rows do – while any device of the list announced a kind
 * (`anyDeviceKind`, §10.4's condition): with none the rows have no leading box and the names
 * stand at the gutter. A list sheet, it opens on its first row (§9.22;
 * the #314 lead's ruling: the container is for a title-and-notice sheet and the form-sheet
 * exception only), the dialog's title read ahead of it. With one other device the menu names it
 * and sends outright, so this sheet is for two or more; should the list have emptied meanwhile
 * it says so (§9.17).
 */
export function SendTabSheetLayer(): JSX.Element | null {
  const request = uiStore.use((s) => s.sendTabSheet)
  const state = browserStore.use((s) => s.state)
  const tab = request && state ? state.tabs[request.tabId] : undefined
  if (!request || !state || !tab) return null
  return <SendTabSheet key={request.tabId} state={state} tab={tab} />
}

function SendTabSheet({ state, tab }: { state: UIState; tab: Tab }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  // The ages are judged as the sheet opens; it is never up for long.
  const [now] = useState(() => Date.now())
  const devices = [...state.sync.devices].sort((a, b) => b.lastSeen - a.lastSeen)
  const glyphs = anyDeviceKind(devices)
  const send = (device: SyncStatus['devices'][number]): void => {
    sheet.current?.dismiss(() => {
      void run('sync.sendTab', {
        deviceId: device.id,
        url: tab.url,
        title: tab.title,
        tabId: tab.id
      })
    })
  }
  return (
    <PhoneSheet
      name="send-tab"
      // A list sheet: the centred 48 header (§9.16), Chrome's title in sentence case; it opens
      // on its first row (§9.22) and stands at most 80 % of the frame (§9.20).
      title={{ pose: 'header', text: 'Send to your devices' }}
      focus="first"
      body="list"
      onClose={closeSendTabSheet}
      sheetRef={sheet}
      contentKey={devices.map((device) => device.id).join('/')}
    >
      <div className="zen-phone-list pb-2">
        {devices.length === 0 ? (
          <PhoneEmptyNote>{SYNC_COPY.noDevices}</PhoneEmptyNote>
        ) : (
          devices.map((device) => {
            const when = `Last active ${lowerFirst(relativeTime(device.lastSeen, now))}`
            return (
              <PhoneListRow
                key={device.id}
                icon={glyphs ? <DeviceGlyph kind={device.kind} /> : undefined}
                title={device.name}
                subtitle={when}
                ariaLabel={`${device.name}, ${when}`}
                onTap={() => send(device)}
              />
            )
          })
        )}
      </div>
    </PhoneSheet>
  )
}

/** "Just now" mid-sentence reads "just now"; a date ("9/14/2026") is left as it is. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text
}
