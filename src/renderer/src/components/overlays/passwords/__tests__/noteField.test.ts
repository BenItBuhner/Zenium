import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { NOTE_MAX_LENGTH } from '@shared/types'
import { NOTE_COUNTER_FROM, noteCounter, noteOverLimit } from '../lib'

describe('the note field (ID-34)', () => {
  it('clips at Chrome’s 1000 characters', () => {
    expect(NOTE_MAX_LENGTH).toBe(1000)
    expect(NOTE_COUNTER_FROM).toBe(900)
  })

  it('shows the counter only within a hundred characters of the limit', () => {
    expect(noteCounter(0)).toBeUndefined()
    expect(noteCounter(899)).toBeUndefined()
    expect(noteCounter(900)).toBe('900 / 1000')
    expect(noteCounter(1000)).toBe('1000 / 1000')
  })

  it('validates a note over the limit – one that arrived by sync – and says by how much', () => {
    expect(noteOverLimit(1000)).toBeNull()
    expect(noteOverLimit(1001)).toBe('The note is 1 character over the limit of 1000')
    expect(noteOverLimit(1042)).toBe('The note is 42 characters over the limit of 1000')
  })
})
