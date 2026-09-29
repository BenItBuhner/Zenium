import type { JSX } from 'react'
import { useId, useRef } from 'react'
import { Plus, Search } from 'lucide-react'
import type { ShareChooser, ShareChooserApp, ShareKind } from '@shared/shareTarget'
import { useEscapeUnlessLeaving } from '@renderer/hooks/useEscape'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { SheetPresence, useSheetLeave } from '@renderer/lib/motion/presence'
import { answerShareChooser, uiStore } from '@renderer/lib/ui'
import { LinkHeader } from '../menus/MenuSheet'
import { AppIcon } from '../phone/InstallSheet'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/**
 * Another app shared a link or text to Zenium and an installed web app declares a share target
 * for it (MW-63; `share_target` in its manifest): the core asks where it goes before it routes.
 * A §9.13 chooser sheet on the phone, whose header is the shared thing – a link on the §9.31
 * link header, text on the share panel's read-only twin of it – then the house route first
 * ("Open in a new tab" for a link, "Search" for text) and a group headed "Apps": one row per
 * app, its icon at 20 and its name, no verb. Chrome's targets stand in the system share sheet as
 * WebAPKs; ours cannot, so the sheet is the route. Dismissing it drops the share. Tablets and a
 * mouse get the chooser as a centred dialog, as the external-protocol chooser does. Mounted once,
 * above whichever shell is up.
 *
 * The sheet's leave outlives its request (`SheetPresence`, v2 draft §11.1): a newer share that
 * goes its own way takes the chooser down (`share.chooserHide`), the store's `null` a leave.
 */
export function ShareChooserLayer(): JSX.Element | null {
  const chooser = uiStore.use((s) => s.shareChooser)
  const viewport = useViewport()
  const sheet = viewport.coarse && viewport.formFactor !== 'tablet'
  return (
    <SheetPresence>
      {!chooser ? null : sheet ? (
        <ChooserSheet key={chooser.requestId} chooser={chooser} />
      ) : (
        <ChooserDialog key={chooser.requestId} chooser={chooser} />
      )}
    </SheetPresence>
  )
}

// ---------------------------------------------------------------------------
// Copy: the ruling's three strings, nothing else
// ---------------------------------------------------------------------------

const HOUSE_ROW: Record<ShareKind, string> = { url: 'Open in a new tab', text: 'Search' }
const APPS_HEADING = 'Apps'

// ---------------------------------------------------------------------------
// Shared content
// ---------------------------------------------------------------------------

/** The header names the sheet (`aria-labelledby`): the link's title, or the text itself. */
function Header({ chooser, titleId }: { chooser: ShareChooser; titleId: string }): JSX.Element {
  if (chooser.link) return <LinkHeader header={chooser.link} titleId={titleId} />
  // Shared text on the share panel's preview: the §9.31 header read-only, the text on two lines
  // at most (`.zen-share-panel-preview[data-kind='text']`), no press fill – nothing happens on it.
  return (
    <div className="zen-menu-link-header zen-share-panel-preview" data-kind="text">
      <span className="zen-menu-link-text">
        <span id={titleId} className="zen-menu-link-title">
          {chooser.text}
        </span>
      </span>
    </div>
  )
}

/**
 * The rows: the house route, then the "Apps" group. A house row carries a 20 glyph in the
 * leading slot so its label lines up with the apps' names after their icons (§9.3, §10.3).
 */
function Body({
  chooser,
  onPick
}: {
  chooser: ShareChooser
  onPick: (appId: string | null) => void
}): JSX.Element {
  const headingId = useId()
  const HouseGlyph = chooser.kind === 'url' ? Plus : Search
  return (
    <div className="flex flex-col pb-2">
      <ul className="flex flex-col">
        <li>
          <button
            type="button"
            className="zen-sheet-item"
            data-route="house"
            onClick={() => onPick(null)}
          >
            <span className="zen-sheet-item-glyph" aria-hidden>
              <HouseGlyph />
            </span>
            <span className="min-w-0 flex-1 truncate">{HOUSE_ROW[chooser.kind]}</span>
          </button>
        </li>
      </ul>
      <h3 id={headingId} className="zen-sheet-heading">
        {APPS_HEADING}
      </h3>
      <ul className="flex flex-col" aria-labelledby={headingId}>
        {chooser.apps.map((app) => (
          <li key={app.id}>
            <AppRow app={app} onPick={() => onPick(app.id)} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One installed app: its icon at 20 (a letter tile when it has none) and its name, no verb. */
function AppRow({ app, onPick }: { app: ShareChooserApp; onPick: () => void }): JSX.Element {
  return (
    <button type="button" className="zen-sheet-item" data-app={app.id} onClick={onPick}>
      <span className="zen-sheet-item-glyph" aria-hidden>
        <AppIcon icon={app.icon} name={app.name} tint={null} size={20} />
      </span>
      <span className="min-w-0 flex-1 truncate">{app.name}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Phone: bottom sheet on the menu's chassis
// ---------------------------------------------------------------------------

function ChooserSheet({ chooser }: { chooser: ShareChooser }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  const answer = (appId: string | null | 'cancel'): void =>
    answerShareChooser(chooser.requestId, appId)

  // The system back gesture pulls the sheet down like a drag; commit or the back button slides it
  // away, which drops the share (`onDismissed`).
  useBackSurface({
    name: 'share-chooser',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscapeUnlessLeaving(() => sheet.current?.dismiss(), useSheetLeave()?.leaving)

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={() => answer('cancel')}
      contentKey={chooser.requestId}
      handleLabel="Dismiss"
      labelledBy={titleId}
      header={<Header chooser={chooser} titleId={titleId} />}
    >
      {/* The sheet leaves first; the pick's tab or app window comes up behind it. */}
      <Body chooser={chooser} onPick={(appId) => sheet.current?.dismiss(() => answer(appId))} />
    </BottomSheet>
  )
}

// ---------------------------------------------------------------------------
// Tablets and a mouse (DeX): a centred dialog
// ---------------------------------------------------------------------------

function ChooserDialog({ chooser }: { chooser: ShareChooser }): JSX.Element {
  const titleId = useId()
  const answer = (appId: string | null | 'cancel'): void =>
    answerShareChooser(chooser.requestId, appId)
  useBackSurface({ name: 'share-chooser', onCommit: () => answer('cancel') })
  useEscapeUnlessLeaving(() => answer('cancel'))
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-6">
      <div className="zen-sheet-scrim absolute inset-0" onClick={() => answer('cancel')} />
      <div
        role="dialog"
        // Modal: the scrim behind it takes every press, and Escape drops the share.
        aria-modal="true"
        aria-labelledby={titleId}
        className="zen-panel zen-animate-pop relative w-full max-w-[400px] pb-1"
      >
        <Header chooser={chooser} titleId={titleId} />
        <Body chooser={chooser} onPick={answer} />
      </div>
    </div>
  )
}
