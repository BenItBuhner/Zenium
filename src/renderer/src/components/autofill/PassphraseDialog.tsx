import type { JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Lock } from 'lucide-react'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { useFrameDialog } from '@renderer/lib/portals'
import { answerPassphrase, cancelPassphrase } from '@renderer/lib/autofill'
import { uiStore, type UiState } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import {
  Btn,
  Field,
  Footer,
  InSheet,
  Labelled,
  SheetTitleBlock,
  TitleBlock,
  useEscape,
  wrapTab
} from './controls'

type Ask = NonNullable<UiState['autofillPassphrase']>

/**
 * The vault passphrase asked for by a re-authenticated command that ran from the chrome rather
 * than from a page's picker – copying a card's number in Settings, for one (`withPassphrase` in
 * lib/autofill.ts). A modal dialog in the frame on desktop (§9.5, through the `FrameDialogHost`
 * `TabDialogs` mounts, so it centres over the frame wherever the caller sits, Settings included)
 * and a sheet on phones (§9.11, §9.23: the same title block after the grip strip, no 48
 * header): one §9.12 field with the refused attempt as its error, Cancel and Unlock. Every
 * answer repeats the command; dismissing it ends the command refused.
 */
export function PassphraseDialog(): JSX.Element | null {
  const ask = uiStore.use((s) => s.autofillPassphrase)
  const phone = useViewport().formFactor === 'phone'
  if (!ask) return null
  return phone ? <PassphraseSheet ask={ask} /> : <PassphraseFrameDialog ask={ask} />
}

/**
 * The field, its label and the refused attempt, shared by the dialog and the sheet; the footer
 * hugs on desktop and splits the sheet's width on a phone by the sheet's own rule.
 */
function PassphraseForm({ ask, onCancel }: { ask: Ask; onCancel: () => void }): JSX.Element {
  const [value, setValue] = useState('')
  const id = useId()
  const field = useRef<HTMLInputElement>(null)
  // The field takes the focus when the form opens and again when a refused attempt hands it back
  // (the disabled field lost it while the attempt ran); an attempt clears the field as it leaves.
  useEffect(() => {
    if (!ask.busy) field.current?.focus()
  }, [ask.busy])
  return (
    <form
      className="zen-v2-af-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!value || ask.busy) return
        void answerPassphrase(value)
        setValue('')
      }}
    >
      <Labelled label="Vault passphrase" htmlFor={id} error={ask.error}>
        <Field
          ref={field}
          id={id}
          type="password"
          value={value}
          autoComplete="current-password"
          disabled={ask.busy}
          onChange={(e) => setValue(e.target.value)}
        />
      </Labelled>
      <Footer count={2}>
        <Btn onClick={onCancel} disabled={ask.busy}>
          Cancel
        </Btn>
        <Btn type="submit" variant="primary" busy={ask.busy} disabled={!value}>
          Unlock
        </Btn>
      </Footer>
    </form>
  )
}

function PassphraseFrameDialog({ ask }: { ask: Ask }): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFrameDialog({ onScrimPress: cancelPassphrase })
  useEscape(cancelPassphrase)
  useBackSurface({ name: 'autofill-passphrase', onCommit: cancelPassphrase })
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="zen-v2-af zen-v2-af-dialog zen-animate-pop"
      data-surface="page"
      onKeyDown={(e) => wrapTab(e, panelRef.current)}
    >
      <TitleBlock id={titleId} icon={Lock} title={ask.title} description={ask.description} />
      <div className="zen-v2-af-body">
        <PassphraseForm ask={ask} onCancel={cancelPassphrase} />
      </div>
    </div>
  )
}

function PassphraseSheet({ ask }: { ask: Ask }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  // Cancel leaves through the sheet's own dismissal, so the command is refused once it is gone.
  const dismissed = useRef(false)
  const leave = (): void => sheet.current?.dismiss()
  useBackSurface({
    name: 'autofill-passphrase',
    onProgress: (p) => sheet.current?.backProgress(p),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(leave)
  return createPortal(
    <BottomSheet
      ref={sheet}
      onDismissed={() => {
        if (dismissed.current) return
        dismissed.current = true
        cancelPassphrase()
      }}
      handleLabel="Dismiss"
      className="zen-v2-af zen-v2-af-sheet"
      fitContent
    >
      <InSheet.Provider value>
        <div className="zen-v2-af" data-surface="page" aria-labelledby={titleId}>
          <SheetTitleBlock
            id={titleId}
            icon={Lock}
            title={ask.title}
            description={ask.description}
          />
          <PassphraseForm ask={ask} onCancel={leave} />
        </div>
      </InSheet.Provider>
    </BottomSheet>,
    document.body
  )
}
