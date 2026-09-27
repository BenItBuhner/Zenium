import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOAST_UNDO_MS } from '@shared/toastCard'
import { UNDO_DELAY_MS, UndoableDeletes } from '../undo'

// `removeWithUndo` lives with the phone panels; what it needs of the chrome is stubbed so the
// toast it pushes can be read back, and the shared `undoableDeletes` instance runs for real.
const pushToast = vi.fn<(message: string, kind: string, opts: { duration?: number }) => number>(
  () => 1
)
vi.mock('@renderer/lib/ui', () => ({
  pushToast: (...args: Parameters<typeof pushToast>) => pushToast(...args),
  uiStore: { get: () => ({ menu: null, bookmarkEdit: null }) }
}))
vi.mock('@renderer/lib/back', () => ({ useBackSurface: () => undefined }))
const { removeWithUndo } = await import('@renderer/components/phone/phonePanel')

describe('the grace period is the §9.33 Undo clock', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    pushToast.mockClear()
  })

  it('UNDO_DELAY_MS is TOAST_UNDO_MS, and the phone panels push their Undo toast for exactly as long as the delete can be undone', () => {
    expect(UNDO_DELAY_MS).toBe(TOAST_UNDO_MS)
    expect(TOAST_UNDO_MS).toBe(8000)

    const commit = vi.fn()
    removeWithUndo(['row'], 'Bookmark deleted', commit)
    expect(pushToast).toHaveBeenCalledTimes(1)
    expect(pushToast).toHaveBeenCalledWith(
      'Bookmark deleted',
      'info',
      expect.objectContaining({ duration: TOAST_UNDO_MS })
    )

    // The commit's clock is the toast's: the delete goes through the instant the toast would go.
    vi.advanceTimersByTime(TOAST_UNDO_MS - 1)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledTimes(1)
  })
})

describe('UndoableDeletes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('hides the rows at once and commits after the grace period', () => {
    const deletes = new UndoableDeletes()
    const commit = vi.fn()
    deletes.schedule(['a', 'b'], commit)
    expect(deletes.isPending('a')).toBe(true)
    expect(deletes.isPending('b')).toBe(true)
    expect(commit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(UNDO_DELAY_MS - 1)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(deletes.isPending('a')).toBe(false)
  })

  it('undo within the period puts the rows back and the delete never runs', () => {
    const deletes = new UndoableDeletes()
    const commit = vi.fn()
    const handle = deletes.schedule(['a'], commit)
    vi.advanceTimersByTime(UNDO_DELAY_MS / 2)
    expect(handle.undo()).toBe(true)
    expect(deletes.isPending('a')).toBe(false)
    vi.advanceTimersByTime(UNDO_DELAY_MS)
    expect(commit).not.toHaveBeenCalled()
  })

  it('undo after the delete has gone through is a no-op', () => {
    const deletes = new UndoableDeletes()
    const commit = vi.fn()
    const handle = deletes.schedule(['a'], commit, 1000)
    vi.advanceTimersByTime(1000)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(handle.undo()).toBe(false)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('tracks several deletes independently', () => {
    const deletes = new UndoableDeletes()
    const first = vi.fn()
    const second = vi.fn()
    const a = deletes.schedule(['a'], first, 1000)
    vi.advanceTimersByTime(500)
    deletes.schedule(['b'], second, 1000)
    expect([...deletes.pendingKeys()].sort()).toEqual(['a', 'b'])
    a.undo()
    expect([...deletes.pendingKeys()]).toEqual(['b'])
    vi.advanceTimersByTime(500)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(second).toHaveBeenCalledTimes(1)
    expect(deletes.pendingKeys().size).toBe(0)
  })

  it('commit() runs the delete early exactly once', () => {
    const deletes = new UndoableDeletes()
    const commit = vi.fn()
    const handle = deletes.schedule(['a'], commit)
    handle.commit()
    expect(commit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(UNDO_DELAY_MS)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(handle.undo()).toBe(false)
  })

  it('flush settles everything pending (the app goes to the background)', () => {
    const deletes = new UndoableDeletes()
    const first = vi.fn()
    const second = vi.fn()
    deletes.schedule(['a'], first)
    deletes.schedule(['b'], second)
    deletes.flush()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(deletes.pendingKeys().size).toBe(0)
  })

  it('tells subscribers when the hidden set changes', () => {
    const deletes = new UndoableDeletes()
    const listener = vi.fn()
    deletes.subscribe(listener)
    const handle = deletes.schedule(['a'], () => undefined)
    expect(listener).toHaveBeenCalledTimes(1)
    handle.undo()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
