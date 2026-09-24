/**
 * The task manager page's pure parts (`zen://tasks`, `pages/tasks/TasksPage.tsx`): how the rows
 * sort under a column header, how memory, CPU and network read in the asides, how a kind is
 * named in a row's description, and what the search matches. The list itself is the host's
 * (`Commands['tasks.list']`, `core/tasks.ts`).
 */
import type { TaskInfo, TaskKind } from './types'

export type TaskSortColumn = 'task' | 'memory' | 'cpu' | 'network'

export interface TaskSort {
  column: TaskSortColumn
  direction: 'asc' | 'desc'
}

/**
 * No header pressed: the core's order – the browser first, then the tabs, the extensions and
 * the helpers (`TaskService.list`) – the way Chrome's task manager opens.
 */
export const DEFAULT_TASK_SORT: TaskSort | null = null

/**
 * The sort a header press leaves: a fresh column starts where its eye goes – a name ascending,
 * a figure descending (the heaviest first, as Chrome's task manager sorts a figure column) – and
 * a second press on the same header turns it round.
 */
export function nextTaskSort(current: TaskSort | null, column: TaskSortColumn): TaskSort {
  if (current && current.column === column)
    return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  return { column, direction: column === 'task' ? 'asc' : 'desc' }
}

/** The rows in the sort's order; stable, the core's order breaking ties. */
export function sortTasks(tasks: readonly TaskInfo[], sort: TaskSort | null): TaskInfo[] {
  const out = [...tasks]
  if (!sort) return out
  const sign = sort.direction === 'asc' ? 1 : -1
  const indexed = out.map((task, index) => ({ task, index }))
  indexed.sort((a, b) => {
    const order = compareBy(sort.column, a.task, b.task) * sign
    return order !== 0 ? order : a.index - b.index
  })
  return indexed.map((entry) => entry.task)
}

function compareBy(column: TaskSortColumn, a: TaskInfo, b: TaskInfo): number {
  switch (column) {
    case 'task':
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
    case 'memory':
      return a.memoryBytes - b.memoryBytes
    case 'cpu':
      return a.cpuPercent - b.cpuPercent
    case 'network':
      // Rows with no count (the helpers) sort as less than every counted row – under them in
      // the descending order a figure column opens with.
      return (a.networkBytesPerSecond ?? -1) - (b.networkBytesPerSecond ?? -1)
  }
}

/** Whether a row matches the page's search: by the task's name alone. */
export function matchesTask(task: TaskInfo, text: string): boolean {
  const query = text.trim().toLowerCase()
  if (!query) return true
  const terms = query.split(/\s+/)
  const title = task.title.toLowerCase()
  return terms.every((term) => title.includes(term))
}

const MB = 1024 * 1024

/**
 * Memory in one unit for the whole column – megabytes, thousands grouped – so the eye compares
 * down it: "1,204 MB", "38 MB", "0.4 MB" under one.
 */
export function formatTaskMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / MB
  if (mb < 1) return `${Math.max(0.1, Math.round(mb * 10) / 10).toFixed(1)} MB`
  if (mb < 10) return `${(Math.round(mb * 10) / 10).toFixed(1)} MB`
  return `${Math.round(mb).toLocaleString('en-US')} MB`
}

/** CPU as one figure with a decimal, the way Chrome's column reads: "0.0", "12.3", "104.5". */
export function formatTaskCpu(percent: number): string {
  if (!Number.isFinite(percent) || percent < 0) return '0.0'
  return (Math.round(percent * 10) / 10).toFixed(1)
}

/**
 * Network as a rate: "—" where the host does not count (a helper, the browser), "0" idle, then
 * "1.2 kB/s", "3.4 MB/s".
 */
export function formatTaskNetwork(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) return '—'
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 1) return '0'
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`
  const kb = bytesPerSecond / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} kB/s`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB/s`
}

/** The kind's word in a row's description ("Tab · 12345", "2 tabs · 12345", "Extension · 12346"). */
export function taskKindLabel(kind: TaskKind, tabCount: number = 0): string {
  switch (kind) {
    case 'browser':
      return 'Browser'
    case 'tab':
      return tabCount > 1 ? `${tabCount} tabs` : 'Tab'
    case 'extension':
      return 'Extension'
    case 'devtools':
      return 'DevTools'
    case 'gpu':
      return 'GPU'
    case 'utility':
      return 'Utility'
    case 'renderer':
      return 'Renderer'
    case 'other':
      return 'Helper'
  }
}

/** The row's second line: the kind, then the pid, the middle dot between them. */
export function taskDescription(task: TaskInfo): string {
  return `${taskKindLabel(task.kind, task.tabIds.length)} · ${task.pid}`
}
