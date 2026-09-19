// The chrome-side half of BootHandoffProbe.kt: replays, inside the booted chrome, each transport a
// boot document or a fetched body can take between the Kotlin host and the chrome, and times it.
//
//   callSync(method)   the synchronous bridge (`__zenNative.callSync`), a JSON-quoted string
//                      returned through JNI and parsed here: the pre-handoff path of the boot
//                      payload and of `storage.read`. Its wall time is main-thread time.
//   call(method)       the asynchronous bridge: the reply comes back JSON-quoted inside an
//                      `evaluateJavascript` script (`ChromeWebView.resolve`), parsed here.
//   fetchText(url)     a fetch on the app origin, answered by the document / spill handlers of
//                      the handoff branch (404 or a failed fetch on a host without them).
//
// Main-thread stalls are read from the Long Tasks API (tasks over 50 ms overlapping the
// measurement). Results land in `window.__probeResult` as JSON; `window.__probeArgs` names the
// hosts list the loopback server serves. Nothing here touches the core: transport only.
;(() => {
  const args = window.__probeArgs || {}
  const origin = 'https://appassets.androidplatform.net'
  const native = window.__zenNative
  const host = window.__zenHost
  const now = () => performance.now()
  const round = (x) => Math.round(x * 10) / 10
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const tasks = []
  let longTasks = false
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push([entry.startTime, entry.duration])
    })
    observer.observe({ type: 'longtask', buffered: true })
    longTasks = true
  } catch {
    // No Long Tasks API: stalls are reported as null.
  }
  const stalled = (t0, t1) =>
    longTasks
      ? round(
          tasks.reduce(
            (sum, [start, duration]) =>
              sum + Math.max(0, Math.min(start + duration, t1) - Math.max(start, t0)),
            0
          )
        )
      : null
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const summarize = (samples) => {
    const out = {}
    for (const key of Object.keys(samples[0])) {
      const values = samples.map((s) => s[key])
      if (values.every((v) => typeof v === 'number')) out[key] = round(median(values))
      else out[key] = values[values.length - 1]
    }
    out.samples = samples.length
    return out
  }

  function callSync(method, callArgs) {
    const t0 = now()
    const raw = native.callSync(JSON.stringify({ id: 0, method, args: callArgs }))
    const value = raw === '' ? undefined : JSON.parse(raw)
    const t1 = now()
    return { bytes: raw.length, ms: round(t1 - t0), value }
  }

  let nextId = 1_000_000_000
  function call(method, callArgs) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      const resolveBefore = host.resolve
      const rejectBefore = host.reject
      const restore = () => {
        host.resolve = resolveBefore
        host.reject = rejectBefore
      }
      const t0 = now()
      host.resolve = (rid, json) => {
        if (rid !== id) return resolveBefore.call(host, rid, json)
        restore()
        const tParse = now()
        const value = json ? JSON.parse(json) : undefined
        const t1 = now()
        resolve({ bytes: json ? json.length : 0, wallMs: t1 - t0, parseMs: t1 - tParse, t0, t1, value })
      }
      host.reject = (rid, message) => {
        if (rid !== id) return rejectBefore.call(host, rid, message)
        restore()
        reject(new Error(message))
      }
      native.call(JSON.stringify({ id, method, args: callArgs }))
    })
  }

  async function fetchText(url) {
    const t0 = now()
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) return { ok: false, status: response.status }
    const text = await response.text()
    const t1 = now()
    return {
      ok: true,
      status: response.status,
      bytes: text.length,
      wallMs: t1 - t0,
      t0,
      t1,
      etag: response.headers.get('ETag')
    }
  }

  /** `fn` three times over; the medians, with the stall of each sample measured after a pause. */
  async function repeat(fn) {
    const samples = []
    for (let i = 0; i < 3; i++) {
      const sample = await fn()
      if (sample === null) return null
      // Long tasks are reported once the task is over: give the observer a moment.
      await sleep(250)
      if (sample.t0 !== undefined) {
        sample.stallMs = stalled(sample.t0, sample.t1)
        delete sample.t0
        delete sample.t1
      }
      samples.push(sample)
      await sleep(250)
    }
    return summarize(samples)
  }

  const FEED_DOC = 'safebrowsing/phishing-database.json'
  const INDEX = 'blocking/index.json'

  async function run() {
    const result = { longTasks }

    // 1. The boot payload, as `bootAndroid` calls it (`Host.dispatchSync("boot")`).
    const bootSamples = await repeat(async () => {
      const { bytes, ms, value } = callSync('boot', {})
      return { bytes, ms, t0: now() - ms, t1: now(), value }
    })
    const boot = bootSamples.value
    delete bootSamples.value
    result.bootPayload = bootSamples
    result.bootFiles = Object.fromEntries(
      Object.entries(boot.files || {}).map(([name, text]) => [name, text.length])
    )
    result.bootDeferred = boot.deferred || null

    // 2. The feed document as the core read it before the handoff (`storage.read` through
    //    `AndroidStoreIO.readSync`), and as the handoff fetches it (`/zen-docs/<name>`).
    result.feedDocSync = await repeat(async () => {
      const { bytes, ms } = callSync('storage.read', { name: FEED_DOC })
      return { bytes, ms, t0: now() - ms, t1: now() }
    })
    result.feedDocFetch = await repeat(async () => {
      try {
        const sample = await fetchText(`${origin}/zen-docs/${FEED_DOC}`)
        return sample.ok ? sample : null
      } catch {
        return null
      }
    })

    // 3. The rule index by itself (`storage.read`), for its size and cost.
    result.indexSync = await repeat(async () => {
      const { bytes, ms } = callSync('storage.read', { name: INDEX })
      return { bytes, ms, t0: now() - ms, t1: now() }
    })

    // 4. A fetched body the size of the phishing-domains list (`net.fetch`): inline in the
    //    reply before the handoff; spilled to a file and fetched by token with it.
    if (args.hostsUrl) {
      let spilled = null
      result.netFetch = await repeat(async () => {
        const reply = await call('net.fetch', { url: args.hostsUrl, headers: {}, timeoutMs: 60_000 })
        const body = reply.value && reply.value.body
        const sample = {
          bytes: reply.bytes,
          textBytes: reply.value && typeof reply.value.text === 'string' ? reply.value.text.length : 0,
          wallMs: reply.wallMs,
          parseMs: reply.parseMs,
          t0: reply.t0,
          t1: reply.t1
        }
        if (body && body.token) {
          const fetched = await fetchText(`${origin}/zen-net/${body.token}`)
          await call('net.release', { token: body.token })
          spilled = spilled || []
          spilled.push({ ...fetched, spilledBytes: body.bytes })
        }
        return sample
      })
      if (spilled) {
        result.netFetchSpilled = await repeat(async () => {
          const sample = spilled.shift()
          return sample && sample.ok ? sample : null
        })
      } else {
        result.netFetchSpilled = null
      }
    }

    return result
  }

  window.__probeResult = undefined
  run().then(
    (result) => {
      window.__probeResult = JSON.stringify(result)
    },
    (error) => {
      window.__probeResult = JSON.stringify({ error: String((error && error.stack) || error) })
    }
  )
})()
