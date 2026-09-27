// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Events } from '@shared/types'

/*
 * The core's `toast` event as `useMainEvents` hands it to the chrome's toast slot: a plain toast
 * as it always was, and one carrying an action (the first automatic picture-in-picture toast,
 * MW-28) as a toast with that trailing action on §9.33's action clock, the pick running the
 * command the core named on the ordinary `zen:cmd` path. A clock the core names (the tile
 * removal's 8 s Undo, NTP-07) stands in place of the chrome's default.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const on = (name: string, listener: (payload: unknown) => void): (() => void) => {
  const set = listeners.get(name) ?? new Set()
  listeners.set(name, set)
  set.add(listener)
  return () => void set.delete(listener)
}
const fire = <K extends keyof Events>(name: K, payload: Events[K]): void => {
  for (const listener of listeners.get(name) ?? []) listener(payload)
}
Object.assign(window, { zen: { invoke, on } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useMainEvents } = await import('../useMainEvents')
const { TOAST_ACTION_DURATION, TOAST_DURATION, uiStore } = await import('@renderer/lib/ui')
const { TOAST_UNDO_MS } = await import('@shared/toastCard')

function Wired(): null {
  useMainEvents()
  return null
}

describe('the toast event in the chrome', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(createElement(Wired)))
    invoke.mockClear()
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    uiStore.set({ toasts: [] })
    listeners.clear()
  })

  it('shows a plain toast as it always did', () => {
    act(() => fire('toast', { message: 'Link copied', kind: 'info' }))
    const [toast] = uiStore.get().toasts
    expect(toast.message).toBe('Link copied')
    expect(toast.kind).toBe('info')
    expect(toast.action).toBeUndefined()
    expect(toast.duration).toBe(TOAST_DURATION)
  })

  it('gives a toast with an action its trailing action on the action clock, the pick running the command', () => {
    act(() =>
      fire('toast', {
        message: 'Video from video.example opened in a small window',
        kind: 'info',
        action: {
          label: 'Turn off for this site',
          command: 'media.autoPipOptOut',
          args: { tabId: 'tab_1' }
        }
      })
    )
    const [toast] = uiStore.get().toasts
    expect(toast.message).toBe('Video from video.example opened in a small window')
    expect(toast.action?.label).toBe('Turn off for this site')
    expect(toast.duration).toBe(TOAST_ACTION_DURATION)
    expect(TOAST_ACTION_DURATION).toBe(5000)
    expect(invoke).not.toHaveBeenCalledWith('media.autoPipOptOut', expect.anything())
    toast.action!.onPick()
    expect(invoke).toHaveBeenCalledWith('media.autoPipOptOut', { tabId: 'tab_1' })
  })

  it('keeps the clock the core named – the new tab page tile removal’s 8 s Undo (NTP-07, §9.33)', () => {
    act(() =>
      fire('toast', {
        message: 'Shortcut removed',
        kind: 'info',
        action: {
          label: 'Undo',
          command: 'newtab.undoRemove',
          args: { url: 'https://a.example/' }
        },
        duration: TOAST_UNDO_MS
      })
    )
    const [toast] = uiStore.get().toasts
    expect(toast.message).toBe('Shortcut removed')
    expect(toast.action?.label).toBe('Undo')
    expect(toast.duration).toBe(TOAST_UNDO_MS)
    expect(TOAST_UNDO_MS).toBe(8000)
    toast.action!.onPick()
    expect(invoke).toHaveBeenCalledWith('newtab.undoRemove', { url: 'https://a.example/' })
  })

  it('a clock named without an action is kept too', () => {
    act(() => fire('toast', { message: 'Settings reset', kind: 'info', duration: 4000 }))
    expect(uiStore.get().toasts[0].duration).toBe(4000)
  })
})
