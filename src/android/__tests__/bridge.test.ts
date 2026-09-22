import { describe, expect, it, vi } from 'vitest'
import { Bridge, type NativeBridge } from '../bridge'

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
