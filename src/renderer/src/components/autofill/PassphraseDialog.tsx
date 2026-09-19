import type { JSX } from 'react'
import { useId, useRef } from 'react'
import { Lock } from 'lucide-react'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { useFrameDialog } from '@renderer/lib/portals'
import { answerPassphrase, cancelPassphrase } from '@renderer/lib/autofill'
import { uiStore, type UiState } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { InSheet, SheetTitleBlock, TitleBlock, useEscape, wrapTab } from './controls'
import { PassphraseForm } from './PassphraseForm'

type Ask = NonNullable<UiState['autofillPassphrase']>

/**
 * The vault passphrase asked for by a re-authenticated command that ran from the chrome rather
 * than from a page's picker – copying a card's number in Settings, for one (`withPassphrase` in
 * lib/autofill.ts). A modal dialog in the frame on desktop (§9.5, through the `FrameDialogHost`
 * `TabDialogs` mounts, so it centres over the frame wherever the caller sits, Settings included)
 * and a sheet on phones (§9.11, §9.23: the same title block after the grip strip, no 48
 * header), in the same host: the shared `PassphraseForm` (§9.30) with the refused attempt as
 * its error, Cancel and Unlock. Every answer repeats the command; dismissing it ends the command
 * refused.
 */
export function PassphraseDialog(): JSX.Element | null {
  const ask = uiStore.use((s) => s.autofillPassphrase)
  const phone = useViewport().formFactor === 'phone'
  if (!ask) return null
  return phone ? <PassphraseSheet ask={ask} /> : <PassphraseFrameDialog ask={ask} />
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
        <PassphraseForm
          error={ask.error}
          busy={ask.busy}
          onCancel={cancelPassphrase}
          onSubmit={(passphrase) => void answerPassphrase(passphrase)}
        />
      </div>
    </div>
  )
}

/**
 * The phone sheet on the `BottomSheet` chassis, hosted by the frame's dialog host it renders in
 * (`hosted`, its own scrim fading with its motion: `ownScrim`). The chassis moves the focus in
 * as it opens, wraps Tab and keeps the chrome inert; what is the surface's is Escape and back.
 */
function PassphraseSheet({ ask }: { ask: Ask }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  // Cancel leaves through the sheet's own dismissal, so the command is refused once it is gone.
  const dismissed = useRef(false)
  const leave = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: leave, ownScrim: true })
  useBackSurface({
    name: 'autofill-passphrase',
    onProgress: (p) => sheet.current?.backProgress(p),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(leave)
  return (
    <div className="zen-v2-af absolute inset-0" data-surface="page">
      <BottomSheet
        ref={sheet}
        hosted
        onDismissed={() => {
          if (dismissed.current) return
          dismissed.current = true
          cancelPassphrase()
        }}
        handleLabel="Dismiss"
        labelledBy={titleId}
        className="zen-v2-af zen-v2-af-sheet"
        fitContent
      >
        <InSheet.Provider value>
          <div className="zen-v2-af" data-surface="page">
            <SheetTitleBlock
              id={titleId}
              icon={Lock}
              title={ask.title}
              description={ask.description}
            />
            <PassphraseForm
              error={ask.error}
              busy={ask.busy}
              focusOnOpen={false}
              onCancel={leave}
              onSubmit={(passphrase) => void answerPassphrase(passphrase)}
            />
          </div>
        </InSheet.Provider>
      </BottomSheet>
    </div>
  )
}
