import type { EngineContextKind, MessageSender } from '../api/engine'
import { presentExtensionUrl } from './extensionUrls'
import { extensionOrigin } from './plan'

/**
 * Routes `runtime.sendMessage` / `tabs.sendMessage` and ports between the endpoints of one
 * extension the way Chrome does: a message goes to every extension page except the sender (or
 * to the frames of one tab), the first response wins, "no receiving end" is an error while
 * "listeners but no response" resolves to nothing. Ports fan out 1:N from the connecting side.
 *
 * Pure: the host registers endpoints as they say hello, feeds the page → host messages in and
 * sends whatever the router hands to `outbox` to the named endpoint.
 */
export interface Endpoint {
  id: string
  extensionId: string
  context: EngineContextKind
  /** Core tab id when the endpoint is a content script frame. */
  tabId: string | null
  frameId: number
  url: string
}

export interface RouterOutbox {
  send(endpointId: string, message: Record<string, unknown>): void
  /** The `tabs.Tab` object a content-script sender is attributed to. */
  tabFor(tabId: string): Record<string, unknown> | null
  /** Numeric `tabs.Tab.id` → core tab id. */
  tabIdFromChrome(chromeTabId: number): string | null
}

export const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
export const PORT_CLOSED = 'The message port closed before a response was received.'

interface PendingMessage {
  sender: string
  senderMessageId: number
  outstanding: Set<string>
  sawListeners: boolean
  awaitingAsync: Set<string>
  done: boolean
}

interface PortState {
  initiator: string
  /** Endpoints that were offered the connection and have not answered yet. */
  offered: Set<string>
  accepted: Set<string>
  extensionId: string
  /** Messages the initiator posted before every offered endpoint answered (Chrome queues them too). */
  queue: unknown[]
}

type MessageTarget = {
  extensionId?: string | null
  tabId?: unknown
  options?: { frameId?: unknown } | null
}

export class MessageRouter {
  private readonly endpoints = new Map<string, Endpoint>()
  private readonly pending = new Map<number, PendingMessage>()
  private readonly ports = new Map<string, PortState>()
  private seq = 0

  constructor(private readonly outbox: RouterOutbox) {}

  register(endpoint: Endpoint): void {
    this.endpoints.set(endpoint.id, endpoint)
  }

  endpoint(id: string): Endpoint | undefined {
    return this.endpoints.get(id)
  }

  all(): Endpoint[] {
    return [...this.endpoints.values()]
  }

  /** Endpoints of an extension, optionally limited to one context kind. */
  of(extensionId: string, context?: EngineContextKind): Endpoint[] {
    return this.all().filter(
      (e) => e.extensionId === extensionId && (context === undefined || e.context === context)
    )
  }

  unregister(id: string): void {
    if (!this.endpoints.delete(id)) return
    for (const [rid, message] of [...this.pending]) {
      if (message.sender === id) {
        this.pending.delete(rid)
        continue
      }
      if (message.outstanding.has(id) || message.awaitingAsync.has(id)) {
        message.outstanding.delete(id)
        message.awaitingAsync.delete(id)
        this.settle(rid, message)
      }
    }
    for (const [portId, port] of [...this.ports]) {
      if (port.initiator === id) {
        for (const remote of port.accepted)
          this.outbox.send(remote, { t: 'portDisconnect', portId })
        this.ports.delete(portId)
        continue
      }
      if (port.offered.delete(id) || port.accepted.delete(id)) this.checkPort(portId, port)
    }
  }

  /** Drop every endpoint of a tab (the tab navigated or closed). */
  unregisterTab(tabId: string): void {
    for (const endpoint of this.all()) if (endpoint.tabId === tabId) this.unregister(endpoint.id)
  }

  /** A page → host message the router owns; returns false for messages it does not handle. */
  handle(from: string, message: Record<string, unknown>): boolean {
    const sender = this.endpoints.get(from)
    if (!sender) return false
    switch (message.t) {
      case 'msg':
        this.sendMessage(
          sender,
          Number(message.id),
          (message.target ?? {}) as MessageTarget,
          message.data
        )
        return true
      case 'msgReply':
        this.onMessageReply(from, message)
        return true
      case 'connect':
        this.connect(
          sender,
          String(message.portId),
          String(message.name ?? ''),
          (message.target ?? {}) as MessageTarget
        )
        return true
      case 'portAccept': {
        const portId = String(message.portId)
        const port = this.ports.get(portId)
        if (!port || !port.offered.delete(from)) return true
        if (message.accept) port.accepted.add(from)
        this.checkPort(portId, port)
        return true
      }
      case 'portMsg': {
        const portId = String(message.portId)
        const port = this.ports.get(portId)
        if (!port) return true
        if (from === port.initiator) {
          if (port.offered.size > 0) port.queue.push(message.data)
          else
            for (const remote of port.accepted)
              this.outbox.send(remote, { t: 'portMsg', portId, data: message.data })
        } else if (port.accepted.has(from)) {
          this.outbox.send(port.initiator, { t: 'portMsg', portId, data: message.data })
        }
        return true
      }
      case 'portDisconnect': {
        const portId = String(message.portId)
        const port = this.ports.get(portId)
        if (!port) return true
        if (from === port.initiator) {
          for (const remote of port.accepted)
            this.outbox.send(remote, { t: 'portDisconnect', portId })
          this.ports.delete(portId)
        } else if (port.accepted.delete(from) || port.offered.delete(from)) {
          this.checkPort(portId, port, true)
        }
        return true
      }
      default:
        return false
    }
  }

  // --- messages ------------------------------------------------------------------------------

  private targetsFor(sender: Endpoint, target: MessageTarget): Endpoint[] | string {
    if (target.tabId !== undefined && target.tabId !== null) {
      const chromeTabId = Number(target.tabId)
      const tabId = this.outbox.tabIdFromChrome(chromeTabId)
      if (tabId === null) return `No tab with id: ${chromeTabId}.`
      const frameId = target.options?.frameId
      // Every document of the extension hosted in the tab: its content scripts, its user-script
      // worlds and an extension page of its own open as the tab (their `runtime.onMessage` /
      // `onConnect` hear `tabs.sendMessage` / `tabs.connect`, as Chrome's do); popups and the
      // background are hosted in no tab.
      return this.all().filter(
        (e) =>
          e.extensionId === sender.extensionId &&
          e.tabId === tabId &&
          (frameId === undefined || frameId === null || e.frameId === Number(frameId))
      )
    }
    if (target.extensionId && target.extensionId !== sender.extensionId) return NO_RECEIVER
    // Extension pages only: content scripts and user scripts never receive runtime.sendMessage.
    return this.all().filter(
      (e) =>
        e.extensionId === sender.extensionId &&
        e.context !== 'content' &&
        e.context !== 'userScript' &&
        e.id !== sender.id
    )
  }

  senderInfo(endpoint: Endpoint): MessageSender {
    const inFrame = endpoint.context === 'content' || endpoint.context === 'userScript'
    // An extension page names itself as Chrome spells it, `chrome-extension://<id>/popup.html`,
    // whatever origin the WebView loaded it from: Tampermonkey's background admits its own
    // pages by that prefix (`INTERNAL_PAGE_PROTOCOLS`) and reads the page's name out of it.
    // `origin` stays the served one, the `location.origin` the page itself sees – which is what
    // a background compares it with.
    const info: MessageSender = {
      id: endpoint.extensionId,
      url: inFrame ? endpoint.url : presentExtensionUrl(endpoint.url)
    }
    // Chrome attributes a sender to the tab it is hosted in, an extension page open as a tab as
    // much as a content script (`sender.tab`, `frameId`; Vimium's background answers nothing to
    // a sender without a tab, and its own options page asks it `initializeFrame` from the tab
    // it is open in). Popups, the background and offscreen documents have none.
    const tab = endpoint.tabId ? this.outbox.tabFor(endpoint.tabId) : null
    if (tab) info.tab = tab
    if (inFrame || tab) {
      info.frameId = endpoint.frameId
      // Chrome 106+ identifies the sending document (extensions key per-document state on it:
      // Dark Reader's dark-theme detection, for one); the endpoint id is per document here, as
      // in `runtime.getContexts`.
      info.documentId = endpoint.id
      info.documentLifecycle = 'active'
    }
    if (inFrame) {
      try {
        info.origin = new URL(endpoint.url).origin
      } catch {
        info.origin = 'null'
      }
    } else {
      info.origin = extensionOrigin(endpoint.extensionId)
    }
    return info
  }

  private sendMessage(
    sender: Endpoint,
    senderMessageId: number,
    target: MessageTarget,
    data: unknown
  ): void {
    const targets = this.targetsFor(sender, target)
    if (typeof targets === 'string' || targets.length === 0) {
      this.outbox.send(sender.id, {
        t: 'reply',
        id: senderMessageId,
        ok: false,
        error: typeof targets === 'string' ? targets : NO_RECEIVER
      })
      return
    }
    const rid = ++this.seq
    const pending: PendingMessage = {
      sender: sender.id,
      senderMessageId,
      outstanding: new Set(targets.map((t) => t.id)),
      sawListeners: false,
      awaitingAsync: new Set(),
      done: false
    }
    this.pending.set(rid, pending)
    const info = this.senderInfo(sender)
    // A user script's message lands on runtime.onUserScriptMessage, never on onMessage.
    const flag = sender.context === 'userScript' ? { userScript: true } : {}
    for (const endpoint of targets)
      this.outbox.send(endpoint.id, { t: 'deliver', id: rid, data, sender: info, ...flag })
  }

  private onMessageReply(from: string, message: Record<string, unknown>): void {
    const rid = Number(message.id)
    const pending = this.pending.get(rid)
    if (!pending || pending.done) return
    if (!pending.outstanding.delete(from) && !pending.awaitingAsync.delete(from)) return
    if (message.listeners !== false) pending.sawListeners = true
    if (message.handled && message.willRespond) {
      pending.awaitingAsync.add(from)
      pending.sawListeners = true
      return
    }
    if (message.handled) {
      pending.done = true
      this.pending.delete(rid)
      this.outbox.send(pending.sender, {
        t: 'reply',
        id: pending.senderMessageId,
        ok: true,
        result: message.response ?? null
      })
      return
    }
    this.settle(rid, pending)
  }

  /** Everyone answered without a response: "no listener anywhere" is an error, otherwise undefined. */
  private settle(rid: number, pending: PendingMessage): void {
    if (pending.done || pending.outstanding.size > 0 || pending.awaitingAsync.size > 0) return
    pending.done = true
    this.pending.delete(rid)
    if (pending.sawListeners)
      this.outbox.send(pending.sender, {
        t: 'reply',
        id: pending.senderMessageId,
        ok: true,
        result: null
      })
    else
      this.outbox.send(pending.sender, {
        t: 'reply',
        id: pending.senderMessageId,
        ok: false,
        error: NO_RECEIVER
      })
  }

  // --- ports -----------------------------------------------------------------------------------

  private connect(sender: Endpoint, portId: string, name: string, target: MessageTarget): void {
    const targets = this.targetsFor(sender, target)
    if (typeof targets === 'string' || targets.length === 0) {
      this.outbox.send(sender.id, {
        t: 'portAccept',
        portId,
        accept: false,
        error: typeof targets === 'string' ? targets : NO_RECEIVER
      })
      return
    }
    const port: PortState = {
      initiator: sender.id,
      offered: new Set(targets.map((t) => t.id)),
      accepted: new Set(),
      extensionId: sender.extensionId,
      queue: []
    }
    this.ports.set(portId, port)
    const info = this.senderInfo(sender)
    const flag = sender.context === 'userScript' ? { userScript: true } : {}
    for (const endpoint of targets)
      this.outbox.send(endpoint.id, { t: 'portConnect', portId, name, sender: info, ...flag })
  }

  /** Once every offered endpoint answered: accept for the initiator, or refuse when nobody took it. */
  private checkPort(portId: string, port: PortState, remoteLeft = false): void {
    if (port.offered.size > 0) return
    if (port.accepted.size === 0) {
      this.ports.delete(portId)
      if (remoteLeft) this.outbox.send(port.initiator, { t: 'portDisconnect', portId })
      else
        this.outbox.send(port.initiator, {
          t: 'portAccept',
          portId,
          accept: false,
          error: NO_RECEIVER
        })
      return
    }
    if (!remoteLeft) this.outbox.send(port.initiator, { t: 'portAccept', portId, accept: true })
    const queued = port.queue.splice(0)
    for (const data of queued)
      for (const remote of port.accepted) this.outbox.send(remote, { t: 'portMsg', portId, data })
  }

  /** Open ports whose initiator or acceptor is `endpointId` (for tests and diagnostics). */
  portsOf(endpointId: string): string[] {
    return [...this.ports]
      .filter(([, p]) => p.initiator === endpointId || p.accepted.has(endpointId))
      .map(([id]) => id)
  }
}
