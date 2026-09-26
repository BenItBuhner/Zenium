import type { JSX } from 'react'
import { useId, useRef } from 'react'
import { Globe } from 'lucide-react'
import type { SharePanelRequest, SharePanelTarget } from '@shared/types'
import { useEscapeUnlessLeaving } from '@renderer/hooks/useEscape'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { SheetPresence, useSheetLeave } from '@renderer/lib/motion/presence'
import {
  SHARE_PANEL_MORE,
  afterPageShown,
  sharePanelChips,
  sharePanelCopy,
  sharePanelPreview,
  type SharePanelChip
} from '@renderer/lib/sharePanel'
import { answerSharePanel, openLongScreenshot, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { RowFavicon } from '../phone/PhoneList'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/**
 * The browser's own share panel (Android below 14, where the system sheet has no row for the
 * sharing app's actions; SH-03), as Chrome 152's sharing hub stands in for the system sheet
 * there: a sheet on the menu's chassis that reads from its subject down (v2 draft §9.38) – the
 * share's preview in the header's place (the favicon at 20, or the image itself at 40, the title
 * over the link; a selection's text over the page's link), then Zenium's own chips in the
 * Android 14 action row's order (Copy link, QR code, Long screenshot, Print; `sharePanelChips`),
 * a hairline, and the apps the user shares to, ranked by Zenium's own record, More for the
 * system sheet at the row's end – the 14 sheet's order, the ranked row nearest the thumb
 * (Chrome's hub puts its apps first; that is Chrome's). The host holds the share's intent under
 * the request's id until the sheet answers (`answerSharePanel`); every way out that picks
 * nothing is the dismissal. Mounted once, above whichever shell is up; the leave outlives the
 * request (`SheetPresence`, v2 draft §11.1).
 *
 * A share the app menu started arrives while the menu still stands (`lib/shareSeam.ts`,
 * §9.38's hand-off): the menu's sheet draws the panel then – its chassis becoming the panel's,
 * one sheet, no bare page between – with the same preview and rows (`SharePanelPreview`,
 * `SharePanelContent`); this layer stands aside for it. A page's `navigator.share` and a share
 * whose menu has gone rise here on their own.
 */
export function SharePanelLayer(): JSX.Element | null {
  const request = uiStore.use((s) => s.sharePanel)
  const hosted = uiStore.use((s) => s.shareSeam?.phase === 'hosting')
  return (
    <SheetPresence>
      {request && !hosted ? <SharePanelSheet key={request.id} request={request} /> : null}
    </SheetPresence>
  )
}

function SharePanelSheet({ request }: { request: SharePanelRequest }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()

  // The system back gesture pulls the sheet down like a drag; commit or the back button slides
  // it away, which lets the share go (`onDismissed`).
  useBackSurface({
    name: 'share-panel',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscapeUnlessLeaving(() => sheet.current?.dismiss(), useSheetLeave()?.leaving)

  // The sheet leaves first, then the pick runs: the other app, the system sheet or a chip's own
  // surface comes up over the page, not over a sheet on its way out.
  const pick = (then: () => void): void => sheet.current?.dismiss(then)
  const release = (): void => answerSharePanel(request.id, { kind: 'dismiss' })

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={release}
      contentKey={request.id}
      handleLabel="Dismiss"
      labelledBy={titleId}
      className="zen-share-panel"
      header={<SharePanelPreview request={request} titleId={titleId} />}
    >
      <SharePanelContent request={request} pick={pick} />
    </BottomSheet>
  )
}

/**
 * The panel's rows – Zenium's own chips, a hairline, the apps with More at the end – as the
 * panel's own sheet draws them and as the app menu's sheet draws them once it hosts the panel
 * (`MenuSheet.tsx`). `pick` is the chassis's leave with the action after it: the other app, the
 * system sheet or a chip's own surface comes up over the page, not over a sheet on its way out.
 * The page view itself comes back later still, once the sheet has unmounted and the host has
 * drawn the page again (`lib/pageView.ts`): the one pick that copies the page waits for that
 * (`afterPageShown`). A chip the chrome runs itself (Copy, Long screenshot, Print) is reported
 * as `chip`, so a page's awaited share hears `shared` for it as Chrome's does on a first-party
 * tap; the chips the host carries out (QR, Copy image) go by their own kinds.
 */
export function SharePanelContent({
  request,
  pick
}: {
  request: SharePanelRequest
  pick: (then: () => void) => void
}): JSX.Element {
  const chips = sharePanelChips(request)
  const ran = (chip: SharePanelChip): void =>
    answerSharePanel(request.id, { kind: 'chip', chip: chip.kind })

  const onChip = (chip: SharePanelChip): void => {
    switch (chip.kind) {
      case 'copy':
        if (request.kind === 'image') {
          pick(() => answerSharePanel(request.id, { kind: 'copyImage' }))
          return
        }
        pick(() => {
          ran(chip)
          const copy = sharePanelCopy(request)
          if (copy) run('clipboard.writeText', copy)
        })
        return
      case 'screenshot': {
        const tabId = request.tabId
        pick(() => {
          ran(chip)
          if (tabId) afterPageShown(tabId, () => openLongScreenshot(tabId))
        })
        return
      }
      case 'print':
        pick(() => {
          ran(chip)
          if (request.tabId) run('page.print', { tabId: request.tabId })
        })
        return
      case 'qr':
        pick(() => answerSharePanel(request.id, { kind: 'qr' }))
        return
    }
  }

  return (
    <>
      <div className="zen-share-panel-row" data-row="chips">
        {chips.map((chip) => (
          <button
            key={chip.kind}
            type="button"
            className="zen-share-panel-cell"
            data-kind={chip.kind}
            onClick={() => onChip(chip)}
          >
            <span className="zen-v2-icon-button zen-share-panel-box" aria-hidden>
              <chip.icon />
            </span>
            <span className="zen-share-panel-caption">{chip.label}</span>
          </button>
        ))}
      </div>
      <div className="zen-sheet-sep" role="presentation" />
      <div className="zen-share-panel-row" data-row="apps">
        {request.targets.map((target) => (
          <TargetCell
            key={target.component}
            target={target}
            onPick={() =>
              pick(() =>
                answerSharePanel(request.id, { kind: 'target', component: target.component })
              )
            }
          />
        ))}
        <button
          type="button"
          className="zen-share-panel-cell"
          data-kind="more"
          onClick={() => pick(() => answerSharePanel(request.id, { kind: 'more' }))}
        >
          <span className="zen-v2-icon-button zen-share-panel-box" aria-hidden>
            <SHARE_PANEL_MORE.icon />
          </span>
          <span className="zen-share-panel-caption">{SHARE_PANEL_MORE.label}</span>
        </button>
      </div>
    </>
  )
}

/**
 * What is being shared (PUI-18's header, as a link's menu opens on its link): for a page or a
 * link the favicon at 20 – the globe at 69 % for a page the cache holds none for – the title
 * 15/600 over the link 13 in the deemphasised ink, one line each; for an image the picture itself
 * at 40 in the favicon's place; for a selection the selected text leads, on two lines at most,
 * the page's link under it without the highlight's `#:~:text=` fragment (`displayedLink`), and no
 * favicon – the text is its own picture (Chrome's hub: the text, then the link; §9.38). A page's
 * share of text and a link reads the same way, its text first (Chrome's `LINK_AND_TEXT`
 * preview); a page's link alone reads as the page's. The first line names the sheet. `className`
 * is the menu's sheet's, for the preview's rise as it takes the menu's header (`MenuSheet.tsx`).
 */
export function SharePanelPreview({
  request,
  titleId,
  className
}: {
  request: SharePanelRequest
  titleId: string
  className?: string
}): JSX.Element {
  const { title, detail } = sharePanelPreview(request)
  return (
    <div
      className={cn('zen-menu-link-header zen-share-panel-preview', className)}
      data-kind={request.kind}
    >
      {request.image ? (
        <img src={request.image} alt="" className="zen-menu-link-thumbnail" draggable={false} />
      ) : request.kind === 'text' ? null : (
        <span className="zen-menu-link-favicon" aria-hidden>
          <RowFavicon
            src={request.favicon}
            fallback={<Globe className="zen-list-standin h-5 w-5" strokeWidth={1.75} />}
          />
        </span>
      )}
      <span className="zen-menu-link-text">
        <span id={titleId} className="zen-menu-link-title">
          {title}
        </span>
        {detail && <span className="zen-menu-link-url">{detail}</span>}
      </span>
    </div>
  )
}

/** One app of the row: its launcher icon at 40 in the chip's 44 box, its name under. */
function TargetCell({
  target,
  onPick
}: {
  target: SharePanelTarget
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-share-panel-cell"
      data-kind="target"
      data-component={target.component}
      onClick={onPick}
    >
      <span className="zen-v2-icon-button zen-share-panel-box" aria-hidden>
        <img src={target.icon} alt="" className="zen-share-panel-app" draggable={false} />
      </span>
      <span className="zen-share-panel-caption">{target.label}</span>
    </button>
  )
}
