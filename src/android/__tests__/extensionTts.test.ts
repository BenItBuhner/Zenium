import { describe, expect, it } from 'vitest'
import { ERROR_NO_PERMISSION } from '@core/extensions/api/tts'
import { ANDROID_TTS_EVENT_TYPES, ERROR_NO_ENGINE } from '../extensionTts'
import {
  type Harness,
  ID,
  backgroundUp,
  call,
  events,
  harness,
  hello,
  manifest,
  message,
  record
} from './runtimeHarness'

const TEXT = 'The quick brown fox jumps'

async function withTts(h: Harness, permissions: string[] = ['tts', 'storage']): Promise<void> {
  await h.runtime.attach(record(h, {}, manifest({ permissions, name: 'Reader' })))
  backgroundUp(h, 'bg1', ['tts.onEvent', 'tts.onVoicesChanged'])
}

/** The `options.onEvent` deliveries the endpoint got for the token: `[token, event]` pairs, the events alone. */
function onEvents(h: Harness, ep: string, token: string): Record<string, unknown>[] {
  return events(h, ep, 'tts.onEvent')
    .map((m) => m.args as unknown[])
    .filter((args) => args[0] === token)
    .map((args) => args[1] as Record<string, unknown>)
}

async function speak(
  h: Harness,
  ep: string,
  text: string,
  options: Record<string, unknown> = {},
  token: string | null = 'tok1'
): Promise<Record<string, unknown>> {
  return call(h, ep, 'tts', 'speak', [text, options, token])
}

describe("chrome.tts on the phone: Chrome's queue over the device's speech engine", () => {
  it("getVoices lists the engine's voices in Chrome's shape: the engine's voice name, the tag, remote for a network voice", async () => {
    const h = harness()
    await withTts(h)
    const reply = await call(h, 'bg1', 'tts', 'getVoices', [])
    expect(reply.ok).toBe(true)
    expect(reply.result).toEqual([
      {
        voiceName: 'en-us-x-tpf-local',
        lang: 'en-US',
        remote: false,
        eventTypes: [...ANDROID_TTS_EVENT_TYPES]
      },
      {
        voiceName: 'de-de-x-nfh-network',
        lang: 'de-DE',
        remote: true,
        eventTypes: [...ANDROID_TTS_EVENT_TYPES]
      }
    ])
    // The engine's voices changing (a language pack installed) reaches the extension as `tts.onVoicesChanged`.
    h.speech!.voicesChanged()
    expect(events(h, 'bg1', 'tts.onVoicesChanged')).toHaveLength(1)
  })

  it('speak hands the engine the text with the voice, language, rate, pitch and volume Chrome takes, and answers at once', async () => {
    const h = harness()
    await withTts(h)
    const reply = await speak(h, 'bg1', TEXT, {
      voiceName: 'en-us-x-tpf-local',
      lang: 'en-US',
      rate: 1.25,
      pitch: 1.4,
      volume: 0.5,
      requiredEventTypes: ['start', 'end'],
      desiredEventTypes: ['start', 'end', 'word', 'error']
    })
    expect(reply.ok).toBe(true)
    expect(h.speech!.spoken).toEqual([
      {
        utteranceId: 'ext-tts:1:0',
        text: TEXT,
        options: {
          voiceId: 'en-us-x-tpf-local',
          lang: 'en-US',
          rate: 1.25,
          pitch: 1.4,
          volume: 0.5
        }
      }
    ])
    // Nothing chosen: the engine's default voice for no language, at rate 1, its own pitch and volume.
    await speak(h, 'bg1', 'Hello', {}, null)
    expect(h.speech!.last()!.options).toEqual({ voiceId: null, lang: '', rate: 1 })
  })

  it("the utterance's events go back to the calling context alone, with Chrome's charIndex and isFinalEvent", async () => {
    const h = harness()
    await withTts(h)
    // A popup of the extension listens for the relay too (it spoke earlier); it is not the caller here.
    hello(h, 'pop1', 'popup')
    message(h, 'pop1', { t: 'listen', event: 'tts.onEvent', on: true })
    await speak(h, 'bg1', TEXT)
    const speech = h.speech!
    expect((await call(h, 'bg1', 'tts', 'isSpeaking', [])).result).toBe(true)
    speech.fire('ext-tts:1:0', { type: 'start' })
    speech.fire('ext-tts:1:0', { type: 'word', charIndex: 4, length: 5 })
    speech.fire('ext-tts:1:0', { type: 'end' })
    expect(onEvents(h, 'bg1', 'tok1')).toEqual([
      { type: 'start', charIndex: 0, isFinalEvent: false },
      { type: 'word', charIndex: 4, length: 5, isFinalEvent: false },
      { type: 'end', charIndex: TEXT.length, isFinalEvent: true }
    ])
    expect(events(h, 'pop1', 'tts.onEvent')).toHaveLength(0)
    expect((await call(h, 'bg1', 'tts', 'isSpeaking', [])).result).toBe(false)
    // Events for an utterance the engine no longer has are stale and say nothing.
    speech.fire('ext-tts:1:0', { type: 'word', charIndex: 10, length: 5 })
    expect(onEvents(h, 'bg1', 'tok1')).toHaveLength(3)
  })

  it("a second speak interrupts the first (Chrome's rules), enqueue queues it behind, stop empties everything", async () => {
    const h = harness()
    await withTts(h)
    const speech = h.speech!
    await speak(h, 'bg1', 'First', {}, 'tok1')
    speech.fire('ext-tts:1:0', { type: 'start' })
    await speak(h, 'bg1', 'Second', {}, 'tok2')
    expect(speech.stops).toBe(1)
    expect(onEvents(h, 'bg1', 'tok1')).toEqual([
      { type: 'start', charIndex: 0, isFinalEvent: false },
      { type: 'interrupted', charIndex: 0, isFinalEvent: true }
    ])
    expect(speech.last()!.text).toBe('Second')
    // Queued behind: spoken when the second ends.
    await speak(h, 'bg1', 'Third', { enqueue: true }, 'tok3')
    expect(speech.spoken).toHaveLength(2)
    speech.fire('ext-tts:2:0', { type: 'end' })
    expect(speech.last()!.text).toBe('Third')
    expect(speech.last()!.utteranceId).toBe('ext-tts:3:0')
    // Stop: the third is interrupted, a fourth waiting behind it is cancelled, nothing speaks.
    await speak(h, 'bg1', 'Fourth', { enqueue: true }, 'tok4')
    await call(h, 'bg1', 'tts', 'stop', [])
    expect(speech.stops).toBe(2)
    expect(onEvents(h, 'bg1', 'tok3').map((e) => e.type)).toEqual(['interrupted'])
    expect(onEvents(h, 'bg1', 'tok4').map((e) => e.type)).toEqual(['cancelled'])
    expect((await call(h, 'bg1', 'tts', 'isSpeaking', [])).result).toBe(false)
    expect(speech.spoken).toHaveLength(3)
  })

  it('pause stops the engine at the word being spoken and resume speaks the rest from that word, with the pause and resume events', async () => {
    const h = harness()
    await withTts(h)
    const speech = h.speech!
    await speak(h, 'bg1', TEXT)
    speech.fire('ext-tts:1:0', { type: 'start' })
    speech.fire('ext-tts:1:0', { type: 'word', charIndex: 4, length: 5 })
    speech.fire('ext-tts:1:0', { type: 'word', charIndex: 10, length: 5 })
    await call(h, 'bg1', 'tts', 'pause', [])
    expect(speech.stops).toBe(1)
    // Paused, the utterance is still the current one (Chrome's isSpeaking says so).
    expect((await call(h, 'bg1', 'tts', 'isSpeaking', [])).result).toBe(true)
    await call(h, 'bg1', 'tts', 'resume', [])
    expect(speech.last()).toMatchObject({ utteranceId: 'ext-tts:1:1', text: 'brown fox jumps' })
    // The resumed segment's own start is no new start; its words count from where it began.
    speech.fire('ext-tts:1:1', { type: 'start' })
    speech.fire('ext-tts:1:1', { type: 'word', charIndex: 6, length: 3 })
    speech.fire('ext-tts:1:1', { type: 'end' })
    expect(onEvents(h, 'bg1', 'tok1')).toEqual([
      { type: 'start', charIndex: 0, isFinalEvent: false },
      { type: 'word', charIndex: 4, length: 5, isFinalEvent: false },
      { type: 'word', charIndex: 10, length: 5, isFinalEvent: false },
      { type: 'pause', charIndex: 10, isFinalEvent: false },
      { type: 'resume', charIndex: 10, isFinalEvent: false },
      { type: 'word', charIndex: 16, length: 3, isFinalEvent: false },
      { type: 'end', charIndex: TEXT.length, isFinalEvent: true }
    ])
  })

  it('an engine that reports no words resumes the utterance from its start; a speak while paused waits for resume', async () => {
    const h = harness()
    await withTts(h)
    const speech = h.speech!
    await speak(h, 'bg1', 'One', {}, 'tok1')
    speech.fire('ext-tts:1:0', { type: 'start' })
    await call(h, 'bg1', 'tts', 'pause', [])
    // New utterances wait while paused (Chrome holds them), and the paused one keeps its place.
    await speak(h, 'bg1', 'Two', {}, 'tok2')
    expect(speech.spoken).toHaveLength(1)
    await call(h, 'bg1', 'tts', 'resume', [])
    expect(speech.last()).toMatchObject({ utteranceId: 'ext-tts:1:1', text: 'One' })
    expect(onEvents(h, 'bg1', 'tok1').map((e) => [e.type, e.charIndex])).toEqual([
      ['start', 0],
      ['pause', 0],
      ['resume', 0]
    ])
    speech.fire('ext-tts:1:1', { type: 'end' })
    expect(speech.last()!.text).toBe('Two')
  })

  it("read aloud's player pauses when an extension speaks, and read aloud taking the engine back interrupts the extension without stopping the player", async () => {
    const h = harness()
    await withTts(h)
    const speech = h.speech!
    h.readAloud.status = 'playing'
    await speak(h, 'bg1', 'First', {}, 'tok1')
    expect(h.readAloud).toEqual({ status: 'paused', pauses: 1 })
    speech.fire('ext-tts:1:0', { type: 'start' })
    await speak(h, 'bg1', 'Second', { enqueue: true }, 'tok2')
    // The user presses Play: read aloud's sentence flushes the engine, which reports the extension's utterance interrupted.
    speech.speak('ra-7', 'A sentence of the page.', { voiceId: null, lang: 'en', rate: 1 })
    expect(onEvents(h, 'bg1', 'tok1').map((e) => e.type)).toEqual(['start', 'interrupted'])
    expect(onEvents(h, 'bg1', 'tok2').map((e) => e.type)).toEqual(['cancelled'])
    // The newcomer keeps the engine: no stop went to it, and the extension no longer speaks.
    expect(speech.stops).toBe(0)
    expect(speech.current).toBe('ra-7')
    expect((await call(h, 'bg1', 'tts', 'isSpeaking', [])).result).toBe(false)
  })

  it('without a speech engine getVoices answers none and speak fails with an error event', async () => {
    const h = harness({ speech: false })
    await withTts(h)
    expect((await call(h, 'bg1', 'tts', 'getVoices', [])).result).toEqual([])
    await speak(h, 'bg1', TEXT)
    await Promise.resolve()
    expect(onEvents(h, 'bg1', 'tok1')).toEqual([
      { type: 'error', charIndex: 0, errorMessage: ERROR_NO_ENGINE, isFinalEvent: true }
    ])
    expect((await call(h, 'bg1', 'tts', 'isSpeaking', [])).result).toBe(false)
  })

  it("Chrome's option checks in Chrome's words, and the permission", async () => {
    const h = harness()
    await withTts(h)
    expect((await speak(h, 'bg1', TEXT, { rate: 20 })).error).toBe('Invalid rate.')
    expect((await speak(h, 'bg1', TEXT, { pitch: 3 })).error).toBe('Invalid pitch.')
    expect((await speak(h, 'bg1', TEXT, { volume: 2 })).error).toBe('Invalid volume.')
    expect((await speak(h, 'bg1', 'x'.repeat(40_000))).error).toBe('Utterance length is too long.')
    expect(h.speech!.spoken).toHaveLength(0)
    const other = harness()
    await withTts(other, ['storage'])
    expect((await call(other, 'bg1', 'tts', 'getVoices', [])).error).toBe(ERROR_NO_PERMISSION)
  })

  it('events for a context that went away are dropped rather than waking it, and a disabled extension falls silent', async () => {
    const h = harness()
    await withTts(h)
    const speech = h.speech!
    await speak(h, 'bg1', TEXT)
    speech.fire('ext-tts:1:0', { type: 'start' })
    h.runtime.onGone(['bg1'])
    speech.fire('ext-tts:1:0', { type: 'word', charIndex: 4, length: 5 })
    expect(onEvents(h, 'bg1', 'tok1').map((e) => e.type)).toEqual(['start'])
    // Speech goes on, as in Chrome, until the extension itself goes.
    expect(speech.current).toBe('ext-tts:1:0')
    await h.runtime.detach(ID)
    expect(speech.stops).toBe(1)
    expect(speech.current).toBeNull()
  })
})
