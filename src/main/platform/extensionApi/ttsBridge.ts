import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  TTS_COMMAND_CHANNEL,
  TTS_REPORT_CHANNEL,
  type EngineEvent,
  type SpeechCommand,
  type SpeechReport,
  type TtsVoice
} from '../../../core/extensions/api/tts'
import type { SpeechEngine } from './tts'

const ttsPreload = join(__dirname, '../preload/tts.js')

/** How long the first `getVoices` waits for the engine to list its voices. */
const VOICES_TIMEOUT_MS = 1500

/**
 * Electron's speech engine for `chrome.tts`: a hidden window whose page does nothing but hold
 * `speechSynthesis` (`preload/tts.ts` drives it), created on the first use and kept for the
 * session. Commands go down as IPC messages, utterance events and voice lists come back up.
 */
export function electronSpeechEngine(): SpeechEngine {
  let win: BrowserWindow | null = null
  let ready: Promise<void> | null = null
  let voiceList: TtsVoice[] = []
  let voicesListed: Promise<void> | null = null
  let markVoicesListed: (() => void) | null = null
  const eventListeners: Array<(id: number, event: EngineEvent) => void> = []
  const voicesListeners: Array<() => void> = []

  let markReady: (() => void) | null = null
  ipcMain.on(TTS_REPORT_CHANNEL, (event, report: SpeechReport) => {
    if (!win || event.sender !== win.webContents) return
    switch (report.kind) {
      case 'ready':
        voiceList = report.voices
        if (voiceList.length > 0) markVoicesListed?.()
        markReady?.()
        return
      case 'voices':
        voiceList = report.voices
        markVoicesListed?.()
        for (const listener of voicesListeners) listener()
        return
      case 'event':
        for (const listener of eventListeners) listener(report.id, report.event)
        return
    }
  })

  const ensure = (): Promise<void> => {
    if (ready) return ready
    const bw = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        preload: ttsPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    win = bw
    voicesListed = new Promise<void>((resolve) => {
      markVoicesListed = resolve
    })
    ready = new Promise<void>((resolve) => {
      markReady = resolve
      bw.webContents.on('did-fail-load', () => resolve())
      bw.on('closed', () => {
        if (win === bw) {
          win = null
          ready = null
        }
        resolve()
      })
      void bw.loadURL('data:text/html,<title>Zenium speech</title>').catch(() => resolve())
    })
    return ready
  }

  const send = (command: SpeechCommand): void => {
    void ensure().then(() => {
      if (win && !win.isDestroyed()) win.webContents.send(TTS_COMMAND_CHANNEL, command)
    })
  }

  return {
    speak: (id, text, options) => send({ kind: 'speak', id, text, ...options }),
    cancel: () => {
      if (win) send({ kind: 'cancel' })
    },
    pause: () => {
      if (win) send({ kind: 'pause' })
    },
    resume: () => {
      if (win) send({ kind: 'resume' })
    },
    voices: async () => {
      await ensure()
      // The engine lists its voices a moment after the page loads; give the first ask that moment.
      if (voiceList.length === 0 && voicesListed) {
        await Promise.race([
          voicesListed,
          new Promise<void>((resolve) => setTimeout(resolve, VOICES_TIMEOUT_MS))
        ])
      }
      return voiceList
    },
    onEvent: (listener) => {
      eventListeners.push(listener)
    },
    onVoicesChanged: (listener) => {
      voicesListeners.push(listener)
    }
  }
}

let shared: SpeechEngine | null = null

/**
 * The one engine of the process: `chrome.tts` and read aloud (`platform/speech.ts`) speak
 * through the same hidden page, so there is one `speechSynthesis`, one voice list and one
 * event stream (the two tell their utterances apart by id).
 */
export function sharedSpeechEngine(): SpeechEngine {
  shared ??= electronSpeechEngine()
  return shared
}
