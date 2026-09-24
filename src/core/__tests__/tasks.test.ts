import { describe, expect, it } from 'vitest'
import { TaskService } from '../tasks'
import type { TaskHost, TaskSample } from '../platform'
import type { Browser } from '../browser'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'

function sample(part: Partial<TaskSample> & { pid: number; kind: TaskSample['kind'] }): TaskSample {
  return {
    tabIds: [],
    extensionId: null,
    devtoolsForTabId: null,
    serviceName: null,
    memoryBytes: 10 * 1024 * 1024,
    privateBytes: null,
    cpuPercent: 0,
    networkBytesPerSecond: null,
    ...part
  }
}

function browserWith(tabs: Record<string, Partial<Record<string, unknown>>>): Browser {
  return {
    state: { model: { tabs } },
    newTab: { isPreloadId: (id: string) => id.startsWith('newtab_preload') },
    extensions: {
      list: () => [
        { id: EXT, name: 'uBlock Origin', icon: 'data:image/png;base64,AAAA' },
        { id: 'other', name: '', icon: null }
      ]
    }
  } as unknown as Browser
}

function hostOf(samples: TaskSample[]): TaskHost & { ended: number[] } {
  const host = {
    ended: [] as number[],
    sample: () => samples,
    end(pid: number) {
      host.ended.push(pid)
      return true
    }
  }
  return host
}

describe('TaskService', () => {
  const tabs = {
    a: { title: 'Alpha – news', customTitle: null, url: 'https://a.example/', favicon: 'data:a' },
    b: { title: 'Beta', customTitle: 'My beta', url: 'https://b.example/', favicon: null },
    c: { title: '', customTitle: null, url: 'https://c.example/path', favicon: null },
    d: { title: '', customTitle: null, url: 'about:blank', favicon: null }
  }

  it('lists nothing on a host without a task host', () => {
    const service = new TaskService(browserWith(tabs), null)
    expect(service.list(5)).toEqual({ sampledAt: 5, tasks: [] })
    expect(service.end(1)).toBe(false)
  })

  it('names each process from the core’s own model and orders the browser first, then tabs, then the helpers', () => {
    const host = hostOf([
      sample({ pid: 300, kind: 'gpu' }),
      sample({ pid: 500, kind: 'other', serviceName: 'Zygote' }),
      sample({ pid: 202, kind: 'tab', tabIds: ['a', 'b'], networkBytesPerSecond: 1200 }),
      sample({ pid: 203, kind: 'tab', tabIds: ['c'] }),
      sample({ pid: 208, kind: 'tab', tabIds: ['d'] }),
      // The new tab page a window preloads off screen: a placeholder id the model never holds.
      sample({ pid: 211, kind: 'tab', tabIds: ['newtab_preload_7f3a'] }),
      sample({ pid: 212, kind: 'tab', tabIds: ['gone'] }),
      sample({ pid: 204, kind: 'devtools', devtoolsForTabId: 'b' }),
      sample({ pid: 209, kind: 'devtools' }),
      sample({ pid: 205, kind: 'extension', extensionId: EXT }),
      sample({ pid: 210, kind: 'extension', extensionId: 'unknown' }),
      sample({ pid: 400, kind: 'utility', serviceName: 'Network Service' }),
      sample({ pid: 401, kind: 'utility' }),
      sample({ pid: 206, kind: 'renderer', serviceName: 'Subframe: embed.example', tabIds: ['a'] }),
      sample({ pid: 207, kind: 'renderer' }),
      sample({ pid: 101, kind: 'browser', serviceName: 'Browser window' }),
      sample({ pid: 100, kind: 'browser', memoryBytes: 250 * 1024 * 1024, privateBytes: 1024 })
    ])
    const list = new TaskService(browserWith(tabs), host).list(42)
    expect(list.sampledAt).toBe(42)
    expect(list.tasks.map((t) => [t.pid, t.kind, t.title, t.icon, t.endable])).toEqual([
      [100, 'browser', 'Browser', null, false],
      [101, 'browser', 'Browser window', null, false],
      // Two tabs in one renderer share the row; the rename wins; the first tab's favicon.
      [202, 'tab', 'Alpha – news, My beta', 'data:a', true],
      // No title yet: the address, as the tab row shows it.
      [203, 'tab', 'c.example/path', null, true],
      [208, 'tab', 'New Tab', null, true],
      [211, 'tab', 'New Tab (preloaded)', null, true],
      [212, 'tab', 'Tab gone', null, true],
      // The extension's NAME and icon as the extension host lists them.
      [205, 'extension', 'uBlock Origin', 'data:image/png;base64,AAAA', true],
      [210, 'extension', 'Extension', null, true],
      [204, 'devtools', 'Developer Tools – My beta', null, true],
      [209, 'devtools', 'Developer Tools', null, true],
      [300, 'gpu', 'GPU Process', null, true],
      [400, 'utility', 'Network Service', null, true],
      [401, 'utility', 'Utility Process', null, true],
      [206, 'renderer', 'Subframe: embed.example', null, true],
      [207, 'renderer', 'Renderer', null, true],
      [500, 'other', 'Zygote', null, false]
    ])
    const browser = list.tasks[0]!
    expect(browser.memoryBytes).toBe(250 * 1024 * 1024)
    expect(browser.privateBytes).toBe(1024)
    expect(list.tasks.find((t) => t.pid === 202)).toMatchObject({
      tabIds: ['a', 'b'],
      networkBytesPerSecond: 1200
    })
  })

  it('ends only what the page was shown and may end', () => {
    const host = hostOf([
      sample({ pid: 100, kind: 'browser' }),
      sample({ pid: 202, kind: 'tab', tabIds: ['a'] }),
      sample({ pid: 500, kind: 'other', serviceName: 'Zygote' })
    ])
    const service = new TaskService(browserWith(tabs), host)
    // Nothing listed yet: nothing to end.
    expect(service.end(202)).toBe(false)
    service.list(1)
    expect(service.end(202)).toBe(true)
    expect(service.end(100)).toBe(false)
    expect(service.end(500)).toBe(false)
    expect(service.end(777)).toBe(false)
    expect(host.ended).toEqual([202])
  })
})
