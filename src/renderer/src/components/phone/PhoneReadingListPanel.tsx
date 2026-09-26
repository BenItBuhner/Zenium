import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCheck, EllipsisVertical, Globe } from 'lucide-react'
import type { ReadingListEntry, UIState } from '@shared/types'
import { filterReadingList, isUnread, sortReadingList } from '@shared/readingList'
import { displayHost } from '@shared/url'
import { run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import { closeOverlay, MENU_GAP, showLocalMenu } from '@renderer/lib/ui'
import { relativeTime } from '@renderer/lib/utils'
import { OverlayShell } from '../overlays/OverlayShell'
import {
  PhoneEmptyNote,
  PhoneGroupHeading,
  PhoneHeader,
  PhoneIconButton,
  PhoneListRow,
  PhoneSearchField,
  RowFavicon
} from './PhoneList'
import { noteSheetOpener, useScrolled } from './phonePanel'

/**
 * The reading list on a phone (HB-20; design-language v2 draft §9.16, §9.17, §9.27, §10.4): the
 * desktop's `zen://reading-list` page (W6-1, `pages/readingList`) as the phone's panel on the
 * History and Bookmarks panels' chassis – the 56 header, the search field under it, then the
 * entries under two headings, Unread with its count as the aside and Read, each half newest
 * first (`sortReadingList`, the model's one order). A row is the page's title over its host and
 * when it was added; a tap opens the page in the current tab and marks the entry read
 * (`readingList.open`, which brings a tab already showing the page forward instead), and the
 * panel leaves on it. The row's ⋮ – or the row held – hangs the desktop row menu's items from
 * the row's own name: Open in New Tab, Mark as Read / Mark as Unread, Copy Link, Remove. While
 * anything is unread and nothing is searched, the top row marks every entry read at once, where
 * the desktop's title block holds the same action.
 *
 * The panel reads `UIState.readingList` and writes through the core's commands alone – the
 * model is the desktop's, shared. Rows are keyed by `id` (a page saved on two devices resolves
 * to one surviving entry under sync, so a URL is no key), and an entry that goes while the
 * panel is up – removed elsewhere, folded by a sync – simply leaves the list on the next state:
 * a menu still up for it drops what is picked rather than act on a row that is gone. A synced
 * entry arrives without a favicon; the row's icon comes from the favicon cache by the page's
 * address (`RowFavicon`), as the History and Bookmarks rows' do. The search field never takes
 * the focus as the panel opens (the keyboard would come up with it).
 */
export function PhoneReadingListPanel({ state }: { state: UIState }): JSX.Element {
  const tab = activeTab(state)
  const [query, setQuery] = useState('')
  const [attachList, listScrolled] = useScrolled<HTMLDivElement>()

  const entries = useMemo(() => sortReadingList(state.readingList), [state.readingList])
  const shown = useMemo(() => filterReadingList(entries, query), [entries, query])
  const waiting = useMemo(() => shown.filter(isUnread), [shown])
  const done = useMemo(() => shown.filter((entry) => !isUnread(entry)), [shown])
  const unreadCount = useMemo(() => entries.filter(isUnread).length, [entries])

  // The list as the core last pushed it, by id: a gesture that lands after its entry went
  // (a menu picked for a row a sync just folded away) finds nothing here and is dropped.
  const latest = useRef(new Map<string, ReadingListEntry>())
  useEffect(() => {
    latest.current = new Map(entries.map((entry) => [entry.id, entry]))
  }, [entries])
  const still = (id: string): ReadingListEntry | undefined => latest.current.get(id)

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** The row's tap: the page here, the entry read, the panel gone (the desktop row's click). */
  const open = (id: string): void => {
    if (!still(id)) return
    run('readingList.open', { id, tabId: tab?.id ?? null })
    closeOverlay()
  }

  const openInNewTab = (id: string): void => {
    if (!still(id)) return
    run('readingList.open', { id, tabId: tab?.id ?? null, newTab: true })
  }

  const setRead = (id: string, read: boolean): void => {
    if (!still(id)) return
    run('readingList.setRead', { id, read })
  }

  const copyLink = (id: string): void => {
    const entry = still(id)
    if (!entry) return
    run('clipboard.writeText', { text: entry.url, confirmation: 'Link copied' })
  }

  const remove = (id: string): void => {
    if (!still(id)) return
    run('readingList.remove', { id })
  }

  const markAllRead = (): void => {
    run('readingList.markAllRead', undefined)
  }

  // Menu items are Title Case (v2 draft 9.1) and read as the core's row menu does
  // (`showReadingListContextMenu`), less Open – the row's tap is that.
  const rowMenu = (entry: ReadingListEntry): void => {
    const id = entry.id
    const unread = isUnread(entry)
    noteSheetOpener()
    void showLocalMenu(
      'readingList',
      [
        { label: 'Open in New Tab', onSelect: () => openInNewTab(id) },
        MENU_GAP,
        {
          label: unread ? 'Mark as Read' : 'Mark as Unread',
          onSelect: () => setRead(id, unread)
        },
        MENU_GAP,
        { label: 'Copy Link', onSelect: () => copyLink(id) },
        { label: 'Remove', danger: true, onSelect: () => remove(id) }
      ],
      tab?.id ?? null,
      { title: entryTitle(entry) }
    )
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const searching = query.trim().length > 0
  return (
    <OverlayShell
      title="Reading list"
      header={<PhoneHeader title="Reading list" onClose={() => closeOverlay()} />}
      scroll={false}
      className="zen-phone-panel"
    >
      <PhoneSearchField
        value={query}
        onChange={setQuery}
        placeholder="Search reading list"
        scrolled={listScrolled}
      />
      <div
        ref={attachList}
        className="zen-phone-list min-h-0 flex-1 overflow-y-auto pb-2"
        data-testid="reading-list-panel"
      >
        {!searching && unreadCount > 0 && (
          <PhoneListRow
            icon={<CheckCheck className="h-5 w-5" strokeWidth={1.75} />}
            title="Mark all as read"
            onTap={markAllRead}
          />
        )}
        {shown.length === 0 ? (
          <PhoneEmptyNote>
            {searching ? 'No matching pages' : 'Pages you save to read later appear here'}
          </PhoneEmptyNote>
        ) : (
          <>
            {waiting.length > 0 && (
              <section aria-label="Unread">
                <PhoneGroupHeading aside={waiting.length}>Unread</PhoneGroupHeading>
                {waiting.map((entry) => (
                  <ReadingEntryRow
                    key={entry.id}
                    entry={entry}
                    onTap={() => open(entry.id)}
                    onMenu={() => rowMenu(entry)}
                  />
                ))}
              </section>
            )}
            {done.length > 0 && (
              <section aria-label="Read">
                <PhoneGroupHeading>Read</PhoneGroupHeading>
                {done.map((entry) => (
                  <ReadingEntryRow
                    key={entry.id}
                    entry={entry}
                    onTap={() => open(entry.id)}
                    onMenu={() => rowMenu(entry)}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </OverlayShell>
  )
}

/** The row's name: the page's title, else its host (an entry added from a page without one). */
function entryTitle(entry: ReadingListEntry): string {
  return entry.title || displayHost(entry.url) || entry.url
}

/** "Added 3 h ago": the desktop row's time (`ReadingListPage`'s `addedWhen`), after the host. */
function addedLabel(addedAt: number): string {
  return `Added ${relativeTime(addedAt).replace(/^Just now$/, 'just now')}`
}

/**
 * One saved page (§10.4: a row naming a page – the title on one line, the host and when it was
 * added on the second – and, its tap spoken for, the trailing 44 ⋮ for the rest). The favicon is
 * the entry's own when this device saved it, else the cache's copy for the page's address.
 */
function ReadingEntryRow({
  entry,
  onTap,
  onMenu
}: {
  entry: ReadingListEntry
  onTap: () => void
  onMenu: () => void
}): JSX.Element {
  const title = entryTitle(entry)
  const host = displayHost(entry.url) || entry.url
  const when = addedLabel(entry.addedAt)
  const unread = isUnread(entry)
  return (
    <PhoneListRow
      icon={
        <RowFavicon
          src={entry.favicon}
          page={entry.url}
          fallback={<Globe className="zen-list-standin h-5 w-5" strokeWidth={1.75} />}
        />
      }
      title={title}
      subtitle={`${host} · ${when}`}
      ariaLabel={`${title}, ${host}, ${when}, ${unread ? 'Unread' : 'Read'}`}
      trailing={
        <PhoneIconButton label={`More options for ${title}`} onClick={onMenu}>
          <EllipsisVertical className="h-5 w-5" strokeWidth={1.75} />
        </PhoneIconButton>
      }
      onTap={onTap}
      onLongPress={onMenu}
    />
  )
}
