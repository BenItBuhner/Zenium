import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, webContents: {} }))

const { ElectronTaskHost, NETWORK_IDLE_MS, classify, contentLength, extensionIdOf, utilityName } =
  await import('../tasks')
type EngineContents = import('../tasks').EngineContents
type EngineProcess = import('../tasks').EngineProcess
type TaskEngine = import('../tasks').TaskEngine
type WebRequestListener = import('../webRequest').WebRequestListener
type WebRequestMultiplexer = import('../webRequest').WebRequestMultiplexer

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const BROWSER_PID = 100

function proc(pid: number, type: string, extra: Partial<EngineProcess> = {}): EngineProcess {
  return { pid, type, cpuPercent: 1.5, workingSetKb: 1024, ...extra }
}

function contents(
  id: number,
  osProcessId: number,
  url: string,
  extra: Partial<EngineContents> = {}
): EngineContents & { crashed: number } {
  const c = {
    id,
    osProcessId,
    url,
    frames: [],
    devToolsContentsId: null,
    crashed: 0,
    crash() {
      c.crashed++
    },
    ...extra
  }
  return c
}

interface World {
  processes: EngineProcess[]
  all: Array<EngineContents & { crashed: number }>
  tabs: Map<number, string>
  /** Web contents id → the core's id of the window whose chrome they are. */
  chromeWindows: Map<number, string>
  killed: number[]
  host: InstanceType<typeof ElectronTaskHost>
  tick(ms: number): void
}

/** A world of processes and web contents the host reads, with the ids the platform would give. */
function world(): World {
  const processes: EngineProcess[] = []
  const all: Array<EngineContents & { crashed: number }> = []
  const tabs = new Map<number, string>()
  const chromeWindows = new Map<number, string>()
  const killed: number[] = []
  const engine: TaskEngine = {
    processes: () => processes,
    contents: () => all,
    browserPid: () => BROWSER_PID,
    kill: (pid) => {
      killed.push(pid)
      return true
    }
  }
  let now = 1_000
  const host = new ElectronTaskHost({
    engine,
    tabIdForWebContents: (id) => tabs.get(id),
    chromeWindowId: (id) => chromeWindows.get(id) ?? null,
    now: () => now
  })
  return {
    processes,
    all,
    tabs,
    chromeWindows,
    killed,
    host,
    tick: (ms: number) => {
      now += ms
    }
  }
}

describe('the Electron task host', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('places every process by the web contents that run in it', () => {
    const w = world()
    w.processes.push(
      proc(BROWSER_PID, 'Browser', { workingSetKb: 200_000 }),
      proc(201, 'Tab'),
      proc(202, 'Tab'),
      proc(203, 'Tab'),
      proc(204, 'Tab'),
      proc(205, 'Tab'),
      proc(300, 'GPU'),
      proc(400, 'Utility', {
        serviceName: 'network.mojom.NetworkService',
        name: 'Network Service'
      }),
      proc(401, 'Utility', { serviceName: 'audio.mojom.AudioService' }),
      proc(500, 'Zygote')
    )
    // The window's chrome, two tabs sharing a renderer, a third tab of its own with a toolbox
    // open, an extension's background page and a renderer nothing claims.
    w.all.push(contents(1, 201, 'file:///chrome/index.html'))
    w.chromeWindows.set(1, 'win_1')
    w.all.push(contents(2, 202, 'https://a.example/'))
    w.tabs.set(2, 'tab-a')
    w.all.push(contents(3, 202, 'https://a.example/two'))
    w.tabs.set(3, 'tab-a2')
    w.all.push(contents(4, 203, 'https://b.example/', { devToolsContentsId: 5 }))
    w.tabs.set(4, 'tab-b')
    w.all.push(contents(5, 204, 'devtools://devtools/bundled/devtools_app.html'))
    w.all.push(contents(6, 205, `chrome-extension://${EXT}/_generated_background_page.html`))

    const samples = w.host.sample()
    const byPid = new Map(samples.map((s) => [s.pid, s]))
    expect(byPid.get(BROWSER_PID)).toMatchObject({
      kind: 'browser',
      serviceName: null,
      memoryBytes: 200_000 * 1024,
      privateBytes: null,
      cpuPercent: 1.5
    })
    // The window's chrome carries the window's id, so the core can put its name on the row.
    expect(byPid.get(201)).toMatchObject({
      kind: 'browser',
      serviceName: 'Browser window',
      windowId: 'win_1'
    })
    expect(byPid.get(BROWSER_PID)!.windowId).toBeNull()
    expect(byPid.get(202)).toMatchObject({
      kind: 'tab',
      tabIds: ['tab-a', 'tab-a2'],
      windowId: null
    })
    expect(byPid.get(203)).toMatchObject({ kind: 'tab', tabIds: ['tab-b'] })
    expect(byPid.get(204)).toMatchObject({ kind: 'devtools', devtoolsForTabId: 'tab-b' })
    expect(byPid.get(205)).toMatchObject({ kind: 'extension', extensionId: EXT })
    expect(byPid.get(300)).toMatchObject({ kind: 'gpu' })
    expect(byPid.get(400)).toMatchObject({ kind: 'utility', serviceName: 'Network Service' })
    expect(byPid.get(401)).toMatchObject({ kind: 'utility', serviceName: 'Audio Service' })
    expect(byPid.get(500)).toMatchObject({ kind: 'other', serviceName: 'Zygote' })
  })

  it('names a renderer nothing claims, and an out-of-process frame for its site under the tab', () => {
    const w = world()
    w.processes.push(
      proc(BROWSER_PID, 'Browser'),
      proc(202, 'Tab'),
      proc(206, 'Tab'),
      proc(207, 'Tab')
    )
    w.all.push(
      contents(2, 202, 'https://a.example/', {
        frames: [
          { osProcessId: 202, url: 'https://a.example/same-process' },
          { osProcessId: 206, url: 'https://embed.example/player' }
        ]
      })
    )
    w.tabs.set(2, 'tab-a')
    const byPid = new Map(w.host.sample().map((s) => [s.pid, s]))
    expect(byPid.get(206)).toMatchObject({
      kind: 'renderer',
      tabIds: ['tab-a'],
      serviceName: 'Subframe: embed.example'
    })
    // The spare renderer (or an MV3 worker alone in its process): no frame names it.
    expect(byPid.get(207)).toMatchObject({ kind: 'renderer', serviceName: null, tabIds: [] })
  })

  it('reports private bytes where the engine has them', () => {
    const w = world()
    w.processes.push(proc(BROWSER_PID, 'Browser', { privateKb: 150_000 }))
    expect(w.host.sample()[0]?.privateBytes).toBe(150_000 * 1024)
  })

  it('ends a tab by crashing its renderer in place, a helper by killing it, and refuses the browser', () => {
    const w = world()
    w.processes.push(
      proc(BROWSER_PID, 'Browser'),
      proc(201, 'Tab'),
      proc(202, 'Tab'),
      proc(300, 'GPU'),
      proc(500, 'Zygote')
    )
    const chrome = contents(1, 201, 'file:///chrome/index.html')
    w.chromeWindows.set(1, 'win_1')
    const tab = contents(2, 202, 'https://a.example/')
    w.tabs.set(2, 'tab-a')
    w.all.push(chrome, tab)
    w.host.sample()

    expect(w.host.end(202)).toBe(true)
    expect(tab.crashed).toBe(1)
    expect(w.killed).toEqual([])

    expect(w.host.end(300)).toBe(true)
    expect(w.killed).toEqual([300])

    // The browser process and a window's chrome are the app; zygotes are the engine's plumbing.
    expect(w.host.end(BROWSER_PID)).toBe(false)
    expect(w.host.end(201)).toBe(false)
    expect(chrome.crashed).toBe(0)
    expect(w.host.end(500)).toBe(false)
    // A pid the page was never shown.
    expect(w.host.end(999)).toBe(false)
    expect(w.killed).toEqual([300])
  })

  it('counts network per tab between samples, only while sampling', () => {
    vi.useFakeTimers()
    const w = world()
    w.processes.push(proc(BROWSER_PID, 'Browser'), proc(202, 'Tab'), proc(203, 'Tab'))
    w.all.push(contents(2, 202, 'https://a.example/'))
    w.tabs.set(2, 'tab-a')
    w.all.push(contents(3, 203, 'https://b.example/'))
    w.tabs.set(3, 'tab-b')

    let listener: WebRequestListener | null = null
    let removed = 0
    const multiplexer = {
      addListener: (event: string, fn: WebRequestListener) => {
        expect(event).toBe('onCompleted')
        listener = fn
        return () => {
          removed++
          listener = null
        }
      }
    } as unknown as WebRequestMultiplexer
    w.host.attachNetwork(multiplexer)

    // The first sample starts the count: no rate yet.
    const first = w.host.sample()
    expect(first.find((s) => s.pid === 202)?.networkBytesPerSecond).toBeNull()
    expect(listener).not.toBeNull()

    const complete = (tabId: string | null, length?: string): void => {
      void listener!({
        event: 'onCompleted',
        tabId,
        responseHeaders: length === undefined ? {} : { 'Content-Length': [length] }
      } as never)
    }
    complete('tab-a', '1500')
    complete('tab-a', '500')
    complete('tab-b', '4000')
    // Requests outside a tab (an extension's, the browser's) are not attributed.
    complete(null, '9999')
    complete('tab-a')

    w.tick(2_000)
    const second = w.host.sample()
    expect(second.find((s) => s.pid === 202)?.networkBytesPerSecond).toBe(1000)
    expect(second.find((s) => s.pid === 203)?.networkBytesPerSecond).toBe(2000)
    expect(second.find((s) => s.pid === BROWSER_PID)?.networkBytesPerSecond).toBeNull()

    // Nothing more: the next rate is 0, not the old one again.
    w.tick(1_000)
    expect(w.host.sample().find((s) => s.pid === 202)?.networkBytesPerSecond).toBe(0)

    // The page closed: the listener goes once the samples stop.
    vi.advanceTimersByTime(NETWORK_IDLE_MS + 1)
    expect(removed).toBe(1)
    expect(listener).toBeNull()
    // Sampling again starts a fresh count.
    w.tick(NETWORK_IDLE_MS)
    expect(w.host.sample().find((s) => s.pid === 202)?.networkBytesPerSecond).toBeNull()
    vi.useRealTimers()
  })

  it('samples nothing of the network without a multiplexer', () => {
    const w = world()
    w.processes.push(proc(202, 'Tab'))
    w.all.push(contents(2, 202, 'https://a.example/'))
    w.tabs.set(2, 'tab-a')
    w.host.sample()
    w.tick(1_000)
    expect(w.host.sample()[0]?.networkBytesPerSecond).toBeNull()
  })
})

describe('the words of a process', () => {
  it('reads a utility process from the engine’s name, else the mojo service name', () => {
    expect(utilityName(proc(1, 'Utility', { name: 'Audio Service' }))).toBe('Audio Service')
    expect(utilityName(proc(1, 'Utility', { serviceName: 'network.mojom.NetworkService' }))).toBe(
      'Network Service'
    )
    expect(utilityName(proc(1, 'Utility', { serviceName: 'storage.mojom.StorageService' }))).toBe(
      'Storage Service'
    )
    expect(utilityName(proc(1, 'Utility'))).toBeNull()
  })

  it('folds the engine’s process types to the page’s kinds', () => {
    expect(classify(proc(1, 'Browser'), undefined, 1).kind).toBe('browser')
    expect(classify(proc(2, 'Tab'), undefined, 1)).toMatchObject({ kind: 'renderer' })
    expect(classify(proc(3, 'GPU'), undefined, 1).kind).toBe('gpu')
    // The coined names in sentence case (§4); the engine's own name as given.
    expect(classify(proc(4, 'Sandbox helper'), undefined, 1)).toMatchObject({
      kind: 'other',
      serviceName: 'Sandbox helper'
    })
    expect(classify(proc(6, 'Pepper Plugin Broker'), undefined, 1)).toMatchObject({
      kind: 'other',
      serviceName: 'Plugin broker'
    })
    expect(classify(proc(5, 'Unknown', { name: 'Odd' }), undefined, 1)).toMatchObject({
      kind: 'other',
      serviceName: 'Odd'
    })
  })

  it('reads an extension id from its origin alone', () => {
    expect(extensionIdOf(`chrome-extension://${EXT}/popup.html`)).toBe(EXT)
    expect(extensionIdOf('https://a.example/')).toBeNull()
    expect(extensionIdOf('')).toBeNull()
  })

  it('reads content-length whatever its case, 0 when absent or odd', () => {
    expect(contentLength({ 'content-length': ['1234'] })).toBe(1234)
    expect(contentLength({ 'Content-Length': ['99'] })).toBe(99)
    expect(contentLength({ 'Content-Length': ['nope'] })).toBe(0)
    expect(contentLength({})).toBe(0)
    expect(contentLength(undefined)).toBe(0)
  })
})
