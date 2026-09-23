import { describe, expect, it } from 'vitest'
import {
  MediaAccessGate,
  mediaDeviceKinds,
  mediaRefusedMessage,
  type MediaAccessStatus,
  type MediaDeviceKind,
  type SystemMediaAccess
} from '../mediaAccess'

/**
 * A stand-in for `systemPreferences`: the status per device, the dialogs it was asked to put
 * up (each resolved by the test), and the answer each gives.
 */
function fakeSystem(initial: Partial<Record<MediaDeviceKind, MediaAccessStatus>> = {}): {
  system: SystemMediaAccess
  status: Record<MediaDeviceKind, MediaAccessStatus>
  asked: MediaDeviceKind[]
  answer: (kind: MediaDeviceKind, granted: boolean) => void
} {
  const status: Record<MediaDeviceKind, MediaAccessStatus> = {
    camera: 'not-determined',
    microphone: 'not-determined',
    ...initial
  }
  const asked: MediaDeviceKind[] = []
  const dialogs = new Map<MediaDeviceKind, (granted: boolean) => void>()
  return {
    status,
    asked,
    answer: (kind, granted) => {
      const resolve = dialogs.get(kind)
      if (!resolve) throw new Error(`no dialog up for the ${kind}`)
      dialogs.delete(kind)
      status[kind] = granted ? 'granted' : 'denied'
      resolve(granted)
    },
    system: {
      getMediaAccessStatus: (kind) => status[kind],
      askForMediaAccess: (kind) => {
        asked.push(kind)
        return new Promise((resolve) => dialogs.set(kind, resolve))
      }
    }
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function gate(
  platform: NodeJS.Platform,
  fake: ReturnType<typeof fakeSystem>
): { gate: MediaAccessGate; refused: Array<[MediaDeviceKind, MediaAccessStatus]> } {
  const refused: Array<[MediaDeviceKind, MediaAccessStatus]> = []
  return {
    refused,
    gate: new MediaAccessGate({
      platform,
      system: fake.system,
      onRefused: (kind, status) => refused.push([kind, status])
    })
  }
}

describe('mediaDeviceKinds', () => {
  it('names the camera for video and the microphone for audio, camera first, each once', () => {
    expect(mediaDeviceKinds(['video'])).toEqual(['camera'])
    expect(mediaDeviceKinds(['audio'])).toEqual(['microphone'])
    expect(mediaDeviceKinds(['audio', 'video', 'audio'])).toEqual(['camera', 'microphone'])
    expect(mediaDeviceKinds([])).toEqual([])
  })
})

describe('MediaAccessGate', () => {
  it('lets every request through off macOS without a word to the system', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const fake = fakeSystem({ camera: 'denied', microphone: 'denied' })
      const g = gate(platform, fake)
      await expect(g.gate.allows(['video', 'audio'])).resolves.toBe(true)
      expect(fake.asked).toEqual([])
      expect(g.refused).toEqual([])
    }
  })

  it('asks the system before the first request for a device, and its answer decides', async () => {
    const fake = fakeSystem()
    const g = gate('darwin', fake)
    const pending = g.gate.allows(['video'])
    await tick()
    expect(fake.asked).toEqual(['camera'])
    fake.answer('camera', true)
    await expect(pending).resolves.toBe(true)
    // Granted now: the next request is not asked about again.
    await expect(g.gate.allows(['video'])).resolves.toBe(true)
    expect(fake.asked).toEqual(['camera'])
    expect(g.refused).toEqual([])
  })

  it('refuses when the user says no in the system dialog, and tells once', async () => {
    const fake = fakeSystem()
    const g = gate('darwin', fake)
    const pending = g.gate.allows(['audio'])
    await tick()
    fake.answer('microphone', false)
    await expect(pending).resolves.toBe(false)
    expect(g.refused).toEqual([['microphone', 'denied']])
    // Denied now: refused at once, no dialog, and the user is not told again this run.
    await expect(g.gate.allows(['audio'])).resolves.toBe(false)
    expect(fake.asked).toEqual(['microphone'])
    expect(g.refused).toHaveLength(1)
  })

  it('refuses a device the system already withholds without a dialog, restricted included', async () => {
    const fake = fakeSystem({ camera: 'restricted' })
    const g = gate('darwin', fake)
    await expect(g.gate.allows(['video', 'audio'])).resolves.toBe(false)
    // The microphone, still undecided, is not asked for on a request that fails anyway.
    expect(fake.asked).toEqual([])
    expect(g.refused).toEqual([['camera', 'restricted']])
    const unknown = fakeSystem({ microphone: 'unknown' })
    await expect(gate('darwin', unknown).gate.allows(['audio'])).resolves.toBe(false)
  })

  it('asks for the camera and then the microphone of one request, and shares a dialog between concurrent requests', async () => {
    const fake = fakeSystem()
    const g = gate('darwin', fake)
    const both = g.gate.allows(['video', 'audio'])
    const cameraAlone = g.gate.allows(['video'])
    await tick()
    // One camera dialog for the two requests; the microphone's waits for the camera's answer.
    expect(fake.asked).toEqual(['camera'])
    fake.answer('camera', true)
    await expect(cameraAlone).resolves.toBe(true)
    await tick()
    expect(fake.asked).toEqual(['camera', 'microphone'])
    fake.answer('microphone', true)
    await expect(both).resolves.toBe(true)
  })

  it('treats a system that throws as refusing', async () => {
    const broken: SystemMediaAccess = {
      getMediaAccessStatus: () => 'not-determined',
      askForMediaAccess: () => Promise.reject(new Error('no TCC here'))
    }
    const refused: MediaDeviceKind[] = []
    const g = new MediaAccessGate({
      platform: 'darwin',
      system: broken,
      onRefused: (kind) => refused.push(kind)
    })
    await expect(g.allows(['video'])).resolves.toBe(false)
    expect(refused).toEqual(['camera'])
    const throwing: SystemMediaAccess = {
      getMediaAccessStatus: () => {
        throw new Error('no such API')
      },
      askForMediaAccess: () => Promise.resolve(true)
    }
    await expect(
      new MediaAccessGate({ platform: 'darwin', system: throwing }).allows(['audio'])
    ).resolves.toBe(false)
  })
})

describe('mediaRefusedMessage', () => {
  it('points at the system setting pane of the device', () => {
    expect(mediaRefusedMessage('camera')).toBe(
      'macOS is not letting Zenium use the camera. Allow it in System Settings → Privacy & Security → Camera.'
    )
    expect(mediaRefusedMessage('microphone')).toMatch(
      /microphone.*Privacy & Security → Microphone\.$/
    )
  })
})
