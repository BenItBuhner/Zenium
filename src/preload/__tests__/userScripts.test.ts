// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIRST_USER_SCRIPT_WORLD_ID,
  installUserScripts,
  type UserScriptsBridge
} from '../userScripts'
import {
  NO_RECEIVER_ERROR,
  type PortWire,
  type WireAnswer,
  type WireExtensionPlan,
  type WorldDelivery,
  type WorldExecution,
  type WorldMessage
} from '../../shared/userScripts'
import { WORLD_EVALUATOR } from '../../shared/userScriptWorld'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake worlds' untyped globals
type Any = any

interface Fake {
  bridge: UserScriptsBridge
  /** Fake isolated worlds by id: a private global object each, sharing the test's document. */
  roots: Map<number, Any>
  mainRuns: string[]
  isolatedRuns: Array<{ worldId: number; code: string }>
  infos: Array<{ worldId: number; info: unknown }>
  ports: PortWire[]
  answers: WireAnswer[]
  messages: WorldMessage[]
  reply(message: WorldMessage): unknown
  pushPort(wire: PortWire): void
  deliver(delivery: WorldDelivery): void
  execute(execution: WorldExecution): void
  /** Make one world's script executions fail, as a world whose CSP blocked them would. */
  failIsolated: boolean
  /** Make the worlds' evaluator report a CSP that forbids eval. */
  noEval: boolean
}

/** The evaluator's flag on a fake root once the fake has taken it over. */
const FAKE_EVALUATOR = Symbol('fake evaluator')

/**
 * The fake engine: `executeInIsolatedWorld` evaluates the code with the world's private root
 * standing in for `globalThis` (the world API installs `chrome` there) and the world's own
 * `chrome` in scope, as a real isolated world would have it. The world API's evaluator uses an
 * indirect `eval`, which here would see the test's global rather than the root, so the fake
 * takes the evaluator over with one that keeps its contract against the root.
 */
function fake(plans: unknown): Fake {
  const roots = new Map<number, Any>()
  const listeners: {
    port?: (wire: PortWire) => void
    deliver?: (delivery: WorldDelivery) => void
    execute?: (execution: WorldExecution) => void
  } = {}
  const f: Fake = {
    roots,
    mainRuns: [],
    isolatedRuns: [],
    infos: [],
    ports: [],
    answers: [],
    messages: [],
    reply: () => ({ result: 'default-reply' }),
    failIsolated: false,
    noEval: false,
    pushPort: (wire) => listeners.port?.(wire),
    deliver: (delivery) => listeners.deliver?.(delivery),
    execute: (execution) => listeners.execute?.(execution),
    bridge: {
      plan: () => plans,
      message: async (message) => {
        f.messages.push(message)
        return f.reply(message)
      },
      port: (wire) => {
        f.ports.push(wire)
      },
      answer: (answer) => {
        f.answers.push(answer)
      },
      onPort: (l) => {
        listeners.port = l
      },
      onDeliver: (l) => {
        listeners.deliver = l
      },
      onExecute: (l) => {
        listeners.execute = l
      },
      executeInMainWorld: async (code) => {
        f.mainRuns.push(code)
        return (0, eval)(code)
      },
      executeInIsolatedWorld: async (worldId, code) => {
        f.isolatedRuns.push({ worldId, code })
        if (f.failIsolated) throw new Error('Script failed to execute')
        let root = roots.get(worldId)
        if (!root) {
          root = { document }
          roots.set(worldId, root)
        }
        const run = new Function(
          'globalThis',
          'chrome',
          'browser',
          WORLD_EVALUATOR,
          'code',
          'return eval(code)'
        ) as (g: Any, c: Any, b: Any, e: Any, code: string) => unknown
        const evaluate = (source: string): unknown =>
          run(root, root.chrome, root.chrome, root[WORLD_EVALUATOR], source)
        const result = evaluate(code)
        if (typeof root[WORLD_EVALUATOR] === 'function' && !root[FAKE_EVALUATOR]) {
          root[FAKE_EVALUATOR] = true
          Object.defineProperty(root, WORLD_EVALUATOR, {
            value: (source: string): unknown => {
              if (f.noEval) return { noEval: true }
              try {
                return { value: evaluate(source) }
              } catch (error) {
                return {
                  error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
                }
              }
            },
            configurable: true
          })
        }
        return result
      },
      setIsolatedWorldInfo: (worldId, info) => {
        f.infos.push({ worldId, info })
      }
    }
  }
  return f
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const W1 = FIRST_USER_SCRIPT_WORLD_ID

function plan(worlds: WireExtensionPlan['worlds'], extensionId = EXT): WireExtensionPlan {
  return { extensionId, incognito: false, worlds }
}

describe('installUserScripts', () => {
  let errors: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ;(globalThis as Any).__ran = []
  })
  afterEach(() => {
    errors.mockRestore()
    delete (globalThis as Any).__ran
  })

  it('configures a USER_SCRIPT world with the extension origin and CSP and installs the world API', async () => {
    const f = fake([
      plan([
        {
          world: 'USER_SCRIPT',
          worldId: null,
          csp: "script-src 'self' 'unsafe-eval'",
          messaging: true,
          scripts: [{ id: 'a', runAt: 'document_idle', code: ['globalThis.__a = 1'] }]
        }
      ])
    ])
    installUserScripts(f.bridge)
    expect(f.infos).toEqual([
      {
        worldId: W1,
        info: {
          securityOrigin: `chrome-extension://${EXT}`,
          csp: "script-src 'self' 'unsafe-eval'",
          name: `Zenium user scripts ${EXT}`
        }
      }
    ])
    await tick()
    const root = f.roots.get(W1)
    expect(root.chrome.runtime.id).toBe(EXT)
    expect(root.browser).toBe(root.chrome)
    expect(typeof root.chrome.runtime.sendMessage).toBe('function')
    expect(root.__a).toBe(1)
    expect(f.mainRuns).toEqual([])
  })

  it('runs MAIN scripts in the page world and names a worldId world', async () => {
    const f = fake([
      plan([
        {
          world: 'MAIN',
          worldId: null,
          csp: null,
          messaging: false,
          scripts: [{ id: 'm', runAt: 'document_end', code: ['__ran.push("main")'] }]
        },
        {
          world: 'USER_SCRIPT',
          worldId: 'w2',
          csp: null,
          messaging: false,
          scripts: [
            { id: 'u', runAt: 'document_end', code: ['globalThis.__u = chrome.runtime.id'] }
          ]
        }
      ])
    ])
    installUserScripts(f.bridge)
    await tick()
    expect((globalThis as Any).__ran).toEqual(['main'])
    expect(f.infos[0]).toEqual({
      worldId: W1,
      info: { securityOrigin: `chrome-extension://${EXT}`, name: `Zenium user scripts ${EXT} (w2)` }
    })
    expect(f.roots.get(W1).__u).toBe(EXT)
    expect(f.roots.get(W1).chrome.runtime.sendMessage).toBeUndefined()
  })

  it('gives every extension and worldId a world of its own, in order', async () => {
    const world = (extensionId: string, worldId: string | null, code: string): WireExtensionPlan =>
      plan(
        [
          {
            world: 'USER_SCRIPT',
            worldId,
            csp: null,
            messaging: false,
            scripts: [{ id: 's', runAt: 'document_start', code: [code] }]
          }
        ],
        extensionId
      )
    const f = fake([
      world(EXT, null, 'globalThis.tag = "a"'),
      world(EXT, 'x', 'globalThis.tag = "ax"'),
      world(OTHER, null, 'globalThis.tag = "b"')
    ])
    installUserScripts(f.bridge)
    await tick()
    expect(f.infos.map((i) => i.worldId)).toEqual([W1, W1 + 1, W1 + 2])
    expect(f.roots.get(W1).tag).toBe('a')
    expect(f.roots.get(W1 + 1).tag).toBe('ax')
    expect(f.roots.get(W1 + 2).tag).toBe('b')
    expect(f.roots.get(W1 + 2).chrome.runtime.id).toBe(OTHER)
  })

  it('runs the scripts of one world in order, each source in turn, across phases', async () => {
    const f = fake([
      plan([
        {
          world: 'USER_SCRIPT',
          worldId: null,
          csp: null,
          messaging: false,
          scripts: [
            { id: 'one', runAt: 'document_start', code: ['__ran.push(1)', '__ran.push(2)'] },
            { id: 'two', runAt: 'document_idle', code: ['__ran.push(4)'] },
            { id: 'three', runAt: 'document_end', code: ['__ran.push(3)'] }
          ]
        }
      ])
    ])
    installUserScripts(f.bridge)
    await tick()
    // Phases are reached in order (start, end, idle) even when the plan lists them otherwise.
    expect((globalThis as Any).__ran).toEqual([1, 2, 3, 4])
  })

  it('logs a failing script and goes on with the next', async () => {
    const f = fake([
      plan([
        {
          world: 'MAIN',
          worldId: null,
          csp: null,
          messaging: false,
          scripts: [
            { id: 'bad', runAt: 'document_start', code: ['throw new Error("boom")'] },
            { id: 'good', runAt: 'document_start', code: ['__ran.push("after")'] }
          ]
        }
      ])
    ])
    installUserScripts(f.bridge)
    await tick()
    expect((globalThis as Any).__ran).toEqual(['after'])
    expect(errors).toHaveBeenCalledWith(`[zenium] user script 'bad' of ${EXT} failed: boom`)
  })

  it('ignores a plan that is not a list of extension plans', () => {
    const f = fake({ nope: true })
    installUserScripts(f.bridge)
    const g = fake([{ bogus: 1 }, null])
    installUserScripts(g.bridge)
    expect(f.infos).toEqual([])
    expect(g.infos).toEqual([])
  })

  describe('the worlds waiting for the document', () => {
    let html: HTMLElement
    beforeEach(() => {
      html = document.documentElement
      document.removeChild(html)
      Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
    })
    afterEach(() => {
      if (!document.documentElement) document.appendChild(html)
      Reflect.deleteProperty(document, 'readyState')
    })

    it('runs document_start once the document element exists, document_end at DOMContentLoaded, idle after load', async () => {
      vi.useFakeTimers()
      try {
        const f = fake([
          plan([
            {
              world: 'MAIN',
              worldId: null,
              csp: null,
              messaging: false,
              scripts: [
                { id: 's', runAt: 'document_start', code: ['__ran.push("start")'] },
                { id: 'e', runAt: 'document_end', code: ['__ran.push("end")'] },
                { id: 'i', runAt: 'document_idle', code: ['__ran.push("idle")'] }
              ]
            }
          ])
        ])
        installUserScripts(f.bridge)
        expect(f.mainRuns).toEqual([])
        document.appendChild(html)
        await Promise.resolve()
        await Promise.resolve()
        expect((globalThis as Any).__ran).toEqual(['start'])
        Object.defineProperty(document, 'readyState', {
          value: 'interactive',
          configurable: true
        })
        document.dispatchEvent(new Event('DOMContentLoaded'))
        await Promise.resolve()
        await Promise.resolve()
        expect((globalThis as Any).__ran).toEqual(['start', 'end'])
        window.dispatchEvent(new Event('load'))
        await Promise.resolve()
        await Promise.resolve()
        expect((globalThis as Any).__ran).toEqual(['start', 'end', 'idle'])
        vi.runAllTimers()
        expect(f.mainRuns).toHaveLength(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('reaches document_idle 200 ms after DOMContentLoaded when load is slow', async () => {
      vi.useFakeTimers()
      try {
        const f = fake([
          plan([
            {
              world: 'MAIN',
              worldId: null,
              csp: null,
              messaging: false,
              scripts: [{ id: 'i', runAt: 'document_idle', code: ['__ran.push("idle")'] }]
            }
          ])
        ])
        installUserScripts(f.bridge)
        document.appendChild(html)
        document.dispatchEvent(new Event('DOMContentLoaded'))
        await Promise.resolve()
        expect(f.mainRuns).toEqual([])
        vi.advanceTimersByTime(199)
        expect(f.mainRuns).toEqual([])
        vi.advanceTimersByTime(1)
        expect(f.mainRuns).toEqual(['__ran.push("idle")'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('holds a userScripts.execute without injectImmediately until document idle', async () => {
      const f = fake([])
      installUserScripts(f.bridge)
      f.execute({
        token: 5,
        extensionId: EXT,
        world: 'MAIN',
        worldId: null,
        csp: null,
        messaging: false,
        incognito: false,
        code: ['1 + 1'],
        injectImmediately: false
      })
      await tick()
      expect(f.answers).toEqual([])
      document.appendChild(html)
      Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
      document.dispatchEvent(new Event('DOMContentLoaded'))
      await tick()
      expect(f.answers).toEqual([{ token: 5, result: 2 }])
    })
  })

  describe('messaging from the worlds', () => {
    async function worldWithMessaging(messaging = true): Promise<{ f: Fake; root: Any }> {
      const f = fake([
        plan([
          {
            world: 'USER_SCRIPT',
            worldId: 'chat',
            csp: null,
            messaging,
            scripts: []
          }
        ])
      ])
      installUserScripts(f.bridge)
      await tick()
      return { f, root: f.roots.get(W1) }
    }

    it('relays runtime.sendMessage to the host with the world attributed by the preload', async () => {
      const { f, root } = await worldWithMessaging()
      f.reply = (message) => ({ result: { echo: message.message } })
      await expect(root.chrome.runtime.sendMessage({ q: 1 })).resolves.toEqual({ echo: { q: 1 } })
      expect(f.messages).toEqual([{ extensionId: EXT, worldId: 'chat', message: { q: 1 } }])
    })

    it('turns the host error, or a failed invoke, into the rejection', async () => {
      const { f, root } = await worldWithMessaging()
      f.reply = () => ({ error: NO_RECEIVER_ERROR })
      await expect(root.chrome.runtime.sendMessage('x')).rejects.toThrow(NO_RECEIVER_ERROR)
      f.bridge.message = async () => {
        throw new Error('ipc gone')
      }
      await expect(root.chrome.runtime.sendMessage('x')).rejects.toThrow('ipc gone')
    })

    it('opens ports through the host and routes their traffic both ways', async () => {
      const { f, root } = await worldWithMessaging()
      const port = root.chrome.runtime.connect({ name: 'tm' })
      expect(f.ports).toHaveLength(1)
      const connect = f.ports[0] as Extract<PortWire, { kind: 'connect' }>
      expect(connect).toEqual({
        kind: 'connect',
        portId: connect.portId,
        extensionId: EXT,
        worldId: 'chat',
        name: 'tm'
      })
      expect(connect.portId.startsWith('1:')).toBe(true)
      port.postMessage({ up: 1 })
      expect(f.ports[1]).toEqual({ kind: 'message', portId: connect.portId, message: { up: 1 } })

      const got: unknown[] = []
      port.onMessage.addListener((m: unknown) => got.push(m))
      f.pushPort({ kind: 'message', portId: connect.portId, message: { down: 2 } })
      expect(got).toEqual([{ down: 2 }])

      let lastError: unknown = 'unset'
      port.onDisconnect.addListener(() => {
        lastError = root.chrome.runtime.lastError
      })
      f.pushPort({ kind: 'disconnect', portId: connect.portId, error: 'closed by host' })
      expect(lastError).toEqual({ message: 'closed by host' })
      // The mapping is gone: further host traffic for the id is dropped.
      f.pushPort({ kind: 'message', portId: connect.portId, message: 'late' })
      expect(got).toEqual([{ down: 2 }])
    })

    it("a world's own disconnect tells the host once", async () => {
      const { f, root } = await worldWithMessaging()
      const port = root.chrome.runtime.connect()
      const portId = (f.ports[0] as { portId: string }).portId
      port.disconnect()
      port.disconnect()
      expect(f.ports.slice(1)).toEqual([{ kind: 'disconnect', portId }])
      f.pushPort({ kind: 'message', portId, message: 'late' })
      expect(f.ports).toHaveLength(2)
    })
  })

  describe('tabs.sendMessage deliveries', () => {
    it('answers unhandled when the extension has no world in this frame', () => {
      const f = fake([])
      installUserScripts(f.bridge)
      f.deliver({ token: 9, extensionId: EXT, message: 'm', sender: {} })
      expect(f.answers).toEqual([{ token: 9, handled: false, responded: false }])
    })

    it('delivers to every world of the extension; the first response wins', async () => {
      const f = fake([
        plan([
          {
            world: 'USER_SCRIPT',
            worldId: null,
            csp: null,
            messaging: true,
            scripts: [
              {
                id: 'a',
                runAt: 'document_start',
                code: ['chrome.runtime.onMessage.addListener((m, s, r) => { r("from-a:" + m) })']
              }
            ]
          },
          {
            world: 'USER_SCRIPT',
            worldId: 'other',
            csp: null,
            messaging: true,
            scripts: [
              {
                id: 'b',
                runAt: 'document_start',
                code: ['chrome.runtime.onMessage.addListener(() => { return true })']
              }
            ]
          }
        ]),
        plan(
          [{ world: 'USER_SCRIPT', worldId: null, csp: null, messaging: true, scripts: [] }],
          OTHER
        )
      ])
      installUserScripts(f.bridge)
      await tick()
      const sender = { id: EXT, url: `chrome-extension://${EXT}/sw.js` }
      f.deliver({ token: 1, extensionId: EXT, message: 'hi', sender })
      await tick()
      expect(f.answers).toEqual([{ token: 1, handled: true, responded: true, result: 'from-a:hi' }])
      // The other extension's world never saw it.
      expect(f.roots.get(W1 + 2).chrome.runtime.onMessage.hasListeners()).toBe(false)
    })

    it('reports handled without a response when the listeners let the channel close', async () => {
      const f = fake([
        plan([
          {
            world: 'USER_SCRIPT',
            worldId: null,
            csp: null,
            messaging: true,
            scripts: [
              {
                id: 'a',
                runAt: 'document_start',
                code: ['chrome.runtime.onMessage.addListener(() => {})']
              }
            ]
          },
          { world: 'USER_SCRIPT', worldId: 'silent', csp: null, messaging: true, scripts: [] }
        ])
      ])
      installUserScripts(f.bridge)
      await tick()
      f.deliver({ token: 2, extensionId: EXT, message: 'hi', sender: null })
      await tick()
      expect(f.answers).toEqual([{ token: 2, handled: true, responded: false }])
    })
  })

  describe('userScripts.execute', () => {
    const execution = (over: Partial<WorldExecution>): WorldExecution => ({
      token: 1,
      extensionId: EXT,
      world: 'USER_SCRIPT',
      worldId: null,
      csp: "script-src 'self'",
      messaging: false,
      incognito: true,
      code: ['1 + 1'],
      injectImmediately: true,
      ...over
    })

    it('runs in the page world and answers with the last value', async () => {
      const f = fake([])
      installUserScripts(f.bridge)
      f.execute(execution({ world: 'MAIN', code: ['__ran.push("x")', '40 + 2'] }))
      await tick()
      expect(f.answers).toEqual([{ token: 1, result: 42 }])
      expect((globalThis as Any).__ran).toEqual(['x'])
    })

    it('makes the world on demand with the execution CSP and answers through the evaluator', async () => {
      const f = fake([])
      installUserScripts(f.bridge)
      f.execute(
        execution({ code: ['globalThis.mark = chrome.runtime.id; globalThis.mark.length'] })
      )
      await tick()
      expect(f.infos).toEqual([
        {
          worldId: W1,
          info: {
            securityOrigin: `chrome-extension://${EXT}`,
            csp: "script-src 'self'",
            name: `Zenium user scripts ${EXT}`
          }
        }
      ])
      expect(f.answers).toEqual([{ token: 1, result: 32 }])
      expect(f.roots.get(W1).chrome.extension.inIncognitoContext).toBe(true)
      // The evaluator was used: the code itself never went to the engine plainly.
      expect(f.isolatedRuns.some((r) => r.code.startsWith(WORLD_EVALUATOR))).toBe(true)
    })

    it("answers with the thrown error's message", async () => {
      const f = fake([])
      installUserScripts(f.bridge)
      f.execute(execution({ code: ['throw new TypeError("bad thing")'] }))
      await tick()
      expect(f.answers).toEqual([{ token: 1, error: 'TypeError: bad thing' }])
    })

    it('runs the code plainly when the world forbids eval', async () => {
      const f = fake([])
      installUserScripts(f.bridge)
      f.execute(execution({ token: 3, code: ['globalThis.plain = 7; 7'] }))
      await tick()
      const root = f.roots.get(W1)
      f.noEval = true
      f.execute(execution({ token: 4, code: ['globalThis.plain2 = 8; 8'] }))
      await tick()
      expect(f.answers).toEqual([
        { token: 3, result: 7 },
        { token: 4, result: 8 }
      ])
      expect(root.plain2).toBe(8)
      expect(f.isolatedRuns.at(-1)?.code).toBe('globalThis.plain2 = 8; 8')
    })

    it("answers with the engine's error when a world cannot run scripts", async () => {
      const f = fake([])
      installUserScripts(f.bridge)
      f.failIsolated = true
      f.execute(execution({ token: 6 }))
      await tick()
      expect(f.answers).toEqual([{ token: 6, error: 'Script failed to execute' }])
      expect(errors).toHaveBeenCalled()
    })
  })
})
