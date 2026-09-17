import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Ellipsis, Globe, Trash2, X } from 'lucide-react'
import type { UIState } from '@shared/types'
import { displayUrl, getHost } from '@shared/url'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { run } from '@renderer/lib/api'
import {
  clearBrowsingDataSheet,
  clearHistory,
  deleteHistoryRows,
  loadHistoryRows,
  type HistoryRow
} from '@renderer/lib/historyAdapter'
import { groupByDay, visitTime } from '@renderer/lib/historyGroups'
import {
  NO_SELECTION,
  orderedSelection,
  pruneSelection,
  startSelection,
  toggleSelected,
  type Selection
} from '@renderer/lib/multiSelect'
import { activeTab } from '@renderer/lib/selectors'
import { closeOverlay, MENU_GAP, pushToast, showLocalMenu } from '@renderer/lib/ui'
import { EmptyNote, OverlayShell } from '../overlays/OverlayShell'
import {
  PhoneGroupHeading,
  PhoneHeader,
  PhoneIconButton,
  PhoneListRow,
  PhoneSearchField,
  PhoneSelectionHeader,
  RowFavicon
} from './PhoneList'
import { removeWithUndo, usePanelStep, usePendingDeletes } from './phonePanel'

const LIMIT = 300

/**
 * History on a phone (design-language 8.1, 8.2, 8.7): visits grouped by day under a 56 header
 * and a search field, one 48 row per visit with its favicon, title, site and time. A row opens
 * the page; its trailing control or a sideways swipe removes it (undoable from the toast); a
 * long press starts selection mode, whose header replaces the panel's and acts on every picked
 * row. The top row clears the whole history, undoable like the rest, until shared services'
 * clear-browsing-data sheet takes its place (`clearBrowsingDataSheet`).
 */
export function PhoneHistoryPanel({ state }: { state: UIState }): JSX.Element {
  const tab = activeTab(state)
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState<{ rows: HistoryRow[]; at: number }>({ rows: [], at: 0 })
  const [rawSelection, setSelection] = useState<Selection>(NO_SELECTION)
  const pending = usePendingDeletes()
  const fade = useFadeEdges<HTMLDivElement>({ axis: 'y' })

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void loadHistoryRows(query, LIMIT).then((rows) => {
        if (!cancelled) setLoaded({ rows, at: Date.now() })
      })
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  // Rows waiting for their delete to go through are gone from the list already.
  const rows = useMemo(
    () => loaded.rows.filter((row) => !pending.has(row.id)),
    [loaded.rows, pending]
  )
  // "Today" is judged at load time: the list is never more than a search away from a reload.
  const groups = useMemo(() => groupByDay(rows, loaded.at), [rows, loaded.at])
  const order = useMemo(() => rows.map((row) => row.id), [rows])
  const selection = useMemo(() => pruneSelection(rawSelection, order), [rawSelection, order])
  const selectedRows = useMemo(() => {
    const ids = new Set(orderedSelection(selection, order))
    return rows.filter((row) => ids.has(row.id))
  }, [selection, order, rows])

  const exitSelection = (): void => setSelection(NO_SELECTION)
  usePanelStep(selection.active, exitSelection)

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
    run('clipboard.writeText', { text: list.map((row) => row.url).join('\n') })
    pushToast(list.length === 1 ? 'Link copied' : `${list.length} links copied`)
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
        deleteHistoryRows(doomed)
        setLoaded((l) => ({ ...l, rows: l.rows.filter((row) => !keys.has(row.id)) }))
      }
    )
    exitSelection()
  }

  const clearAll = (): void => {
    const sheet = clearBrowsingDataSheet()
    if (sheet) {
      sheet()
      return
    }
    removeWithUndo(order, 'History cleared', () => {
      clearHistory()
      setLoaded((l) => ({ ...l, rows: [] }))
    })
  }

  const selectionMenu = (): void => {
    const picked = selectedRows
    void showLocalMenu(
      'selection',
      [
        {
          label: picked.length === 1 ? 'Open in new tab' : 'Open in new tabs',
          onSelect: () => openAll(picked)
        },
        { label: picked.length === 1 ? 'Copy link' : 'Copy links', onSelect: () => copy(picked) },
        MENU_GAP,
        { label: 'Delete', danger: true, onSelect: () => remove(picked) }
      ],
      tab?.id ?? null,
      { title: `${picked.length} selected` }
    )
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const header = selection.active ? (
    <PhoneSelectionHeader
      count={selection.ids.size}
      onExit={exitSelection}
      actions={
        <>
          <PhoneIconButton label="Delete" onClick={() => remove(selectedRows)}>
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
    <OverlayShell title="History" header={header} scroll={false}>
      <PhoneSearchField value={query} onChange={setQuery} placeholder="Search history" />
      <div ref={fade} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!searching && rows.length > 0 && (
          <PhoneListRow
            icon={<Trash2 className="h-5 w-5" strokeWidth={1.75} />}
            title="Clear history"
            onTap={clearAll}
          />
        )}
        {rows.length === 0 ? (
          <EmptyNote>
            {searching ? 'No matching pages.' : 'Pages you visit will show up here.'}
          </EmptyNote>
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
    </OverlayShell>
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
  const host = getHost(row.url).replace(/^www\./, '') || displayUrl(row.url)
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
