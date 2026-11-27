// Minimal CDP and WebDriver BiDi clients over Node's built-in WebSocket. The harness talks to
// every browser through these instead of Puppeteer/Playwright so that no automation layer
// attaches to every tab (an attached client can keep a tab from being discarded or frozen and
// enables per-page agents that cost memory). Pages are attached only for the moment a step
// needs them and detached again.

export class CdpClient {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const l of this.listeners) l(msg)
      }
    })
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('connection closed'))
      this.pending.clear()
      this.closed = true
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), {
        once: true
      })
    })
    return new CdpClient(ws)
  }

  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('connection closed'))
    const id = this.nextId++
    const msg = { id, method, params }
    if (sessionId) msg.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      })
      this.ws.send(JSON.stringify(msg))
    })
  }

  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Attach to a target for the length of `fn` only. */
  async withSession(targetId, fn) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    try {
      return await fn(sessionId)
    } finally {
      await this.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
  }

  async evaluate(sessionId, expression, timeoutMs = 15_000) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
      timeoutMs
    )
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* already gone */
    }
  }
}

export class BidiClient {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.type === 'error') reject(new Error(`${msg.error}: ${msg.message}`))
        else resolve(msg.result)
      }
    })
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('connection closed'))
      this.pending.clear()
      this.closed = true
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), {
        once: true
      })
    })
    const c = new BidiClient(ws)
    await c.send('session.new', { capabilities: {} })
    return c
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('connection closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(context, expression, timeoutMs = 15_000) {
    const r = await this.send(
      'script.evaluate',
      { expression, target: { context }, awaitPromise: true, resultOwnership: 'none' },
      timeoutMs
    )
    if (r.type === 'exception') throw new Error(r.exceptionDetails?.text ?? 'exception')
    return deserialize(r.result)
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* already gone */
    }
  }
}

function deserialize(v) {
  if (!v) return undefined
  switch (v.type) {
    case 'object':
      return Object.fromEntries((v.value ?? []).map(([k, val]) => [k, deserialize(val)]))
    case 'array':
      return (v.value ?? []).map(deserialize)
    case 'undefined':
    case 'null':
      return null
    default:
      return v.value
  }
}

/**
 * Firefox's Marionette protocol (length-prefixed JSON over TCP). Used instead of WebDriver BiDi
 * because it can run script in the browser's own UI ("chrome" context): an unloaded Firefox tab
 * has no browsing context for BiDi to address, but its <tab> element is still there.
 */
export class MarionetteClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    this.greeting = null
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      for (;;) {
        const colon = this.buffer.indexOf(':')
        if (colon < 0) return
        const len = Number(this.buffer.subarray(0, colon).toString())
        if (this.buffer.length < colon + 1 + len) return
        const msg = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + len).toString())
        this.buffer = this.buffer.subarray(colon + 1 + len)
        if (!Array.isArray(msg)) {
          this.greeting = msg
          continue
        }
        const [, id, error, result] = msg
        const p = this.pending.get(id)
        if (!p) continue
        this.pending.delete(id)
        if (error) p.reject(new Error(`${error.error}: ${error.message}`))
        else p.resolve(result)
      }
    })
    socket.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('connection closed'))
      this.pending.clear()
      this.closed = true
    })
  }

  static async connect(port) {
    const { createConnection } = await import('node:net')
    const socket = createConnection({ host: '127.0.0.1', port })
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const c = new MarionetteClient(socket)
    await c.send('WebDriver:NewSession', { capabilities: {} })
    return c
  }

  send(name, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('connection closed'))
    const id = this.nextId++
    const body = JSON.stringify([0, id, name, params])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${name} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      })
      this.socket.write(`${Buffer.byteLength(body)}:${body}`)
    })
  }

  async context(value) {
    if (this.current === value) return
    await this.send('Marionette:SetContext', { value })
    this.current = value
  }

  /** Run `script` (a function body; `arguments` holds `args`) and return its (awaited) value. */
  async run(context, script, args = [], timeoutMs = 15_000) {
    await this.context(context)
    const r = await this.send(
      'WebDriver:ExecuteScript',
      { script, args, scriptTimeout: timeoutMs },
      timeoutMs + 2_000
    )
    return r?.value
  }

  close() {
    this.socket.destroy()
  }
}
