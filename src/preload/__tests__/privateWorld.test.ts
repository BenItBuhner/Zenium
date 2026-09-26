import { describe, expect, it } from 'vitest'
import { installPrivateWorld, type PrivateWorldBridge } from '../privateWorld'
import { IMAGE_THUMBNAIL_WORLD_ID, type PrivateWorldAnswer } from '../../shared/privateWorld'

interface Fake {
  bridge: PrivateWorldBridge
  runs: Array<{ worldId: number; code: string }>
  answers: PrivateWorldAnswer[]
  receive(raw: unknown): void
  /** What the fake world answers a run with; a thrown error models a script that failed. */
  outcome: (code: string) => unknown
}

function fake(): Fake {
  let listener: ((raw: unknown) => void) | undefined
  const f: Fake = {
    runs: [],
    answers: [],
    outcome: () => ({ ok: true }),
    receive: (raw) => listener?.(raw),
    bridge: {
      onExecute: (l) => {
        listener = l
      },
      executeInIsolatedWorld: async (worldId, code) => {
        f.runs.push({ worldId, code })
        return f.outcome(code)
      },
      answer: (answer) => {
        f.answers.push(answer)
      }
    }
  }
  installPrivateWorld(f.bridge)
  return f
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the frame’s side of the private world (CT-32)', () => {
  it('runs the host’s script in the thumbnail world through the frame’s own isolated-world call and answers under the token', async () => {
    const f = fake()
    f.outcome = () => ({ ok: true, thumbnail: { base64: '/9j/' } })
    f.receive({ token: 4, worldId: IMAGE_THUMBNAIL_WORLD_ID, code: '(async () => 1)()' })
    await settle()
    expect(f.runs).toEqual([{ worldId: IMAGE_THUMBNAIL_WORLD_ID, code: '(async () => 1)()' }])
    expect(f.answers).toEqual([{ token: 4, result: { ok: true, thumbnail: { base64: '/9j/' } } }])
  })

  it('answers a script that threw with its message', async () => {
    const f = fake()
    f.outcome = () => {
      throw new Error('Script failed to execute, this normally means an error was thrown')
    }
    f.receive({ token: 5, worldId: IMAGE_THUMBNAIL_WORLD_ID, code: 'x' })
    await settle()
    expect(f.answers).toEqual([
      { token: 5, error: 'Script failed to execute, this normally means an error was thrown' }
    ])
  })

  it('runs nothing in any other world – the main world, the preload’s, an extension’s – and answers nothing for such a request', async () => {
    const f = fake()
    for (const worldId of [0, 999, 1, 100_000, 1 << 20, IMAGE_THUMBNAIL_WORLD_ID + 1])
      f.receive({ token: 6, worldId, code: 'x' })
    await settle()
    expect(f.runs).toEqual([])
    expect(f.answers).toEqual([])
  })

  it('drops a malformed request unanswered', async () => {
    const f = fake()
    f.receive(undefined)
    f.receive('run this')
    f.receive({ token: '7', worldId: IMAGE_THUMBNAIL_WORLD_ID, code: 'x' })
    f.receive({ token: 7, worldId: IMAGE_THUMBNAIL_WORLD_ID })
    f.receive({ token: 7, worldId: String(IMAGE_THUMBNAIL_WORLD_ID), code: 'x' })
    await settle()
    expect(f.runs).toEqual([])
    expect(f.answers).toEqual([])
  })

  it('answers each request by its own token, in the order the world settles them', async () => {
    const f = fake()
    f.outcome = (code) => code.toUpperCase()
    f.receive({ token: 1, worldId: IMAGE_THUMBNAIL_WORLD_ID, code: 'a' })
    f.receive({ token: 2, worldId: IMAGE_THUMBNAIL_WORLD_ID, code: 'b' })
    await settle()
    expect(f.answers).toEqual([
      { token: 1, result: 'A' },
      { token: 2, result: 'B' }
    ])
  })
})
