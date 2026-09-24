import { describe, expect, it } from 'vitest'
import {
  formatTaskCpu,
  formatTaskMemory,
  formatTaskNetwork,
  matchesTask,
  nextTaskSort,
  sortTasks,
  taskDescription,
  taskKindLabel
} from '../tasks'
import type { TaskInfo } from '../types'

/*
 * The task manager page's pure parts (shared/tasks.ts): a header press's sort and its turn, the
 * stable sort under each column, the search by task name, and how memory, CPU and network read
 * in the asides and the kind in a row's description.
 */

function task(over: Partial<TaskInfo> & { pid: number }): TaskInfo {
  return {
    kind: 'tab',
    title: `Task ${over.pid}`,
    icon: null,
    tabIds: [],
    extensionId: null,
    memoryBytes: 0,
    privateBytes: null,
    cpuPercent: 0,
    networkBytesPerSecond: null,
    endable: true,
    ...over
  }
}

describe('nextTaskSort', () => {
  it('starts a name ascending and a figure descending, and turns the same column round', () => {
    expect(nextTaskSort(null, 'task')).toEqual({ column: 'task', direction: 'asc' })
    expect(nextTaskSort(null, 'memory')).toEqual({ column: 'memory', direction: 'desc' })
    expect(nextTaskSort(null, 'cpu')).toEqual({ column: 'cpu', direction: 'desc' })
    expect(nextTaskSort(null, 'network')).toEqual({ column: 'network', direction: 'desc' })
    expect(nextTaskSort({ column: 'memory', direction: 'desc' }, 'memory')).toEqual({
      column: 'memory',
      direction: 'asc'
    })
    expect(nextTaskSort({ column: 'memory', direction: 'asc' }, 'cpu')).toEqual({
      column: 'cpu',
      direction: 'desc'
    })
  })
})

describe('sortTasks', () => {
  const rows = [
    task({
      pid: 1,
      title: 'Browser',
      memoryBytes: 300,
      cpuPercent: 2,
      networkBytesPerSecond: null
    }),
    task({ pid: 2, title: 'beta', memoryBytes: 100, cpuPercent: 5, networkBytesPerSecond: 10 }),
    task({ pid: 3, title: 'Alpha 10', memoryBytes: 200, cpuPercent: 5, networkBytesPerSecond: 0 }),
    task({ pid: 4, title: 'Alpha 2', memoryBytes: 200, cpuPercent: 1, networkBytesPerSecond: 50 })
  ]
  const pids = (list: TaskInfo[]): number[] => list.map((t) => t.pid)

  it('keeps the core’s order with no sort, and leaves the input alone', () => {
    const copy = [...rows]
    expect(pids(sortTasks(rows, null))).toEqual([1, 2, 3, 4])
    expect(rows).toEqual(copy)
  })

  it('sorts names case-insensitively with numbers in order, and turns round', () => {
    expect(pids(sortTasks(rows, { column: 'task', direction: 'asc' }))).toEqual([4, 3, 2, 1])
    expect(pids(sortTasks(rows, { column: 'task', direction: 'desc' }))).toEqual([1, 2, 3, 4])
  })

  it('sorts a figure with the core’s order breaking ties either way round', () => {
    expect(pids(sortTasks(rows, { column: 'memory', direction: 'desc' }))).toEqual([1, 3, 4, 2])
    expect(pids(sortTasks(rows, { column: 'memory', direction: 'asc' }))).toEqual([2, 3, 4, 1])
    expect(pids(sortTasks(rows, { column: 'cpu', direction: 'desc' }))).toEqual([2, 3, 1, 4])
  })

  it('sorts rows with no network count as less than every counted row', () => {
    expect(pids(sortTasks(rows, { column: 'network', direction: 'desc' }))).toEqual([4, 2, 3, 1])
    expect(pids(sortTasks(rows, { column: 'network', direction: 'asc' }))).toEqual([1, 3, 2, 4])
  })
})

describe('matchesTask', () => {
  it('matches by the task name alone, every term, case aside', () => {
    const row = task({ pid: 7, title: 'Zenium – Task Manager', extensionId: 'abc' })
    expect(matchesTask(row, '')).toBe(true)
    expect(matchesTask(row, '   ')).toBe(true)
    expect(matchesTask(row, 'task')).toBe(true)
    expect(matchesTask(row, 'MANAGER zen')).toBe(true)
    expect(matchesTask(row, 'abc')).toBe(false)
    expect(matchesTask(row, 'task history')).toBe(false)
  })
})

describe('the figures', () => {
  it('reads memory in megabytes, grouped, with a decimal under ten', () => {
    expect(formatTaskMemory(0)).toBe('0 MB')
    expect(formatTaskMemory(-5)).toBe('0 MB')
    expect(formatTaskMemory(Number.NaN)).toBe('0 MB')
    expect(formatTaskMemory(10 * 1024)).toBe('0.1 MB')
    expect(formatTaskMemory(0.44 * 1024 * 1024)).toBe('0.4 MB')
    expect(formatTaskMemory(3.26 * 1024 * 1024)).toBe('3.3 MB')
    expect(formatTaskMemory(38.4 * 1024 * 1024)).toBe('38 MB')
    expect(formatTaskMemory(1204.6 * 1024 * 1024)).toBe('1,205 MB')
  })

  it('reads CPU as one figure with a decimal', () => {
    expect(formatTaskCpu(0)).toBe('0.0')
    expect(formatTaskCpu(12.34)).toBe('12.3')
    expect(formatTaskCpu(104.49)).toBe('104.5')
    expect(formatTaskCpu(-1)).toBe('0.0')
    expect(formatTaskCpu(Number.NaN)).toBe('0.0')
  })

  it('reads network as a rate, a dash where nothing is counted', () => {
    expect(formatTaskNetwork(null)).toBe('—')
    expect(formatTaskNetwork(0)).toBe('0')
    expect(formatTaskNetwork(0.4)).toBe('0')
    expect(formatTaskNetwork(512)).toBe('512 B/s')
    expect(formatTaskNetwork(1536)).toBe('1.5 kB/s')
    expect(formatTaskNetwork(120 * 1024)).toBe('120 kB/s')
    expect(formatTaskNetwork(2.5 * 1024 * 1024)).toBe('2.5 MB/s')
    expect(formatTaskNetwork(30 * 1024 * 1024)).toBe('30 MB/s')
  })
})

describe('the description', () => {
  it('names the kind – tabs counted – then the pid', () => {
    expect(taskKindLabel('browser')).toBe('Browser')
    expect(taskKindLabel('tab')).toBe('Tab')
    expect(taskKindLabel('tab', 1)).toBe('Tab')
    expect(taskKindLabel('tab', 3)).toBe('3 tabs')
    expect(taskKindLabel('extension')).toBe('Extension')
    expect(taskKindLabel('devtools')).toBe('DevTools')
    expect(taskKindLabel('gpu')).toBe('GPU')
    expect(taskKindLabel('utility')).toBe('Utility')
    expect(taskKindLabel('renderer')).toBe('Renderer')
    expect(taskKindLabel('other')).toBe('Helper')
    expect(taskDescription(task({ pid: 4242, kind: 'tab', tabIds: ['a', 'b'] }))).toBe(
      '2 tabs · 4242'
    )
    expect(taskDescription(task({ pid: 99, kind: 'gpu' }))).toBe('GPU · 99')
  })
})
