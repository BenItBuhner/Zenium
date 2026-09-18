import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SensitiveClipboard } from '../clipboard'

/** A host clipboard that remembers what it holds and only clears the exact secret asked for. */
class FakeClipboard {
  text = ''
  sensitive: boolean[] = []
  cleared: string[] = []
  writeText(text: string, sensitive?: boolean): void {
    this.text = text
    this.sensitive.push(sensitive === true)
  }
  async clearText(expected: string): Promise<void> {
    this.cleared.push(expected)
    if (this.text === expected) this.text = ''
  }
}

describe('SensitiveClipboard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks every copy sensitive and clears it after the timeout', async () => {
    const host = new FakeClipboard()
    const clipboard = new SensitiveClipboard(host)
    expect(clipboard.canClear()).toBe(true)
    expect(clipboard.copy('hunter2', 30)).toBe(30)
    expect(host.text).toBe('hunter2')
    expect(host.sensitive).toEqual([true])
    await vi.advanceTimersByTimeAsync(29_999)
    expect(host.cleared).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(host.cleared).toEqual(['hunter2'])
    expect(host.text).toBe('')
  })

  it('leaves something the user copied meanwhile alone (the host compares)', async () => {
    const host = new FakeClipboard()
    const clipboard = new SensitiveClipboard(host)
    clipboard.copy('hunter2', 10)
    host.text = 'a shopping list'
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.cleared).toEqual(['hunter2'])
    expect(host.text).toBe('a shopping list')
  })

  it('lets a second copy replace the first timer', async () => {
    const host = new FakeClipboard()
    const clipboard = new SensitiveClipboard(host)
    clipboard.copy('first', 10)
    await vi.advanceTimersByTimeAsync(5_000)
    clipboard.copy('second', 10)
    await vi.advanceTimersByTimeAsync(5_000)
    // The first timer would have fired now; it was replaced.
    expect(host.cleared).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(host.cleared).toEqual(['second'])
  })

  it('does not schedule anything with the timeout at 0 or on a host that cannot clear', async () => {
    const host = new FakeClipboard()
    expect(new SensitiveClipboard(host).copy('x', 0)).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.cleared).toEqual([])

    const bare = { writeText: vi.fn() }
    const clipboard = new SensitiveClipboard(bare)
    expect(clipboard.canClear()).toBe(false)
    expect(clipboard.copy('x', 30)).toBe(0)
    expect(bare.writeText).toHaveBeenCalledWith('x', true)
  })

  it('clears a pending secret at once on flush, and only then', async () => {
    const host = new FakeClipboard()
    const clipboard = new SensitiveClipboard(host)
    clipboard.copy('hunter2', 60)
    await clipboard.flush()
    expect(host.cleared).toEqual(['hunter2'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.cleared).toEqual(['hunter2'])
    // Nothing pending: nothing cleared.
    await clipboard.flush()
    expect(host.cleared).toEqual(['hunter2'])
  })

  it('survives a host whose clearing fails', async () => {
    const host = {
      writeText: vi.fn(),
      clearText: vi.fn(async () => {
        throw new Error('clipboard busy')
      })
    }
    const clipboard = new SensitiveClipboard(host)
    clipboard.copy('x', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(host.clearText).toHaveBeenCalledWith('x')
    clipboard.copy('y', 1)
    await expect(clipboard.flush()).resolves.toBeUndefined()
  })
})
