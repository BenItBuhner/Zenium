import type { JSX } from 'react'
import { useId, useRef, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { useEscape } from '@renderer/hooks/useEscape'
import { usePopover } from '@renderer/hooks/usePopover'
import { useBackSurface } from '@renderer/lib/back'
import { FrameDialogPortal, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../../sheet/BottomSheet'
import { MIN_PASSPHRASE, usePhone } from './lib'
import { Btn, Field, StatusGlyph, TextField, TitleBlock } from './shared'

export interface PassphraseRequest {
  /** Ask for the existing passphrase, or have one created first. */
  mode: 'passphrase' | 'setup'
  reason: string
  /**
   * Try what was typed (§9.30: the prompt stays up, read-only, while this runs). Resolves the
   * refusal to show under the field – the field clears and takes the focus – or null when the
   * passphrase was accepted, on which the prompt leaves with its values in place.
   */
  verify: (passphrase: string) => Promise<string | null>
}

/**
 * Asks for the vault passphrase (or for a new one on devices without an OS keystore or
 * biometrics). A modal dialog, so it mounts in the frame's `FrameDialogHost` through
 * `FrameDialogPortal` (lib/portals.tsx) – over the content frame and the manager alike, outside
 * the overlay's stacking context and the frame's transform – and never draws a portal or a scrim
 * of its own. On a phone it is a v2 sheet on the shared `BottomSheet` (§6, §9.25) that draws the
 * stack's one scrim itself (`ownScrim`, §9.24, §9.28) and opens on the chassis's title block
 * (§9.23: a prompt has no 48 header – grip strip, glyph and title, the reason as its
 * description, the §9.11 footer); the chassis moves the focus into it, wraps Tab, holds the
 * page under it inert and hands the focus back when it has gone, and one spring moves the
 * sheet, the scrim and the recede together – dragged, flung or pulled down by the back gesture.
 * On the desktop it is the shared `.zen-v2-dialog` at the form width, 400 (§9.20), headed by a
 * title block (no X) and ending in its actions with no hairline (footer form i), centred by the
 * host over its §9.5 scrim, which dims the content frame only; `usePopover` puts the focus in
 * its field, wraps Tab and returns the focus to what asked when it closes. Escape and the back
 * gesture settle it either way (§9.22), and the manager behind it stays open. Titles are
 * sentence case (§9.1: a dialog's or a sheet's, unlike a pane's).
 */
export function PassphrasePrompt({
  request,
  onGone
}: {
  request: PassphraseRequest
  /** The prompt has left; `accepted` when a passphrase opened the vault, else it was backed out of. */
  onGone: (accepted: boolean) => void
}): JSX.Element {
  const phone = usePhone()
  return (
    <FrameDialogPortal>
      {phone ? (
        <PhonePrompt request={request} onGone={onGone} />
      ) : (
        <DesktopPrompt request={request} onGone={onGone} />
      )}
    </FrameDialogPortal>
  )
}

function PhonePrompt({
  request,
  onGone
}: {
  request: PassphraseRequest
  onGone: (accepted: boolean) => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  const descriptionId = useId()
  // The sheet leaves the screen first; what it answers is decided by how it left.
  const accepted = useRef(false)
  const dismiss = (): void => sheet.current?.dismiss()
  // The host draws no scrim of its own while this sheet is on top: the sheet's fades with its motion.
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name: 'passwords-prompt',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)
  return (
    <div className="zen-v2-pw zen-v2-pw-sheet-layer absolute inset-0" data-surface="page">
      <BottomSheet
        ref={sheet}
        hosted
        labelledBy={titleId}
        onDismissed={() => onGone(accepted.current)}
        handleLabel="Dismiss"
      >
        <TitleBlock
          id={titleId}
          descriptionId={descriptionId}
          description={describe(request)}
          glyph={<Glyph request={request} />}
        >
          {title(request)}
        </TitleBlock>
        <PromptForm
          request={request}
          onCancel={dismiss}
          onAccepted={() => {
            accepted.current = true
            dismiss()
          }}
        />
      </BottomSheet>
    </div>
  )
}

function DesktopPrompt({
  request,
  onGone
}: {
  request: PassphraseRequest
  onGone: (accepted: boolean) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const cancel = (): void => onGone(false)
  useFrameDialog({ onScrimPress: cancel })
  useBackSurface({ name: 'passwords-prompt', onCommit: cancel })
  // §9.22: focus lands in the passphrase field (the first control), Tab wraps, Escape cancels
  // and the focus goes back to the control that asked.
  usePopover(ref, { onClose: cancel })
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="zen-v2-pw zen-v2-dialog zen-animate-pop flex max-w-[calc(100%-32px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <TitleBlock
        id={titleId}
        descriptionId={descriptionId}
        description={describe(request)}
        glyph={<Glyph request={request} />}
      >
        {title(request)}
      </TitleBlock>
      <PromptForm request={request} onCancel={cancel} onAccepted={() => onGone(true)} />
    </div>
  )
}

/** The title's glyph (§9.23): 16 on the desktop, 20 on a phone, in the accent ink, no fill box. */
function Glyph({ request }: { request: PassphraseRequest }): JSX.Element {
  return (
    <StatusGlyph tone="accent">
      {request.mode === 'setup' ? <ShieldCheck /> : <KeyRound />}
    </StatusGlyph>
  )
}

/** Dialog and sheet titles are sentence case (§9.1). */
function title(request: PassphraseRequest): string {
  return request.mode === 'setup' ? 'Create a vault passphrase' : 'Enter your vault passphrase'
}

/** Why the prompt is up: the caller's reason, or what a first passphrase is for. */
function describe(request: PassphraseRequest): string {
  return request.mode === 'setup'
    ? 'This device cannot verify you on its own, so Zenium asks for a passphrase before showing, copying or exporting passwords. It cannot be recovered.'
    : request.reason
}

/**
 * The body under the title block: the field (two when a passphrase is being created) and the
 * footer – on a phone the sheet footer of §9.11 (peers split the width at an 8 px gap, the
 * primary trailing, 16 above the bottom inset), on the desktop footer form (i): the actions
 * hugging right, 16 to the edge, no hairline. A busy form (§9.30): while the passphrase is
 * being verified the fields stay read-only at full opacity with the typed value in place
 * (masked), only the primary is busy and Cancel sits at .4; refused, the field clears, takes
 * the focus and shows the §9.12 validation line; accepted, the form leaves with its values.
 */
function PromptForm({
  request,
  onCancel,
  onAccepted
}: {
  request: PassphraseRequest
  onCancel: () => void
  onAccepted: () => void
}): JSX.Element {
  const phone = usePhone()
  const field = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const setup = request.mode === 'setup'
  const mismatch = setup && confirm.length > 0 && confirm !== value
  const ready = setup ? value.length >= MIN_PASSPHRASE && confirm === value : value.length > 0
  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setRefusal(null)
    const refused = await request.verify(value)
    if (refused === null) {
      onAccepted()
      return
    }
    setBusy(false)
    setRefusal(refused)
    setValue('')
    setConfirm('')
    field.current?.focus({ preventScroll: true })
  }
  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-4 px-4">
        <Field id="vault-passphrase" label="Passphrase" error={refusal}>
          {(aria) => (
            <TextField
              {...aria}
              ref={field}
              type="password"
              autoFocus
              readOnly={busy}
              autoComplete={setup ? 'new-password' : 'current-password'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={setup ? `At least ${MIN_PASSPHRASE} characters` : undefined}
            />
          )}
        </Field>
        {setup && (
          <Field
            id="vault-passphrase-confirm"
            label="Confirm passphrase"
            error={mismatch ? 'The two passphrases differ.' : null}
          >
            {(aria) => (
              <TextField
                {...aria}
                type="password"
                readOnly={busy}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            )}
          </Field>
        )}
      </div>
      <div className={cn(phone ? 'zen-sheet-footer' : 'flex justify-end gap-2 p-4')}>
        <Btn onClick={onCancel} disabled={busy}>
          Cancel
        </Btn>
        <Btn type="submit" variant="primary" busy={busy} disabled={!ready}>
          {setup ? 'Create' : 'Continue'}
        </Btn>
      </div>
    </form>
  )
}
