// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TaskInfo, TaskList, UIState } from '@shared/types'

/*
 * The task manager page tab (`zen://tasks`, Shift+Esc, More Tools › Task Manager; Chrome's task
 * manager as a page tab, shortcuts-menus-121 / -149 / -32): the title block and search field,
 * the header row whose buttons sort their column (a figure the heaviest first, a second press
 * turning it round, the sort kept for the window's session), the rows in the core's order with
 * "kind · pid" under the title and the three figures, one selected row and the footer's End
 * process verb – disabled with nothing or the browser selected – the keyboard (Up / Down, Home /
 * End, Delete through the destructive prompt, Escape clearing), the prompt's confirm calling
 * `tasks.end` and refreshing, the sample taken every 1.5 s on screen and never while hidden, a
 * selection cleared when its process has gone, and the search by task name on `?q=`.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const css = readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')

const MB = 1024 * 1024

function info(over: Partial<TaskInfo> & { pid: number; kind: TaskInfo['kind'] }): TaskInfo {
  return {
    title: `Task ${over.pid}`,
    icon: null,
    tabIds: [],
    extensionId: null,
    memoryBytes: 0,
    privateBytes: null,
    cpuPercent: 0,
    networkBytesPerSecond: null,
    endable: over.kind !== 'browser' && over.kind !== 'other',
    ...over
  }
}

const SAMPLE: TaskInfo[] = [
  info({ pid: 100, kind: 'browser', title: 'Browser', memoryBytes: 180 * MB, cpuPercent: 1.2 }),
  info({
    pid: 201,
    kind: 'tab',
    title: 'Wikipedia',
    icon: 'data:image/png;base64,AAAA',
    tabIds: ['t1'],
    memoryBytes: 95.4 * MB,
    cpuPercent: 4.05,
    networkBytesPerSecond: 2048
  }),
  info({
    pid: 202,
    kind: 'tab',
    title: 'Docs, Mail',
    tabIds: ['t2', 't3'],
    memoryBytes: 240 * MB,
    cpuPercent: 0,
    networkBytesPerSecond: 0
  }),
  info({
    pid: 301,
    kind: 'extension',
    title: 'uBlock Origin',
    extensionId: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
    memoryBytes: 60 * MB,
    cpuPercent: 0.5
  }),
  info({ pid: 401, kind: 'gpu', title: 'GPU Process', memoryBytes: 120 * MB, cpuPercent: 8 }),
  info({ pid: 501, kind: 'other', title: 'Zygote', memoryBytes: 2 * MB })
]

let sample: TaskInfo[] = SAMPLE
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'tasks.list') return { sampledAt: 1000, tasks: sample } satisfies TaskList
  if (name === 'tasks.end') return true
  return null
})
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { TasksPage, TASKS_REFRESH_MS } = await import('../TasksPage')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { browserStore } = await import('@renderer/lib/browserStore')

function state(platform = 'linux', chrome: 'full' | 'page' = 'full'): UIState {
  return {
    platform,
    shortcuts: [],
    spaces: [{ id: 'space', activeTabId: null, tabIds: [] }],
    activeSpaceId: 'space',
    tabs: {},
    window: { chrome }
  } as unknown as UIState
}

function tab(url = 'zen://tasks'): Tab {
  return {
    id: 'tasks',
    spaceId: 'space',
    containerId: 'default',
    url,
    title: 'Task Manager',
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    openerTabId: null
  } as Tab
}

let root: Root | null = null
let mount: HTMLElement | null = null

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Mounts the page inside the frame dialog host and lets the first sample land. */
async function mountPage(t: Tab = tab(), s: UIState = state()): Promise<HTMLElement> {
  browserStore.set({ state: s })
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  await act(async () =>
    root!.render(
      createElement(FrameDialogHost, null, createElement(TasksPage, { state: s, tab: t }))
    )
  )
  await settle()
  return mount
}

function unmountPage(): void {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
}

function calls(name: string): unknown[] {
  return invoke.mock.calls.filter((c) => c[0] === name).map((c) => c[1])
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function rows(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('.zen-tasks-row')]
}

function pids(el: HTMLElement): number[] {
  return rows(el).map((r) => Number(r.getAttribute('data-task-pid')))
}

function row(el: HTMLElement, pid: number): HTMLElement {
  return el.querySelector<HTMLElement>(`.zen-tasks-row[data-task-pid="${pid}"]`)!
}

function rowButton(el: HTMLElement, pid: number): HTMLButtonElement {
  return row(el, pid).querySelector<HTMLButtonElement>('[data-row-focus]')!
}

function figures(el: HTMLElement, pid: number): string[] {
  return [...row(el, pid).querySelectorAll('.zen-tasks-figure')].map((f) => text(f))
}

function header(el: HTMLElement, column: string): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>(`[data-testid="tasks-sort-${column}"]`)!
}

function endButton(el: HTMLElement): HTMLButtonElement {
  return el.querySelector<HTMLButtonElement>('[data-testid="tasks-end"]')!
}

function selectedPid(el: HTMLElement): number | null {
  const picked = el.querySelector<HTMLElement>('.zen-tasks-row[data-selected]')
  return picked ? Number(picked.getAttribute('data-task-pid')) : null
}

/** The prompt that is up – a panel on its way out (`data-leaving`) is not one. */
function prompt(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-confirm="end-task"]:not([data-leaving])')
}

/** The kept panels' exit animations end (happy-dom runs none): the host lets the chrome go. */
async function endExit(): Promise<void> {
  await act(async () => {
    for (const panel of document.querySelectorAll('.zen-frame-dialogs-slot > [data-leaving]'))
      panel.dispatchEvent(new Event('animationend'))
  })
}

async function press(el: HTMLElement, key: string, target?: HTMLElement): Promise<void> {
  const page = el.querySelector<HTMLElement>('[data-testid="tasks-page"]')!
  await act(async () => {
    ;(target ?? page).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    )
  })
}

async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    vi.advanceTimersByTime(200)
  })
}

function setVisibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  invoke.mockClear()
  sample = SAMPLE
  window.sessionStorage.clear()
  setVisibility('visible')
})

afterEach(() => {
  unmountPage()
  browserStore.set({ state: null })
  vi.useRealTimers()
})

describe('TasksPage', () => {
  it('lists every process in the core’s order with its kind, pid and figures, the verb disabled', async () => {
    const el = await mountPage()
    expect(text(el.querySelector('h1.zen-page-title'))).toBe('Task Manager')
    // The description names every column the table draws – network with memory and CPU.
    expect(text(el.querySelector('.zen-page-title-desc'))).toBe(
      'Every process Zenium is running, with the memory, CPU and network it uses. Select one to end it.'
    )
    expect(el.querySelector<HTMLInputElement>('[data-testid="tasks-search"]')!.placeholder).toBe(
      'Find a task'
    )
    expect(
      [...el.querySelectorAll('.zen-tasks-header [role="columnheader"]')].map((h) => text(h))
    ).toEqual(['Task', 'Memory', 'CPU', 'Network'])
    expect(calls('tasks.list')).toHaveLength(1)
    expect(el.querySelector('[data-testid="tasks-loading"]')).toBeNull()
    expect(pids(el)).toEqual([100, 201, 202, 301, 401, 501])

    const wikipedia = row(el, 201)
    expect(text(wikipedia.querySelector('.zen-page-row-label'))).toBe('Wikipedia')
    expect(text(wikipedia.querySelector('.zen-page-row-desc'))).toBe('Tab · 201')
    expect(wikipedia.querySelector<HTMLImageElement>('img.zen-page-row-favicon')!.src).toBe(
      'data:image/png;base64,AAAA'
    )
    expect(figures(el, 201)).toEqual(['95 MB', '4.1', '2.0 kB/s'])
    expect(text(row(el, 202).querySelector('.zen-page-row-desc'))).toBe('2 tabs · 202')
    expect(figures(el, 202)).toEqual(['240 MB', '0.0', '0'])
    expect(text(row(el, 301).querySelector('.zen-page-row-desc'))).toBe('Extension · 301')
    expect(figures(el, 100)).toEqual(['180 MB', '1.2', '—'])
    // A process with no favicon takes the page's activity glyph in the lead slot.
    expect(row(el, 401).querySelector('svg.zen-page-row-glyph')).not.toBeNull()
    expect(row(el, 100).getAttribute('data-endable')).toBeNull()
    expect(row(el, 501).getAttribute('data-endable')).toBeNull()
    expect(row(el, 201).getAttribute('data-endable')).toBe('true')

    expect(selectedPid(el)).toBeNull()
    expect(endButton(el).disabled).toBe(true)
    expect(endButton(el).hasAttribute('data-danger')).toBe(true)
    expect(text(endButton(el))).toBe('End process')
  })

  it('shows the one loading line until the first sample lands', async () => {
    let release: (() => void) | null = null
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void => resolve({ sampledAt: 1, tasks: sample })
        })
    )
    const el = await mountPage()
    const loading = el.querySelector('[data-testid="tasks-loading"]')!
    expect(text(loading)).toBe('Reading the processes')
    // One form for the list's three states (§9.17): the loading line is the same centred
    // `PageEmpty` as "no processes" and "no match", not the group-row line at the gutter.
    expect(loading.className).toBe('zen-page-empty')
    expect(loading.getAttribute('role')).toBe('status')
    expect(rows(el)).toHaveLength(0)
    await act(async () => {
      release!()
    })
    await settle()
    expect(el.querySelector('[data-testid="tasks-loading"]')).toBeNull()
    expect(rows(el)).toHaveLength(6)
  })

  it('sorts under a header – a figure the heaviest first, a second press turning it round – and keeps the sort for the session', async () => {
    const el = await mountPage()
    const table = el.querySelector<HTMLElement>('[data-testid="tasks-table"]')!
    expect(table.getAttribute('data-sort')).toBeNull()
    for (const column of ['task', 'memory', 'cpu', 'network'])
      expect(header(el, column).parentElement!.getAttribute('aria-sort')).toBe('none')

    await act(async () => header(el, 'memory').click())
    expect(table.getAttribute('data-sort')).toBe('memory:desc')
    expect(pids(el)).toEqual([202, 100, 401, 201, 301, 501])
    const memory = header(el, 'memory').parentElement!
    expect(memory.getAttribute('aria-sort')).toBe('descending')
    expect(memory.hasAttribute('data-active')).toBe(true)
    expect(memory.querySelector('.zen-tasks-sort-glyph')).not.toBeNull()
    expect(header(el, 'task').parentElement!.querySelector('.zen-tasks-sort-glyph')).toBeNull()

    await act(async () => header(el, 'memory').click())
    expect(table.getAttribute('data-sort')).toBe('memory:asc')
    expect(pids(el)).toEqual([501, 301, 201, 401, 100, 202])
    expect(memory.getAttribute('aria-sort')).toBe('ascending')

    await act(async () => header(el, 'task').click())
    expect(table.getAttribute('data-sort')).toBe('task:asc')
    expect(pids(el)).toEqual([100, 202, 401, 301, 201, 501])
    expect(memory.getAttribute('aria-sort')).toBe('none')

    unmountPage()
    const again = await mountPage()
    expect(again.querySelector('[data-testid="tasks-table"]')!.getAttribute('data-sort')).toBe(
      'task:asc'
    )
    expect(pids(again)).toEqual([100, 202, 401, 301, 201, 501])
  })

  it('selects one row on a click, arms the verb for an endable one, and moves with the keyboard', async () => {
    const el = await mountPage()
    await act(async () => rowButton(el, 201).click())
    expect(selectedPid(el)).toBe(201)
    expect(row(el, 201).getAttribute('aria-selected')).toBe('true')
    expect(row(el, 202).getAttribute('aria-selected')).toBe('false')
    expect(endButton(el).disabled).toBe(false)

    // The browser process and a helper can be selected and not ended.
    await act(async () => rowButton(el, 100).click())
    expect(selectedPid(el)).toBe(100)
    expect(endButton(el).disabled).toBe(true)
    await act(async () => rowButton(el, 501).click())
    expect(endButton(el).disabled).toBe(true)

    await press(el, 'ArrowUp')
    expect(selectedPid(el)).toBe(401)
    expect(document.activeElement).toBe(rowButton(el, 401))
    await press(el, 'ArrowUp')
    await press(el, 'ArrowUp')
    expect(selectedPid(el)).toBe(202)
    await press(el, 'ArrowDown')
    expect(selectedPid(el)).toBe(301)
    await press(el, 'End')
    expect(selectedPid(el)).toBe(501)
    await press(el, 'ArrowDown')
    expect(selectedPid(el)).toBe(501)
    await press(el, 'Home')
    expect(selectedPid(el)).toBe(100)
    await press(el, 'ArrowUp')
    expect(selectedPid(el)).toBe(100)

    await press(el, 'Escape')
    expect(selectedPid(el)).toBeNull()
    expect(endButton(el).disabled).toBe(true)
    // With nothing selected Down takes the first row, Up the last.
    await press(el, 'ArrowDown')
    expect(selectedPid(el)).toBe(100)
    await press(el, 'Escape')
    await press(el, 'ArrowUp')
    expect(selectedPid(el)).toBe(501)
  })

  it('Delete and the verb open the destructive prompt; Cancel leaves the process, End process ends it and refreshes', async () => {
    const el = await mountPage()
    // Delete with the browser selected does nothing.
    await act(async () => rowButton(el, 100).click())
    await press(el, 'Delete')
    expect(prompt()).toBeNull()

    await act(async () => rowButton(el, 201).click())
    await press(el, 'Delete')
    await settle()
    const dialog = prompt()
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('data-task-pid')).toBe('201')
    expect(text(dialog!.querySelector('h2, [id$="-title"]') ?? dialog)).toContain('End Wikipedia?')
    expect(text(dialog)).toContain('The tab stops and shows a crashed page until it is reloaded.')
    const confirm = dialog!.querySelector<HTMLButtonElement>('[data-action="confirm"]')!
    const cancel = dialog!.querySelector<HTMLButtonElement>('[data-action="cancel"]')!
    expect(text(confirm)).toBe('End process')
    expect(confirm.hasAttribute('data-primary')).toBe(false)
    expect(confirm.hasAttribute('data-danger')).toBe(true)
    await act(async () => cancel.click())
    await settle()
    expect(prompt()).toBeNull()
    await endExit()
    expect(calls('tasks.end')).toEqual([])
    expect(selectedPid(el)).toBe(201)
    // The keyboard comes back to the row it left (§9.5).
    expect(document.activeElement).toBe(rowButton(el, 201))

    const before = calls('tasks.list').length
    await act(async () => endButton(el).click())
    await settle()
    expect(prompt()).not.toBeNull()
    await act(async () =>
      prompt()!.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click()
    )
    await settle()
    await endExit()
    // The two-tab row's line counts the tabs.
    await act(async () => rowButton(el, 202).click())
    await press(el, 'Delete')
    await settle()
    expect(text(prompt())).toContain('End Docs, Mail?')
    expect(text(prompt())).toContain('The 2 tabs in this process stop and show a crashed page')
    sample = SAMPLE.filter((t) => t.pid !== 202)
    await act(async () =>
      prompt()!.querySelector<HTMLButtonElement>('[data-action="confirm"]')!.click()
    )
    await settle()
    await endExit()
    expect(prompt()).toBeNull()
    expect(calls('tasks.end')).toEqual([{ pid: 202 }])
    expect(calls('tasks.list').length).toBeGreaterThan(before)
    // The ended process has gone from the list and from the selection.
    expect(pids(el)).toEqual([100, 201, 301, 401, 501])
    expect(selectedPid(el)).toBeNull()
    expect(endButton(el).disabled).toBe(true)
  })

  it('samples every 1.5 s while on screen and not while the document is hidden', async () => {
    const el = await mountPage()
    expect(calls('tasks.list')).toHaveLength(1)
    await act(async () => {
      vi.advanceTimersByTime(TASKS_REFRESH_MS)
    })
    await settle()
    expect(calls('tasks.list')).toHaveLength(2)
    await act(async () => {
      vi.advanceTimersByTime(TASKS_REFRESH_MS)
    })
    await settle()
    expect(calls('tasks.list')).toHaveLength(3)

    await act(async () => setVisibility('hidden'))
    await act(async () => {
      vi.advanceTimersByTime(TASKS_REFRESH_MS * 4)
    })
    await settle()
    expect(calls('tasks.list')).toHaveLength(3)

    // Shown again: one sample at once, then the beat resumes; a new sample redraws the rows.
    sample = SAMPLE.map((t) => (t.pid === 201 ? { ...t, cpuPercent: 42.2 } : t))
    await act(async () => setVisibility('visible'))
    await settle()
    expect(calls('tasks.list')).toHaveLength(4)
    expect(figures(el, 201)[1]).toBe('42.2')
    await act(async () => {
      vi.advanceTimersByTime(TASKS_REFRESH_MS)
    })
    await settle()
    expect(calls('tasks.list')).toHaveLength(5)

    // Gone from the screen: the beat stops.
    unmountPage()
    await act(async () => {
      vi.advanceTimersByTime(TASKS_REFRESH_MS * 4)
    })
    expect(calls('tasks.list')).toHaveLength(5)
  })

  it('filters the rows by task name, moving the tab’s URL to ?q= without a history entry', async () => {
    const el = await mountPage()
    const field = el.querySelector<HTMLInputElement>('[data-testid="tasks-search"]')!
    await type(field, 'wiki')
    expect(pids(el)).toEqual([201])
    expect(calls('page.navigate')).toContainEqual({
      tabId: 'tasks',
      section: null,
      replace: true,
      query: { q: 'wiki' }
    })
    await type(field, 'nothing here')
    expect(rows(el)).toHaveLength(0)
    expect(text(el.querySelector('[data-testid="tasks-no-match"]'))).toBe(
      'No tasks match “nothing here”'
    )
    // A pid is not a name.
    await type(field, '301')
    expect(rows(el)).toHaveLength(0)
    await type(field, '')
    expect(pids(el)).toEqual([100, 201, 202, 301, 401, 501])

    unmountPage()
    const again = await mountPage(tab('zen://tasks?q=gpu'))
    expect(again.querySelector<HTMLInputElement>('[data-testid="tasks-search"]')!.value).toBe('gpu')
    expect(pids(again)).toEqual([401])
  })

  it('says so when the host lists no processes', async () => {
    sample = []
    const el = await mountPage()
    expect(text(el.querySelector('[data-testid="tasks-empty"]'))).toBe(
      'This host lists no processes'
    )
    expect(rows(el)).toHaveLength(0)
  })

  it('in the window form drops the title block, names the table for the frame’s bar, and lets Escape by to the window unless the prompt or the field’s text takes it (W5-18)', async () => {
    const el = await mountPage(tab(), state('linux', 'page'))
    const page = el.querySelector<HTMLElement>('[data-testid="tasks-page"]')!
    expect(page.classList.contains('zen-tasks-window')).toBe(true)
    // The frame's bar is the title: no H1, no description; the search field leads the header.
    expect(el.querySelector('h1.zen-page-title')).toBeNull()
    expect(el.querySelector('.zen-page-title-desc')).toBeNull()
    const field = el.querySelector<HTMLInputElement>('[data-testid="tasks-search"]')!
    expect(field.closest('.zen-page-header')).not.toBeNull()
    expect(el.querySelector('.zen-page-header')!.firstElementChild).toBe(
      field.closest('.zen-page-search')
    )
    // R1: the 16 above the field is the HEADER's padding, never the search wrapper's – the
    // glyph (and the clear button, once there is text) are absolute against that wrapper at the
    // field's centre, so a padded wrapper would push the field down and leave them 16 high.
    const wrapper = field.closest('.zen-page-search')!
    expect(el.querySelector('.zen-page-search-glyph')!.closest('.zen-page-search')).toBe(wrapper)
    expect(css).toMatch(/\.zen-tasks-window \.zen-page-header \{[^}]*padding-top: 16px;/)
    expect(css).not.toMatch(/\.zen-tasks-window \.zen-page-search[^{]*\{[^}]*padding/)
    const table = el.querySelector<HTMLElement>('[data-testid="tasks-table"]')!
    expect(table.getAttribute('aria-label')).toBe('Task Manager')
    expect(table.getAttribute('data-form')).toBe('window')
    expect(
      [...el.querySelectorAll('.zen-tasks-header [role="columnheader"]')].map((h) => text(h))
    ).toEqual(['Task', 'Memory', 'CPU', 'Network'])
    expect(pids(el)).toEqual([100, 201, 202, 301, 401, 501])

    // Escape: the shell closes the window on a key nothing in the page took (`defaultPrevented`).
    const escapeOn = async (target: HTMLElement): Promise<boolean> => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => {
        target.dispatchEvent(e)
      })
      return e.defaultPrevented
    }
    // A selected row does not swallow it: the selection stands and the key goes by.
    await act(async () => rowButton(el, 201).click())
    expect(selectedPid(el)).toBe(201)
    expect(await escapeOn(rowButton(el, 201))).toBe(false)
    expect(selectedPid(el)).toBe(201)
    // An empty field does not either.
    expect(await escapeOn(field)).toBe(false)
    expect(field.value).toBe('')
    // The field's text is the first Escape's: cleared, the key taken.
    await type(field, 'wiki')
    expect(pids(el)).toEqual([201])
    expect(el.querySelector('.zen-page-search-clear')!.closest('.zen-page-search')).toBe(wrapper)
    expect(await escapeOn(field)).toBe(true)
    expect(field.value).toBe('')
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(pids(el)).toEqual([100, 201, 202, 301, 401, 501])
    // The prompt's before all: Escape cancels it and stops there; the selection stands.
    await press(el, 'Delete')
    await settle()
    expect(prompt()).not.toBeNull()
    expect(await escapeOn(page)).toBe(true)
    await settle()
    expect(prompt()).toBeNull()
    await endExit()
    expect(calls('tasks.end')).toEqual([])
    expect(selectedPid(el)).toBe(201)
    // The prompt gone, the next Escape is the window's again.
    expect(await escapeOn(rowButton(el, 201))).toBe(false)

    // The tab form keeps its title block and names the table for itself.
    unmountPage()
    const asTab = await mountPage(tab(), state('linux', 'full'))
    expect(asTab.querySelector('[data-testid="tasks-page"]')!.classList).not.toContain(
      'zen-tasks-window'
    )
    expect(text(asTab.querySelector('h1.zen-page-title'))).toBe('Task Manager')
    expect(asTab.querySelector('[data-testid="tasks-table"]')!.getAttribute('aria-label')).toBe(
      'Processes'
    )
    expect(asTab.querySelector('[data-testid="tasks-table"]')!.getAttribute('data-form')).toBe(
      'tab'
    )
  })
})
