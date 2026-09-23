import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Globe, X } from 'lucide-react'
import type { ArchivedTabSummary, InactiveTabsArchiveDays } from '@shared/types'
import { displayUrl, getHost } from '@shared/url'
import { timeOrDay } from '@renderer/lib/historyGroups'
import { inactiveTabsAdapter } from '@renderer/lib/inactiveTabs'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneEmptyNote, PhoneIconButton, PhoneListRow, RowFavicon } from './PhoneList'
import { PhoneSheet } from './PhoneSheet'

/**
 * The switcher's Inactive tabs (matrix TAB-20; Chrome's archived tabs): the tabs the core moved
 * out of the grid after the threshold (`InactiveTabsService`), as a sheet on the frame's dialog
 * host under the §9.16 header, one §10.3 row per tab most recently used first – favicon, title,
 * host and when it was last used – with a trailing 44 close (§9.3; a sideways swipe closes too),
 * the tab going to the recently closed list. A tap brings the tab back – at the start of its
 * space and to the front, page intact, as Chrome's `unarchiveAndRestoreTabs` does – once the
 * sheet is gone. The footer holds the two whole-list actions as §9.11 peers: Restore all (Chrome
 * keeps it in the dialog's overflow) and Close all in the danger ink, which asks first on a
 * §9.23 prompt sheet stacked over this one (§9.24) with Chrome's own words, no icon – it is a
 * confirmation of the user's own command. Empty (the last row closed here; a Never set while
 * the sheet was up brings every tab back), the §9.17 sentence. The list is read again whenever
 * the core says the archive changed, so a row never names a tab that is back already.
 */
export function InactiveTabsSheet({
  initial,
  archiveDays,
  onClose,
  onRestore
}: {
  /** The list as the entry read it, so the sheet opens full. */
  initial: readonly ArchivedTabSummary[]
  /** The threshold in force, for the empty sentence. */
  archiveDays: InactiveTabsArchiveDays
  onClose: () => void
  onRestore: (entry: ArchivedTabSummary) => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const [entries, setEntries] = useState<readonly ArchivedTabSummary[]>(initial)
  useEffect(
    () =>
      inactiveTabsAdapter.onChanged(() => {
        void inactiveTabsAdapter.list().then(setEntries)
      }),
    []
  )
  // "Today" and the times are judged as the sheet opens; it is never up for long.
  const [now] = useState(() => Date.now())
  // Close all's question stands over this sheet while it is asked.
  const [asking, setAsking] = useState(false)
  return (
    <>
      <PhoneSheet
        name="overview-inactive-tabs"
        // A list sheet: the centred 48 header (§9.16); it opens on its first row (§9.22) and
        // stands at most 80 % of the frame, the list scrolling under the title (§9.20).
        title={{ pose: 'header', text: 'Inactive tabs' }}
        focus="first"
        body="list"
        under={asking}
        onClose={onClose}
        sheetRef={sheet}
        contentKey={entries.map((entry) => entry.id).join('/')}
        footer={
          entries.length > 0 ? (
            <>
              <button
                type="button"
                className="zen-v2-button"
                onClick={() => sheet.current?.dismiss(() => void inactiveTabsAdapter.restoreAll())}
              >
                Restore all
              </button>
              <button
                type="button"
                className="zen-v2-button"
                data-danger
                onClick={() => setAsking(true)}
              >
                Close all
              </button>
            </>
          ) : undefined
        }
      >
        <div className="zen-phone-list pb-2">
          {entries.length === 0 ? (
            <PhoneEmptyNote>{emptySentence(archiveDays)}</PhoneEmptyNote>
          ) : (
            entries.map((entry) => (
              <ArchivedTabRow
                key={entry.id}
                entry={entry}
                now={now}
                onTap={() => sheet.current?.dismiss(() => onRestore(entry))}
                onCloseTab={() => void inactiveTabsAdapter.close(entry.id)}
              />
            ))
          )}
        </div>
      </PhoneSheet>
      {asking && (
        <CloseInactiveTabsSheet
          count={entries.length}
          onClose={() => setAsking(false)}
          // The question leaves first, then the list, and only then do the tabs go: nothing
          // closes in the open while a sheet is still up over the grid.
          onConfirm={() => sheet.current?.dismiss(() => void inactiveTabsAdapter.closeAll())}
        />
      )}
    </>
  )
}

/** What the empty sheet says (§9.17): where the threshold stands, or that there is none. */
function emptySentence(archiveDays: InactiveTabsArchiveDays): string {
  return archiveDays === 0
    ? 'Tabs are no longer moved here'
    : `Tabs you haven't used for ${archiveDays} days will appear here`
}

/** One archived tab as a row – favicon, title, host and when it was last used – with its close. */
function ArchivedTabRow({
  entry,
  now,
  onTap,
  onCloseTab
}: {
  entry: ArchivedTabSummary
  now: number
  onTap: () => void
  onCloseTab: () => void
}): JSX.Element {
  const title = entry.title || (entry.url ? displayUrl(entry.url) : 'Tab')
  const host = entry.url ? getHost(entry.url).replace(/^www\./, '') || displayUrl(entry.url) : ''
  const when = timeOrDay(entry.lastActiveAt, now)
  const subtitle = host ? `${host} · ${when}` : when
  return (
    <PhoneListRow
      icon={
        <RowFavicon
          src={entry.favicon}
          fallback={<Globe className="zen-list-standin h-5 w-5" strokeWidth={1.75} />}
        />
      }
      title={title}
      subtitle={subtitle}
      ariaLabel={`${title}, ${subtitle}`}
      trailing={
        <PhoneIconButton label={`Close ${title}`} onClick={onCloseTab}>
          <X className="h-5 w-5" strokeWidth={1.75} />
        </PhoneIconButton>
      }
      onTap={onTap}
      onSwipeDelete={onCloseTab}
    />
  )
}

/**
 * Close all's question (§9.23): a prompt sheet over the list – the title block with Chrome's
 * words and no icon (a confirmation of the user's own command carries none), the §9.11 footer
 * with Close all in the danger ink trailing. Escape, the scrim, the back gesture and Cancel keep
 * the tabs.
 */
function CloseInactiveTabsSheet({
  count,
  onClose,
  onConfirm
}: {
  count: number
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  return (
    <PhoneSheet
      name="overview-inactive-close-all"
      title={{
        pose: 'block',
        text: count === 1 ? 'Close 1 inactive tab?' : `Close ${count} inactive tabs?`,
        description: 'You can always get them back in History'
      }}
      focus="dialog"
      onClose={onClose}
      // One detent: a drag on the grip only sends the prompt away (as the close-all prompt's).
      handleLabel="Dismiss"
      sheetRef={sheet}
      footer={
        <>
          <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
            Cancel
          </button>
          <button
            type="button"
            className="zen-v2-button"
            data-danger
            onClick={() => sheet.current?.dismiss(onConfirm)}
          >
            Close all
          </button>
        </>
      }
    >
      {null}
    </PhoneSheet>
  )
}
