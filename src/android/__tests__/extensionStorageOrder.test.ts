import { describe, expect, it } from 'vitest'
import {
  type Harness,
  harness,
  record,
  hello,
  message,
  nextCallId,
  until,
  backgroundUp
} from './runtimeHarness'

/**
 * The storage order the runtime keeps from the bridge's receipt on (round 21's R21-12, Zoom
 * Video's lost update; the sweep's storage order probe reads the same on the phone): messages of
 * two contexts handed to `onMessage` in an order are committed and answered in that order, on the
 * `ext.send` port and on round 20's reply hop alike. What the runtime does NOT do – merge a
 * read-modify-write's `set` with a write that landed between its `get` and its `set` – is
 * Chrome's shape too: that race is the extension's own.
 */

const POPUP = 'popup1'
const CONTENT = 'doc1.n.abcdefgh'
const KEY = 'order_probe'

function setup(options: { hop?: boolean } = {}): Harness {
  const h = harness(options)
  return h
}

async function attach(h: Harness): Promise<void> {
  await h.runtime.attach(record(h))
  backgroundUp(h, 'bg1', ['storage.onChanged'])
  hello(h, POPUP, 'popup')
  hello(h, CONTENT, 'content')
}

/** A call handed to the runtime without waiting for its reply; the id to find the reply by. */
function issue(h: Harness, ep: string, method: string, args: unknown[]): number {
  const id = nextCallId()
  message(h, ep, { t: 'call', id, ns: 'storage', method, args })
  return id
}

function replyOf(h: Harness, ep: string, id: number): Record<string, unknown> | undefined {
  return h.kt.to(ep).find((m) => m.t === 'reply' && m.id === id)
}

/** The position of a reply in everything the runtime sent, for the order two endpoints' replies left in. */
function sentIndex(h: Harness, ep: string, id: number): number {
  return h.kt.sent.findIndex((s) => s.ep === ep && s.message.t === 'reply' && s.message.id === id)
}

describe.each([
  { name: 'the ext.send port', hop: false },
  { name: "round 20's reply hop", hop: true }
])('AndroidExtensionRuntime: chrome.storage order from receipt on, over $name', ({ hop }) => {
  it("a content script's get handed right after a popup's set answers the set's value, and the set is answered first", async () => {
    const h = setup({ hop })
    await attach(h)
    const set = issue(h, POPUP, 'set', ['local', { [KEY]: { scale: 1.25, popAt: 1 } }])
    const get = issue(h, CONTENT, 'get', ['local', KEY])
    await until(
      () => replyOf(h, POPUP, set) !== undefined && replyOf(h, CONTENT, get) !== undefined
    )
    expect(replyOf(h, POPUP, set)?.ok).toBe(true)
    expect(replyOf(h, CONTENT, get)?.result).toEqual({ [KEY]: { scale: 1.25, popAt: 1 } })
    expect(sentIndex(h, POPUP, set)).toBeGreaterThanOrEqual(0)
    expect(sentIndex(h, POPUP, set)).toBeLessThan(sentIndex(h, CONTENT, get))
  })

  it("a popup's get handed right after a content script's set answers the set's value", async () => {
    const h = setup({ hop })
    await attach(h)
    const set = issue(h, CONTENT, 'set', ['local', { [KEY]: { cs: 7, csAt: 2 } }])
    const get = issue(h, POPUP, 'get', ['local', KEY])
    await until(
      () => replyOf(h, CONTENT, set) !== undefined && replyOf(h, POPUP, get) !== undefined
    )
    expect(replyOf(h, POPUP, get)?.result).toEqual({ [KEY]: { cs: 7, csAt: 2 } })
    expect(sentIndex(h, CONTENT, set)).toBeLessThan(sentIndex(h, POPUP, get))
  })

  it('forty sets and gets of two contexts interleaved without a wait each answer the store as of their place in the order', async () => {
    const h = setup({ hop })
    await attach(h)
    const gets: { ep: string; id: number; expected: number }[] = []
    let latest = 0
    for (let i = 1; i <= 20; i++) {
      const writer = i % 2 === 0 ? POPUP : CONTENT
      const reader = writer === POPUP ? CONTENT : POPUP
      issue(h, writer, 'set', ['local', { [KEY]: { seq: i } }])
      latest = i
      gets.push({ ep: reader, id: issue(h, reader, 'get', ['local', KEY]), expected: latest })
    }
    await until(() => gets.every((g) => replyOf(h, g.ep, g.id) !== undefined))
    for (const g of gets) {
      expect(replyOf(h, g.ep, g.id)?.result).toEqual({ [KEY]: { seq: g.expected } })
    }
    const positions = gets.map((g) => sentIndex(h, g.ep, g.id))
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it("a read-modify-write's set commits as given – a write that landed between its get and its set is replaced, as Chrome replaces it: the race is the extension's own", async () => {
    const h = setup({ hop })
    await attach(h)
    const popupGet = issue(h, POPUP, 'get', ['local', KEY])
    await until(() => replyOf(h, POPUP, popupGet) !== undefined)
    const read = (replyOf(h, POPUP, popupGet)?.result as Record<string, unknown>)[KEY] ?? {}
    const contentSet = issue(h, CONTENT, 'set', ['local', { [KEY]: { cs: 1, csAt: 10 } }])
    const popupSet = issue(h, POPUP, 'set', [
      'local',
      { [KEY]: { ...(read as object), scale: 1.25, popAt: 11 } }
    ])
    const after = issue(h, CONTENT, 'get', ['local', KEY])
    await until(
      () => replyOf(h, POPUP, popupSet) !== undefined && replyOf(h, CONTENT, after) !== undefined
    )
    expect(replyOf(h, CONTENT, contentSet)?.ok).toBe(true)
    // The popup's read saw no `cs`; its set carries none; the content script's write is gone.
    expect(replyOf(h, CONTENT, after)?.result).toEqual({ [KEY]: { scale: 1.25, popAt: 11 } })
    // Both commits raised onChanged in order, the second's oldValue the first's newValue.
    const changed = h.kt
      .to('bg1')
      .filter((m) => m.t === 'event' && m.ns === 'storage' && m.name === 'onChanged')
    expect(changed).toHaveLength(2)
    const first = (changed[0].args as unknown[])[0] as Record<string, { newValue?: unknown }>
    const second = (changed[1].args as unknown[])[0] as Record<
      string,
      { oldValue?: unknown; newValue?: unknown }
    >
    expect(first[KEY].newValue).toEqual({ cs: 1, csAt: 10 })
    expect(second[KEY].oldValue).toEqual({ cs: 1, csAt: 10 })
    expect(second[KEY].newValue).toEqual({ scale: 1.25, popAt: 11 })
  })
})
