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
import type { ActionRow, ItemRow, RowGroup } from './model'
import { RowView } from './rows'
import { SheetStack } from './sheets'
import { SiteDataPrompt } from './SiteDataPrompt'
import { useSheetStack } from './useSheetStack'
import { useSiteDataListing } from './useSiteDataListing'

/** The origin the row and its sheet stand for, as their ids carry it. */
const ORIGIN_ROW = 'site-data-origin:'

/**
 * See all site data on the phone (Chrome's All sites, PS-25): Privacy and Security's drill-in
 * page `zen://settings/privacy/site-data` (design language v2 §10.2, the #322 ruling (a)),
 * reached from "See all site data and permissions" and standing over the section in the tab's
 * history – a list of up to a thousand rows whose rows have their own action is a page, not a
 * sheet at its peek detent. The body is the engine's reading (`useSiteDataListing`) under the
 * page's paragraph and one heading, "Sites", with the count as the heading's aside and the cap's
 * and the sizes-unavailable lines under it (§9.17, §9.18), each origin a §10.4 item row – the
 * host, then its cookies, size and permissions and the policy's word for it – opening an item
 * sheet whose one row, "Clear site data", is the danger action row with its confirmation sheet
 * (§10.4: a destructive action is never an inline button on a phone; page → item sheet → prompt
 * is depth two from a page, §9.24). "Clear all site data" is the page's action row in the danger
 * ink under the paragraph, in reach before the list runs, with its own confirmation (§9.23). A
 * row whose clear the engine refused stays with the failure line in the danger ink; a cleared
 * row leaves the list and its sheet, the row gone, leaves with it. The confirmations are
 * `SiteDataPrompt`: the container takes the focus (§9.22), the sheet chassis recedes what is
 * under them.
 */
export function SiteDataPage(): JSX.Element {
  const data = useSiteDataListing()
  const sheets = useSheetStack()
  const [prompt, setPrompt] = useState<{ kind: 'all' } | { kind: 'site'; origin: string } | null>(
    null
  )
  const { listing, rows, failed } = data
  const notes = listing ? siteDataListingNotes(listing) : []
  const t = SITE_DATA_TEXT.viewer
  const clearAll: ActionRow = {
    kind: 'action',
    id: 'site-data-clear-all',
    label: t.clearAllRow,
    destructive: true,
    prompts: true,
    busy: data.clearingAll,
    disabled: rows.length === 0 && !data.clearingAll,
    onPress: () => setPrompt({ kind: 'all' })
  }
  const items = rows.map((row) =>
    originItem(
      row,
      listing?.sized ?? false,
      data.clearing.has(row.origin),
      data.refused.has(row.origin),
      () => setPrompt({ kind: 'site', origin: row.origin })
    )
  )
  const groups: RowGroup[] = [
    { id: 'site-data-page', heading: null, rows: [clearAll] },
    { id: 'site-data-origins', heading: t.sites, rows: items }
  ]
  const status = failed
    ? t.failed
    : listing === null
      ? t.reading
      : rows.length === 0
        ? t.empty
        : null
  const prompted =
    prompt?.kind === 'site' ? rows.find((r) => r.origin === prompt.origin) : undefined
  return (
    <div className="zen-settings-groups zen-settings-body" data-testid="site-data-page">
      <section className="zen-settings-group" data-group="site-data-page">
        <p className="zen-settings-group-description">{t.description}</p>
        {data.allFailed && (
          <p className="zen-settings-group-description" data-tone="danger" role="alert">
            {t.failed}
          </p>
        )}
        <RowView row={clearAll} ctx={sheets.ctx} />
      </section>
      <section
        role="group"
        className="zen-settings-group"
        data-group="site-data-origins"
        aria-label={t.sites}
        aria-busy={listing === null && !failed ? true : undefined}
      >
        <h3 className="zen-v2-heading zen-settings-heading">
          {t.sites}
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
        {status !== null ? (
          <p className="zen-settings-empty" data-tone={failed ? 'danger' : undefined}>
            {status}
          </p>
        ) : (
          items.map((row) => <RowView key={row.id} row={row} ctx={sheets.ctx} />)
        )}
      </section>
      <SheetStack
        requests={sheets.requests}
        groups={groups}
        ctx={sheets.ctx}
        closeTop={sheets.closeTop}
      />
      {prompt?.kind === 'all' && (
        <SiteDataPrompt
          host="sheet"
          name="site-data-clear-all"
          title={t.clearAllTitle}
          description={t.clearAllDescription}
          action={t.clearAll}
          close={() => setPrompt(null)}
          confirm={data.clearAll}
        />
      )}
      {prompt?.kind === 'site' && prompted && (
        <SiteDataPrompt
          host="sheet"
          name={`${ORIGIN_ROW}${prompted.origin}:clear`}
          title={t.clearSiteTitle(originLabel(prompted.origin))}
          description={t.clearSitePrompt}
          action={t.clearSite}
          close={() => setPrompt(null)}
          confirm={() => data.clearSite(prompted.origin)}
        />
      )}
    </div>
  )
}

/**
 * One origin as an item row (§10.4): the host over its storage line – or the failure line in
 * the danger ink when its clear was refused – opening the sheet titled with the host, the
 * storage line as its paragraph, and "Clear site data" as its one row: the danger action, busy
 * while the engine clears (§9.30), prompting first.
 */
function originItem(
  row: SiteDataOriginRow,
  sized: boolean,
  busy: boolean,
  refused: boolean,
  onClear: () => void
): ItemRow {
  const label = originLabel(row.origin)
  const line = originDescription(row, sized)
  const t = SITE_DATA_TEXT.viewer
  const clear: ActionRow = {
    kind: 'action',
    id: `${ORIGIN_ROW}${row.origin}:clear`,
    label: t.clearSite,
    description: refused ? t.failed : t.clearSiteDescription,
    tone: refused ? 'danger' : undefined,
    destructive: true,
    prompts: true,
    busy,
    onPress: onClear
  }
  return {
    kind: 'item',
    id: `${ORIGIN_ROW}${row.origin}`,
    label,
    description: refused ? t.failed : line,
    tone: refused ? 'danger' : undefined,
    sheet: {
      title: label,
      description: line,
      groups: [{ id: `${ORIGIN_ROW}${row.origin}:actions`, heading: null, rows: [clear] }]
    }
  }
}
