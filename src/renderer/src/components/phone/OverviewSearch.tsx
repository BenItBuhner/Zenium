import type { JSX, RefObject } from 'react'
import { useState } from 'react'
import { Search, X } from 'lucide-react'
import type { SyncRemoteTab } from '@shared/types'
import type { ClosedEntrySummary } from '@renderer/lib/historyAdapter'
import { OTHER_DEVICES_COPY, remoteTabLines } from '@renderer/lib/otherDevices'
import { SEARCH_TABS_PLACEHOLDER } from '@renderer/lib/overviewSearch'
import { RemoteTabRow } from './OtherDevicesGroup'
import { PhoneGroupHeading } from './PhoneList'
import { ClosedTabRow } from './RecentlyClosedSheet'
import type { SearchReach } from './useSearchReach'

/** The id of the field's input: what the preview host's `type:` step and the drivers find. */
export const OVERVIEW_SEARCH_ID = 'overview-search'

/**
 * The tab search's field (matrix TAB-21; v2 §9.12): the phone field, 40 tall at the grid's
 * gutter, pinned under the overview's header and over the segment – part of what stays put
 * while the pane under it scrolls and narrows.
 * On the overview's window backdrop it is a resting control in the URL bar's own fill
 * (`--v2-urlbar`) with the panel's shadow and no hairline – the pill's look, as the new tab
 * page's field wears it – its text in the page ink: a page surface standing on the window
 * (§9.29). The trailing X is one control with two meanings, the ones Escape and back have
 * (`TabOverview`): with a query it clears the field and keeps it up; empty, it closes the field.
 * The field takes the keyboard only from the header's magnifier (a user's tap, `inputRef`),
 * never as the overview opens.
 */
export function OverviewSearchField({
  value,
  inputRef,
  onChange,
  onClear,
  onClose
}: {
  value: string
  inputRef: RefObject<HTMLInputElement | null>
  onChange: (value: string) => void
  onClear: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="zen-overview-search shrink-0 px-3 pb-2" data-testid="overview-search">
      <div className="zen-phone-field zen-overview-search-field">
        <Search className="zen-phone-field-icon h-5 w-5" strokeWidth={1.75} aria-hidden />
        <input
          id={OVERVIEW_SEARCH_ID}
          ref={inputRef}
          type="search"
          value={value}
          // The label names the field, the placeholder is its example text (§9.12): different
          // words, so a reader hears a name and a hint, not the same thing twice (A11Y-01).
          aria-label="Search tabs"
          placeholder={SEARCH_TABS_PLACEHOLDER}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="zen-phone-field-clear zen-v2-field-clear"
          aria-label={value ? 'Clear search' : 'Close search'}
          data-testid="overview-search-clear"
          // The press never takes the focus (the omnibox's Clear the same): the input keeps it
          // and the keyboard stays where it is. Otherwise the button's moment of focus would
          // send the host a hide, the input's refocus a show right after, and the two race.
          onPointerDown={(e) => e.preventDefault()}
          onClick={value ? onClear : onClose}
        >
          <X className="h-5 w-5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The search's reach: recently closed tabs and the other devices' tabs
// ---------------------------------------------------------------------------

/**
 * The reach's matches (`useSearchReach`) as rows under headings beneath the grid (§10.4's
 * list-row form under §9.27's 15/600 headings; the rows and headings draw in the window family
 * on the overview's backdrop, `.zen-overview-search-reach` in main.css): "Recently closed" – favicon, title, host
 * and when the tab closed, a tap restoring it – and "From your other devices" – favicon, title,
 * then the host and the device's name, a tap opening the tab here (or bringing it to the front
 * when this device holds it, ID-10). A heading stands only over rows: a query nothing beyond the
 * cards matches leaves nothing here, and the grid's §9.17 sentence is the parent's. The rows run
 * edge to edge as every phone list's do, their text at the list's 16.
 */
export function OverviewSearchReach({
  reach,
  onRestore,
  onOpenTab
}: {
  reach: SearchReach
  onRestore: (entry: ClosedEntrySummary) => void
  onOpenTab: (tab: SyncRemoteTab) => void
}): JSX.Element | null {
  // "5 min ago" is judged as the rows come up: a query's results are a glance, not a page left open.
  const [now] = useState(() => Date.now())
  if (reach.closed.length === 0 && reach.remote.length === 0) return null
  return (
    <div
      className="zen-overview-search-reach zen-phone-list -mx-3"
      data-testid="overview-search-reach"
    >
      {reach.closed.length > 0 && (
        <section aria-label={OTHER_DEVICES_COPY.closedHeading}>
          <PhoneGroupHeading>{OTHER_DEVICES_COPY.closedHeading}</PhoneGroupHeading>
          {reach.closed.map((entry) => (
            <ClosedTabRow key={entry.id} entry={entry} now={now} onTap={() => onRestore(entry)} />
          ))}
        </section>
      )}
      {reach.remote.length > 0 && (
        <section aria-label={OTHER_DEVICES_COPY.devicesHeading}>
          <PhoneGroupHeading>{OTHER_DEVICES_COPY.devicesHeading}</PhoneGroupHeading>
          {reach.remote.map(({ device, tab }) => (
            <RemoteTabRow
              key={`${device.deviceId}:${tab.tabId}`}
              tab={tab}
              subtitle={`${remoteTabLines(tab).host} · ${device.deviceName}`}
              onTap={() => onOpenTab(tab)}
            />
          ))}
        </section>
      )}
    </div>
  )
}
