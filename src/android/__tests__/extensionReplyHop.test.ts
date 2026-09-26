import { describe, expect, it } from 'vitest'
import { findReplyHop, REPLY_HOP, withReplyHop } from '../extensionReplyHop'
import type { RuntimeBridge } from '../extensionRuntime'

function bridge(): RuntimeBridge & { log: string[] } {
  const log: string[] = []
  return {
    log,
    call<T = void>(method: string, args?: unknown): Promise<T> {
      log.push(`call ${method} ${JSON.stringify(args ?? null)}`)
      return Promise.resolve(undefined as T)
    },
    send(method: string, args?: unknown): void {
      log.push(`send ${method} ${JSON.stringify(args ?? null)}`)
    },
    post(method: string, args?: unknown): void {
      // Bound to the bridge as the real one's is (`this.flush()` before the string leaves).
      if (this !== undefined && (this as { log?: string[] }).log !== log)
        throw new Error('post called unbound')
      log.push(`post ${method} ${JSON.stringify(args ?? null)}`)
    }
  }
}

describe('withReplyHop', () => {
  it('is the bridge itself for a chrome document without __zenExtHop, or with one of another shape', () => {
    const b = bridge()
    expect(withReplyHop(b, {})).toBe(b)
    expect(withReplyHop(b, { [REPLY_HOP]: null })).toBe(b)
    expect(withReplyHop(b, { [REPLY_HOP]: { send: 'not a function' } })).toBe(b)
    expect(findReplyHop({ [REPLY_HOP]: 3 })).toBeNull()
  })

  it("delivers over the hop with the stamps as JSON (null without them) and leaves call, send and post the bridge's own", async () => {
    const b = bridge()
    const hops: Array<[string, string, string | null]> = []
    const scope = {
      [REPLY_HOP]: {
        send: (ep: string, message: string, at: string | null) => hops.push([ep, message, at])
      }
    }
    const wrapped = withReplyHop(b, scope)
    expect(wrapped).not.toBe(b)
    expect(wrapped.deliver?.('t1:abc', '{"t":"reply","id":4}', [1000, 1003])).toBe(true)
    expect(wrapped.deliver?.('t1:abc', '{"t":"event"}')).toBe(true)
    expect(hops).toEqual([
      ['t1:abc', '{"t":"reply","id":4}', '[1000,1003]'],
      ['t1:abc', '{"t":"event"}', null]
    ])
    await wrapped.call('ext.readFile', { id: 'x' })
    wrapped.send('ext.expect', { n: 1 })
    wrapped.post?.('ext.send', { ep: 'e' })
    expect(b.log).toEqual([
      'call ext.readFile {"id":"x"}',
      'send ext.expect {"n":1}',
      'post ext.send {"ep":"e"}'
    ])
  })

  it('has no post when the bridge has none', () => {
    const b = bridge()
    const bare: RuntimeBridge = { call: b.call, send: b.send }
    const wrapped = withReplyHop(bare, { [REPLY_HOP]: { send: () => undefined } })
    expect(wrapped.post).toBeUndefined()
    expect(wrapped.deliver?.('e', '{}')).toBe(true)
  })

  it('falls back for good once the hop throws, said once', () => {
    const b = bridge()
    const warnings: string[] = []
    let calls = 0
    const scope = {
      [REPLY_HOP]: {
        send: () => {
          calls++
          throw new Error('the object is gone')
        }
      }
    }
    const wrapped = withReplyHop(b, scope, (message) => warnings.push(message))
    expect(wrapped.deliver?.('e', '{}')).toBe(false)
    expect(wrapped.deliver?.('e', '{}')).toBe(false)
    expect(calls).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('reply hop failed')
  })
})
