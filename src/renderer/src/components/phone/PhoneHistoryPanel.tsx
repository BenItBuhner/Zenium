import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Ellipsis, Globe, History, Trash2, X } from 'lucide-react'
import type { SyncRemoteTab, UIState } from '@shared/types'
import { displayUrl } from '@shared/url'
import { presentedHost, useExtensionList } from '@renderer/lib/extensions/pages'
import { run } from '@renderer/lib/api'
import {
  historyAdapter,
  type ClosedEntrySummary,
  type HistoryRow
} from '@renderer/lib/historyAdapter'
import { visitTime, type DayGroup } from '@renderer/lib/historyGroups'
import { hideDevice, OTHER_DEVICES_COPY, type RemoteDevice } from '@renderer/lib/otherDevices'
import { openSettings } from '@renderer/lib/pages'
import {
  deselectAll,
  NO_SELECTION,
  orderedSelection,
  pruneSelection,
  selectAll,
  startSelection,
  toggleSelected,
  type Selection
} from '@renderer/lib/multiSelect'
import { openInPrivateItems } from '@renderer/lib/privateTabs'
import { activeTab } from '@renderer/lib/selectors'
import { closeOverlay, MENU_GAP, showLocalMenu } from '@renderer/lib/ui'
import { OverlayShell } from '../overlays/OverlayShell'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { OtherDevicesGroup } from './OtherDevicesGroup'
import {
  PhoneEmptyNote,
  PhoneGroupHeading,
  PhoneHeader,
  PhoneIconButton,
  PhoneListRow,
  PhoneSearchField,
  PhoneSelectionHeader,
  RowFavicon
} from './PhoneList'
import { PhoneSheet } from './PhoneSheet'
import {
  noteSheetOpener,
  removeWithUndo,
  usePanelStep,
  usePendingDeletes,
  useScrolled
} from './phonePanel'

const LIMIT = 300

interface Loaded {
  groups: DayGroup<HistoryRow>[]
  /** When the groups were fetched: "Today" is judged then, the list never being more than a search away from a reload. */
  at: number
}

/**
 * History on a phone (design-language v2 draft, sections 5, 6 and 9): visits grouped by day under
 * a 56 header and a search field, one row per visit with its favicon, title, site and time. A row opens
 * the page; its trailing control or a sideways swipe removes it (undoable from the toast); a
 * long press starts selection mode, whose header replaces the panel's and acts on every picked
 * row. The top row clears the whole history behind the same question the desktop page asks
 * (`ClearHistorySheet`, the count of what goes, Cancel or Clear all). Recently closed tabs sit
 * above the days (`historyAdapter.recentlyClosed`), and under them the other devices' open tabs
 * as one group per device (`OtherDevicesGroup`, TAB-02 / history-07: the desktop History page's
 * groups on the phone's; a tap opens a device's tab here, a device's heading held hides the
 * device, and with sync off or Open tabs out of what syncs the "From your other devices" group
 * is the prompt with its row to Settings › Sync; with nothing published it is absent), both
 * while nothing is searched. The list loads again whenever the core says the history or the recently closed
 * list changed. The search field does not take the focus as the panel opens: the keyboard would
 * come up with it (as `HistoryPage` on a phone).
 */
export function PhoneHistoryPanel({ state }: { state: UIState }): JSX.Element {
  const tab = activeTab(state)
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState<Loaded>({ groups: [], at: 0 })
  const [closed, setClosed] = useState<ClosedEntrySummary[]>([])
  const [rawSelection, setSelection] = useState<Selection>(NO_SELECTION)
  /** "Clear history" asks first: the number of visits about to go, while the question is up. */
  const [clearing, setClearing] = useState<number | null>(null)
  const pending = usePendingDeletes()
  const [attachList, listScrolled] = useScrolled<HTMLDivElement>()

  // A reload counter: bumped by the core's change events, so the effect below runs again.
  const [generation, setGeneration] = useState(0)
  useEffect(() => historyAdapter.onChanged(() => setGeneration((g) => g + 1)), [])
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      const at = Date.now()
      void historyAdapter.loadGroups(query, LIMIT, at).then((groups) => {
        if (!cancelled) setLoaded({ groups, at })
      })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, generation])

  const [closedGeneration, setClosedGeneration] = useState(0)
  useEffect(
    () => historyAdapter.onRecentlyClosedChanged(() => setClosedGeneration((g) => g + 1)),
    []
  )
  useEffect(() => {
    let cancelled = false
    void historyAdapter.recentlyClosed().then((list) => {
      if (!cancelled) setClosed(list)
    })
    return () => {
      cancelled = true
    }
  }, [closedGeneration])

  // Rows waiting for their delete to go through are gone from the list already.
  const groups = useMemo(
    () =>
      loaded.groups
        .map((group) => ({ ...group, items: group.items.filter((row) => !pending.has(row.id)) }))
        .filter((group) => group.items.length > 0),
    [loaded.groups, pending]
  )
  const rows = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const order = useMemo(() => rows.map((row) => row.id), [rows])
  const selection = useMemo(() => pruneSelection(rawSelection, order), [rawSelection, order])
  const selectedRows = useMemo(() => {
    const ids = new Set(orderedSelection(selection, order))
    return rows.filter((row) => ids.has(row.id))
  }, [selection, order, rows])

  const exitSelection = (): void => setSelection(NO_SELECTION)
  usePanelStep(selection.active && clearing === null, exitSelection)

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const open = (url: string, newTab: boolean): void => {
    run('urlbar.submit', { input: url, newTab: newTab || !tab, tabId: tab?.id ?? null })
    if (!newTab) closeOverlay()
  }

  const openAll = (list: readonly HistoryRow[]): void => {
    for (const row of list) open(row.url, true)
    exitSelection()
  }

  const copy = (list: readonly HistoryRow[]): void => {
    if (!list.length) return
    run('clipboard.writeText', {
      text: list.map((row) => row.url).join('\n'),
      confirmation: list.length === 1 ? 'Link copied' : `${list.length} links copied`
    })
    exitSelection()
  }

  const remove = (list: readonly HistoryRow[]): void => {
    if (!list.length) return
    const doomed = [...list]
    const keys = new Set(doomed.map((row) => row.id))
    removeWithUndo(
      [...keys],
      doomed.length === 1 ? 'Removed from history' : `${doomed.length} pages removed`,
      () => {
        void historyAdapter.deleteRows(doomed)
        setLoaded((l) => ({
          ...l,
          groups: l.groups.map((group) => ({
            ...group,
            items: group.items.filter((row) => !keys.has(row.id))
          }))
        }))
      }
    )
    exitSelection()
  }

  // The question is asked with the count of every visit, not only the loaded page of them.
  const clearAll = (): void => {
    noteSheetOpener()
    void historyAdapter.count().then((count) => setClearing(count))
  }

  const clearConfirmed = (): void => {
    void historyAdapter.clear()
    setLoaded((l) => ({ ...l, groups: [] }))
    exitSelection()
  }

  const restore = (entry: ClosedEntrySummary): void => {
    void historyAdapter.restoreClosed(entry.id)
    setClosed((list) => list.filter((e) => e.id !== entry.id))
    closeOverlay()
  }

  /**
   * Another device's tab (TAB-02): its address in a new tab in front – or, when this device
   * already holds that very tab (the Open tabs scope carries the records too, ID-10), that tab
   * to the front rather than a second one, as Settings › Sync's rows do (#314) – and the panel
   * leaves on it.
   */
  const openRemote = (remote: SyncRemoteTab): void => {
    if (remote.tabId in state.tabs) run('tab.activate', { tabId: remote.tabId })
    else run('tab.create', { url: remote.url, active: true })
    closeOverlay()
  }

  /**
   * The group's rows to Settings › Sync: where sync is turned on, or – Open tabs out of what
   * syncs – the page opened with its What you sync group on screen, the Open tabs switch the
   * row's subject (`?row=`, as Privacy's `?site=` brings a site's group up).
   */
  const openSync = (row?: string): void => {
    openSettings('sync', row ? { row } : undefined)
    closeOverlay()
  }

  /** A device's heading held: its sheet, whose one item hides the device for this run of the chrome. */
  const deviceMenu = (device: RemoteDevice): void => {
    noteSheetOpener()
    void showLocalMenu(
      'history',
      [{ label: OTHER_DEVICES_COPY.hideDevice, onSelect: () => hideDevice(device.deviceId) }],
      tab?.id ?? null,
      { title: device.deviceName }
    )
  }

  // Menu items are Title Case (v2 draft 9.1) and read as the core's history menus do (#119).
  const selectionMenu = (): void => {
    const picked = selectedRows
    void showLocalMenu(
      'selection',
      [
        {
          label: picked.length === 1 ? 'Open in New Tab' : `Open All (${picked.length})`,
          onSelect: () => openAll(picked)
        },
        // On a host with private tabs (INC-08); a private tab records no history of its own.
        ...openInPrivateItems(
          state.capabilities,
          picked.map((row) => row.url),
          exitSelection
        ),
        { label: picked.length === 1 ? 'Copy Link' : 'Copy Links', onSelect: () => copy(picked) },
        MENU_GAP,
        { label: 'Remove from History', danger: true, onSelect: () => remove(picked) }
      ],
      tab?.id ?? null,
      { title: `${picked.length} selected` }
    )
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Select all picks every visit the list shows – the loaded page of them, as Ctrl+A on the
  // History page does – and Deselect all unpicks them with the mode kept (the X leaves it).
  const header = selection.active ? (
    <PhoneSelectionHeader
      count={selection.ids.size}
      total={order.length}
      onSelectAll={(all) => setSelection(all ? selectAll(order) : deselectAll())}
      onExit={exitSelection}
      actions={
        <>
          <PhoneIconButton label="Remove from history" onClick={() => remove(selectedRows)}>
            <Trash2 className="h-5 w-5" strokeWidth={1.75} />
          </PhoneIconButton>
          <PhoneIconButton label="More" onClick={selectionMenu}>
            <Ellipsis className="h-5 w-5" strokeWidth={1.75} />
          </PhoneIconButton>
        </>
      }
    />
  ) : (
    <PhoneHeader title="History" onClose={() => closeOverlay()} />
  )

  const searching = query.trim().length > 0
  return (
    <OverlayShell title="History" header={header} scroll={false} className="zen-phone-panel">
      <PhoneSearchField
        value={query}
        onChange={setQuery}
        placeholder="Search history"
        scrolled={listScrolled}
      />
      <div ref={attachList} className="zen-phone-list min-h-0 flex-1 overflow-y-auto pb-2">
        {!searching && rows.length > 0 && (
          <PhoneListRow
            icon={<Trash2 className="h-5 w-5" strokeWidth={1.75} />}
            title="Clear history"
            danger
            onTap={clearAll}
          />
        )}
        {!searching && closed.length > 0 && (
          <section aria-label="Recently closed">
            <PhoneGroupHeading>Recently closed</PhoneGroupHeading>
            {closed.map((entry) => (
              <RecentlyClosedRow key={entry.id} entry={entry} onTap={() => restore(entry)} />
            ))}
          </section>
        )}
        {!searching && (
          <OtherDevicesGroup
            state={state}
            onOpenTab={openRemote}
            onOpenSync={openSync}
            onDeviceMenu={deviceMenu}
          />
        )}
        {rows.length === 0 ? (
          <PhoneEmptyNote>
            {searching ? 'No matching pages' : 'Pages you visit will show up here'}
          </PhoneEmptyNote>
        ) : (
          groups.map((group) => (
            <section key={group.dayKey} aria-label={group.label}>
              <PhoneGroupHeading>{group.label}</PhoneGroupHeading>
              {group.items.map((row) => (
                <HistoryVisitRow
                  key={row.id}
                  row={row}
                  selecting={selection.active}
                  selected={selection.ids.has(row.id)}
                  onTap={() =>
                    selection.active
                      ? setSelection(toggleSelected(selection, row.id))
                      : open(row.url, false)
                  }
                  onLongPress={() =>
                    setSelection(
                      selection.active ? toggleSelected(selection, row.id) : startSelection(row.id)
                    )
                  }
                  onDelete={() => remove([row])}
                />
              ))}
            </section>
          ))
        )}
      </div>
      {clearing !== null && (
        <ClearHistorySheet
          count={clearing}
          onClose={() => setClearing(null)}
          onConfirm={clearConfirmed}
        />
      )}
    </OverlayShell>
  )
}

/**
 * "Clear history" asks before it wipes the history, with the count of what goes: the desktop
 * page's question (`HistoryPage`'s `ClearAllDialog`) as a prompt sheet (v2 draft §9.23 – grip
 * strip, title block with the glyph, the one paragraph, the §9.11 footer) in the frame's dialog
 * host. Escape, the scrim, the back gesture and Cancel keep the history; Clear all clears it
 * once the sheet is gone. The focus starts on the sheet itself (§9.22: a title-and-notice sheet
 * holds its container; Cancel first is the failure the section names), so a stray Enter does
 * no harm.
 */
function ClearHistorySheet({
  count,
  onClose,
  onConfirm
}: {
  count: number
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const visits = count === 1 ? '1 visit' : `${count} visits`
  return (
    <PhoneSheet
      name="history-clear"
      // A prompt: the title block (§9.23) with the glyph on the title's start.
      title={{
        pose: 'block',
        text: 'Clear all history?',
        icon: <Trash2 className="h-5 w-5 shrink-0" strokeWidth={1.75} aria-hidden />,
        description: `${visits} will be removed from Zenium's history. Recently closed tabs and windows stay.`
      }}
      focus="dialog"
      onClose={onClose}
      handleLabel="Resize prompt"
      sheetRef={sheet}
    >
      <div className="zen-sheet-footer">
        <button type="button" className="zen-v2-button" onClick={() => sheet.current?.dismiss()}>
          Cancel
        </button>
        <button
          type="button"
          className="zen-v2-button"
          data-primary
          onClick={() => sheet.current?.dismiss(onConfirm)}
        >
          Clear all
        </button>
      </div>
    </PhoneSheet>
  )
}

function HistoryVisitRow({
  row,
  selecting,
  selected,
  onTap,
  onLongPress,
  onDelete
}: {
  row: HistoryRow
  selecting: boolean
  selected: boolean
  onTap: () => void
  onLongPress: () => void
  onDelete: () => void
}): JSX.Element {
  const extensions = useExtensionList()
  const host = presentedHost(row.url, extensions) || displayUrl(row.url)
  const time = visitTime(row.visitTime)
  return (
    <PhoneListRow
      icon={
        <RowFavicon
          src={row.favicon}
          fallback={<Globe className="h-5 w-5 opacity-60" strokeWidth={1.75} />}
        />
      }
      title={row.title}
      subtitle={`${host} · ${time}`}
      ariaLabel={`${row.title}, ${host}, ${time}`}
      trailing={
        <PhoneIconButton label="Remove from history" onClick={onDelete}>
          <X className="h-5 w-5 opacity-60" strokeWidth={1.75} />
        </PhoneIconButton>
      }
      selecting={selecting}
      selected={selected}
      onTap={onTap}
      onLongPress={onLongPress}
      onSwipeDelete={onDelete}
    />
  )
}

function RecentlyClosedRow({
  entry,
  onTap
}: {
  entry: ClosedEntrySummary
  onTap: () => void
}): JSX.Element {
  const window = entry.kind === 'window'
  const extensions = useExtensionList()
  const title = entry.title || (entry.url ? displayUrl(entry.url) : 'Window')
  const subtitle = window
    ? `${entry.tabCount} ${entry.tabCount === 1 ? 'tab' : 'tabs'}`
    : entry.url
      ? presentedHost(entry.url, extensions) || displayUrl(entry.url)
      : undefined
  return (
    <PhoneListRow
      icon={
        window ? (
          <History className="h-5 w-5" strokeWidth={1.75} />
        ) : (
          <RowFavicon
            src={entry.favicon}
            fallback={<Globe className="h-5 w-5 opacity-60" strokeWidth={1.75} />}
          />
        )
      }
      title={title}
      subtitle={subtitle}
      onTap={onTap}
    />
  )
}
