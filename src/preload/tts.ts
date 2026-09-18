import { ipcRenderer } from 'electron'
import {
  TTS_COMMAND_CHANNEL,
  TTS_REPORT_CHANNEL,
  engineEventFromWebSpeech,
  pickWebSpeechVoice,
  voiceFromWebSpeech,
  type SpeechCommand,
  type SpeechReport,
  type TtsVoice
} from '../core/extensions/api/tts'

/**
 * The hidden speech page behind `chrome.tts`: drives the engine's `speechSynthesis` on the main
 * process's commands and reports the utterance's events and the voice list back. One utterance
 * at a time; the queue and Chrome's rules live host-side.
 */

const utterances = new Map<number, SpeechSynthesisUtterance>()

function report(message: SpeechReport): void {
  ipcRenderer.send(TTS_REPORT_CHANNEL, message)
}

function voices(): TtsVoice[] {
  return speechSynthesis.getVoices().map(voiceFromWebSpeech)
}

function speak(command: SpeechCommand & { kind: 'speak' }): void {
  const utterance = new SpeechSynthesisUtterance(command.text)
  const voice = pickWebSpeechVoice(speechSynthesis.getVoices(), command)
  if (voice) utterance.voice = voice
  if (command.lang) utterance.lang = command.lang
  if (command.rate !== undefined) utterance.rate = command.rate
  if (command.pitch !== undefined) utterance.pitch = command.pitch
  if (command.volume !== undefined) utterance.volume = command.volume
  const relay = (event: SpeechSynthesisEvent | SpeechSynthesisErrorEvent): void => {
    const detail: { charIndex?: number; charLength?: number; name?: string; error?: string } = {
      charIndex: event.charIndex,
      charLength: event.charLength
    }
    if (event.name) detail.name = event.name
    if ('error' in event) detail.error = event.error
    const mapped = engineEventFromWebSpeech(event.type, detail)
    if (!mapped) return
    if (mapped.type === 'end' || mapped.type === 'error') utterances.delete(command.id)
    report({ kind: 'event', id: command.id, event: mapped })
  }
  for (const type of ['start', 'end', 'error', 'boundary', 'mark', 'pause', 'resume'] as const) {
    utterance.addEventListener(type, relay)
  }
  // The engine only keeps a weak hold; an utterance collected mid-speech loses its events.
  utterances.set(command.id, utterance)
  speechSynthesis.speak(utterance)
}

ipcRenderer.on(TTS_COMMAND_CHANNEL, (_event, command: SpeechCommand) => {
  switch (command.kind) {
    case 'speak':
      speak(command)
      return
    case 'cancel':
      speechSynthesis.cancel()
      return
    case 'pause':
      speechSynthesis.pause()
      return
    case 'resume':
      speechSynthesis.resume()
      return
    case 'voices':
      report({ kind: 'voices', voices: voices() })
      return
  }
})

speechSynthesis.addEventListener('voiceschanged', () => {
  report({ kind: 'voices', voices: voices() })
})

report({ kind: 'ready', voices: voices() })
