import { describe, expect, it, vi } from 'vitest'
import { Bridge, type NativeBridge } from '../bridge'

/*
 * The one-way `post` of the JS ⇄ Kotlin bridge (the bar hide profile, #270): a command sent
 * every frame whose answer nobody reads goes to the host without an id and gets no `resolve`
 * back – a `send` is a `call`, and every answer to one is an `evaluateJavascript` on the chrome's
 * main thread, a task per frame beside the frame's own work. A host without `post` (an older
 * APK's bridge object) gets the `send`.
 */

function native(withPost: boolean): { native: NativeBridge; calls: string[]; posts: string[] } {
  const calls: string[] = []
  const posts: string[] = []
  const bridge: NativeBridge = {
    call: (json) => calls.push(json),
    callSync: () => ''
  }
  if (withPost) bridge.post = (json) => posts.push(json)
  return { native: bridge, calls, posts }
}

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
