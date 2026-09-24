import type { JSX, KeyboardEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ChevronDown, ChevronUp } from 'lucide-react'
import { parseInternalPageUrl } from '@shared/internalPages'
import {
  formatTaskCpu,
  formatTaskMemory,
  formatTaskNetwork,
  matchesTask,
  nextTaskSort,
  sortTasks,
  taskDescription,
  type TaskSort,
  type TaskSortColumn
} from '@shared/tasks'
import type { Tab, TaskInfo, TaskList, UIState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { useChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { ConfirmDialog } from '../../dialogs/ConfirmDialog'
import { PageColumn, PageEmpty, PageSearchField, PageTitleBlock } from '../PageFrame'
import { usePageSearch } from '../usePageSearch'

/** How often the page asks the host for a fresh sample while it is on screen. */
export const TASKS_REFRESH_MS = 1500

const COLUMNS: ReadonlyArray<{ id: TaskSortColumn; label: string; figure: boolean }> = [
  { id: 'task', label: 'Task', figure: false },
  { id: 'memory', label: 'Memory', figure: true },
  { id: 'cpu', label: 'CPU', figure: true },
  { id: 'network', label: 'Network', figure: true }
]

/**
 * The sort the last header press left, kept for the window's session (`sessionStorage`): a task
 * manager opened again during the run comes back sorted as it was, and a fresh run opens in
 * the core's order.
 */
const SORT_KEY = 'zen.tasks.sort'

function rememberedSort(): TaskSort | null {
  try {
    const raw = window.sessionStorage.getItem(SORT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'column' in parsed &&
      'direction' in parsed &&
      COLUMNS.some((c) => c.id === parsed.column) &&
      (parsed.direction === 'asc' || parsed.direction === 'desc')
    )
      return { column: parsed.column as TaskSortColumn, direction: parsed.direction }
    return null
  } catch {
    return null
  }
}

function rememberSort(sort: TaskSort): void {
  try {
    window.sessionStorage.setItem(SORT_KEY, JSON.stringify(sort))
  } catch {
    // Storage refused (a locked-down session): the sort stands for this mount alone.
  }
}

/**
 * The task manager (`zen://tasks`, Shift+Esc, More Tools › Task Manager; Chrome's task manager
 * as a page tab, shortcuts-menus-121 / -149 / -32): every process the app runs – the browser,
 * each tab's renderer (its title and favicon; several tabs in one renderer share a row), each
 * extension's (its name), the DevTools frontends, the GPU and the utility processes – with its
 * memory, CPU and network, in the §10.1 page frame with a TABLE body: a 32 header row at 13 in
 * the deemphasised ink, each header a button that sorts its column and carries the sort glyph
 * while it is the active one; then 52 two-line rows – the title over "kind · pid" – with the
 * three figures as right-aligned tabular asides. One row is selected at a time (`--v2-selected`)
 * and the footer's "End process" verb, pinned at the page's foot in the danger ink (§9.11),
 * ends it through the §9.23 destructive prompt – disabled while nothing, the browser process or
 * a window's own chrome is selected. Keyboard: Up / Down move the selection, Delete is End
 * process (through the prompt), Escape clears the selection; Ctrl+F is the search field's,
 * which filters by task name and rides on `?q=` like the other list pages. The list refreshes
 * every `TASKS_REFRESH_MS` while the page is on screen – the page is mounted for the active tab
 * alone, and the timer stops while the document is hidden – and never otherwise.
 */
export function TasksPage({ tab }: { state: UIState; tab: Tab }): JSX.Element {
  const urlQuery = parseInternalPageUrl(tab.url)?.query?.q ?? ''
  const field = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const endButton = useRef<HTMLButtonElement>(null)
  const [snapshot, setSnapshot] = useState<TaskList | null>(null)
  const [sort, setSort] = useState<TaskSort | null>(rememberedSort)
  const [selectedPid, setSelectedPid] = useState<number | null>(null)
  const [ending, setEnding] = useState<TaskInfo | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await cmd('tasks.list', undefined)
      setSnapshot(next)
    } catch {
      // The host said nothing this time; the last sample stands until the next.
    }
  }, [])

  // Sample while on screen, never while hidden (a minimised window, another desktop).
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (timer !== null) return
      void refresh()
      timer = setInterval(() => void refresh(), TASKS_REFRESH_MS)
    }
    const stop = (): void => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') stop()
      else start()
    }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  const { query, setQuery, text } = usePageSearch({
    urlQuery,
    push: (value) =>
      run('page.navigate', {
        tabId: tab.id,
        section: null,
        replace: true,
        query: value ? { q: value } : undefined
      })
  })

  useChromeShortcut('find.open', (request) => {
    if (request.tabId !== tab.id) return false
    field.current?.focus()
    field.current?.select()
    return true
  })

  const tasks = snapshot?.tasks ?? []
  const shown = sortTasks(
    tasks.filter((task) => matchesTask(task, text)),
    sort
  )
  // The selection is the pid's row in the current sample: a process that has gone (ended,
  // closed) leaves nothing selected, no row carrying its pid any more.
  const selected = selectedPid === null ? null : (tasks.find((t) => t.pid === selectedPid) ?? null)

  const pressHeader = (column: TaskSortColumn): void => {
    const next = nextTaskSort(sort, column)
    rememberSort(next)
    setSort(next)
  }

  const focusRow = (pid: number): void => {
    list.current
      ?.querySelector<HTMLElement>(`[data-task-pid="${pid}"] [data-row-focus]`)
      ?.focus({ preventScroll: false })
  }

  const moveSelection = (delta: 1 | -1): void => {
    if (shown.length === 0) return
    const at = selected === null ? -1 : shown.findIndex((t) => t.pid === selected.pid)
    const next =
      at === -1
        ? delta === 1
          ? 0
          : shown.length - 1
        : Math.min(shown.length - 1, Math.max(0, at + delta))
    const pid = shown[next]!.pid
    setSelectedPid(pid)
    focusRow(pid)
  }

  const askToEnd = (): void => {
    if (selected && selected.endable) setEnding(selected)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (ending) return
    const target = e.target
    if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable]'))
      return
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        moveSelection(e.key === 'ArrowDown' ? 1 : -1)
        return
      case 'Home':
      case 'End':
        if (shown.length === 0) return
        e.preventDefault()
        {
          const pid = (e.key === 'Home' ? shown[0] : shown[shown.length - 1])!.pid
          setSelectedPid(pid)
          focusRow(pid)
        }
        return
      case 'Delete':
        if (selected?.endable) {
          e.preventDefault()
          askToEnd()
        }
        return
      case 'Escape':
        if (selected) {
          e.preventDefault()
          e.stopPropagation()
          setSelectedPid(null)
        }
        return
      default:
        return
    }
  }

  const confirmEnd = (): void => {
    const task = ending
    setEnding(null)
    if (!task) return
    void cmd('tasks.end', { pid: task.pid })
      .catch(() => false)
      .then(() => refresh())
  }

  const loading = snapshot === null
  const empty = snapshot !== null && tasks.length === 0

  return (
    <PageColumn
      testId="tasks-page"
      className="zen-tasks-page"
      onKeyDown={onKeyDown}
      header={
        <>
          <PageTitleBlock
            title="Task Manager"
            description="Every process Zenium is running, with the memory, CPU and network it uses. Select one to end it."
          />
          <PageSearchField
            field={field}
            value={query}
            onChange={setQuery}
            placeholder="Find a task"
            testId="tasks-search"
          />
        </>
      }
      footer={
        <button
          ref={endButton}
          type="button"
          className="zen-v2-button zen-tasks-end"
          data-danger=""
          data-testid="tasks-end"
          disabled={!selected?.endable}
          onClick={askToEnd}
        >
          End process
        </button>
      }
    >
      <div
        ref={list}
        className="zen-page-list zen-tasks-table"
        role="grid"
        aria-label="Processes"
        data-testid="tasks-table"
        data-sort={sort ? `${sort.column}:${sort.direction}` : undefined}
      >
        <div className="zen-tasks-header" role="row">
          {COLUMNS.map((column) => {
            const active = sort?.column === column.id
            const direction = active ? sort!.direction : null
            return (
              <div
                key={column.id}
                role="columnheader"
                className="zen-tasks-col"
                data-column={column.id}
                data-figure={column.figure || undefined}
                data-active={active || undefined}
                aria-sort={
                  direction === null ? 'none' : direction === 'asc' ? 'ascending' : 'descending'
                }
              >
                <button
                  type="button"
                  className="zen-tasks-col-button"
                  data-testid={`tasks-sort-${column.id}`}
                  onClick={() => pressHeader(column.id)}
                >
                  <span className="zen-tasks-col-label">{column.label}</span>
                  {direction === 'asc' && (
                    <ChevronUp className="zen-tasks-sort-glyph" aria-hidden />
                  )}
                  {direction === 'desc' && (
                    <ChevronDown className="zen-tasks-sort-glyph" aria-hidden />
                  )}
                </button>
              </div>
            )
          })}
        </div>
        {loading && <PageEmpty testId="tasks-loading">Reading the processes</PageEmpty>}
        {empty && <PageEmpty testId="tasks-empty">This host lists no processes</PageEmpty>}
        {!loading && !empty && shown.length === 0 && (
          <PageEmpty testId="tasks-no-match">No tasks match “{text}”</PageEmpty>
        )}
        {shown.length > 0 && (
          <ul className="zen-page-rows zen-tasks-rows" role="rowgroup">
            {shown.map((task) => (
              <TaskRow
                key={task.pid}
                task={task}
                selected={task.pid === selectedPid}
                onSelect={() => setSelectedPid(task.pid)}
                onOpen={() => {
                  // Chrome's task manager: a double-click on a tab's row goes to the tab.
                  const tabId = task.tabIds[0]
                  if (task.kind === 'tab' && tabId) run('tab.activate', { tabId })
                }}
              />
            ))}
          </ul>
        )}
      </div>
      {ending && (
        <ConfirmDialog
          name="end-task"
          title={`End ${ending.title}?`}
          description={endDescription(ending)}
          action="End process"
          destructive
          onCancel={() => setEnding(null)}
          onConfirm={confirmEnd}
          returnFocus={() =>
            list.current?.querySelector<HTMLElement>(
              `[data-task-pid="${ending.pid}"] [data-row-focus]`
            ) ?? endButton.current
          }
          data={{ 'data-dialog': 'confirm:end-task', 'data-task-pid': ending.pid }}
        />
      )}
    </PageColumn>
  )
}

/** The prompt's one line: what ending this process does to what it holds. */
function endDescription(task: TaskInfo): string {
  switch (task.kind) {
    case 'tab':
      return task.tabIds.length > 1
        ? `The ${task.tabIds.length} tabs in this process stop and show a crashed page until they are reloaded.`
        : 'The tab stops and shows a crashed page until it is reloaded.'
    case 'extension':
      return 'The extension stops until it is reloaded or the browser restarts.'
    case 'devtools':
      return 'The Developer Tools window closes; the page it inspected is left as it is.'
    case 'gpu':
      return 'Pages repaint as the GPU process restarts; anything it was drawing may flicker.'
    case 'utility':
      return 'The helper restarts on its next use; what it was doing may be lost.'
    default:
      return 'The process stops; what it was doing may be lost.'
  }
}

/**
 * One process on the shared two-line row, laid out on the table's grid: the task cell – the
 * favicon (or the page's activity glyph) in the row's lead slot, the title over "kind · pid" as
 * the row's text button – then the three figures as right-aligned asides, tabular so the columns
 * line up under their headers. A click (or the focus) selects the row; a double-click opens what
 * it stands for (a tab).
 */
function TaskRow({
  task,
  selected,
  onSelect,
  onOpen
}: {
  task: TaskInfo
  selected: boolean
  onSelect: () => void
  onOpen: () => void
}): JSX.Element {
  const memoryTitle =
    task.privateBytes === null
      ? `Working set ${formatTaskMemory(task.memoryBytes)}`
      : `Private ${formatTaskMemory(task.privateBytes)} · Working set ${formatTaskMemory(task.memoryBytes)}`
  return (
    <li
      className="zen-v2-row zen-page-row zen-tasks-row"
      role="row"
      aria-selected={selected}
      data-selected={selected || undefined}
      data-task-pid={task.pid}
      data-task-kind={task.kind}
      data-endable={task.endable || undefined}
    >
      <div className="zen-tasks-cell-task" role="gridcell">
        <span className="zen-page-row-lead" aria-hidden>
          {task.icon ? (
            <img className="zen-page-row-favicon" src={task.icon} alt="" draggable={false} />
          ) : (
            <Activity className="zen-page-row-favicon zen-page-row-glyph" />
          )}
        </span>
        <button
          type="button"
          className="zen-page-row-text"
          data-row-focus=""
          onClick={onSelect}
          onDoubleClick={onOpen}
          onFocus={onSelect}
        >
          <span className="zen-page-row-label">{task.title}</span>
          <span className="zen-page-row-desc">{taskDescription(task)}</span>
        </button>
      </div>
      <span
        className="zen-tasks-figure zen-page-row-time"
        role="gridcell"
        data-column="memory"
        title={memoryTitle}
      >
        {formatTaskMemory(task.memoryBytes)}
      </span>
      <span className="zen-tasks-figure zen-page-row-time" role="gridcell" data-column="cpu">
        {formatTaskCpu(task.cpuPercent)}
      </span>
      <span className="zen-tasks-figure zen-page-row-time" role="gridcell" data-column="network">
        {formatTaskNetwork(task.networkBytesPerSecond)}
      </span>
    </li>
  )
}
