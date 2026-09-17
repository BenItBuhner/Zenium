import type { JSX } from 'react'
import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { useBackSurface } from '@renderer/lib/back'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../../sheet/BottomSheet'
import { MIN_PASSPHRASE, useEscape, useFocusReach, usePhone } from './lib'
import { Btn, Description, ErrorNote, Field, StatusGlyph, TextField, TitleBlock } from './shared'

export interface PassphraseRequest {
  /** Ask for the existing passphrase, or have one created first. */
  mode: 'passphrase' | 'setup'
  reason: string
  error: string | null
}

/**
 * Asks for the vault passphrase (or for a new one on devices without an OS keystore or
 * biometrics). On a phone it is a v2 sheet (§6: neutral panel, radius 12, hairline, grabber,
 * black scrim; §9.16: a 48 header after the 20 px grip strip) on the `BottomSheet` spring – one
 * progress value moves the sheet, the scrim and the back preview together; it is dragged, flung
 * or pulled down by the back gesture. On the desktop it is a dialog headed by a title block
 * (§9.23: glyph, title and the reason as its description, no X) whose scrim dims the content
 * frame only (§9.5). Either way it is the topmost surface and takes the keyboard (§9.22): focus
 * lands in the passphrase field, Tab stays inside, Escape and back settle it and hand focus
 * back to the control that asked; the manager behind it stays open.
 */
export function PassphrasePrompt({
  request,
  onSettle
}: {
  request: PassphraseRequest
  onSettle: (passphrase: string | null) => void
}): JSX.Element {
  const phone = usePhone()
  return phone ? (
    <PhonePrompt request={request} onSettle={onSettle} />
  ) : (
    <DesktopPrompt request={request} onSettle={onSettle} />
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
  // The sheet leaves the screen first; what it answers is decided by how it left.
  const answer = useRef<string | null>(null)
  useBackSurface({
    name: 'passwords-prompt',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape('passwords-prompt', () => sheet.current?.dismiss())
  // Like the shell's other sheets (Root.tsx) this one sits at the window level, above the phone
  // bar and outside the overlay host's stacking context, rather than inside the manager's page.
  return createPortal(
    <BottomSheet
      ref={sheet}
      className="zen-v2-pw zen-v2-pw-sheet"
      onDismissed={() => onSettle(answer.current)}
      handleLabel="Dismiss"
      header={
        <div className="zen-v2-pw-sheet-header flex items-center gap-3 px-4">
          <StatusGlyph tone="accent">
            {request.mode === 'setup' ? <ShieldCheck /> : <KeyRound />}
          </StatusGlyph>
          <span className="zen-v2-pw-panel-title min-w-0 flex-1 truncate">{title(request)}</span>
        </div>
      }
    >
      <PromptForm
        request={request}
        description={describe(request)}
        className="px-4 pb-4 pt-2"
        onCancel={() => sheet.current?.dismiss()}
        onSubmit={(value) => {
          answer.current = value
          sheet.current?.dismiss()
        }}
      />
    </BottomSheet>,
    document.body
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
  useBackSurface({ name: 'passwords-prompt', onCommit: () => onSettle(null) })
  useEscape('passwords-prompt', () => onSettle(null))
  return (
    <div
      className="zen-v2-pw-scrim zen-animate-fade absolute inset-0 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        // Only this prompt closes; the overlay behind it stays open.
        e.stopPropagation()
        onSettle(null)
      }}
    >
      <div
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="zen-v2-pw zen-v2-pw-dialog zen-animate-pop flex w-full max-w-[400px] flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <TitleBlock
          id={titleId}
          descriptionId={descriptionId}
          description={describe(request)}
          glyph={
            <StatusGlyph tone="accent">
              {request.mode === 'setup' ? <ShieldCheck /> : <KeyRound />}
            </StatusGlyph>
          }
        >
          {title(request)}
        </TitleBlock>
        <PromptForm
          request={request}
          className="px-4 pb-4"
          onCancel={() => onSettle(null)}
          onSubmit={onSettle}
        />
      </div>
    </div>
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

function PromptForm({
  request,
  description,
  onCancel,
  onSubmit,
  className
}: {
  request: PassphraseRequest
  /** The reason as the body's first line (the phone sheet; the desktop title block carries it). */
  description?: string
  onCancel: () => void
  onSubmit: (passphrase: string) => void
  className?: string
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
      className={cn('flex flex-col gap-4', className)}
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSubmit(value)
      }}
    >
      {description && <Description>{description}</Description>}
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
      <div className={cn('flex gap-2', phone ? 'flex-col-reverse' : 'justify-end')}>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn type="submit" variant="primary" disabled={!ready}>
          {setup ? 'Create' : 'Continue'}
        </Btn>
      </div>
    </form>
  )
}
