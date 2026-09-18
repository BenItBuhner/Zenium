import { describe, expect, it } from 'vitest'
import { createScriptRecovery, type ScriptRecoveryHost } from '../extensionScriptRecovery'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const ORIGIN = `https://${EXT}.ext.zenium.invalid`

/** A `<script>` as the recovery sees it: a tag name, a resolved `src`, and DOM events. */
class FakeScript extends EventTarget {
  readonly tagName = 'SCRIPT'
  readonly events: string[] = []
  constructor(readonly src: string) {
    super()
    this.addEventListener('load', () => this.events.push('load'))
    this.addEventListener('error', () => this.events.push('error'))
  }
}

function errorEvent(target: unknown): {
  target: unknown
  stopImmediatePropagation: () => void
  stopped: boolean
} {
  const event = {
    target,
    stopped: false,
    stopImmediatePropagation() {
      event.stopped = true
    }
  }
  return event
}

function harness(ids = [EXT]): {
  host: ScriptRecoveryHost
  requests: Array<[string, string, string]>
  errors: unknown[][]
} {
  const requests: Array<[string, string, string]> = []
  const errors: unknown[][] = []
  const host: ScriptRecoveryHost = {
    attachedIds: () => ids,
    request: (id, extId, url) => void requests.push([id, extId, url]),
    error: (...args) => void errors.push(args)
  }
  return { host, requests, errors }
}

describe('extension-origin scripts the page CSP refused', () => {
  it("reports a refused script of an attached extension to the host and keeps the refusal from the extension's handlers", () => {
    const { host, requests } = harness()
    const recovery = createScriptRecovery(host)
    const script = new FakeScript(`${ORIGIN}/menu-fixer.js`)
    const event = errorEvent(script)
    recovery.onError(event)
    expect(event.stopped).toBe(true)
    expect(requests).toEqual([['s1', EXT, `${ORIGIN}/menu-fixer.js`]])
    expect(recovery.pending()).toBe(1)
    expect(script.events).toEqual([])
  })

  it('fires load on the element once the host ran the file in the main world', () => {
    const { host } = harness()
    const recovery = createScriptRecovery(host)
    const script = new FakeScript(`${ORIGIN}/inject.js`)
    recovery.onError(errorEvent(script))
    recovery.done('s1', null)
    expect(script.events).toEqual(['load'])
    expect(recovery.pending()).toBe(0)
  })

  it('lets the error through, once, when the host could not run the file', () => {
    const { host, errors } = harness()
    const recovery = createScriptRecovery(host)
    const script = new FakeScript(`${ORIGIN}/private.js`)
    recovery.onError(errorEvent(script))
    recovery.done('s1', 'private.js is not a web-accessible resource')
    expect(script.events).toEqual(['error'])
    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.[0])).toContain('private.js is not a web-accessible resource')
    // The re-dispatched error reaches the window listener again: no second request.
    const again = errorEvent(script)
    recovery.onError(again)
    expect(again.stopped).toBe(false)
    expect(recovery.pending()).toBe(0)
  })

  it("ignores the page's own scripts, other extensions' origins and non-script targets", () => {
    const { host, requests } = harness()
    const recovery = createScriptRecovery(host)
    const page = errorEvent(new FakeScript('https://m.youtube.com/s/player/base.js'))
    recovery.onError(page)
    const other = errorEvent(
      new FakeScript('https://ponmlkjihgfedcbaponmlkjihgfedcb.ext.zenium.invalid/a.js')
    )
    recovery.onError(other)
    const image = Object.assign(new EventTarget(), { tagName: 'IMG', src: `${ORIGIN}/icon.png` })
    recovery.onError(errorEvent(image))
    recovery.onError(errorEvent(null))
    expect(page.stopped).toBe(false)
    expect(other.stopped).toBe(false)
    expect(requests).toEqual([])
  })

  it('ignores an answer it never asked for', () => {
    const { host, errors } = harness()
    const recovery = createScriptRecovery(host)
    expect(() => recovery.done('s9', 'late')).not.toThrow()
    expect(errors).toEqual([])
    expect(recovery.pending()).toBe(0)
  })
})
