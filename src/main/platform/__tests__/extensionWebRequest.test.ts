import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'
import type { EventDelivery } from '../../../core/extensions/api/shim'
import { BLOCKING_PERMISSION_ERROR } from '../../../core/extensions/api/webRequest'
import type { ListenerOptions, WebRequestDetails } from '../blocking'
import type { WebRequestEvent, WebRequestListener } from '../webRequest'
import type { FrameContext, WorkerContext } from '../extensionApi/contexts'
import { WebRequestApi, type WebRequestListenerHost } from '../extensionApi/webRequest'
import type { ApiContext, ApiHost } from '../extensionApi/types'

const MV2 = 'abcdefghijklmnopabcdefghijklmnop'
const MV3 = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const NO_PERMISSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

interface Hooked {
  event: WebRequestEvent
  listener: WebRequestListener
  options: ListenerOptions
  removed: boolean
}

/** Stands in for `ElectronBlocking`: records what was hooked and lets the test fire it. */
class FakeListenerHost implements WebRequestListenerHost {
  hooked: Hooked[] = []
  removedOf: string[] = []

  addListener(
    event: WebRequestEvent,
    listener: WebRequestListener,
    options: ListenerOptions
  ): () => void {
    const entry: Hooked = { event, listener, options, removed: false }
    this.hooked.push(entry)
    return () => {
      entry.removed = true
    }
  }

  removeListenersOf(registrant: string): void {
    this.removedOf.push(registrant)
  }

  live(): Hooked[] {
    return this.hooked.filter((h) => !h.removed)
  }

  fire(
    event: WebRequestEvent,
    details: Partial<WebRequestDetails>
  ): ReturnType<WebRequestListener>[] {
    return this.live()
      .filter((h) => h.event === event)
      .map((h) => h.listener(fakeDetails(event, details)))
  }
}

function fakeDetails(
  event: WebRequestEvent,
  details: Partial<WebRequestDetails>
): WebRequestDetails {
  return {
    event,
    requestId: '1',
    url: 'https://cdn.example/a.js',
    method: 'GET',
    resourceType: 'script',
    frameId: 0,
    parentFrameId: -1,
    tabId: 'tab-1',
    partition: 'default',
    initiator: 'https://page.example',
    documentUrl: 'https://page.example/',
    timestamp: 100,
    ...details
  }
}

interface Sent {
  context: FrameContext | WorkerContext
  namespace: string
  event: string
  args: unknown[]
  delivery: EventDelivery | undefined
}

interface World {
  api: WebRequestApi
  pipeline: FakeListenerHost
  sent: Sent[]
  /** Contexts the registry knows, by key; a missing key means the frame or worker is gone. */
  contexts: Map<string, FrameContext | WorkerContext>
  worker(extensionId: string, key?: string): WorkerContext
  frame(extensionId: string, key?: string): FrameContext
  ctx(context: FrameContext | WorkerContext): ApiContext
  loaded: Set<string>
  access: (extensionId: string, url: string) => boolean
  /** The partitions each extension's rules apply to (`ApiHost.partitionsOf`). */
  partitions: Map<string, string[]>
}

function world(options: { timeoutMs?: number; attach?: boolean } = {}): World {
  const sent: Sent[] = []
  const contexts = new Map<string, FrameContext | WorkerContext>()
  const loaded = new Set([MV2, MV3, NO_PERMISSION])
  const partitions = new Map<string, string[]>([
    [MV2, ['default']],
    [MV3, ['default']],
    [NO_PERMISSION, ['default']]
  ])
  const tabs = new Map<string, Tab>([
    ['tab-1', { id: 'tab-1', url: 'https://page.example/' } as Tab],
    ['tab-2', { id: 'tab-2', url: 'https://other.example/' } as Tab]
  ])
  const win = { id: 'win-1' } as unknown as ZenWindow
  const state: World = {
    api: undefined as unknown as WebRequestApi,
    pipeline: new FakeListenerHost(),
    sent,
    contexts,
    loaded,
    partitions,
    access: (extensionId, url) =>
      extensionId === MV2
        ? true
        : url.startsWith('https://cdn.example/') || url.startsWith('https://page.example'),
    worker(extensionId, key = `${extensionId}:worker`) {
      const context = {
        key,
        extensionId,
        worker: { isDestroyed: () => false },
        running: true
      } as unknown as WorkerContext
      contexts.set(key, context)
      return context
    },
    frame(extensionId, key = `${extensionId}:frame`) {
      const context = {
        key,
        extensionId,
        frame: { isDestroyed: () => false },
        webContents: { isDestroyed: () => false }
      } as unknown as FrameContext
      contexts.set(key, context)
      return context
    },
    ctx(context) {
      const manifestVersion = context.extensionId === MV2 ? 2 : 3
      const sender =
        'worker' in context
          ? { kind: 'worker' as const, worker: context.worker, session: {} }
          : { kind: 'frame' as const, frame: context.frame, webContents: context.webContents }
      return {
        extensionId: context.extensionId,
        extension: { id: context.extensionId, manifest: { manifest_version: manifestVersion } },
        sender,
        tabId: null,
        window: undefined
      } as unknown as ApiContext
    }
  }
  const host = {
    grants: (extensionId: string) => ({
      permissions:
        extensionId === MV2
          ? ['webRequest', 'webRequestBlocking', '<all_urls>']
          : extensionId === MV3
            ? ['webRequest', 'webRequestBlocking', 'webRequestAuthProvider']
            : ['storage'],
      origins: []
    }),
    loaded: (extensionId: string) => (loaded.has(extensionId) ? { id: extensionId } : undefined),
    hostAccess: (extensionId: string, url: string) => state.access(extensionId, url),
    partitionsOf: (extensionId: string) => partitions.get(extensionId) ?? [],
    registry: {
      frameFor: (frame: unknown) =>
        [...contexts.values()].find((c) => 'frame' in c && c.frame === frame),
      workerFor: (worker: unknown) =>
        [...contexts.values()].find((c) => 'worker' in c && c.worker === worker),
      isLive: (context: FrameContext | WorkerContext) => contexts.get(context.key) === context,
      sendTo: (
        context: FrameContext | WorkerContext,
        namespace: string,
        event: string,
        args: unknown[],
        delivery?: EventDelivery
      ) => {
        sent.push({ context, namespace, event, args, delivery })
      }
    },
    model: {
      tab: (id: string) => tabs.get(id),
      windowOfTab: (tab: Tab) => (tab.id === 'tab-1' ? win : undefined),
      chromeTabId: (tab: Tab) => (tab.id === 'tab-1' ? 11 : 12),
      windowIdOf: () => 1
    },
    browser: {
      extensions: {
        list: () => [
          { id: MV2, installedAt: 2000 },
          { id: MV3, installedAt: 3000 }
        ]
      }
    }
  } as unknown as ApiHost
  state.api = new WebRequestApi(host, options.timeoutMs)
  if (options.attach !== false) state.api.attach(state.pipeline)
  return state
}

function add(
  w: World,
  context: FrameContext | WorkerContext,
  event: string,
  filter: unknown,
  spec: unknown,
  id: number
): void {
  w.api.handlers.addListener(w.ctx(context), event, filter, spec, id)
}

describe('WebRequestApi registration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('needs the webRequest permission, a known event and a valid filter', () => {
    const w = world()
    const none = w.worker(NO_PERMISSION)
    expect(() => add(w, none, 'onBeforeRequest', { urls: [] }, [], 1)).toThrow(
      "The 'webRequest' permission is required."
    )
    const mv3 = w.worker(MV3)
    expect(() => add(w, mv3, 'onBeforeNavigate', { urls: [] }, [], 1)).toThrow(
      'Unknown webRequest event.'
    )
    expect(() => add(w, mv3, 'onBeforeRequest', { urls: ['nope'] }, [], 1)).toThrow(
      "'nope' is not a valid URL pattern."
    )
    expect(() => add(w, mv3, 'onBeforeRequest', { urls: [] }, ['blocking', 'bogus'], 1)).toThrow(
      /Error at index 1/
    )
    expect(() => add(w, mv3, 'onBeforeRequest', { urls: [] }, [], 0)).toThrow(
      'Invalid listener id.'
    )
    expect(w.api.listenerCount()).toBe(0)
    expect(w.pipeline.hooked).toEqual([])
  })

  it('lets only MV2 extensions holding webRequestBlocking register blocking listeners', () => {
    const w = world()
    const mv3 = w.worker(MV3)
    expect(() => add(w, mv3, 'onBeforeRequest', { urls: [] }, ['blocking'], 1)).toThrow(
      BLOCKING_PERMISSION_ERROR
    )
    expect(() => add(w, mv3, 'onHeadersReceived', { urls: [] }, ['blocking'], 1)).toThrow(
      BLOCKING_PERMISSION_ERROR
    )
    add(w, mv3, 'onBeforeRequest', { urls: [] }, [], 1)
    // webRequestAuthProvider lets an MV3 password manager answer onAuthRequired (which never
    // fires here, but the registration must not fail).
    add(w, mv3, 'onAuthRequired', { urls: [] }, ['asyncBlocking'], 2)
    const mv2 = w.frame(MV2)
    add(w, mv2, 'onBeforeRequest', { urls: [] }, ['blocking'], 1)
    add(w, mv2, 'onAuthRequired', { urls: [] }, ['blocking'], 2)
    expect(w.api.listenerCount(MV3)).toBe(2)
    expect(w.api.listenerCount(MV2)).toBe(2)
    expect(w.pipeline.hooked.map((h) => h.options)).toEqual([
      { registrant: MV3, priority: 3000, blocking: false },
      { registrant: MV2, priority: 2000, blocking: true }
    ])
    const noProvider = w.worker(NO_PERMISSION)
    expect(() => add(w, noProvider, 'onAuthRequired', { urls: [] }, ['asyncBlocking'], 1)).toThrow(
      "The 'webRequest' permission is required."
    )
  })

  it('hooks what registered before the pipeline existed, except onAuthRequired', () => {
    const w = world({ attach: false })
    const mv2 = w.frame(MV2)
    add(w, mv2, 'onBeforeRequest', { urls: [] }, [], 1)
    add(w, mv2, 'onAuthRequired', { urls: [] }, [], 2)
    add(w, mv2, 'onCompleted', { urls: [] }, [], 3)
    expect(w.api.listenerCount()).toBe(3)
    expect(w.pipeline.hooked).toEqual([])
    w.api.attach(w.pipeline)
    expect(w.pipeline.hooked.map((h) => h.event)).toEqual(['onBeforeRequest', 'onCompleted'])
    // Attaching again changes nothing.
    w.api.attach(w.pipeline)
    expect(w.pipeline.hooked).toHaveLength(2)
  })

  it('removes a listener by its id and event, and everything of an unloaded extension', () => {
    const w = world()
    const mv3 = w.worker(MV3)
    add(w, mv3, 'onBeforeRequest', { urls: [] }, [], 1)
    add(w, mv3, 'onCompleted', { urls: [] }, [], 2)
    w.api.handlers.removeListener(w.ctx(mv3), 'onCompleted', 1) // wrong event: nothing happens
    expect(w.api.listenerCount(MV3)).toBe(2)
    w.api.handlers.removeListener(w.ctx(mv3), 'onBeforeRequest', 1)
    expect(w.api.listenerCount(MV3)).toBe(1)
    expect(w.pipeline.live().map((h) => h.event)).toEqual(['onCompleted'])
    expect(() => w.api.handlers.removeListener(w.ctx(mv3), 'onCompleted', 'x')).toThrow(
      'Invalid listener id.'
    )
    w.api.unload(MV3)
    expect(w.api.listenerCount()).toBe(0)
    expect(w.pipeline.live()).toEqual([])
    expect(w.pipeline.removedOf).toEqual([MV3])
  })

  it('forgets what a previous document of the same frame registered', () => {
    const w = world()
    const first = w.frame(MV2, 'frame-7')
    add(w, first, 'onBeforeRequest', { urls: [] }, [], 1)
    add(w, first, 'onCompleted', { urls: [] }, [], 2)
    // The frame navigated: the registry now holds a new context object under the same key.
    const second = w.frame(MV2, 'frame-7')
    add(w, second, 'onBeforeRequest', { urls: [] }, [], 1)
    expect(w.api.listenerCount(MV2)).toBe(1)
    expect(w.pipeline.live()).toHaveLength(1)
    expect(w.pipeline.live()[0].event).toBe('onBeforeRequest')
  })

  it('rejects a context the registry does not know', () => {
    const w = world()
    const ghost = {
      key: 'ghost',
      extensionId: MV3,
      worker: { isDestroyed: () => false }
    } as unknown as WorkerContext
    expect(() => add(w, ghost, 'onBeforeRequest', { urls: [] }, [], 1)).toThrow(
      'The calling context is not registered.'
    )
  })
})

describe('WebRequestApi dispatch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delivers Chrome-shaped details to the one listener, addressed by its id', () => {
    const w = world()
    const mv3 = w.worker(MV3)
    add(w, mv3, 'onBeforeSendHeaders', { urls: ['*://cdn.example/*'] }, ['requestHeaders'], 3)
    const answers = w.pipeline.fire('onBeforeSendHeaders', {
      requestId: '77',
      requestHeaders: { Accept: '*/*' }
    })
    expect(answers).toEqual([undefined])
    expect(w.sent).toHaveLength(1)
    expect(w.sent[0]).toMatchObject({
      context: mv3,
      namespace: 'webRequest',
      event: 'onBeforeSendHeaders',
      delivery: { unfiltered: false, matched: [3] }
    })
    expect(w.sent[0].args).toEqual([
      {
        requestId: '77',
        url: 'https://cdn.example/a.js',
        method: 'GET',
        frameId: 0,
        parentFrameId: -1,
        tabId: 11,
        type: 'script',
        timeStamp: 100,
        initiator: 'https://page.example',
        documentLifecycle: 'active',
        frameType: 'outermost_frame',
        requestHeaders: [{ name: 'Accept', value: '*/*' }]
      },
      null
    ])
  })

  it('skips requests the extension may not see or the filter does not match', () => {
    const w = world()
    const mv3 = w.worker(MV3)
    add(w, mv3, 'onBeforeRequest', { urls: [], types: ['script'], tabId: 11 }, [], 1)
    // No host access to the URL.
    w.pipeline.fire('onBeforeRequest', { url: 'https://secret.example/a.js' })
    // Access to the URL but not to the initiator of a sub-resource.
    w.pipeline.fire('onBeforeRequest', { initiator: 'https://secret.example' })
    // Another extension's page as the initiator.
    w.pipeline.fire('onBeforeRequest', { initiator: `chrome-extension://${MV2}` })
    // Type and tab filters.
    w.pipeline.fire('onBeforeRequest', { resourceType: 'image' })
    w.pipeline.fire('onBeforeRequest', { tabId: 'tab-2' })
    w.pipeline.fire('onBeforeRequest', { tabId: null })
    expect(w.sent).toEqual([])
    // The matching request goes through; a navigation needs no initiator access.
    w.pipeline.fire('onBeforeRequest', {})
    w.pipeline.fire('onBeforeRequest', {
      url: 'https://cdn.example/',
      resourceType: 'script',
      initiator: 'https://secret.example',
      frameId: 0
    })
    expect(w.sent).toHaveLength(1)
    add(
      w,
      mv3,
      'onBeforeRequest',
      { urls: ['https://cdn.example/*'], types: ['main_frame'] },
      [],
      2
    )
    w.pipeline.fire('onBeforeRequest', {
      url: 'https://cdn.example/',
      resourceType: 'main_frame',
      initiator: 'https://secret.example'
    })
    expect(w.sent.map((s) => s.delivery?.matched)).toEqual([[1], [2]])
  })

  it('maps requests outside a tab to TAB_ID_NONE and drops listeners of dead contexts', () => {
    const w = world()
    const mv3 = w.worker(MV3)
    add(w, mv3, 'onCompleted', { urls: [] }, [], 1)
    w.pipeline.fire('onCompleted', { tabId: null, statusCode: 200 })
    expect(w.sent[0].args[0]).toMatchObject({ tabId: -1, statusCode: 200, fromCache: false })
    // The worker restarted: the registry holds a fresh context under the same key.
    w.worker(MV3)
    w.pipeline.fire('onCompleted', {})
    expect(w.sent).toHaveLength(1)
    expect(w.api.listenerCount(MV3)).toBe(0)
    expect(w.pipeline.live()).toEqual([])
  })

  it('stays silent for an extension that is no longer loaded', () => {
    const w = world()
    const mv3 = w.worker(MV3)
    add(w, mv3, 'onBeforeRequest', { urls: [] }, [], 1)
    w.loaded.delete(MV3)
    w.pipeline.fire('onBeforeRequest', {})
    expect(w.sent).toEqual([])
  })

  it('leaves a private window’s requests alone unless the extension is allowed there', async () => {
    const w = world()
    const mv2 = w.frame(MV2)
    add(w, mv2, 'onBeforeRequest', { urls: [] }, ['blocking'], 1)
    // A normal window's request reaches the blocking listener and its answer cancels it.
    const normal = w.pipeline.fire('onBeforeRequest', { partition: 'default' })
    expect(w.sent).toHaveLength(1)
    const token = w.sent[0].args[1]
    w.api.answer(w.ctx(mv2), { token, response: { cancel: true } })
    expect(await normal[0]).toEqual({ cancel: true })
    // The same request from the private partition, where the extension is not loaded, is not
    // delivered: the listener cannot block it, and nothing waits for an answer.
    expect(w.pipeline.fire('onBeforeRequest', { partition: 'private', tabId: 'tab-2' })).toEqual([
      undefined
    ])
    expect(w.sent).toHaveLength(1)
    expect(w.api.pendingAnswers).toBe(0)
    // A container the extension is loaded into counts; one it is not does not.
    w.partitions.set(MV2, ['default', 'work'])
    w.pipeline.fire('onBeforeRequest', { partition: 'work' })
    w.pipeline.fire('onBeforeRequest', { partition: 'school' })
    expect(w.sent).toHaveLength(2)
    // The user allowed the extension in private windows: the private partition joins its scope.
    w.partitions.set(MV2, ['default', 'private'])
    w.pipeline.fire('onBeforeRequest', { partition: 'private' })
    expect(w.sent).toHaveLength(3)
    expect(w.sent[2].args[0]).toMatchObject({ url: 'https://cdn.example/a.js' })
  })
})

describe('WebRequestApi blocking round trip', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("waits for the shim's answer under a token and applies it", async () => {
    const w = world()
    const mv2 = w.frame(MV2)
    add(w, mv2, 'onBeforeRequest', { urls: [] }, ['blocking'], 1)
    const [answer] = w.pipeline.fire('onBeforeRequest', {})
    expect(answer).toBeInstanceOf(Promise)
    expect(w.api.pendingAnswers).toBe(1)
    const token = w.sent[0].args[1]
    expect(typeof token).toBe('number')
    // An answer from another extension, or for an unknown token, is not taken.
    w.api.answer(w.ctx(w.worker(MV3)), { token, response: { cancel: true } })
    w.api.answer(w.ctx(mv2), { token: 9999, response: { cancel: true } })
    w.api.answer(w.ctx(mv2), 'garbage')
    expect(w.api.pendingAnswers).toBe(1)
    w.api.answer(w.ctx(mv2), {
      token,
      response: { cancel: false, redirectUrl: 'https://safe.example/', requestHeaders: 'ignored' }
    })
    expect(w.api.pendingAnswers).toBe(0)
    await expect(answer).resolves.toEqual({ redirectUrl: 'https://safe.example/' })
    // A second answer for the same token is ignored.
    w.api.answer(w.ctx(mv2), { token, response: { cancel: true } })
  })

  it('reduces the answer to what the phase accepts', async () => {
    const w = world()
    const mv2 = w.frame(MV2)
    add(w, mv2, 'onBeforeSendHeaders', { urls: [] }, ['blocking', 'requestHeaders'], 1)
    add(w, mv2, 'onHeadersReceived', { urls: [] }, ['blocking', 'responseHeaders'], 2)
    const [send] = w.pipeline.fire('onBeforeSendHeaders', { requestHeaders: { A: '1' } })
    const [recv] = w.pipeline.fire('onHeadersReceived', { responseHeaders: { b: ['2'] } })
    w.api.answer(w.ctx(mv2), {
      token: w.sent[0].args[1],
      response: {
        redirectUrl: 'https://nope.example/',
        requestHeaders: [
          { name: 'A', value: '1' },
          { name: 'X-Mine', value: 'm' }
        ]
      }
    })
    w.api.answer(w.ctx(mv2), {
      token: w.sent[1].args[1],
      response: {
        responseHeaders: [
          { name: 'b', value: '2' },
          { name: 'B', value: '3' }
        ]
      }
    })
    await expect(send).resolves.toEqual({ requestHeaders: { A: '1', 'X-Mine': 'm' } })
    await expect(recv).resolves.toEqual({ responseHeaders: { b: ['2', '3'] } })
    // No answer at all (the listener returned nothing) leaves the request alone.
    const [nothing] = w.pipeline.fire('onBeforeSendHeaders', {})
    w.api.answer(w.ctx(mv2), { token: w.sent[2].args[1] })
    await expect(nothing).resolves.toBeUndefined()
  })

  it('gives up on an answer that does not arrive in time, warning once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const w = world({ timeoutMs: 5 })
    const mv2 = w.frame(MV2)
    add(w, mv2, 'onBeforeRequest', { urls: [] }, ['blocking'], 1)
    const [first] = w.pipeline.fire('onBeforeRequest', {})
    const [second] = w.pipeline.fire('onBeforeRequest', {})
    expect(w.api.pendingAnswers).toBe(2)
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(w.api.pendingAnswers).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(
      /blocking onBeforeRequest listener did not answer within 5 ms/
    )
    // A late answer finds nothing to resolve.
    w.api.answer(w.ctx(mv2), { token: w.sent[0].args[1], response: { cancel: true } })
    expect(w.api.pendingAnswers).toBe(0)
  })

  it('answers nothing for the pending deliveries of an extension that unloads', async () => {
    const w = world()
    const mv2 = w.frame(MV2)
    add(w, mv2, 'onBeforeRequest', { urls: [] }, ['blocking'], 1)
    const [answer] = w.pipeline.fire('onBeforeRequest', {})
    expect(w.api.pendingAnswers).toBe(1)
    w.api.unload(MV2)
    expect(w.api.pendingAnswers).toBe(0)
    await expect(answer).resolves.toBeUndefined()
  })

  it('never waits on a non-blocking listener', () => {
    const w = world()
    const mv2 = w.frame(MV2)
    add(w, mv2, 'onBeforeRequest', { urls: [] }, ['requestBody'], 1)
    expect(w.pipeline.fire('onBeforeRequest', {})).toEqual([undefined])
    expect(w.api.pendingAnswers).toBe(0)
    expect(w.sent[0].args[1]).toBeNull()
  })
})
