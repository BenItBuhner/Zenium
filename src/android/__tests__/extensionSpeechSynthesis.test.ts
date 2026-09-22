import { describe, expect, it } from 'vitest'
import { createScopeProxy } from '../extensionIsolation'
import { installSpeechSynthesis, type SpeechLink } from '../extensionSpeechSynthesis'

interface FakeLink extends SpeechLink {
  calls: Array<{ method: string; args: unknown[] }>
  listens: string[]
  fire: (name: string, args: unknown[]) => void
  voices: Array<{ voiceName: string; lang: string; remote?: boolean }>
  failSpeak: string | null
}

function link(): FakeLink {
  const listeners: Array<(name: string, args: unknown[]) => void> = []
  const fake: FakeLink = {
    calls: [],
    listens: [],
    voices: [{ voiceName: 'en-us-x-sfg', lang: 'en-US' }],
    failSpeak: null,
    fire: (name, args) => {
      for (const listener of listeners) listener(name, args)
    },
    call: (method, args) => {
      fake.calls.push({ method, args })
      if (method === 'getVoices') return Promise.resolve(fake.voices)
      if (method === 'speak' && fake.failSpeak) return Promise.reject(new Error(fake.failSpeak))
      return Promise.resolve(undefined)
    },
    onEvent: (listener) => {
      listeners.push(listener)
    },
    listen: (event) => {
      fake.listens.push(event)
    }
  }
  return fake
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type Win = Record<string, unknown> & {
  speechSynthesis?: ReturnType<typeof installSpeechSynthesis>
  SpeechSynthesisUtterance?: new (text?: string) => EventTarget & Record<string, unknown>
}

describe('extension pages: window.speechSynthesis over the host engine', () => {
  it('installs the API on a window without one and lists the host\u2019s voices synchronously once they arrive', async () => {
    const win: Win = {}
    const l = link()
    const synthesis = installSpeechSynthesis(win, l)
    expect(synthesis).not.toBeNull()
    expect(win.speechSynthesis).toBe(synthesis)
    expect(typeof win.SpeechSynthesisUtterance).toBe('function')
    // Not asked for at boot: a background page's `listen` would wake a stopped worker.
    expect(l.listens).toEqual(['onVoicesChanged'])
    let changes = 0
    synthesis!.addEventListener('voiceschanged', () => changes++)
    await tick()
    const voices = synthesis!.getVoices() as Array<Record<string, unknown>>
    expect(voices).toHaveLength(1)
    expect(voices[0]).toMatchObject({
      name: 'en-us-x-sfg',
      voiceURI: 'en-us-x-sfg',
      lang: 'en-US',
      localService: true,
      default: true
    })
    expect(changes).toBe(1)
    l.voices = [...l.voices, { voiceName: 'fr-fr-x-vlf', lang: 'fr-FR', remote: true }]
    l.fire('onVoicesChanged', [])
    await tick()
    expect(synthesis!.getVoices()).toHaveLength(2)
    expect(changes).toBe(2)
  })

  it('leaves a window that has the platform\u2019s own alone', () => {
    const own = {}
    const win: Win = { speechSynthesis: own as never }
    expect(installSpeechSynthesis(win, link())).toBeNull()
    expect(win.speechSynthesis).toBe(own)
  })

  it('installed on a content scope (the `with` proxy over a page window without the API) answers the scripts there and leaves the page\u2019s window without it', async () => {
    const page: Win = { document: {}, location: {} }
    const scope = createScopeProxy(page, new Set(['document', 'location', 'speechSynthesis']))
    const l = link()
    const synthesis = installSpeechSynthesis(scope, l)
    expect(synthesis).not.toBeNull()
    expect(scope.speechSynthesis).toBe(synthesis)
    expect(typeof scope.SpeechSynthesisUtterance).toBe('function')
    expect('speechSynthesis' in page).toBe(false)
    expect(page.SpeechSynthesisUtterance).toBeUndefined()
    await tick()
    expect((synthesis!.getVoices() as unknown[]).length).toBe(1)
    expect(l.calls.map((c) => c.method)).toEqual(['getVoices'])
  })

  it('speaks through the host with the utterance\u2019s voice, rate, pitch and volume, and maps the engine\u2019s events to the spec\u2019s', async () => {
    const win: Win = {}
    const l = link()
    const synthesis = installSpeechSynthesis(win, l)!
    await tick()
    const Utterance = win.SpeechSynthesisUtterance!
    const utterance = new Utterance('Hello there, phone.')
    utterance.rate = 1.5
    utterance.pitch = 0.8
    utterance.volume = 0.5
    utterance.lang = 'en-US'
    utterance.voice = synthesis.getVoices()[0]
    const seen: string[] = []
    for (const type of ['start', 'boundary', 'pause', 'resume', 'end', 'error'])
      utterance.addEventListener(type, (event) => {
        const e = event as Event & { charIndex: number; name: string; error?: string }
        seen.push(
          `${type}@${e.charIndex}${e.name ? `:${e.name}` : ''}${e.error ? `!${e.error}` : ''}`
        )
      })
    synthesis.speak(utterance)
    expect(l.listens).toEqual(['onVoicesChanged', 'onEvent'])
    expect(synthesis.pending).toBe(true)
    expect(synthesis.speaking).toBe(false)
    const speak = l.calls.find((c) => c.method === 'speak')!
    expect(speak.args[0]).toBe('Hello there, phone.')
    expect(speak.args[1]).toMatchObject({
      enqueue: true,
      rate: 1.5,
      pitch: 0.8,
      volume: 0.5,
      lang: 'en-US',
      voiceName: 'en-us-x-sfg'
    })
    const token = speak.args[2]
    l.fire('onEvent', [token, { type: 'start', charIndex: 0 }])
    expect(synthesis.speaking).toBe(true)
    expect(synthesis.pending).toBe(false)
    l.fire('onEvent', [token, { type: 'word', charIndex: 6, length: 5 }])
    synthesis.pause()
    expect(synthesis.paused).toBe(true)
    l.fire('onEvent', [token, { type: 'pause', charIndex: 6 }])
    synthesis.resume()
    l.fire('onEvent', [token, { type: 'resume', charIndex: 6 }])
    l.fire('onEvent', [token, { type: 'end', charIndex: 19, isFinalEvent: true }])
    expect(seen).toEqual(['start@0', 'boundary@6:word', 'pause@6', 'resume@6', 'end@19'])
    expect(synthesis.speaking).toBe(false)
    expect(synthesis.paused).toBe(false)
    expect(l.calls.map((c) => c.method)).toEqual(['getVoices', 'speak', 'pause', 'resume'])
  })

  it('reports what the engine dropped as an error event (interrupted, canceled) and a refused speak as synthesis-failed', async () => {
    const win: Win = {}
    const l = link()
    const synthesis = installSpeechSynthesis(win, l)!
    await tick()
    const Utterance = win.SpeechSynthesisUtterance!
    const first = new Utterance('one')
    const second = new Utterance('two')
    const errors: string[] = []
    first.addEventListener('error', (e) =>
      errors.push(`first:${(e as Event & { error: string }).error}`)
    )
    second.addEventListener('error', (e) =>
      errors.push(`second:${(e as Event & { error: string }).error}`)
    )
    synthesis.speak(first)
    synthesis.speak(second)
    const tokens = l.calls.filter((c) => c.method === 'speak').map((c) => c.args[2])
    l.fire('onEvent', [tokens[0], { type: 'start' }])
    synthesis.cancel()
    expect(l.calls.at(-1)?.method).toBe('stop')
    l.fire('onEvent', [tokens[0], { type: 'interrupted', charIndex: 1 }])
    l.fire('onEvent', [tokens[1], { type: 'cancelled', charIndex: 0 }])
    expect(errors).toEqual(['first:interrupted', 'second:canceled'])
    expect(synthesis.speaking).toBe(false)
    expect(synthesis.pending).toBe(false)

    l.failSpeak = 'the device has no speech engine'
    const third = new Utterance('three')
    third.addEventListener('error', (e) =>
      errors.push(`third:${(e as Event & { error: string }).error}`)
    )
    synthesis.speak(third)
    await tick()
    expect(errors.at(-1)).toBe('third:synthesis-unavailable')
    expect(synthesis.pending).toBe(false)
  })

  it('refuses to speak anything but an utterance, as Chrome does', () => {
    const win: Win = {}
    const synthesis = installSpeechSynthesis(win, link())!
    expect(() => synthesis.speak('text')).toThrow(TypeError)
  })
})
