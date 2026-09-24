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
import { RowFavicon } from '../phone/PhoneList'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

/**
 * The browser's own share panel (Android below 14, where the system sheet has no row for the
 * sharing app's actions; SH-03), as Chrome 152's sharing hub stands in for the system sheet
 * there: a sheet on the menu's chassis with the share's preview in the header's place – the
 * favicon at 20, or the image itself at 40, the title over the link – then the apps the user
 * shares to, ranked by Zenium's own record, More for the system sheet at the row's end, a
 * hairline, and Zenium's own chips (Chrome's order: Copy, Long screenshot, Print, QR code). The
 * host holds the share's intent under the request's id until the sheet answers
 * (`answerSharePanel`); every way out that picks nothing is the dismissal. Mounted once, above
 * whichever shell is up; the leave outlives the request (`SheetPresence`, v2 draft §11.1).
 */
export function SharePanelLayer(): JSX.Element | null {
  const request = uiStore.use((s) => s.sharePanel)
  return (
    <SheetPresence>
      {request ? <SharePanelSheet key={request.id} request={request} /> : null}
    </SheetPresence>
  )
}

function SharePanelSheet({ request }: { request: SharePanelRequest }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  const preview = sharePanelPreview(request)
  const chips = sharePanelChips(request)

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
  // surface comes up over the page, not over a sheet on its way out. The page view itself comes
  // back later still, once the sheet has unmounted and the host has drawn the page again
  // (`lib/pageView.ts`): the one pick that copies the page waits for that (`afterPageShown`).
  const pick = (then: () => void): void => sheet.current?.dismiss(then)
  const release = (): void => answerSharePanel(request.id, { kind: 'dismiss' })

  const onChip = (chip: SharePanelChip): void => {
    switch (chip.kind) {
      case 'copy':
        if (request.kind === 'image') {
          pick(() => answerSharePanel(request.id, { kind: 'copyImage' }))
          return
        }
        pick(() => {
          release()
          const copy = sharePanelCopy(request)
          if (copy) run('clipboard.writeText', copy)
        })
        return
      case 'screenshot': {
        const tabId = request.tabId
        pick(() => {
          release()
          if (tabId) afterPageShown(tabId, () => openLongScreenshot(tabId))
        })
        return
      }
      case 'print':
        pick(() => {
          release()
          if (request.tabId) run('page.print', { tabId: request.tabId })
        })
        return
      case 'qr':
        pick(() => answerSharePanel(request.id, { kind: 'qr' }))
        return
    }
  }

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={release}
      contentKey={request.id}
      handleLabel="Dismiss"
      labelledBy={titleId}
      className="zen-share-panel"
      header={
        <Preview
          request={request}
          title={preview.title}
          detail={preview.detail}
          titleId={titleId}
        />
      }
    >
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
      <div className="zen-sheet-sep" role="presentation" />
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
    </BottomSheet>
  )
}

/**
 * What is being shared (PUI-18's header, as a link's menu opens on its link): the favicon at 20
 * – the globe at 69 % for a page the cache holds none for – or the image itself at 40, the title
 * 15/600 over the link 13 in the deemphasised ink, one line each. The title names the sheet.
 */
function Preview({
  request,
  title,
  detail,
  titleId
}: {
  request: SharePanelRequest
  title: string
  detail: string
  titleId: string
}): JSX.Element {
  return (
    <div className="zen-menu-link-header zen-share-panel-preview">
      {request.image ? (
        <img src={request.image} alt="" className="zen-menu-link-thumbnail" draggable={false} />
      ) : (
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
