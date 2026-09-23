import type { JSX } from 'react'
import { useState } from 'react'
import type { SiteDataOriginRow } from '@shared/siteData'
import {
  SITE_DATA_TEXT,
  originDescription,
  originLabel,
  siteDataCountAside,
  siteDataListingNotes
} from '@renderer/lib/siteDataUi'
import { V2Button } from '../../extensions/v2'
import { SheetFooter } from './blocks'
import { attachLineCount } from './lineCount'
import { RowText } from './rows'
import { SiteDataPrompt } from './SiteDataPrompt'
import { useSiteDataListing } from './useSiteDataListing'

/**
 * See all site data on the two-pane layout (Chrome's `chrome://settings/content/all`, PS-25):
 * the body of the dialog the "See all site data and permissions" row opens (`siteDataRows.tsx`,
 * `FormSheet.body: 'list'` – the dialog stands at most 80% of the frame and its body scrolls
 * under the title block, design language v2 §9.20 and #314 (c); the phone leaves for the
 * drill-in page instead, `SiteDataPage.tsx`). It draws the engine's reading
 * (`useSiteDataListing`) under one heading, "Sites", with the count as the heading's aside –
 * "1,000 of 1,204 sites" when the listing stopped at the cap, with the cap's one line under the
 * heading – and, where no origin could be sized (Electron), the honest "Sizes are unavailable on
 * this device." once, never per row (§9.17, §9.18).
 *
 * Each origin is a 52 row (§10.5; the description clamped to two lines): the host on the first
 * line, its cookies, its size where the host sized it and its permissions on the second, then
 * the policy's word for it when a list holds it; the trailing Clear is the desktop's 32 button in
 * the row in the danger ink (§10.5, §9.21: the row grows around it, which a two-line row already
 * does), the §9.30 busy button while the engine clears, the row leaving the list when it has (no
 * motion on a layout property), staying with the failure line in the danger ink when it has
 * not. Clear all stands in the dialog's footer (`SheetFooter`: §9.20's list-body footer – a
 * hairline in the gutter, the buttons at 12), in reach at the foot of the longest list, and
 * prompts first (§9.23 – the page's rule for a destructive page action, even where Chrome
 * clears at once): the prompt is §9.20's 320 notice over this dialog, which it covers. Clearing
 * signs the user out of the site; its permissions stay, as the title block says.
 */
export function SiteDataViewer(): JSX.Element {
  const data = useSiteDataListing()
  const [prompt, setPrompt] = useState(false)
  const { listing, rows, failed } = data
  const notes = listing ? siteDataListingNotes(listing) : []
  const status = failed
    ? SITE_DATA_TEXT.viewer.failed
    : listing === null
      ? SITE_DATA_TEXT.viewer.reading
      : rows.length === 0
        ? SITE_DATA_TEXT.viewer.empty
        : null
  return (
    <div className="zen-settings-groups zen-settings-sheet-rows" data-testid="site-data-viewer">
      <section
        role="group"
        className="zen-settings-group"
        data-group="site-data-origins"
        aria-label={SITE_DATA_TEXT.viewer.sites}
        aria-busy={listing === null && !failed ? true : undefined}
      >
        <h3 className="zen-v2-heading zen-settings-heading">
          {SITE_DATA_TEXT.viewer.sites}
          {listing && (
            <span className="zen-settings-heading-aside" data-testid="site-data-count">
              {siteDataCountAside(listing)}
            </span>
          )}
        </h3>
        {notes.map((note) => (
          <p key={note} className="zen-settings-group-description">
            {note}
          </p>
        ))}
        {data.allFailed && (
          <p className="zen-settings-group-description" data-tone="danger" role="alert">
            {SITE_DATA_TEXT.viewer.failed}
          </p>
        )}
        {status !== null ? (
          <p className="zen-settings-empty" data-tone={failed ? 'danger' : undefined}>
            {status}
          </p>
        ) : (
          rows.map((row) => (
            <OriginRow
              key={row.origin}
              row={row}
              sized={listing?.sized ?? false}
              busy={data.clearing.has(row.origin)}
              refused={data.refused.has(row.origin)}
              onClear={() => data.clearSite(row.origin)}
            />
          ))
        )}
      </section>
      <SheetFooter>
        <V2Button
          variant="danger"
          busy={data.clearingAll}
          disabled={rows.length === 0 && !data.clearingAll}
          aria-haspopup="dialog"
          data-testid="site-data-clear-all"
          onClick={() => setPrompt(true)}
        >
          {SITE_DATA_TEXT.viewer.clearAll}
        </V2Button>
      </SheetFooter>
      {prompt && (
        <SiteDataPrompt
          host="dialog"
          name="site-data-clear-all"
          title={SITE_DATA_TEXT.viewer.clearAllTitle}
          description={SITE_DATA_TEXT.viewer.clearAllDescription}
          action={SITE_DATA_TEXT.viewer.clearAll}
          close={() => setPrompt(false)}
          confirm={data.clearAll}
        />
      )}
    </div>
  )
}

/**
 * One origin: the host, its storage line (or the failure line when its Clear was refused), the
 * trailing Clear – the §9.34 row primitive as the page's static control row (`rows.tsx`
 * `ControlRow`), the control the target and not the row.
 */
function OriginRow({
  row,
  sized,
  busy,
  refused,
  onClear
}: {
  row: SiteDataOriginRow
  sized: boolean
  busy: boolean
  refused: boolean
  onClear: () => void
}): JSX.Element {
  const label = originLabel(row.origin)
  return (
    <div
      ref={attachLineCount}
      data-row={`site-data-origin:${row.origin}`}
      data-static=""
      data-tone={refused ? 'danger' : undefined}
      className="zen-settings-row zen-settings-control-row zen-v2-row"
    >
      <RowText
        label={label}
        description={refused ? SITE_DATA_TEXT.viewer.failed : originDescription(row, sized)}
      />
      <span className="zen-settings-trailing zen-settings-control">
        <V2Button
          variant="danger"
          busy={busy}
          aria-label={`${SITE_DATA_TEXT.viewer.clear} ${label}`}
          onClick={onClear}
        >
          {SITE_DATA_TEXT.viewer.clear}
        </V2Button>
      </span>
    </div>
  )
}
