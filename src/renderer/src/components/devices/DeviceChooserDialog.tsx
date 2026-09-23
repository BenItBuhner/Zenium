import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Bluetooth, Cable, Check, Keyboard, type LucideIcon, Usb } from 'lucide-react'
import type {
  DeviceCandidate,
  DeviceChooser,
  DeviceKind,
  DevicePairingPrompt,
  UIState
} from '@shared/types'
import { run } from '@renderer/lib/api'
import {
  CHOOSER_EMPTY,
  CHOOSER_SCANNING,
  CHOOSER_UDEV_HINT,
  chooserTabStop,
  chooserTitle,
  currentDeviceChooser,
  currentDevicePairing,
  isCompletePin,
  listMove,
  pairingDescription,
  pairingTitle,
  PIN_LENGTH,
  sanitizePin
} from '@renderer/lib/devices'
import { hostLabels } from '@renderer/lib/screenPicker'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from '@renderer/lib/ui'
import { ConfirmDialog, PickerDialog, PromptDialog } from '../dialogs/ConfirmDialog'

/**
 * How long the chooser waits for the page's picture before it shows over a blank one: the page
 * keeps painting behind a `requestDevice()` call, so the capture is quick; a page that will not
 * answer does not hold the chooser.
 */
const SNAPSHOT_WAIT_MS = 250

/** The chooser is about to show over `tabId`: the page gives way to its picture, the chrome takes the keyboard. */
async function openDeviceChooser(tabId: string | null): Promise<void> {
  if (tabId) {
    await Promise.race([
      captureActiveTab(tabId),
      new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
    ])
  }
  run('focus.chrome', undefined)
  uiStore.set({ deviceChooserOpen: true })
}

function closeDeviceChooser(): void {
  if (uiStore.get().deviceChooserOpen) uiStore.set({ deviceChooserOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

/** The 16 glyph of each kind (§9.23's title glyph, and the rows' lead). */
export const DEVICE_KIND_GLYPH: Record<DeviceKind, LucideIcon> = {
  usb: Usb,
  serial: Cable,
  hid: Keyboard,
  bluetooth: Bluetooth
}

/**
 * The device chooser (MW-32..35) and the Bluetooth pairing prompt in the frame dialog host
 * `TabDialogs` mounts, tab-modal like Chrome's chooser bubble: the request of the window's
 * active tab shows; another tab in front hides it until its tab is back, and a closed or
 * navigated tab takes its request with it (the core answers the page). The pairing prompt, when
 * the OS asks for one while a site connects, is a second dialog over the chooser (§9.24: the
 * chooser recedes, inert, until the prompt is answered) – or alone, when the OS asks after the
 * chooser has closed. While either is up the page gives way to its picture and the chrome holds
 * the keyboard (`deviceChooserOpen`, as the screen picker does).
 */
export function DeviceChooserLayer({ state }: { state: UIState }): JSX.Element | null {
  const chooser = currentDeviceChooser(state)
  const pairing = currentDevicePairing(state)
  const open = chooser !== null || pairing !== null
  const tabId = chooser?.tabId ?? pairing?.tabId ?? null
  useEffect(() => {
    if (!open) return
    let gone = false
    void openDeviceChooser(tabId).then(() => {
      if (gone) closeDeviceChooser()
    })
    return () => {
      gone = true
      closeDeviceChooser()
    }
  }, [open, tabId])
  if (!open) return null
  return (
    <>
      {chooser && (
        <DeviceChooserDialog key={chooser.id} chooser={chooser} under={pairing !== null} />
      )}
      {pairing && <PairingDialog key={pairing.id} prompt={pairing} />}
    </>
  )
}

/**
 * Chrome's "<site> wants to connect to a USB device" on the picker form of the chassis prompt –
 * desktop's `PickerDialog` (#413): a `dialog` at §9.20's 400 (320 when it stands under the
 * pairing prompt), the title block (§9.23) with the kind's 16 glyph and the requesting frame's
 * host – never elided; it wraps at its dots – then, in the picker's body slot, the live list
 * the engine keeps as a radio list (§9.13): one row per candidate with the kind's glyph, its
 * name and, where the engine gives one, its detail (a serial number, a port's path, an address)
 * at 13 in the deemphasised ink; the picked row `aria-checked` with the selected fill (§9.6)
 * and a trailing check. The slot scrolls the list under the title block at the 80% cap (the
 * primitive's). A Bluetooth list still growing says so under the rows (§9.30's spinner,
 * "Looking for devices…"); an empty list is §9.17's one sentence, with Chrome's udev notice
 * under it on Linux. The §9.11 footer is Cancel and Connect, the primary, `disabled` at .4
 * until a row is picked (`aria-disabled`, still in the tab order); a double-click or Enter on
 * the picked row is Connect too. The keyboard is the prompt's (§9.22): the container holds it
 * at the open, Tab enters the list at its one roving stop (the pick, else the first row), then
 * Cancel, then Connect, wrapping; Down, Up, Home and End move the pick; Enter from the
 * container is Connect once there is a pick and inert before; Escape and the scrim are Cancel –
 * the page's `NotFoundError`, as Chrome's. While the pairing prompt stands over it (`under`)
 * the chooser is `inert` – §9.24's depth two, the cover this owner drops as the prompt goes –
 * and the primitive reads its place for the 320.
 */
export function DeviceChooserDialog({
  chooser,
  under = false
}: {
  chooser: DeviceChooser
  under?: boolean
}): JSX.Element {
  const answered = useRef(false)
  const list = useRef<HTMLDivElement>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const candidates = chooser.candidates
  const selected = picked && candidates.some((c) => c.id === picked) ? picked : null
  const stop = chooserTabStop(candidates, selected)
  const { host, asks } = chooserTitle(chooser)
  const Glyph = DEVICE_KIND_GLYPH[chooser.kind]
  const listId = useId()

  // The cover under the pairing prompt: the primitive's root is found by the handle the chooser
  // puts on it, and made inert before the paint; lifted the same way as the prompt leaves, ahead
  // of the prompt's return of the keyboard to the chooser (a passive cleanup, after this). A
  // panel not in the document yet – the frame's host mounting in the same pass – is covered as
  // it lands.
  useLayoutEffect(() => {
    const selector = `[data-device-chooser="${cssEscape(chooser.id)}"]`
    const cover = (root: HTMLElement): void => {
      if (under) root.setAttribute('inert', '')
      else root.removeAttribute('inert')
    }
    const root = document.querySelector<HTMLElement>(selector)
    if (root) {
      cover(root)
      return
    }
    if (!under) return
    const observer = new MutationObserver(() => {
      const late = document.querySelector<HTMLElement>(selector)
      if (!late) return
      cover(late)
      observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [under, chooser.id])

  const answer = (deviceId: string | null): void => {
    if (answered.current) return
    answered.current = true
    run('devices.respond', { id: chooser.id, deviceId })
  }
  const connect = (): void => {
    if (selected) answer(selected)
  }
  const cancel = (): void => answer(null)

  const focusRow = (id: string): void => {
    list.current
      ?.querySelector<HTMLElement>(`[role="radio"][data-device-id="${cssEscape(id)}"]`)
      ?.focus()
  }
  const onRowKey = (e: ReactKeyboardEvent<HTMLElement>, index: number): void => {
    if (e.key === 'Enter') {
      const id = candidates[index]?.id
      if (!id) return
      e.preventDefault()
      if (id === selected) connect()
      else setPicked(id)
      return
    }
    const next = listMove(e.key, index, candidates.length)
    if (next === null) return
    e.preventDefault()
    const id = candidates[next]!.id
    setPicked(id)
    focusRow(id)
  }

  return (
    <PickerDialog
      name="device-chooser"
      data={{ 'data-device-kind': chooser.kind, 'data-device-chooser': chooser.id }}
      glyph={<Glyph aria-hidden />}
      title={
        <>
          <Host host={host} /> {asks}
        </>
      }
      action="Connect"
      disabled={!selected}
      returnFocus={false}
      onCancel={cancel}
      onConfirm={connect}
      body={
        <div
          className="zen-device-chooser"
          data-scanning={chooser.scanning || undefined}
          data-empty={candidates.length === 0 || undefined}
        >
          {candidates.length > 0 && (
            <div
              ref={list}
              id={listId}
              role="radiogroup"
              aria-label="Devices"
              aria-busy={chooser.scanning || undefined}
              className="zen-device-chooser-list"
            >
              {candidates.map((c, index) => (
                <CandidateRow
                  key={c.id}
                  candidate={c}
                  glyph={Glyph}
                  checked={c.id === selected}
                  tabStop={c.id === stop}
                  onPick={() => setPicked(c.id)}
                  onOpen={() => {
                    setPicked(c.id)
                    answer(c.id)
                  }}
                  onKeyDown={(e) => onRowKey(e, index)}
                />
              ))}
            </div>
          )}
          {candidates.length === 0 && !chooser.scanning && (
            <div className="zen-device-chooser-empty" role="status">
              <p className="zen-device-chooser-empty-line">{CHOOSER_EMPTY}</p>
              {chooser.hint === 'linux-udev' && (
                <p className="zen-device-chooser-notice">{CHOOSER_UDEV_HINT}</p>
              )}
            </div>
          )}
          {chooser.scanning && (
            <div className="zen-device-chooser-scanning" role="status">
              <span className="zen-v2-spinner" aria-hidden />
              <span>{CHOOSER_SCANNING}</span>
            </div>
          )}
        </div>
      }
    />
  )
}

/**
 * One candidate as a radio row on the shared `.zen-v2-row` (§9.34): the kind's glyph leading on
 * the first text line, the name at the row's 15, the detail as a 13 description where the engine
 * gave one, the check trailing on the picked row. The roving stop is the one row Tab reaches.
 */
function CandidateRow({
  candidate,
  glyph: Glyph,
  checked,
  tabStop,
  onPick,
  onOpen,
  onKeyDown
}: {
  candidate: DeviceCandidate
  glyph: LucideIcon
  checked: boolean
  tabStop: boolean
  onPick: () => void
  onOpen: () => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={tabStop ? 0 : -1}
      data-device-id={candidate.id}
      data-lines={candidate.detail ? '2' : undefined}
      className="zen-v2-row zen-device-chooser-row"
      onClick={onPick}
      onDoubleClick={onOpen}
      onKeyDown={onKeyDown}
    >
      <span className="zen-v2-row-body">
        <Glyph className="zen-v2-row-lead" aria-hidden />
        <span className="zen-v2-row-text">
          <span className="zen-v2-label">{candidate.name}</span>
          {candidate.detail && <span className="zen-v2-description">{candidate.detail}</span>}
        </span>
      </span>
      {checked && <Check className="zen-v2-row-trail" aria-hidden />}
    </button>
  )
}

/**
 * The requesting frame's host in the title, as the user is asked to trust it: never elided
 * (§9.23). Too long for its line, it wraps at its dots – a `<wbr>` after each – and in the
 * middle of a label only when that label alone is longer than the line.
 */
function Host({ host }: { host: string }): JSX.Element {
  const labels = hostLabels(host)
  return (
    <span className="zen-device-chooser-host">
      {labels.map((label, index) => (
        <Fragment key={index}>
          {label}
          {index < labels.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  )
}

/**
 * The Bluetooth pairing prompt (`devicePairings`): "Pair with <device>" on the same chassis,
 * over the chooser when one is up (§9.20: the 320 notice whatever it carries, stacked – the
 * primitive reads its place) and alone otherwise. Three forms, by what the OS wants, each on
 * the desktop's export for it (#413): `confirm` is the confirmation itself (`ConfirmDialog`, an
 * `alertdialog`): the title block and Cancel | Pair; `providePin` is the one-field prompt
 * (`PromptDialog`, §9.12: the field takes the keyboard at the open, its name is the title's
 * and its `aria-label`, no placeholder) with the six digits its value – Pair `disabled` at .4
 * until they are in, and Enter in the field the verb once they are, the primitive's default
 * key; `confirmPin` shows the device's PIN large, in `tabular-nums`, to compare, as the body of
 * the picker form (`PickerDialog`, the chassis' one body slot; a `dialog`, since a comparison
 * is asked). Pair is the primary and the prompt's default: nothing here destroys anything.
 * Cancel, Escape and the scrim send null.
 */
export function PairingDialog({ prompt }: { prompt: DevicePairingPrompt }): JSX.Element {
  const answered = useRef(false)
  const [pin, setPin] = useState('')
  const needsPin = prompt.kind === 'providePin'
  const ready = !needsPin || isCompletePin(pin)

  const answer = (confirmed: boolean): void => {
    if (answered.current) return
    answered.current = true
    run('devices.respondPairing', {
      id: prompt.id,
      response: confirmed ? { confirmed: true, ...(needsPin ? { pin } : {}) } : null
    })
  }

  const shared = {
    name: 'device-pairing',
    data: { 'data-pairing-kind': prompt.kind, 'data-device-pairing': prompt.id },
    glyph: <Bluetooth aria-hidden />,
    title: pairingTitle(prompt),
    description: pairingDescription(prompt),
    action: 'Pair',
    onCancel: () => answer(false),
    onConfirm: () => answer(true)
  }

  if (prompt.kind === 'providePin') {
    return (
      <PromptDialog
        {...shared}
        disabled={!ready}
        field={{
          label: 'PIN',
          value: pin,
          onChange: (next) => setPin(sanitizePin(next)),
          maxLength: PIN_LENGTH
        }}
      />
    )
  }
  if (prompt.kind === 'confirmPin') {
    return (
      <PickerDialog
        {...shared}
        body={
          <p
            className="zen-device-pairing-pin"
            aria-label={`PIN ${prompt.pin.split('').join(' ')}`}
          >
            {prompt.pin}
          </p>
        }
      />
    )
  }
  return <ConfirmDialog {...shared} />
}

/** An id inside an attribute selector (`CSS.escape` is not in every test DOM). */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}
