// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SHARE_EVENTS,
  SHARE_MAX_BYTES,
  SHARE_MAX_FILES,
  installShareBridge,
  installShareShim,
  isShareCall,
  type ShareBridgeTransport,
  type ShareCall,
  type ShareOutcome,
  type ShareShimEvents
} from '../share'

function setUserActivation(isActive: boolean): void {
  Object.defineProperty(navigator, 'userActivation', {
    value: { isActive, hasBeenActive: isActive },
    configurable: true
  })
}

interface ScriptedBridge {
  events: ShareShimEvents
  /** What the isolated world handed the browser. */
  sent: ShareCall[]
  /** The browser's sheet answers. */
  answer: (id: string, result: ShareOutcome) => void
}

let installs = 0

/**
 * The isolated-world half with the browser scripted. Every install gets its own event names:
 * the document is shared by the tests and the listeners of an earlier install stay on it.
 */
function bridge(): ScriptedBridge {
  installs++
  const events: ShareShimEvents = {
    request: `${SHARE_EVENTS.request}-${installs}`,
    result: `${SHARE_EVENTS.result}-${installs}`
  }
  let push: (id: string, result: ShareOutcome) => void = () => undefined
  const state: ScriptedBridge = { events, sent: [], answer: (id, result) => push(id, result) }
  const transport: ShareBridgeTransport = {
    send: (call) => {
      state.sent.push(call)
    },
    onResult: (listener) => {
      push = listener
    },
    installShim: (e) => installShareShim(e)
  }
  installShareBridge(transport, events)
  return state
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const file = (name: string, bytes: string, type = 'text/plain'): File =>
  new File([bytes], name, { type })
const manyFiles = (): File[] =>
  Array.from({ length: SHARE_MAX_FILES + 1 }, (_, i) => file(`${i}.txt`, 'a'))

type ShareNavigator = Navigator & {
  share: (data?: unknown) => Promise<void>
  canShare: (data?: unknown) => boolean
}
const nav = (): ShareNavigator => navigator as ShareNavigator

describe('navigator.share shim', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true })
    setUserActivation(true)
  })
  afterEach(() => {
    Reflect.deleteProperty(Navigator.prototype, 'share')
    Reflect.deleteProperty(Navigator.prototype, 'canShare')
  })

  it('canShare follows Chrome: a known field, a parseable http(s) URL, files within the limits', () => {
    bridge()
    expect(nav().canShare()).toBe(false)
    expect(nav().canShare({})).toBe(false)
    expect(nav().canShare({ title: 'x' })).toBe(true)
    expect(nav().canShare({ url: '/relative' })).toBe(true)
    expect(nav().canShare({ url: 'ftp://files.example/' })).toBe(false)
    expect(nav().canShare({ url: 'http://[bad' })).toBe(false)
    expect(nav().canShare({ files: [file('a.txt', 'a')] })).toBe(true)
    expect(nav().canShare({ files: 'a.txt' })).toBe(false)
    expect(nav().canShare({ files: manyFiles() })).toBe(false)
  })

  it('rejects the calls Chrome rejects, with its errors, without troubling the browser', async () => {
    const b = bridge()
    await expect(nav().share()).rejects.toThrow(TypeError)
    await expect(nav().share({})).rejects.toThrow(/No known share data fields/)
    await expect(nav().share({ url: 'ftp://files.example/' })).rejects.toThrow(/Invalid URL/)
    await expect(nav().share({ files: 'nope' })).rejects.toThrow(/not a sequence of files/)
    await expect(nav().share({ files: manyFiles() })).rejects.toMatchObject({
      name: 'NotAllowedError'
    })
    setUserActivation(false)
    await expect(nav().share({ title: 'x' })).rejects.toMatchObject({
      name: 'NotAllowedError',
      message: /user gesture/
    })
    expect(b.sent).toEqual([])
  })

  it('posts the call with its files as base64 and settles when the sheet says shared', async () => {
    const b = bridge()
    const promise = nav().share({
      title: 'A story',
      text: 'Read this',
      url: '/story',
      files: [file('note.txt', 'hello')]
    })
    await flush()
    expect(b.sent).toHaveLength(1)
    const [call] = b.sent
    expect(call).toMatchObject({
      title: 'A story',
      text: 'Read this',
      url: 'http://localhost:3000/story'
    })
    expect(call.files).toEqual([
      { name: 'note.txt', type: 'text/plain', size: 5, data: btoa('hello') }
    ])
    // One sheet at a time, as in Chrome.
    await expect(nav().share({ title: 'again' })).rejects.toMatchObject({
      name: 'InvalidStateError'
    })
    b.answer(call.id, 'shared')
    await expect(promise).resolves.toBeUndefined()
    // The sheet is down: the next share goes through.
    const next = nav().share({ text: 'hi' })
    await flush()
    expect(b.sent).toHaveLength(2)
    expect(b.sent[1]).toMatchObject({ title: '', text: 'hi', url: '', files: [] })
    b.answer(b.sent[1].id, 'shared')
    await expect(next).resolves.toBeUndefined()
  })

  it('rejects with AbortError when the sheet is dismissed; an answer for another call is ignored', async () => {
    const b = bridge()
    const promise = nav().share({ text: 'hi' })
    await flush()
    const [call] = b.sent
    b.answer('someone-else', 'shared')
    b.answer(call.id, 'aborted')
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('the bridge ends a call its checks refuse as cancelled and drops what has no id', () => {
    const b = bridge()
    const results: unknown[] = []
    document.addEventListener(b.events.result, (e) =>
      results.push(JSON.parse((e as CustomEvent<string>).detail))
    )
    const request = (detail: string): boolean =>
      document.dispatchEvent(new CustomEvent(b.events.request, { detail }))
    request(JSON.stringify({ id: 'forged', title: 3 }))
    request('not json')
    request(JSON.stringify({ title: 'x' }))
    expect(results).toEqual([{ id: 'forged', result: 'aborted' }])
    expect(b.sent).toEqual([])
  })

  it('leaves an insecure page without the API', () => {
    Object.defineProperty(globalThis, 'isSecureContext', { value: false, configurable: true })
    installShareShim(SHARE_EVENTS)
    expect('share' in navigator).toBe(false)
    expect('canShare' in navigator).toBe(false)
  })
})

describe('isShareCall', () => {
  const call: ShareCall = { id: 'c', title: '', text: '', url: 'https://a.example/', files: [] }

  it('accepts a call within Chrome’s limits and nothing else', () => {
    expect(isShareCall(call)).toBe(true)
    expect(isShareCall({ ...call, url: '', text: 'words' })).toBe(true)
    expect(isShareCall({ ...call, url: '' })).toBe(false)
    expect(isShareCall({ ...call, url: 'javascript:alert(1)' })).toBe(false)
    expect(isShareCall({ ...call, id: '' })).toBe(false)
    expect(isShareCall({ ...call, files: [{ name: 'a', type: 't', size: 1 }] })).toBe(false)
    expect(
      isShareCall({
        ...call,
        files: [{ name: 'a', type: 't', size: SHARE_MAX_BYTES + 1, data: '' }]
      })
    ).toBe(false)
    expect(
      isShareCall({
        ...call,
        files: Array.from({ length: SHARE_MAX_FILES + 1 }, () => ({
          name: 'a',
          type: 't',
          size: 1,
          data: ''
        }))
      })
    ).toBe(false)
    expect(isShareCall(null)).toBe(false)
  })
})
