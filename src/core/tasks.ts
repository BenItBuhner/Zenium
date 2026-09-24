/**
 * The task manager (`zen://tasks`, Shift+Esc): every live process with its memory and CPU, and
 * the "End process" verb behind the confirmation.
 *
 * The host (`Platform.tasks`, a `TaskHost`) samples the processes and places each one by the
 * ids it shares with the core – which tabs a renderer hosts, which extension owns it, which
 * tab's DevTools a frontend draws. Everything the page shows as words is decided here, from the
 * core's own model: a tab's row carries the tab's title (the rename wins) and favicon, several
 * tabs in one renderer share a row; an extension's row carries the extension's NAME and icon as
 * the extension host lists it (`ExtensionHost.list()`, so the extension program's naming rules
 * apply unchanged); the browser, GPU and helper rows carry Chrome's names for them.
 *
 * Hosts without a `TaskHost` (Android) list nothing; the page id is desktop-only with it
 * (`INTERNAL_PAGES.tasks.layouts`).
 */
import type { Browser } from './browser'
import type { TaskHost, TaskSample } from './platform'
import type { TaskInfo, TaskKind, TaskList } from '../shared/types'
import { displayUrl } from '../shared/url'

/** The order rows come in before the page sorts them: the browser first, tabs, then the helpers. */
const KIND_RANK: Record<TaskKind, number> = {
  browser: 0,
  tab: 1,
  extension: 2,
  devtools: 3,
  gpu: 4,
  utility: 5,
  renderer: 6,
  other: 7
}

export class TaskService {
  /** The rows of the last `list()`, by pid: `end()` only ends what the page was shown. */
  private last = new Map<number, TaskInfo>()

  constructor(
    private readonly browser: Browser,
    private readonly host: TaskHost | null
  ) {}

  /** Every live process, named; an empty list on a host without a `TaskHost`. */
  list(now: number = Date.now()): TaskList {
    if (!this.host) return { sampledAt: now, tasks: [] }
    const tasks = this.host.sample().map((sample) => this.describe(sample))
    tasks.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.pid - b.pid)
    this.last = new Map(tasks.map((task) => [task.pid, task]))
    return { sampledAt: now, tasks }
  }

  /**
   * End the process the user picked and confirmed. Refused (false) for the browser process, for a
   * pid the page was never shown and for one the host no longer owns.
   */
  end(pid: number): boolean {
    if (!this.host) return false
    const task = this.last.get(pid)
    if (!task || !task.endable) return false
    return this.host.end(pid)
  }

  private describe(sample: TaskSample): TaskInfo {
    const named = this.name(sample)
    return {
      pid: sample.pid,
      kind: sample.kind,
      title: named.title,
      icon: named.icon,
      tabIds: sample.tabIds,
      extensionId: sample.extensionId,
      memoryBytes: sample.memoryBytes,
      privateBytes: sample.privateBytes,
      cpuPercent: sample.cpuPercent,
      networkBytesPerSecond: sample.networkBytesPerSecond,
      // The browser process is the app – ending it is quitting, which has its own verb – and
      // the engine's plumbing (zygotes, sandbox helpers) is nothing a user ends one of.
      endable: sample.kind !== 'browser' && sample.kind !== 'other'
    }
  }

  private name(sample: TaskSample): { title: string; icon: string | null } {
    switch (sample.kind) {
      case 'browser': {
        // The main process, or a window's own chrome renderer: "Browser window", with the name
        // the user gave the window (Name window…) so several windows' rows tell apart.
        const title =
          sample.serviceName ?? (sample.windowId === null ? 'Browser' : 'Browser window')
        const name =
          sample.windowId === null ? null : this.browser.windows.get(sample.windowId)?.name
        return { title: name ? `${title} – ${name}` : title, icon: null }
      }
      case 'tab': {
        const tabs = sample.tabIds.map((id) => this.browser.state.model.tabs[id] ?? null)
        const titles = tabs.map((tab, i) =>
          tab ? tabTitle(tab) : this.placeholderTitle(sample.tabIds[i]!)
        )
        const first = tabs.find((tab) => tab !== null) ?? null
        return {
          title: titles.length ? titles.join(', ') : 'Tab',
          icon: first?.favicon ?? null
        }
      }
      case 'extension': {
        const info = sample.extensionId
          ? this.browser.extensions.list().find((e) => e.id === sample.extensionId)
          : undefined
        return { title: info?.name || 'Extension', icon: info?.icon ?? null }
      }
      case 'devtools': {
        const tab = sample.devtoolsForTabId
          ? (this.browser.state.model.tabs[sample.devtoolsForTabId] ?? null)
          : null
        return { title: tab ? `Developer Tools – ${tabTitle(tab)}` : 'Developer Tools', icon: null }
      }
      // The coined titles are sentence case (§4), like "Browser window"; a name the engine gives a
      // helper ("Network Service") stays as given, and "Developer Tools" is the feature's name.
      case 'gpu':
        return { title: 'GPU process', icon: null }
      case 'utility':
        return { title: sample.serviceName || 'Utility process', icon: null }
      case 'renderer':
        return { title: sample.serviceName || 'Renderer', icon: null }
      case 'other':
        return { title: sample.serviceName || 'Helper process', icon: null }
    }
  }

  /**
   * A page view the host maps to a tab id the model does not hold: the new tab page a window
   * preloads off screen before its tab exists (`NewTabService`, a placeholder id); anything
   * else is named by its id so the row still says what it is.
   */
  private placeholderTitle(tabId: string): string {
    return this.browser.newTab.isPreloadId(tabId) ? 'New Tab (preloaded)' : `Tab ${tabId}`
  }
}

function tabTitle(tab: { customTitle: string | null; title: string; url: string }): string {
  return tab.customTitle || tab.title || displayUrl(tab.url) || 'New Tab'
}
