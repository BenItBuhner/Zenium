import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Fragment, useEffect, useId, useRef, useState } from 'react'
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
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { V2Field, V2FormField } from '../extensions/v2'

/**
 * How long the chooser waits for the page's picture before it shows over a blank one: the page
 * keeps painting behind a `requestDevice()` call, so the capture is quick; a page that will not
 * answer does not hold the chooser.
 */
const SNAPSHOT_WAIT_MS = 250

/** The chooser is about to show over `tabId`: the page gives way to its picture, the chrome takes the keyboard. */
export async function openDeviceChooser(tabId: string | null): Promise<void> {
  if (tabId) {
    await Promise.race([
      captureActiveTab(tabId),
      new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
    ])
  }
  run('focus.chrome', undefined)
  uiStore.set({ deviceChooserOpen: true })
}

export function closeDeviceChooser(): void {
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
 * Chrome's "<site> wants to connect to a USB device" as the chassis prompt (`ConfirmDialog`) in
 * its picker form: `role="dialog"`, §9.20's 400 since it carries a list, the title block (§9.23)
 * with the kind's 16 glyph and the requesting frame's host – never elided; it wraps at its dots
 * – then the live list the engine keeps as a radio list (§9.13): one row per candidate with the
 * kind's glyph, its name and, where the engine gives one, its detail (a serial number, a port's
 * path, an address) at 13 in the deemphasised ink; the picked row `aria-checked` with the
 * selected fill (§9.6) and a trailing check. A Bluetooth list still growing says so under the
 * rows (§9.30's spinner, "Looking for devices…"); an empty list is §9.17's one sentence, with
 * Chrome's udev notice under it on Linux. The §9.11 footer is Cancel and Connect, the primary,
 * at .4 until a row is picked; a double-click or Enter on the picked row is Connect too. The
 * keyboard is the prompt's (§9.22): the container holds it at the open, Tab enters the list at
 * its one roving stop (the pick, else the first row), then Cancel, then Connect, wrapping; Down,
 * Up, Home and End move the pick; Enter from the container is Connect once there is a pick;
 * Escape and the scrim are Cancel – the page's `NotFoundError`, as Chrome's.
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
    <ConfirmDialog
      name="device-chooser"
      role="dialog"
      data={{ 'data-device-kind': chooser.kind, 'data-device-chooser': chooser.id }}
      glyph={<Glyph aria-hidden />}
      title={
        <>
          <Host host={host} /> {asks}
        </>
      }
      action="Connect"
      confirmDisabled={!selected}
      under={under}
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
 * over the chooser when one is up (§9.20: the 320 notice whatever it carries, stacked) and
 * alone otherwise. Three forms, by what the OS wants: `confirm` is the title block and Cancel |
 * Pair; `providePin` adds a six-digit field (§9.12) that takes the keyboard at the open, with
 * Pair at .4 until the digits are in – Enter in the field is Pair, as the field is not a
 * control that owns its Enter; `confirmPin`
 * shows the device's PIN large, in `tabular-nums`, to compare. Pair is the primary and the
 * prompt's default: nothing here destroys anything. Cancel, Escape and the scrim send null.
 */
export function PairingDialog({ prompt }: { prompt: DevicePairingPrompt }): JSX.Element {
  const answered = useRef(false)
  const [pin, setPin] = useState('')
  const fieldId = useId()
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

  return (
    <ConfirmDialog
      name="device-pairing"
      role={prompt.kind === 'confirm' ? 'alertdialog' : 'dialog'}
      data={{ 'data-pairing-kind': prompt.kind, 'data-device-pairing': prompt.id }}
      glyph={<Bluetooth aria-hidden />}
      title={pairingTitle(prompt)}
      description={pairingDescription(prompt)}
      action="Pair"
      confirmDisabled={!ready}
      onCancel={() => answer(false)}
      onConfirm={() => answer(true)}
      body={
        prompt.kind === 'providePin' ? (
          <V2FormField id={fieldId} label="PIN">
            {(aria) => (
              <V2Field
                {...aria}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={PIN_LENGTH}
                placeholder="000000"
                value={pin}
                className="zen-device-pairing-input"
                // The digits are the whole interaction: the field takes the keyboard at the open.
                data-autofocus=""
                onChange={(e) => setPin(sanitizePin(e.target.value))}
              />
            )}
          </V2FormField>
        ) : prompt.kind === 'confirmPin' ? (
          <p
            className="zen-device-pairing-pin"
            aria-label={`PIN ${prompt.pin.split('').join(' ')}`}
          >
            {prompt.pin}
          </p>
        ) : undefined
      }
    />
  )
}

/** An id inside an attribute selector (`CSS.escape` is not in every test DOM). */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')
}
