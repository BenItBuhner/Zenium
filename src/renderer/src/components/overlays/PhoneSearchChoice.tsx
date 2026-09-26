import type { JSX, RefCallback } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { PhoneSearchChoiceActions, PhoneSearchChoiceStep } from './PhoneOnboarding'

/**
 * The EEA's search-engine choice screen standing on its own over the phone shell (W6-2 /
 * OMN-26; `searchChoiceCovers`, mounted by `PhoneShell`): the first-run tour's chassis – one
 * page that is the window (§9.29), the space gradient behind, the window family's inks – holding
 * the tour's choice step alone, with §9.16's 56 band empty where the tour's progress sits so the
 * title stands where the tour's does, and the tour's footer pair (§9.11). A run that finds the
 * screen still owed (the tour's step skipped, an existing profile in the EEA) raises it here,
 * and so does Settings › Search › "Choose your search engine again" (`searchChoice.askAgain`).
 *
 * The core answers `searchChoice.choose` / `searchChoice.skip` with the state that takes the
 * screen down; nothing is kept here. The system back gesture is taken and keeps the screen
 * (Chrome's `chrome://search-engine-choice` stays until it is answered): "Skip for now" is the
 * way out that asks again, and the shell under the screen – the bar, the page's view – waits for
 * the answer as it waits for the tour's end (`PhoneShell`, `firstRunCovers`).
 */
export function PhoneSearchChoiceScreen({ state }: { state: UIState }): JSX.Element {
  const [picked, setPicked] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  // The dialog is labelled by its visible title (§9.22), not a second copy of the words.
  const titleId = useId()
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'y' })
  const attachColumn = useCallback<RefCallback<HTMLDivElement>>((el) => fade(el), [fade])

  // The screen takes the focus as it comes up (§9.22: the dialog root, which takes no ring), so
  // a keyboard or TalkBack starts inside it and nothing under the modal keeps the focus.
  useEffect(() => {
    root.current?.focus()
  }, [])
  // Back is consumed and the screen stays: nothing to peel, nothing to close.
  useBackSurface({ name: 'search-choice', onCommit: () => {} })

  const skip = (): void => run('searchChoice.skip', undefined)
  const choose = (): void => {
    if (picked !== null) run('searchChoice.choose', { engineId: picked })
  }
  return (
    <div
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-surface="window"
      className="zen-firstrun absolute inset-0 z-50 flex flex-col outline-none"
      data-testid="search-choice-screen"
      style={{
        paddingTop: 'var(--zen-inset-top)',
        paddingBottom: 'var(--zen-inset-bottom)',
        paddingLeft: 'var(--zen-inset-left)',
        paddingRight: 'var(--zen-inset-right)'
      }}
    >
      <div className="zen-texture" />
      {/* §9.16's 56 band, empty: no progress to show, no Back – the title sits where the tour's does. */}
      <div className="h-14 shrink-0" />
      <div className="relative min-h-0 flex-1">
        <div
          ref={attachColumn}
          className="absolute inset-x-0 inset-y-0 mx-auto flex w-full max-w-[520px] flex-col overflow-y-auto pb-4"
          style={{ touchAction: 'pan-y', overscrollBehavior: 'contain' }}
        >
          <PhoneSearchChoiceStep
            state={state}
            picked={picked}
            onPick={setPicked}
            titleId={titleId}
          />
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[520px] shrink-0 gap-2 px-4 pb-4 pt-2">
        <PhoneSearchChoiceActions picked={picked} onSkip={skip} onChoose={choose} />
      </div>
    </div>
  )
}
