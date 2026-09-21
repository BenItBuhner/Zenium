/**
 * The Web Speech API's synthesis half (`window.speechSynthesis`, `SpeechSynthesisUtterance`,
 * `SpeechSynthesisVoice`, `SpeechSynthesisEvent`, `SpeechSynthesisErrorEvent`) for an
 * extension's pages on the phone. Chrome has it in every document, backed by the platform's
 * speech engine; the Android System WebView has none of it, and an extension page that speaks
 * through it dies at `window.speechSynthesis.getVoices()` (Read&Write's speech feature frame in
 * its offscreen document: the `initialized` message the offscreen document waits for was never
 * posted, so the worker's answer to the toolbar never came).
 *
 * Installed on an extension's documents (popups, options and other pages, the offscreen
 * document, an MV2 background page), not on the MV3 worker page: a service worker's global has
 * no Web Speech API in Chrome either.
 *
 * The page half here talks to the host's `speechSynthesis` namespace (extensionTts.ts: the
 * same queue and engine as `chrome.tts` and read aloud, no permission, as the web platform
 * needs none): `speak` enqueues, `cancel` stops the queue, `pause` / `resume` as `chrome.tts`
 * has them, `getVoices` is synchronous over a list the host sent and fires `voiceschanged`
 * when it arrives or changes. Events come back per utterance and map to the spec's: `start`,
 * `boundary` (name `word`), `end`, `pause`, `resume`, and `error` with `interrupted` /
 * `canceled` / `synthesis-failed`.
 */

type Any = Record<string, unknown>

/** What the shim needs of the page's engine: host calls, the host's events, and the `listen` handshake. */
export interface SpeechLink {
  call(method: string, args: unknown[]): Promise<unknown>
  /** `speechSynthesis.onEvent(token, event)` and `speechSynthesis.onVoicesChanged()` from the host. */
  onEvent(listener: (name: string, args: unknown[]) => void): void
  /** Tell the host this page wants `speechSynthesis.<event>`. */
  listen(event: string): void
}

interface HostVoice {
  voiceName: string
  lang: string
  remote?: boolean
}

interface HostEvent {
  type: string
  charIndex?: number
  length?: number
  errorMessage?: string
  isFinalEvent?: boolean
}

export const SPEECH_SYNTHESIS_GLOBALS = [
  'speechSynthesis',
  'SpeechSynthesis',
  'SpeechSynthesisUtterance',
  'SpeechSynthesisVoice',
  'SpeechSynthesisEvent',
  'SpeechSynthesisErrorEvent'
] as const

const UTTERANCE_EVENTS = ['start', 'end', 'error', 'pause', 'resume', 'mark', 'boundary'] as const

/** An `on<event>` IDL attribute pair: the handler is also a listener, set or replaced in one place. */
function defineHandler(prototype: object, type: string): void {
  const handlers = new WeakMap<EventTarget, EventListener | null>()
  Object.defineProperty(prototype, `on${type}`, {
    configurable: true,
    enumerable: true,
    get(this: EventTarget) {
      return handlers.get(this) ?? null
    },
    set(this: EventTarget, value: unknown) {
      const previous = handlers.get(this)
      if (previous) this.removeEventListener(type, previous)
      const next = typeof value === 'function' ? (value as EventListener) : null
      handlers.set(this, next)
      if (next) this.addEventListener(type, next)
    }
  })
}

/**
 * Install the API on `target` (an extension page's window). Returns the `speechSynthesis`
 * object. Nothing is installed when the platform already has one.
 */
export function installSpeechSynthesis(target: Any, link: SpeechLink): SpeechSynthesisLike | null {
  if (typeof target.speechSynthesis === 'object' && target.speechSynthesis !== null) return null

  class SpeechSynthesisVoice {
    readonly voiceURI: string
    readonly name: string
    readonly lang: string
    readonly localService: boolean
    readonly default: boolean
    constructor(voice: HostVoice, isDefault: boolean) {
      this.voiceURI = voice.voiceName
      this.name = voice.voiceName
      this.lang = voice.lang
      this.localService = voice.remote !== true
      this.default = isDefault
      Object.freeze(this)
    }
  }

  class SpeechSynthesisUtterance extends EventTarget {
    text: string
    lang = ''
    voice: SpeechSynthesisVoice | null = null
    volume = 1
    rate = 1
    pitch = 1
    constructor(text?: unknown) {
      super()
      this.text = text === undefined || text === null ? '' : String(text)
    }
  }
  for (const type of UTTERANCE_EVENTS) defineHandler(SpeechSynthesisUtterance.prototype, type)

  class SpeechSynthesisEvent extends Event {
    readonly utterance: SpeechSynthesisUtterance
    readonly charIndex: number
    readonly charLength: number
    readonly elapsedTime: number
    readonly name: string
    constructor(type: string, init: Any = {}) {
      super(type, init)
      const utterance = init.utterance
      if (!(utterance instanceof SpeechSynthesisUtterance))
        throw new TypeError(
          "Failed to construct 'SpeechSynthesisEvent': required member utterance is undefined."
        )
      this.utterance = utterance
      this.charIndex = Number(init.charIndex ?? 0)
      this.charLength = Number(init.charLength ?? 0)
      this.elapsedTime = Number(init.elapsedTime ?? 0)
      this.name = String(init.name ?? '')
    }
  }

  class SpeechSynthesisErrorEvent extends SpeechSynthesisEvent {
    readonly error: string
    constructor(type: string, init: Any = {}) {
      super(type, init)
      this.error = String(init.error ?? 'synthesis-failed')
    }
  }

  interface Queued {
    token: string
    utterance: SpeechSynthesisUtterance
    started: number | null
    done: boolean
  }

  const queue: Queued[] = []
  let voices: SpeechSynthesisVoice[] = []
  let paused = false
  let seq = 0
  let listeningForEvents = false
  const now = (): number =>
    typeof performance === 'object' && performance ? performance.now() : Date.now()

  const fire = (entry: Queued, type: string, init: Any): void => {
    const event =
      type === 'error'
        ? new SpeechSynthesisErrorEvent(type, { ...init, utterance: entry.utterance })
        : new SpeechSynthesisEvent(type, { ...init, utterance: entry.utterance })
    entry.utterance.dispatchEvent(event)
  }
  const elapsed = (entry: Queued): number => (entry.started === null ? 0 : now() - entry.started)
  const finish = (entry: Queued): void => {
    entry.done = true
    const index = queue.indexOf(entry)
    if (index !== -1) queue.splice(index, 1)
    if (queue.length === 0) paused = false
  }

  const onHostEvent = (token: unknown, raw: unknown): void => {
    const entry = queue.find((q) => q.token === token)
    if (!entry || typeof raw !== 'object' || raw === null) return
    const event = raw as HostEvent
    const charIndex = Number(event.charIndex ?? 0)
    switch (event.type) {
      case 'start':
        entry.started = now()
        fire(entry, 'start', { charIndex: 0 })
        return
      case 'word':
      case 'sentence':
        fire(entry, 'boundary', {
          name: event.type,
          charIndex,
          charLength: Number(event.length ?? 0),
          elapsedTime: elapsed(entry)
        })
        return
      case 'marker':
        fire(entry, 'mark', { charIndex, elapsedTime: elapsed(entry) })
        return
      case 'pause':
        fire(entry, 'pause', { charIndex, elapsedTime: elapsed(entry) })
        return
      case 'resume':
        fire(entry, 'resume', { charIndex, elapsedTime: elapsed(entry) })
        return
      case 'end': {
        const time = elapsed(entry)
        finish(entry)
        fire(entry, 'end', { charIndex: entry.utterance.text.length, elapsedTime: time })
        return
      }
      case 'interrupted':
      case 'cancelled':
      case 'error': {
        const time = elapsed(entry)
        finish(entry)
        fire(entry, 'error', {
          charIndex,
          elapsedTime: time,
          error:
            event.type === 'interrupted'
              ? 'interrupted'
              : event.type === 'cancelled'
                ? 'canceled'
                : 'synthesis-failed'
        })
        return
      }
      default:
        if (event.isFinalEvent) finish(entry)
    }
  }

  class SpeechSynthesis extends EventTarget {
    get pending(): boolean {
      return queue.some((q) => q.started === null)
    }
    get speaking(): boolean {
      return queue.some((q) => q.started !== null && !q.done)
    }
    get paused(): boolean {
      return paused
    }
    getVoices(): SpeechSynthesisVoice[] {
      return voices.slice()
    }
    speak(utterance: unknown): void {
      if (!(utterance instanceof SpeechSynthesisUtterance))
        throw new TypeError(
          "Failed to execute 'speak' on 'SpeechSynthesis': parameter 1 is not of type 'SpeechSynthesisUtterance'."
        )
      const entry: Queued = { token: `ws${++seq}`, utterance, started: null, done: false }
      queue.push(entry)
      if (!listeningForEvents) {
        // Asked for on the first utterance, not at boot: a `listen` from a background page is a
        // listener the host would wake a stopped worker for, and a page that speaks is awake.
        listeningForEvents = true
        link.listen('onEvent')
      }
      const options: Any = {
        enqueue: true,
        rate: utterance.rate,
        pitch: utterance.pitch,
        volume: utterance.volume
      }
      if (utterance.voice) options.voiceName = utterance.voice.name
      if (utterance.lang) options.lang = utterance.lang
      link.call('speak', [utterance.text, options, entry.token]).catch((error: unknown) => {
        if (entry.done) return
        finish(entry)
        fire(entry, 'error', {
          charIndex: 0,
          error: /engine/i.test(String(error)) ? 'synthesis-unavailable' : 'synthesis-failed'
        })
      })
    }
    cancel(): void {
      // The engine reports `cancelled` / `interrupted` for what it drops; the queue empties on those.
      void link.call('stop', []).catch(() => undefined)
    }
    pause(): void {
      if (paused) return
      paused = true
      void link.call('pause', []).catch(() => undefined)
    }
    resume(): void {
      if (!paused) return
      paused = false
      void link.call('resume', []).catch(() => undefined)
    }
  }
  defineHandler(SpeechSynthesis.prototype, 'voiceschanged')

  const synthesis = new SpeechSynthesis()

  const refreshVoices = (): void => {
    link
      .call('getVoices', [])
      .then((list) => {
        const raw = Array.isArray(list) ? (list as HostVoice[]) : []
        const next = raw
          .filter((v) => v && typeof v.voiceName === 'string')
          .map((v, index) => new SpeechSynthesisVoice(v, index === 0))
        const changed =
          next.length !== voices.length ||
          next.some((v, i) => v.name !== voices[i]?.name || v.lang !== voices[i]?.lang)
        voices = next
        if (changed || next.length > 0) synthesis.dispatchEvent(new Event('voiceschanged'))
      })
      .catch(() => undefined)
  }

  link.onEvent((name, args) => {
    if (name === 'onEvent') onHostEvent(args[0], args[1])
    else if (name === 'onVoicesChanged') refreshVoices()
  })
  link.listen('onVoicesChanged')
  refreshVoices()

  const define = (name: string, value: unknown): void => {
    Object.defineProperty(target, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false
    })
  }
  define('SpeechSynthesis', SpeechSynthesis)
  define('SpeechSynthesisUtterance', SpeechSynthesisUtterance)
  define('SpeechSynthesisVoice', SpeechSynthesisVoice)
  define('SpeechSynthesisEvent', SpeechSynthesisEvent)
  define('SpeechSynthesisErrorEvent', SpeechSynthesisErrorEvent)
  // `[Replaceable] readonly attribute SpeechSynthesis speechSynthesis` on Window.
  Object.defineProperty(target, 'speechSynthesis', {
    configurable: true,
    enumerable: true,
    get: () => synthesis,
    set(this: Any, value: unknown) {
      Object.defineProperty(this, 'speechSynthesis', {
        value,
        writable: true,
        configurable: true,
        enumerable: true
      })
    }
  })
  return synthesis
}

/** The `speechSynthesis` object's shape, for the bootstrap and the tests. */
export interface SpeechSynthesisLike extends EventTarget {
  readonly pending: boolean
  readonly speaking: boolean
  readonly paused: boolean
  getVoices(): unknown[]
  speak(utterance: unknown): void
  cancel(): void
  pause(): void
  resume(): void
}
