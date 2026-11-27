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
