import type { JSX } from 'react'
import { useEffect, useId, useRef } from 'react'
import { KeyRound, ShieldAlert } from 'lucide-react'
import type { CredentialLeakAction, CredentialLeakWarning, UIState } from '@shared/types'
import { useBackSurface } from '@renderer/lib/back'
import {
  LEAK_WARNING_BODY,
  LEAK_WARNING_NO_USERNAME,
  LEAK_WARNING_TITLE,
  closeLeakWarning,
  currentLeakWarning,
  openLeakWarning,
  respondToLeak
} from '@renderer/lib/credentialLeak'
import { useViewport } from '@renderer/lib/formFactor'
import { useFrameDialog } from '@renderer/lib/portals'
import { uiStore } from '@renderer/lib/ui'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { PreviewRow } from './AutofillPrompts'
import { Btn, Footer, InSheet, SheetTitleBlock, TitleBlock, useEscape, wrapTab } from './controls'

/** The change-password page the primary opens: the core resolves it (`passwords.leakRespond`). */
type Respond = (action: CredentialLeakAction) => void

/**
 * Chrome's leak warning at sign-in (ID-31): the password just submitted in the active tab is
 * known breached (`UIState.passwords.leaks`, `lib/credentialLeak.ts`). One composition in the
 * two chromes (§9.23): the title block – the shield glyph, "Change your password", Chrome's
 * sentence as the description – then the account the sign-in was for as a static row (§9.34),
 * one line with the way into the password manager as an inline link (§9.10), and the §9.11
 * footer, Ignore and the primary Change password. On a mouse a §9.5 dialog in the frame's
 * dialog host, whose scrim is the one dim over the page's picture; on a phone a prompt sheet on
 * the `BottomSheet` chassis, hosted by the same host (`ownScrim`: the sheet's scrim is the
 * stack's, its press the dismissal). Every way out answers the core: the buttons and the link
 * with their action, Escape, the scrim, the back gesture and a drag away with `dismiss`, which
 * only closes it (Chrome shows the warning once per credential either way).
 *
 * The page does not wait on the answer – the navigation the sign-in started was never held –
 * so the warning takes no capability from it; it goes up over the page's picture like every
 * frame dialog (`openLeakWarning`) and the live page comes back once it has gone.
 */
export function LeakWarnings({ state }: { state: UIState }): JSX.Element | null {
  const warning = currentLeakWarning(state)
  const phone = useViewport().formFactor === 'phone'
  // A phone save sheet that is already up keeps the screen: the warning follows it (the sheet
  // that has not risen yet waits for the warning instead, `AutofillPrompts`).
  const savePromptUp = uiStore.use((s) => s.autofillPrompt !== null)
  if (!warning || (phone && savePromptUp)) return null
  return <Warning key={warning.id} warning={warning} phone={phone} />
}

function Warning({
  warning,
  phone
}: {
  warning: CredentialLeakWarning
  phone: boolean
}): JSX.Element {
  const answered = useRef(false)
  // The page's view hides under the chrome that overlaps it; its picture stands in meanwhile.
  useEffect(() => {
    void openLeakWarning(warning.tabId)
    return () => closeLeakWarning()
  }, [warning.tabId])
  const respond: Respond = (action) => {
    if (answered.current) return
    answered.current = true
    respondToLeak(warning.id, action)
  }
  return phone ? (
    <LeakSheet warning={warning} respond={respond} />
  ) : (
    <LeakDialog warning={warning} respond={respond} />
  )
}

/**
 * The body under the title block: the account row, the manager link and the footer. `act` is
 * the surface's way of answering – at once in the dialog, on the phone once the sheet has left.
 */
function Body({ warning, act }: { warning: CredentialLeakWarning; act: Respond }): JSX.Element {
  return (
    <div className="zen-v2-af-form">
      <PreviewRow
        icon={KeyRound}
        title={warning.username || LEAK_WARNING_NO_USERNAME}
        subtitle={warning.site}
      />
      <p>
        Review all your saved passwords in the{' '}
        <a
          className="zen-v2-link"
          href="zenium://settings/autofill"
          data-leak-manager=""
          onClick={(e) => {
            e.preventDefault()
            act('openManager')
          }}
        >
          password manager
        </a>
        .
      </p>
      <Footer count={2}>
        <Btn onClick={() => act('ignore')}>Ignore</Btn>
        <Btn variant="primary" onClick={() => act('changePassword')}>
          Change password
        </Btn>
      </Footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Desktop dialog (§9.5) in the frame
// ---------------------------------------------------------------------------

/**
 * A `--v2-dialog` at the form width over the host's scrim (§9.5, §9.20). A title-and-notice
 * dialog: the container takes the focus as it opens, named by the title and described by the
 * sentence (§9.22); Tab wraps inside; Escape, the scrim and back dismiss it.
 */
function LeakDialog({
  warning,
  respond
}: {
  warning: CredentialLeakWarning
  respond: Respond
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const dismiss = (): void => respond('dismiss')
  useFrameDialog({ onScrimPress: dismiss })
  useEscape(dismiss)
  useBackSurface({ name: 'credential-leak', onCommit: dismiss })
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      data-credential-leak=""
      className="zen-v2-af zen-v2-af-dialog zen-animate-pop"
      data-surface="page"
      onKeyDown={(e) => wrapTab(e, panelRef.current)}
    >
      <TitleBlock
        id={titleId}
        icon={ShieldAlert}
        title={LEAK_WARNING_TITLE}
        description={LEAK_WARNING_BODY}
        descriptionId={descriptionId}
      />
      <Body warning={warning} act={respond} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phone sheet (§9.11, §9.23) on the BottomSheet chassis
// ---------------------------------------------------------------------------

/**
 * The prompt sheet: no 48 header – the grip strip, the chassis' title block with the 20 px
 * shield, the body, the §9.11 footer whose two peers share the width. The chassis owns the Tab
 * trap, the inert chrome, the recede and the stack's scrim; the focus on open is this
 * surface's: a title-and-notice sheet focuses its container (§9.22) – named by the title,
 * described by the sentence – where the chassis' rule would land on the first control, the
 * inline manager link. What a button, the link, the scrim, back, Escape or a drag decided is
 * answered once the sheet has left (`onDismissed`), so the page comes back under nothing.
 */
function LeakSheet({
  warning,
  respond
}: {
  warning: CredentialLeakWarning
  respond: Respond
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const answer = useRef<CredentialLeakAction>('dismiss')
  const leave = (action: CredentialLeakAction): void => {
    answer.current = action
    sheet.current?.dismiss()
  }
  // Runs after the chassis' own focus effect (a child's effects run first) and so wins.
  useEffect(() => {
    bodyRef.current?.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true })
  }, [])
  useFrameDialog({ onScrimPress: () => leave('dismiss'), ownScrim: true })
  useBackSurface({
    name: 'credential-leak',
    onProgress: (p) => sheet.current?.backProgress(p),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss())
  // The sheet's layer is the host slot's child itself (`data-sheet-layer`).
  return (
    <BottomSheet
      ref={sheet}
      hosted
      onDismissed={() => respond(answer.current)}
      handleLabel="Dismiss"
      labelledBy={titleId}
      describedBy={descriptionId}
      className="zen-v2-af zen-v2-af-sheet"
      fitContent
    >
      <InSheet.Provider value>
        <div ref={bodyRef} className="zen-v2-af" data-surface="page" data-credential-leak="">
          <SheetTitleBlock
            id={titleId}
            icon={ShieldAlert}
            title={LEAK_WARNING_TITLE}
            description={LEAK_WARNING_BODY}
            descriptionId={descriptionId}
          />
          <Body warning={warning} act={leave} />
        </div>
      </InSheet.Provider>
    </BottomSheet>
  )
}
