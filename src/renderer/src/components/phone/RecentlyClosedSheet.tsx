import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import { displayUrl, getHost } from '@shared/url'
import { historyAdapter, type ClosedEntrySummary } from '@renderer/lib/historyAdapter'
import { timeOrDay } from '@renderer/lib/historyGroups'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneEmptyNote, PhoneListRow, RowFavicon } from './PhoneList'
import { PhoneSheet } from './PhoneSheet'

/**
 * The overview menu's "Recently Closed" (matrix TAB-22, TAB-23): the core's recently closed tabs
 * (`session.recentlyClosed`, the history contract v0) as a sheet on the frame's dialog host,
 * one v2 row per tab – favicon, title, host and when it closed (§9.13) – newest first; a tap
 * brings the tab back through `session.restoreClosed`, into its space and position, once the
 * sheet is gone. The list is read again whenever the core says it changed (an Undo from the
 * toast, a tab closed elsewhere), so a row never names a tab that is back already.
 */
export function RecentlyClosedSheet({
  initial,
  onClose,
  onRestore
}: {
  /** The list as the menu had it, so the sheet opens full. */
  initial: readonly ClosedEntrySummary[]
  onClose: () => void
  onRestore: (entry: ClosedEntrySummary) => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const [entries, setEntries] = useState<readonly ClosedEntrySummary[]>(initial)
  useEffect(
    () =>
      historyAdapter.onRecentlyClosedChanged(() => {
        void historyAdapter.recentlyClosed().then(setEntries)
      }),
    []
  )
  // "Today" and the times are judged as the sheet opens; it is never up for long.
  const [now] = useState(() => Date.now())
  const tabs = entries.filter((entry) => entry.kind === 'tab')
  return (
    <PhoneSheet
      name="overview-recently-closed"
      title="Recently closed"
      focus="dialog"
      onClose={onClose}
      sheetRef={sheet}
      contentKey={tabs.map((entry) => entry.id).join('/')}
    >
      <div className="zen-phone-list pb-2">
        {tabs.length === 0 ? (
          <PhoneEmptyNote>Tabs you close will show up here</PhoneEmptyNote>
        ) : (
          tabs.map((entry) => (
            <ClosedTabRow
              key={entry.id}
              entry={entry}
              now={now}
              onTap={() => sheet.current?.dismiss(() => onRestore(entry))}
            />
          ))
        )}
      </div>
    </PhoneSheet>
  )
}

function ClosedTabRow({
  entry,
  now,
  onTap
}: {
  entry: ClosedEntrySummary
  now: number
  onTap: () => void
}): JSX.Element {
  const title = entry.title || (entry.url ? displayUrl(entry.url) : 'Tab')
  const host = entry.url ? getHost(entry.url).replace(/^www\./, '') || displayUrl(entry.url) : ''
  const when = timeOrDay(entry.closedAt, now)
  const subtitle = host ? `${host} · ${when}` : when
  return (
    <PhoneListRow
      icon={
        <RowFavicon
          src={entry.favicon}
          fallback={<Globe className="h-5 w-5 opacity-60" strokeWidth={1.75} />}
        />
      }
      title={title}
      subtitle={subtitle}
      ariaLabel={`${title}, ${subtitle}`}
      onTap={onTap}
    />
  )
}
