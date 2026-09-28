import type { JSX } from 'react'
import { useState } from 'react'
import type { Rect, Tab } from '@shared/types'
import {
  TRACKER_REPORT_EMPTY,
  TRACKER_REPORT_SETTINGS,
  TRACKER_REPORT_TITLE,
  blockedSiteCategoryLabel,
  trackerReportOrder,
  trackerReportRows
} from '@renderer/lib/blockingUi'
import { openSettings } from '@renderer/lib/pages'
import { POPOVER_WIDTH } from '@renderer/lib/portals'
import { siteInfoOpener } from '@renderer/lib/siteInfo'
import { siteOriginOf } from '@shared/blocking'
import { DesktopPopover, EmptyLine, Level, ListRow, RowValue, TitleBlock } from './primitives'

/**
 * The tracker report (PS-33): the §9.20 list popover the shield's count pill opens on the
 * desktop, 320 wide, with the sites the engine blocked requests to on the page and no controls.
 * Each §10.1 row is the registrable domain as its label, the kind of rule that blocked it as the
 * 13/69% line and the request count as a tabular-nums aside. The rows sort by count as the list
 * opens and never re-sort while it is up; a site blocked later joins at the foot (§9.29: no
 * jitter); the counts themselves move live. Empty, it says so in §9.17's one sentence. It is
 * informational only – no per-site allow – and its one footer is §9.20's third form: a hairline
 * and a 32 navigation row to Settings › Privacy and security, at the site. Private tabs get the
 * same list; nothing about it persists (the record is the tab's, gone with its document).
 *
 * The chassis is the site information's (`DesktopPopover`): placed under the pill, light
 * dismissed, Escape and the focus return to the count pill as §9.22 has them. `focus` lands on
 * the first control, which is the footer row – the rows are facts (§9.34).
 */
export function TrackersPopover({
  tab,
  anchor,
  bar,
  closing,
  onDismiss,
  onClosed
}: {
  tab: Tab
  anchor: Rect | null
  bar: Rect | null
  /** The store let go of the tab (another surface took over, the tab closed): leave now. */
  closing: boolean
  /** Escape, a press outside, a window resize: the owner starts the exit. */
  onDismiss: () => void
  onClosed: () => void
}): JSX.Element {
  const titleId = `trackers-${tab.id}`
  // The row order is settled as the list opens and only ever grows (settled during render, so
  // a site blocked between two frames never shows out of place for a frame).
  const [order, setOrder] = useState<readonly string[]>([])
  const nextOrder = trackerReportOrder(order, tab.blockedSites)
  if (nextOrder !== order) setOrder(nextOrder)
  const rows = trackerReportRows(nextOrder, tab.blockedSites)
  const origin = siteOriginOf(tab.url)
  return (
    <DesktopPopover
      anchor={anchor}
      bar={bar}
      width={POPOVER_WIDTH.list}
      labelledBy={titleId}
      closing={closing}
      onClosed={onClosed}
      onDismiss={onDismiss}
      anchorElement={siteInfoOpener}
      data-testid="tracker-report"
    >
      {() => (
        <Level direction="none" className="min-h-0">
          <TitleBlock id={titleId} title={TRACKER_REPORT_TITLE} />
          <div className="min-h-0 flex-1 overflow-y-auto pb-1" data-tracker-rows="">
            {rows.length === 0 ? (
              <EmptyLine>{TRACKER_REPORT_EMPTY}</EmptyLine>
            ) : (
              rows.map((site) => (
                <ListRow
                  key={site.domain}
                  label={site.domain}
                  description={blockedSiteCategoryLabel(site.category)}
                  trailing={
                    <RowValue className="tabular-nums" data-count={site.count}>
                      {site.count}
                    </RowValue>
                  }
                  data-tracker-row={site.domain}
                />
              ))
            )}
          </div>
          <div className="shrink-0" data-footer="navigation">
            <div className="mx-4 mb-1 h-px bg-[var(--v2-border)]" aria-hidden />
            <button
              type="button"
              className="flex h-8 w-full items-center px-4 text-start text-[15px] leading-5 text-[var(--v2-text)] transition-[background] duration-[120ms] hover:bg-[var(--v2-fill-hover)] focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--v2-ring)]"
              onClick={() => {
                onDismiss()
                openSettings('privacy', origin ? { site: origin } : undefined)
              }}
            >
              {TRACKER_REPORT_SETTINGS}
            </button>
          </div>
        </Level>
      )}
    </DesktopPopover>
  )
}
