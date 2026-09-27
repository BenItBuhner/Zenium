// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
import { emptyPasswordsStatus } from '@shared/defaults'
import { TOAST_UNDO_MS } from '@shared/toastCard'

/*
 * The password manager's "Deleted the login for <site>" toast offers Undo, so it stands on
 * §9.33's Undo clock – 8 s, by the one shared constant (`TOAST_UNDO_MS`), never the 5 s action
 * default by omission (W8-11: the clock the panel had left to `pushToast`'s default). The test
 * mounts the panel unlocked, fires the core's `passwords.removed`, and reads what the toast was
 * asked for: the message, the Undo action, and the clock by its constant.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Listener = (payload: unknown) => void
const listeners = new Map<string, Set<Listener>>()
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'passwords.list') return []
  if (name === 'passwords.restore') return true
  return null
})
Object.assign(window, {
  zen: {
    invoke,
    on: (name: string, listener: Listener) => {
      const set = listeners.get(name) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    }
  }
})

const pushToast = vi.fn<(message: string, kind?: string, opts?: unknown) => number>(() => 1)
vi.mock('@renderer/lib/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/ui')>()
  return { ...actual, pushToast: (...args: Parameters<typeof actual.pushToast>) => pushToast(...args) }
})

const { PasswordsPanel } = await import('../PasswordsPanel')

function state(): UIState {
  return {
    platform: 'linux',
    capabilities: { windows: true },
    tabs: {},
    spaces: [],
    passwords: { ...emptyPasswordsStatus(), locked: false },
    settings: {}
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  listeners.clear()
  pushToast.mockClear()
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(async () => Promise.resolve())
}

describe('the deleted-login toast (W8-11): Undo on §9.33’s clock', () => {
  it('asks for TOAST_UNDO_MS by the constant, with the Undo action and the login’s site', async () => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
    act(() => root!.render(createElement(PasswordsPanel, { state: state() })))
    await settle()
    const removed = listeners.get('passwords.removed')
    expect(removed?.size).toBe(1)

    act(() => {
      for (const l of removed!) l({ id: 'cred_1', site: 'example.com' })
    })
    expect(pushToast).toHaveBeenCalledTimes(1)
    const [message, kind, opts] = pushToast.mock.calls[0]!
    expect(message).toBe('Deleted the login for example.com')
    expect(kind).toBe('info')
    const options = opts as { duration?: number; action?: { label: string; onPick: () => void } }
    expect(options.duration).toBe(TOAST_UNDO_MS)
    expect(options.action?.label).toBe('Undo')

    // The clock is §9.33's 8 s – above the 5 s a plain action toast keeps – and one constant.
    expect(TOAST_UNDO_MS).toBe(8000)

    // Undo restores the login by its id.
    options.action!.onPick()
    await settle()
    expect(invoke).toHaveBeenCalledWith('passwords.restore', { id: 'cred_1' })
  })
})
