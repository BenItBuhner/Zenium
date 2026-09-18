import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, WebContents, WebFrameMain } from 'electron'
import {
  ERROR_CONSOLE_NOTIFY_DELAY_MS,
  ExtensionErrorConsole,
  type ErrorConsoleProcess
} from '../extensionErrors'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

/** A WebContents as the console sees it: a `console-message` emitter with a URL. */
class FakeContents extends EventEmitter {
  destroyed = false
  constructor(private url: string) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getURL(): string {
    return this.url
  }
  /** What Electron emits: the params object, with the frame that printed the line. */
  print(
    level: string,
    message: string,
    sourceId: string,
    options: { lineNumber?: number; frame?: FakeFrame | null } = {}
  ): void {
    this.emit('console-message', {
      level,
      message,
      lineNumber: options.lineNumber ?? 1,
      sourceId,
      frame: options.frame === undefined ? new FakeFrame(this.url) : options.frame
    })
  }
  asContents(): WebContents {
    return this as unknown as WebContents
  }
}

/** A `WebFrameMain` whose `url` throws once the frame is disposed, as Electron's does. */
class FakeFrame {
  disposed = false
  constructor(private readonly frameUrl: string) {}
  get url(): string {
    if (this.disposed)
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    return this.frameUrl
  }
  asFrame(): WebFrameMain {
    return this as unknown as WebFrameMain
  }
}

/** A session whose `serviceWorkers` emits `console-message` and knows some versions. */
class FakeSession {
  readonly serviceWorkers: EventEmitter & {
    getWorkerFromVersionID(versionId: number): { scriptURL: string; scope: string } | undefined
    getInfoFromVersionID(versionId: number): { scriptUrl: string; scope: string }
  }
  readonly running = new Map<number, { scriptURL: string; scope: string }>()
  readonly registered = new Map<number, { scriptUrl: string; scope: string }>()

  constructor() {
    const emitter = new EventEmitter()
    this.serviceWorkers = Object.assign(emitter, {
      getWorkerFromVersionID: (versionId: number) => this.running.get(versionId),
      getInfoFromVersionID: (versionId: number) => {
        const info = this.registered.get(versionId)
        if (!info) throw new Error('Could not find service worker with that version ID')
        return info
      }
    })
  }

  log(level: number, message: string, versionId: number, sourceUrl: string, lineNumber = 1): void {
    this.serviceWorkers.emit(
      'console-message',
      {},
      {
        message,
        versionId,
        source: 'console-api',
        level,
        sourceUrl,
        lineNumber
      }
    )
  }

  asSession(): Session {
    return this as unknown as Session
  }
}

class FakeProcess implements ErrorConsoleProcess {
  readonly existing: FakeContents[] = []
  private readonly listeners: Array<(contents: WebContents) => void> = []
  allWebContents(): WebContents[] {
    return this.existing.map((c) => c.asContents())
  }
  onWebContentsCreated(listener: (contents: WebContents) => void): void {
    this.listeners.push(listener)
  }
  create(url: string): FakeContents {
    const contents = new FakeContents(url)
    for (const listener of this.listeners) listener(contents.asContents())
    return contents
  }
}

let now = 1_000_000

function makeConsole(options: { accept?: (id: string) => boolean } = {}): ExtensionErrorConsole {
  return new ExtensionErrorConsole({ now: () => now, ...options })
}

beforeEach(() => {
  vi.useFakeTimers()
  now = 1_000_000
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ExtensionErrorConsole: pages', () => {
  it("records an extension page's errors and warnings as page lines, with script, line and page", () => {
    const console = makeConsole()
    const popup = new FakeContents(`chrome-extension://${ID}/popup.html`)
    console.watch(popup.asContents())
    popup.print(
      'error',
      'Uncaught TypeError: x is not a function',
      `chrome-extension://${ID}/popup.js`,
      {
        lineNumber: 12
      }
    )
    popup.print('warning', 'deprecated thing', `chrome-extension://${ID}/popup.js`, {
      lineNumber: 3
    })
    expect(console.list(ID)).toEqual([
      expect.objectContaining({
        id: 1,
        level: 'error',
        source: 'page',
        message: 'Uncaught TypeError: x is not a function',
        url: `chrome-extension://${ID}/popup.js`,
        line: 12,
        context: `chrome-extension://${ID}/popup.html`,
        at: now,
        count: 1
      }),
      expect.objectContaining({ id: 2, level: 'warning', source: 'page', line: 3 })
    ])
  })

  it('leaves info and debug lines out', () => {
    const console = makeConsole()
    const popup = new FakeContents(`chrome-extension://${ID}/popup.html`)
    console.watch(popup.asContents())
    popup.print('info', 'hello', `chrome-extension://${ID}/popup.js`)
    popup.print('debug', 'hello', `chrome-extension://${ID}/popup.js`)
    expect(console.list(ID)).toEqual([])
  })

  it("credits a content script's error inside a tab page to its extension as a content line", () => {
    const console = makeConsole()
    const tab = new FakeContents('https://example.com/article')
    console.watch(tab.asContents())
    tab.print(
      'error',
      'Uncaught ReferenceError: foo is not defined',
      `chrome-extension://${OTHER}/content.js`,
      {
        lineNumber: 40
      }
    )
    expect(console.list(OTHER)).toEqual([
      expect.objectContaining({
        source: 'content',
        url: `chrome-extension://${OTHER}/content.js`,
        line: 40,
        context: 'https://example.com/article'
      })
    ])
    expect(console.list(ID)).toEqual([])
  })

  it("ignores a tab page's own errors and the chrome's", () => {
    const console = makeConsole()
    const tab = new FakeContents('https://example.com/')
    const chrome = new FakeContents('zen://home')
    console.watch(tab.asContents())
    console.watch(chrome.asContents())
    tab.print('error', 'Uncaught Error: theirs', 'https://example.com/app.js')
    tab.print('error', 'Failed to load resource: 404', 'https://example.com/missing.png')
    chrome.print('error', 'ours', '/opt/zenium/renderer/index.js')
    expect(console.list(ID)).toEqual([])
    expect(console.list(OTHER)).toEqual([])
  })

  it("leaves Electron's own sandbox-bundle failure in an MV2 background page out", () => {
    const console = makeConsole()
    const background = new FakeContents(`chrome-extension://${ID}/_generated_background_page.html`)
    console.watch(background.asContents())
    background.print(
      'error',
      'Electron sandboxed_renderer.bundle.js script failed to run',
      'node:electron/js2c/sandbox_bundle'
    )
    background.print(
      'error',
      "TypeError: Cannot read properties of null (reading 'startupData')",
      'node:electron/js2c/sandbox_bundle'
    )
    background.print('error', 'Uncaught Error: mine', `chrome-extension://${ID}/background.js`)
    expect(console.list(ID)).toEqual([
      expect.objectContaining({ message: 'Uncaught Error: mine', source: 'page' })
    ])
  })

  it('falls back to the contents URL when the frame is disposed by the time the line arrives', () => {
    const console = makeConsole()
    const popup = new FakeContents(`chrome-extension://${ID}/popup.html`)
    console.watch(popup.asContents())
    const frame = new FakeFrame(`chrome-extension://${ID}/popup.html`)
    frame.disposed = true
    popup.print('error', 'late', `chrome-extension://${ID}/popup.js`, { frame })
    expect(console.list(ID)).toEqual([
      expect.objectContaining({ message: 'late', context: `chrome-extension://${ID}/popup.html` })
    ])
    // Neither the frame nor the contents when both are gone: still the extension's, by its script.
    const tab = new FakeContents('https://example.com/')
    console.watch(tab.asContents())
    tab.destroyed = true
    tab.print('error', 'later', `chrome-extension://${ID}/content.js`, { frame: null })
    expect(console.list(ID)[1]).toMatchObject({
      message: 'later',
      source: 'content',
      context: null
    })
  })

  it("uses the frame's URL, not the top page's, for a line from a subframe", () => {
    const console = makeConsole()
    const tab = new FakeContents('https://example.com/')
    console.watch(tab.asContents())
    tab.print('error', 'in frame', `chrome-extension://${ID}/content.js`, {
      frame: new FakeFrame('https://ads.example.net/frame.html')
    })
    expect(console.list(ID)[0].context).toBe('https://ads.example.net/frame.html')
  })

  it('install hears the contents alive already and the ones created later, each once', () => {
    const console = makeConsole()
    const process = new FakeProcess()
    const early = new FakeContents(`chrome-extension://${ID}/options.html`)
    process.existing.push(early)
    console.install(process)
    const late = process.create(`chrome-extension://${ID}/popup.html`)
    console.watch(late.asContents())
    early.print('error', 'early', `chrome-extension://${ID}/options.js`)
    late.print('error', 'late', `chrome-extension://${ID}/popup.js`)
    expect(console.list(ID).map((e) => [e.message, e.count])).toEqual([
      ['early', 1],
      ['late', 1]
    ])
  })
})

describe('ExtensionErrorConsole: workers', () => {
  it("records an MV3 worker's errors as worker lines against its script", () => {
    const console = makeConsole()
    const ses = new FakeSession()
    ses.running.set(7, {
      scriptURL: `chrome-extension://${ID}/sw.js`,
      scope: `chrome-extension://${ID}/`
    })
    console.attachSession(ses.asSession())
    ses.log(3, 'Uncaught (in promise) Error: nope', 7, `chrome-extension://${ID}/sw.js`, 88)
    ses.log(2, 'careful', 7, `chrome-extension://${ID}/lib/util.js`, 5)
    ses.log(1, 'just info', 7, `chrome-extension://${ID}/sw.js`)
    expect(console.list(ID)).toEqual([
      expect.objectContaining({
        level: 'error',
        source: 'worker',
        message: 'Uncaught (in promise) Error: nope',
        url: `chrome-extension://${ID}/sw.js`,
        line: 88,
        context: `chrome-extension://${ID}/sw.js`
      }),
      expect.objectContaining({
        level: 'warning',
        url: `chrome-extension://${ID}/lib/util.js`,
        context: `chrome-extension://${ID}/sw.js`
      })
    ])
  })

  it('finds the extension through the worker when the line names no script', () => {
    const console = makeConsole()
    const ses = new FakeSession()
    ses.running.set(7, {
      scriptURL: `chrome-extension://${ID}/sw.js`,
      scope: `chrome-extension://${ID}/`
    })
    console.attachSession(ses.asSession())
    ses.log(3, 'network failure', 7, '')
    expect(console.list(ID)).toEqual([
      expect.objectContaining({
        url: `chrome-extension://${ID}/sw.js`,
        context: `chrome-extension://${ID}/sw.js`
      })
    ])
  })

  it('falls back to the registration for a version that stopped running', () => {
    const console = makeConsole()
    const ses = new FakeSession()
    ses.registered.set(9, {
      scriptUrl: `chrome-extension://${OTHER}/bg.js`,
      scope: `chrome-extension://${OTHER}/`
    })
    console.attachSession(ses.asSession())
    ses.log(3, 'dying words', 9, '')
    expect(console.list(OTHER)).toEqual([
      expect.objectContaining({ message: 'dying words', url: `chrome-extension://${OTHER}/bg.js` })
    ])
  })

  it("ignores a web page's service worker and a version nobody knows", () => {
    const console = makeConsole()
    const ses = new FakeSession()
    ses.running.set(3, { scriptURL: 'https://example.com/sw.js', scope: 'https://example.com/' })
    console.attachSession(ses.asSession())
    ses.log(3, 'theirs', 3, 'https://example.com/sw.js')
    ses.log(3, 'unknown', 99, '')
    expect(console.list(ID)).toEqual([])
    expect(console.list(OTHER)).toEqual([])
  })

  it('attaches a session once', () => {
    const console = makeConsole()
    const ses = new FakeSession()
    ses.running.set(7, {
      scriptURL: `chrome-extension://${ID}/sw.js`,
      scope: `chrome-extension://${ID}/`
    })
    console.attachSession(ses.asSession())
    console.attachSession(ses.asSession())
    ses.log(3, 'once', 7, `chrome-extension://${ID}/sw.js`)
    expect(console.list(ID)).toHaveLength(1)
    expect(console.list(ID)[0].count).toBe(1)
  })
})

describe('ExtensionErrorConsole: bookkeeping', () => {
  it('collapses a line repeating per event into one row with a count', () => {
    const console = makeConsole()
    const ses = new FakeSession()
    ses.running.set(7, {
      scriptURL: `chrome-extension://${ID}/sw.js`,
      scope: `chrome-extension://${ID}/`
    })
    console.attachSession(ses.asSession())
    for (let i = 0; i < 500; i++) {
      now += 10
      ses.log(3, 'Uncaught TypeError: same every time', 7, `chrome-extension://${ID}/sw.js`, 1)
    }
    expect(console.list(ID)).toHaveLength(1)
    expect(console.list(ID)[0]).toMatchObject({ count: 500, at: 1_000_010, lastAt: 1_005_000 })
  })

  it('drops the lines of an extension the registry does not know', () => {
    const console = makeConsole({ accept: (id) => id === ID })
    console.report(OTHER, { level: 'error', source: 'load', message: 'gone' })
    console.report(ID, { level: 'error', source: 'load', message: 'known' })
    expect(console.list(OTHER)).toEqual([])
    expect(console.list(ID)).toHaveLength(1)
  })

  it('pools changes and tells the chrome once per pool', () => {
    const console = makeConsole()
    const changes = vi.fn()
    console.onChange(changes)
    console.report(ID, { level: 'error', source: 'worker', message: 'a' })
    console.report(ID, { level: 'error', source: 'worker', message: 'b' })
    console.report(OTHER, { level: 'error', source: 'worker', message: 'c' })
    expect(changes).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ERROR_CONSOLE_NOTIFY_DELAY_MS)
    expect(changes).toHaveBeenCalledTimes(1)
    console.report(ID, { level: 'error', source: 'worker', message: 'a' })
    vi.advanceTimersByTime(ERROR_CONSOLE_NOTIFY_DELAY_MS)
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it('clear empties a console and notifies; an empty one stays quiet', () => {
    const console = makeConsole()
    const changes = vi.fn()
    console.report(ID, { level: 'error', source: 'worker', message: 'a' })
    vi.advanceTimersByTime(ERROR_CONSOLE_NOTIFY_DELAY_MS)
    console.onChange(changes)
    console.clear(ID)
    expect(console.list(ID)).toEqual([])
    vi.advanceTimersByTime(ERROR_CONSOLE_NOTIFY_DELAY_MS)
    expect(changes).toHaveBeenCalledTimes(1)
    console.clear(ID)
    console.clear(OTHER)
    vi.advanceTimersByTime(ERROR_CONSOLE_NOTIFY_DELAY_MS)
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('remove keeps the runtime lines of a reload and drops the load ones', () => {
    const console = makeConsole()
    console.report(ID, { level: 'warning', source: 'load', message: 'unknown key' })
    console.report(ID, { level: 'error', source: 'worker', message: 'runtime' })
    console.remove(ID, (entry) => entry.source === 'load')
    expect(console.list(ID).map((e) => e.message)).toEqual(['runtime'])
    // Nothing to remove, nothing to say.
    const changes = vi.fn()
    vi.advanceTimersByTime(ERROR_CONSOLE_NOTIFY_DELAY_MS)
    console.onChange(changes)
    console.remove(ID, (entry) => entry.source === 'load')
    console.remove(OTHER, () => true)
    vi.advanceTimersByTime(ERROR_CONSOLE_NOTIFY_DELAY_MS)
    expect(changes).not.toHaveBeenCalled()
  })

  it('forget drops the console of an uninstalled extension', () => {
    const console = makeConsole()
    console.report(ID, { level: 'error', source: 'worker', message: 'a' })
    console.forget(ID)
    expect(console.list(ID)).toEqual([])
    // A line arriving later starts a new console (the registry decides whether it is kept).
    console.report(ID, { level: 'error', source: 'worker', message: 'b' })
    expect(console.list(ID).map((e) => e.id)).toEqual([1])
  })

  it('rekey moves a console to the id the extension loaded under', () => {
    const console = makeConsole()
    console.report(ID, { level: 'error', source: 'load', message: 'a' })
    console.rekey(ID, OTHER)
    expect(console.list(ID)).toEqual([])
    expect(console.list(OTHER).map((e) => e.message)).toEqual(['a'])
    console.rekey(OTHER, OTHER)
    expect(console.list(OTHER)).toHaveLength(1)
  })

  it('a listener that unsubscribes hears nothing more', () => {
    const console = makeConsole()
    const changes = vi.fn()
    const off = console.onChange(changes)
    off()
    console.report(ID, { level: 'error', source: 'worker', message: 'a' })
    vi.advanceTimersByTime(ERROR_CONSOLE_NOTIFY_DELAY_MS)
    expect(changes).not.toHaveBeenCalled()
  })
})
