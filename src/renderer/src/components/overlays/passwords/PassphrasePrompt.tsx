import type { JSX } from 'react'
import { useId, useRef, useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { useBackSurface } from '@renderer/lib/back'
import { FrameDialogPortal, POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../../sheet/BottomSheet'
import { MIN_PASSPHRASE, useEscape, useFocusReach, useOverPage, usePhone } from './lib'
import { Btn, ErrorNote, Field, StatusGlyph, TextField, TitleBlock } from './shared'

export interface PassphraseRequest {
  /** Ask for the existing passphrase, or have one created first. */
  mode: 'passphrase' | 'setup'
  reason: string
  error: string | null
}

/**
 * Asks for the vault passphrase (or for a new one on devices without an OS keystore or
 * biometrics). A modal dialog, so it mounts in the frame's `FrameDialogHost` through
 * `FrameDialogPortal` (lib/portals.tsx) – over the content frame and the manager alike, outside
 * the overlay's stacking context and the frame's transform – and never draws a portal or a scrim
 * of its own. On a phone it is a v2 sheet on the shared `BottomSheet` (§6, §9.25: neutral panel,
 * radius 12, hairline, grabber, rows edge to edge at the 16 gutter) that draws the stack's one
 * scrim itself (`ownScrim`, §9.24, §9.28) and opens on a title block (§9.23: a prompt has no 48
 * header – grip strip, glyph and title, the reason as its description, the §9.11 footer); one
 * spring moves the sheet, the scrim and the recede of what is under it together, and it is
 * dragged, flung or pulled down by the back gesture. On the desktop it is a `--v2-dialog` panel
 * headed by the same title block (no X), centred by the host over its §9.5 scrim, which dims the
 * content frame only. Either way it is the topmost surface and takes the keyboard (§9.22): focus
 * lands in the passphrase field, Tab stays inside, Escape and back settle it and hand focus back
 * to the control that asked; the manager behind it stays open, receded and inert.
 */
export function PassphrasePrompt({
  request,
  onSettle
}: {
  request: PassphraseRequest
  onSettle: (passphrase: string | null) => void
}): JSX.Element {
  const phone = usePhone()
  return (
    <FrameDialogPortal>
      {phone ? (
        <PhonePrompt request={request} onSettle={onSettle} />
      ) : (
        <DesktopPrompt request={request} onSettle={onSettle} />
      )}
    </FrameDialogPortal>
  )
}

function PhonePrompt({
  request,
  onSettle
}: {
  request: PassphraseRequest
  onSettle: (passphrase: string | null) => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  const descriptionId = useId()
  // The sheet leaves the screen first; what it answers is decided by how it left.
  const answer = useRef<string | null>(null)
  const dismiss = (): void => sheet.current?.dismiss()
  // The host draws no scrim of its own while this sheet is on top: the sheet's fades with its motion.
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useOverPage()
  useBackSurface({
    name: 'passwords-prompt',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape('passwords-prompt', dismiss)
  return (
    <div className="zen-v2-pw zen-v2-pw-sheet-layer absolute inset-0" data-surface="page">
      <BottomSheet
        ref={sheet}
        hosted
        labelledBy={titleId}
        className="zen-v2-pw-sheet"
        onDismissed={() => onSettle(answer.current)}
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
          onSubmit={(value) => {
            answer.current = value
            dismiss()
          }}
        />
      </BottomSheet>
    </div>
  )
}

function DesktopPrompt({
  request,
  onSettle
}: {
  request: PassphraseRequest
  onSettle: (passphrase: string | null) => void
}): JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const cancel = (): void => onSettle(null)
  useFrameDialog({ onScrimPress: cancel })
  useOverPage()
  useBackSurface({ name: 'passwords-prompt', onCommit: cancel })
  useEscape('passwords-prompt', cancel)
  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      className="zen-v2-pw zen-v2-pw-dialog zen-animate-pop flex max-w-[calc(100%-32px)] flex-col"
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
      <PromptForm request={request} onCancel={cancel} onSubmit={onSettle} />
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

/** Dialog titles are Title Case (§9.1). */
function title(request: PassphraseRequest): string {
  return request.mode === 'setup' ? 'Create a Vault Passphrase' : 'Enter Your Vault Passphrase'
}

/** Why the prompt is up: the caller's reason, or what a first passphrase is for. */
function describe(request: PassphraseRequest): string {
  return request.mode === 'setup'
    ? 'This device cannot verify you on its own, so Zenium asks for a passphrase before showing, copying or exporting passwords. It cannot be recovered.'
    : request.reason
}

/**
 * The body under the title block: the field (two when a passphrase is being created), any error,
 * and the footer – on a phone the sheet footer of §9.11 (peers split the width at an 8 px gap,
 * the primary trailing, 16 above the bottom inset), on the desktop hugging right at 32 tall.
 */
function PromptForm({
  request,
  onCancel,
  onSubmit
}: {
  request: PassphraseRequest
  onCancel: () => void
  onSubmit: (passphrase: string) => void
}): JSX.Element {
  const phone = usePhone()
  const form = useRef<HTMLFormElement>(null)
  const [value, setValue] = useState('')
  const [confirm, setConfirm] = useState('')
  const setup = request.mode === 'setup'
  const mismatch = setup && confirm.length > 0 && confirm !== value
  const ready = setup ? value.length >= MIN_PASSPHRASE && confirm === value : value.length > 0
  useFocusReach(form)
  return (
    <form
      ref={form}
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSubmit(value)
      }}
    >
      <div className="flex flex-col gap-4 px-4">
        <Field label="Passphrase" htmlFor="vault-passphrase">
          <TextField
            id="vault-passphrase"
            type="password"
            autoFocus
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={setup ? `At least ${MIN_PASSPHRASE} characters` : undefined}
          />
        </Field>
        {setup && (
          <Field label="Confirm passphrase" htmlFor="vault-passphrase-confirm">
            <TextField
              id="vault-passphrase-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch || undefined}
            />
            {mismatch && <ErrorNote>The two passphrases differ.</ErrorNote>}
          </Field>
        )}
        {request.error && <ErrorNote>{request.error}</ErrorNote>}
      </div>
      <div className={cn(phone ? 'zen-sheet-footer' : 'flex justify-end gap-2 p-4')}>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn type="submit" variant="primary" disabled={!ready}>
          {setup ? 'Create' : 'Continue'}
        </Btn>
      </div>
    </form>
  )
}
