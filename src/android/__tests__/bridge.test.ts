import { describe, expect, it, vi } from 'vitest'
import {
  Bridge,
  PORTED,
  PORT_REQUEST,
  openBridgePort,
  type BridgePort,
  type NativeBridge,
  type PortTarget
} from '../bridge'

/*
 * The one-way `post` of the JS ⇄ Kotlin bridge (the bar hide profile, #270): a command sent
 * every frame whose answer nobody reads goes to the host without an id and gets no `resolve`
 * back – a `send` is a `call`, and every answer to one is an `evaluateJavascript` on the chrome's
 * main thread, a task per frame beside the frame's own work. A host without `post` (an older
 * APK's bridge object) gets the `send`.
 */

function native(
  withPost: boolean,
  withBatch = false
): { native: NativeBridge; calls: string[]; posts: string[]; batches: string[]; hops: string[] } {
  const calls: string[] = []
  const posts: string[] = []
  const batches: string[] = []
  // Every hop in the order the host saw it, by kind and method(s).
  const hops: string[] = []
  const methodsOf = (json: string): string => {
    const parsed = JSON.parse(json) as { method: string } | Array<{ method: string }>
    return Array.isArray(parsed) ? parsed.map((c) => c.method).join('+') : parsed.method
  }
  const bridge: NativeBridge = {
    call: (json) => {
      calls.push(json)
      hops.push(`call ${methodsOf(json)}`)
    },
    callSync: (json) => {
      hops.push(`sync ${methodsOf(json)}`)
      return ''
    }
  }
  if (withPost)
    bridge.post = (json) => {
      posts.push(json)
      hops.push(`post ${methodsOf(json)}`)
    }
  if (withBatch)
    bridge.batch = (json) => {
      batches.push(json)
      hops.push(`batch ${methodsOf(json)}`)
    }
  return { native: bridge, calls, posts, batches, hops }
}

const microtasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('Bridge.post', () => {
  it('goes to the host one way, without an id, and leaves nothing pending', () => {
    const { native: n, calls, posts } = native(true)
    const bridge = new Bridge(n)
    bridge.post('chrome.setBarHide', { edge: 'bottom', offset: 12, travel: 50, shownEdge: 839 })
    expect(calls).toEqual([])
    expect(posts).toEqual([
      JSON.stringify({
        method: 'chrome.setBarHide',
        args: { edge: 'bottom', offset: 12, travel: 50, shownEdge: 839 }
      })
    ])
    // Nothing waits for an answer: a stray resolve for any id is ignored.
    expect(() => bridge.resolve(1, 'null')).not.toThrow()
  })

  it('falls back to a call on a host without post, so an older host still hears the frame', () => {
    const { native: n, calls, posts } = native(false)
    const bridge = new Bridge(n)
    bridge.post('chrome.setBarHide', { enabled: false })
    expect(posts).toEqual([])
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0] ?? '{}')).toEqual({
      id: 1,
      method: 'chrome.setBarHide',
      args: { enabled: false }
    })
    // The fallback's answer resolves the pending call as a send's would.
    expect(() => bridge.resolve(1, 'null')).not.toThrow()
  })

  it('a host that throws is logged, not thrown into the frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bridge = new Bridge({
      call: () => {},
      callSync: () => '',
      post: () => {
        throw new Error('bridge gone')
      }
    })
    expect(() => bridge.post('chrome.setBarHide', {})).not.toThrow()
    expect(warn).toHaveBeenCalledWith('[zen] native chrome.setBarHide failed', expect.any(Error))
    warn.mockRestore()
  })
})

/*
 * `batched` (#312's H3b, the view batch): a layout report's view ops – four to six one-way
 * commands per report, each a synchronous hop to the host's bridge thread that the JS thread
 * waits out – leave as ONE `batch` at the end of the task, or sooner if the task makes a hop of
 * another kind, so the host sees every command in the order it was given. A host without `batch`
 * (an older APK's bridge object) gets a `send` each, as before.
 */
describe('Bridge.batched', () => {
  const bounds = { x: 0, y: 56, width: 412, height: 800 }

  it('coalesces the commands of one task into one batch, in order, at the end of the task', async () => {
    const { native: n, calls, posts, batches } = native(true, true)
    const bridge = new Bridge(n)
    bridge.batched('view.setBounds', { tabId: 't1', rect: bounds })
    bridge.batched('view.setRadius', { tabId: 't1', radius: 12 })
    bridge.batched('view.setVisible', { tabId: 't1', visible: true })
    // Nothing has left yet: the task is still running.
    expect(batches).toEqual([])
    await microtasks()
    expect(batches).toHaveLength(1)
    expect(JSON.parse(batches[0] ?? '[]')).toEqual([
      { method: 'view.setBounds', args: { tabId: 't1', rect: bounds } },
      { method: 'view.setRadius', args: { tabId: 't1', radius: 12 } },
      { method: 'view.setVisible', args: { tabId: 't1', visible: true } }
    ])
    // One way: no id, no call, no post, nothing pending to answer.
    expect(calls).toEqual([])
    expect(posts).toEqual([])
    expect(() => bridge.resolve(1, 'null')).not.toThrow()
  })

  it('leaves before any other hop of the task, so a call never overtakes the commands before it', async () => {
    const { native: n, hops } = native(true, true)
    const bridge = new Bridge(n)
    bridge.batched('view.setVisible', { tabId: 't1', visible: true })
    bridge.batched('view.setBounds', { tabId: 't1', rect: bounds })
    // The layout's focus of the page it just showed: a call, after the flip in the host's order.
    void bridge.call('view.focus', { tabId: 't1' })
    bridge.batched('view.setRadius', { tabId: 't1', radius: 0 })
    bridge.post('chrome.setBarHide', { enabled: false })
    bridge.batched('view.bringToFront', { tabId: 't2' })
    bridge.callSync('boot', {})
    bridge.batched('view.setCover', { tabId: 't2', cover: { top: 0, bottom: 0 } })
    await microtasks()
    expect(hops).toEqual([
      'batch view.setVisible+view.setBounds',
      'call view.focus',
      'batch view.setRadius',
      'post chrome.setBarHide',
      'batch view.bringToFront',
      'sync boot',
      'batch view.setCover'
    ])
  })

  it('starts a new batch for the next task', async () => {
    const { native: n, hops } = native(true, true)
    const bridge = new Bridge(n)
    bridge.batched('view.setBounds', { tabId: 't1', rect: bounds })
    await microtasks()
    bridge.batched('view.setBounds', { tabId: 't1', rect: { ...bounds, y: 0 } })
    bridge.batched('view.setRadius', { tabId: 't1', radius: 0 })
    await microtasks()
    expect(hops).toEqual(['batch view.setBounds', 'batch view.setBounds+view.setRadius'])
  })

  it('falls back to a send each on a host without batch, in order', async () => {
    const { native: n, calls, batches } = native(true, false)
    const bridge = new Bridge(n)
    bridge.batched('view.setBounds', { tabId: 't1', rect: bounds })
    bridge.batched('view.setVisible', { tabId: 't1', visible: true })
    await microtasks()
    expect(batches).toEqual([])
    expect(calls.map((json) => JSON.parse(json) as unknown)).toEqual([
      { id: 1, method: 'view.setBounds', args: { tabId: 't1', rect: bounds } },
      { id: 2, method: 'view.setVisible', args: { tabId: 't1', visible: true } }
    ])
    // The fallback's answers resolve the pending sends as before.
    expect(() => bridge.resolve(1, 'null')).not.toThrow()
    expect(() => bridge.resolve(2, 'null')).not.toThrow()
  })

  it('a host that throws is logged with the batch’s commands, not thrown, and the next batch starts clean', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const batches: string[] = []
    let broken = true
    const bridge = new Bridge({
      call: () => {},
      callSync: () => '',
      batch: (json) => {
        if (broken) throw new Error('bridge gone')
        batches.push(json)
      }
    })
    bridge.batched('view.setBounds', { tabId: 't1', rect: bounds })
    bridge.batched('view.setRadius', { tabId: 't1', radius: 12 })
    await microtasks()
    expect(warn).toHaveBeenCalledWith(
      '[zen] native batch of view.setBounds, view.setRadius failed',
      expect.any(Error)
    )
    broken = false
    bridge.batched('view.setVisible', { tabId: 't1', visible: false })
    await microtasks()
    expect(batches.map((json) => JSON.parse(json) as unknown)).toEqual([
      [{ method: 'view.setVisible', args: { tabId: 't1', visible: false } }]
    ])
    warn.mockRestore()
  })
})

/*
 * The asynchronous channel (services perf pass 2, #455's finding): the storage calls – awaited
 * `call`s whose answer arrives through `__zenHost` once the write has landed – paid a synchronous
 * hop of 4–68 ms of the chrome's frame to hand their string over. Once the host has handed the
 * page a `MessagePort`, EVERY call of the class goes through it (a pipe write, no wait) and none
 * through `call`: one FIFO into the host's one storage thread, the order kept across the switch
 * because the hop before it handed its string over before the JS thread went on. Every other
 * call keeps the hop; a host without the channel says so and nothing changes.
 */
describe('Bridge port', () => {
  /** A page end of the channel that records what was posted, into the shared `hops` too. */
  function port(hops: string[]): { port: BridgePort; messages: string[]; closed: () => number } {
    const messages: string[] = []
    let closed = 0
    return {
      port: {
        postMessage: (message) => {
          messages.push(message)
          hops.push(`port ${(JSON.parse(message) as { method: string }).method}`)
        },
        close: () => {
          closed++
        }
      },
      messages,
      closed: () => closed
    }
  }

  it('a storage call takes the hop before the port and the port after it; the others keep the hop', async () => {
    const { native: n, calls, hops } = native(true, true)
    const bridge = new Bridge(n)
    expect(bridge.ported).toBe(false)
    const before = bridge.call('storage.write', { name: 'state.json', text: '{}', backup: true })
    expect(hops).toEqual(['call storage.write'])

    const page = port(hops)
    bridge.adoptPort(page.port)
    expect(bridge.ported).toBe(true)
    const after = bridge.call<boolean>('storage.write', { name: 'state.json', text: '{"a":1}' })
    void bridge.call('tab.activate', { tabId: 't1' })
    bridge.post('chrome.setBarHide', { enabled: false })
    expect(hops).toEqual([
      'call storage.write',
      'port storage.write',
      'call tab.activate',
      'post chrome.setBarHide'
    ])
    // The ported call is a `call` in every other way: the same envelope, with its id, and its
    // answer comes back through `resolve` as before.
    expect(calls).toHaveLength(2)
    expect(JSON.parse(page.messages[0] ?? '{}')).toEqual({
      id: 2,
      method: 'storage.write',
      args: { name: 'state.json', text: '{"a":1}' }
    })
    bridge.resolve(1, 'true')
    bridge.resolve(2, 'true')
    await expect(before).resolves.toBe(true)
    await expect(after).resolves.toBe(true)
  })

  it('the whole class goes through the port, a send of one included, in one order', async () => {
    const { native: n, calls, hops } = native(true, true)
    const bridge = new Bridge(n)
    const page = port(hops)
    bridge.adoptPort(page.port)
    for (const method of PORTED) void bridge.call(method, { name: 'a.json' })
    bridge.send('storage.writeAbort', { token: 3 })
    await microtasks()
    expect(hops).toEqual([...PORTED, 'storage.writeAbort'].map((m) => `port ${m}`))
    expect(calls).toEqual([])
    // A batch waiting leaves ahead of a ported call, as it leaves ahead of any other hop.
    bridge.batched('view.setBounds', { tabId: 't1', rect: {} })
    void bridge.call('storage.write', { name: 'b.json', text: '1' })
    expect(hops.slice(-2)).toEqual(['batch view.setBounds', 'port storage.write'])
  })

  it('a second port is closed, not taken', () => {
    const { native: n, hops } = native(true, true)
    const bridge = new Bridge(n)
    const first = port(hops)
    const second = port(hops)
    bridge.adoptPort(first.port)
    bridge.adoptPort(second.port)
    expect(second.closed()).toBe(1)
    expect(first.closed()).toBe(0)
    void bridge.call('storage.remove', { name: 'a.json' })
    expect(first.messages).toHaveLength(1)
    expect(second.messages).toEqual([])
  })

  it('a port that will not take a string is dropped for good; the call and every later one take the hop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { native: n, calls, hops } = native(true, true)
    const bridge = new Bridge(n)
    bridge.adoptPort({
      postMessage: () => {
        throw new Error('InvalidStateError: the port is closed')
      },
      close: () => {}
    })
    const pending = bridge.call<boolean>('storage.write', { name: 'state.json', text: '{}' })
    void bridge.call('storage.remove', { name: 'old.json' })
    expect(bridge.ported).toBe(false)
    expect(hops).toEqual(['call storage.write', 'call storage.remove'])
    expect(warn).toHaveBeenCalledWith(
      '[zen] the bridge port failed; back to call',
      expect.any(Error)
    )
    expect(warn).toHaveBeenCalledTimes(1)
    // The call that fell back is still the same pending call.
    expect(calls).toHaveLength(2)
    bridge.resolve(1, 'true')
    await expect(pending).resolves.toBe(true)
    warn.mockRestore()
  })

  it('marks every hop by its channel and method when traced, and never otherwise', () => {
    const mark = vi.spyOn(performance, 'mark').mockImplementation(() => ({}) as PerformanceMark)
    const { native: n, hops } = native(true, true)
    const bridge = new Bridge(n)
    void bridge.call('storage.write', { name: 'a.json' })
    bridge.adoptPort(port(hops).port)
    void bridge.call('storage.write', { name: 'a.json' })
    expect(mark).not.toHaveBeenCalled()

    const g = globalThis as { __zenBridgeTrace?: unknown }
    g.__zenBridgeTrace = true
    try {
      void bridge.call('storage.write', { name: 'a.json' })
      void bridge.call('tab.activate', { tabId: 't1' })
    } finally {
      delete g.__zenBridgeTrace
    }
    expect(mark.mock.calls.map((c) => c[0])).toEqual([
      'bridge:port:storage.write',
      'bridge:call:tab.activate'
    ])
    void bridge.call('storage.write', { name: 'a.json' })
    expect(mark).toHaveBeenCalledTimes(2)
    mark.mockRestore()
  })

  /** The window of the page: what `openBridgePort` listens on, and what the host's port arrives through. */
  function target(): {
    target: PortTarget
    listeners: () => number
    emit: (event: Partial<MessageEvent>) => void
  } {
    const listeners = new Set<(event: MessageEvent) => void>()
    return {
      target: {
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener)
      },
      listeners: () => listeners.size,
      emit: (event) => {
        for (const listener of [...listeners]) listener(event as MessageEvent)
      }
    }
  }

  /** The host's answer to the one `bridge.port` call, by id. */
  function requestOf(calls: string[]): { id: number; token: string } {
    const call = JSON.parse(calls[0] ?? '{}') as {
      id: number
      method: string
      args: { token: string }
    }
    expect(call.method).toBe(PORT_REQUEST)
    return { id: call.id, token: call.args.token }
  }

  it('asks the host once and takes the port that comes back with the token, whichever arrives first', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    for (const answerFirst of [true, false]) {
      const { native: n, calls, hops } = native(true, true)
      const bridge = new Bridge(n)
      const win = target()
      openBridgePort(bridge, win.target, 'tok-1')
      expect(win.listeners()).toBe(1)
      const { id, token } = requestOf(calls)
      expect(token).toBe('tok-1')
      const page = port(hops)
      if (answerFirst) {
        bridge.resolve(id, 'true')
        await microtasks()
        // The answer said a port is coming: the listener stays for it.
        expect(win.listeners()).toBe(1)
        expect(bridge.ported).toBe(false)
      }
      // A message that is not the host's is not a port: another token, or no port in it.
      win.emit({ data: 'tok-other', ports: [page.port as unknown as MessagePort] })
      win.emit({ data: 'tok-1', ports: [] })
      expect(bridge.ported).toBe(false)
      win.emit({ data: 'tok-1', ports: [page.port as unknown as MessagePort] })
      expect(bridge.ported).toBe(true)
      expect(win.listeners()).toBe(0)
      if (!answerFirst) {
        bridge.resolve(id, 'true')
        await microtasks()
      }
      void bridge.call('storage.write', { name: 'state.json', text: '{}' })
      expect(page.messages).toHaveLength(1)
    }
    debug.mockRestore()
  })

  it('a host without the channel says so, or knows no such call: the listener goes and the hop stays', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    for (const rejects of [false, true]) {
      const { native: n, calls, hops } = native(true, true)
      const bridge = new Bridge(n)
      const win = target()
      openBridgePort(bridge, win.target)
      const { id, token } = requestOf(calls)
      expect(token.length).toBeGreaterThan(8)
      if (rejects) bridge.reject(id, 'unknown method bridge.port')
      else bridge.resolve(id, 'false')
      await microtasks()
      expect(win.listeners()).toBe(0)
      // A port arriving now is nobody's: nothing listens.
      const page = port(hops)
      win.emit({ data: token, ports: [page.port as unknown as MessagePort] })
      expect(bridge.ported).toBe(false)
      void bridge.call('storage.write', { name: 'state.json', text: '{}' })
      expect(hops.slice(-1)).toEqual(['call storage.write'])
      expect(page.messages).toEqual([])
    }
    debug.mockRestore()
  })
})
