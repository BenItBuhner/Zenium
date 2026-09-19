// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect, useImperativeHandle, useRef, type JSX, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HttpAuthPrompt, Tab, UIState } from '@shared/types'
import { viewportStore } from '@renderer/lib/formFactor'
import { SIGN_IN_WAIT_MS } from '@renderer/lib/security'
import type { BottomSheetHandle } from '../../sheet/BottomSheet'

/*
 * The sign-in dialog's busy form (v2 draft §9.30, SecurityPrompts in SecurityPromptDialog.tsx):
 * an answer goes to the core and the form stays up, busy, for the server's verdict. A refusal
 * comes back as a new prompt of the same protection space. While the form waits, that prompt
 * lands in the same dialog (the password cleared, the validation line under it); once the wait
 * has run out and the form is leaving – on a phone the sheet is still sliding away – the prompt
 * gets a fresh dialog, so the leaving sheet's dismissal cannot answer it with a cancel.
 */

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({ run: (...args: unknown[]) => run(...args) }))

const cover = { open: vi.fn<(tabId: string | null) => Promise<void>>(), close: vi.fn() }
vi.mock('@renderer/lib/security', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@renderer/lib/security')>()
  return {
    ...mod,
    openSecurityPrompt: (tabId: string | null) => cover.open(tabId),
    closeSecurityPrompt: () => cover.close()
  }
})

/** A stand-in for the sheet chassis: the leave is a step the test completes. */
interface FakeSheet {
  id: number
  leaving: boolean
  unmounted: boolean
  then: (() => void) | null
  onDismissed: () => void
}
const sheets: FakeSheet[] = []
let nextSheet = 0
vi.mock('../../sheet/BottomSheet', () => ({
  BottomSheet: ({
    ref,
    children,
    footer,
    onDismissed,
    contentKey
  }: {
    ref: React.Ref<BottomSheetHandle>
    children: ReactNode
    footer?: ReactNode
    onDismissed: () => void
    contentKey?: string
  }): JSX.Element => {
    const me = useRef<FakeSheet | null>(null)
    if (!me.current) {
      me.current = { id: ++nextSheet, leaving: false, unmounted: false, then: null, onDismissed }
      sheets.push(me.current)
    }
    me.current.onDismissed = onDismissed
    useImperativeHandle(ref, () => ({
      dismiss: (then?: () => void) => {
        me.current!.leaving = true
        me.current!.then = then ?? null
      },
      backProgress: () => undefined,
      commitBack: () => undefined,
      cancelBack: () => undefined
    }))
    useEffect(
      () => () => {
        me.current!.unmounted = true
      },
      []
    )
    return (
      <div data-fake-sheet={me.current.id} data-content-key={contentKey}>
        {children}
        {footer}
      </div>
    )
  }
}))

// Imported after the mocks are declared (hoisted by vitest either way; kept explicit).
const { SecurityPrompts } = await import('../SecurityPromptDialog')

const challenge: HttpAuthPrompt = {
  id: 'A',
  kind: 'http-auth',
  tabId: 't1',
  host: 'intranet',
  port: 8080,
  realm: 'Staff',
  scheme: 'basic',
  isProxy: false,
  secure: false,
  failedBefore: false,
  username: ''
}
const refusal: HttpAuthPrompt = { ...challenge, id: 'B', failedBefore: true, username: 'ann' }
const REFUSED = 'The username or password was not accepted. Please try again.'

function state(prompts: HttpAuthPrompt[], loading = false): UIState {
  return {
    tabs: { t1: { id: 't1', url: 'http://intranet:8080/', loading } as Tab },
    spaces: [{ id: 's1', activeTabId: 't1', tabIds: ['t1'] }],
    activeSpaceId: 's1',
    permissionRules: [],
    blockedPopups: {},
    securityPrompts: prompts,
    permissionPrompts: []
  } as unknown as UIState
}

let container: HTMLDivElement
let root: Root
const show = (s: UIState): void => {
  act(() => root.render(<SecurityPrompts state={s} />))
}
const form = (): HTMLFormElement | null => container.querySelector('form')
const submit = (): void => {
  act(() => {
    form()!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}
const password = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')
const username = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('input[autocomplete="username"]')
const cancelled = (id: string): boolean =>
  run.mock.calls.some(
    ([name, args]) =>
      name === 'security.respond' &&
      (args as { id: string; response: unknown }).id === id &&
      (args as { response: unknown }).response === null
  )

beforeEach(() => {
  vi.useFakeTimers()
  run.mockClear()
  cover.open.mockClear()
  cover.close.mockClear()
  sheets.length = 0
  nextSheet = 0
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

/** Answer the challenge and let the core drop the prompt: the form is up, busy. */
function sendAnswer(): void {
  show(state([challenge]))
  expect(sheets.length).toBe(1)
  expect(form()!.getAttribute('aria-busy')).toBe(null)
  submit()
  expect(run).toHaveBeenCalledWith('security.respond', {
    id: 'A',
    response: { kind: 'http-auth', username: '', password: '', remember: false }
  })
  show(state([]))
  expect(form()).not.toBe(null)
  expect(form()!.getAttribute('aria-busy')).toBe('true')
  expect(sheets[0].leaving).toBe(false)
}

describe('the busy sign-in form (§9.30)', () => {
  it('takes a refusal that comes within the wait into the same dialog: password cleared, line shown', () => {
    sendAnswer()
    act(() => vi.advanceTimersByTime(SIGN_IN_WAIT_MS / 2))
    show(state([refusal]))
    expect(sheets.length).toBe(1)
    expect(sheets[0].leaving).toBe(false)
    expect(form()!.getAttribute('aria-busy')).toBe(null)
    expect(container.textContent).toContain(REFUSED)
    expect(username()!.value).toBe('ann')
    expect(password()!.value).toBe('')
    expect(cancelled('B')).toBe(false)
  })

  it('leaves once the wait runs out, and gives a refusal that arrives then a fresh dialog', () => {
    sendAnswer()
    act(() => vi.advanceTimersByTime(SIGN_IN_WAIT_MS))
    // The wait ran out: the sheet is on its way out with the form still drawn, busy.
    expect(sheets[0].leaving).toBe(true)
    expect(form()!.getAttribute('aria-busy')).toBe('true')

    show(state([refusal]))
    // Not taken over: a second dialog, the first gone with its sheet mid-flight.
    expect(sheets.length).toBe(2)
    expect(sheets[0].unmounted).toBe(true)
    expect(sheets[1].leaving).toBe(false)
    expect(form()!.getAttribute('aria-busy')).toBe(null)
    expect(container.textContent).toContain(REFUSED)
    expect(username()!.value).toBe('ann')
    expect(password()!.value).toBe('')
    expect(document.activeElement).toBe(password())
    // The page's cover stayed: one open for the tab, no close in between.
    expect(cover.open).toHaveBeenCalledTimes(1)
    expect(cover.close).not.toHaveBeenCalled()

    // The first sheet's departure, however it ends, does not answer the new prompt.
    act(() => {
      sheets[0].then?.()
      sheets[0].onDismissed()
    })
    expect(cancelled('B')).toBe(false)
    expect(sheets.length).toBe(2)

    submit()
    expect(run).toHaveBeenCalledWith('security.respond', {
      id: 'B',
      response: { kind: 'http-auth', username: 'ann', password: '', remember: false }
    })
  })

  it('closes the form when nothing comes back, and the cover with it', () => {
    sendAnswer()
    act(() => vi.advanceTimersByTime(SIGN_IN_WAIT_MS))
    expect(sheets[0].leaving).toBe(true)
    act(() => {
      sheets[0].then?.()
      sheets[0].onDismissed()
    })
    expect(form()).toBe(null)
    expect(cancelled('A')).toBe(false)
    expect(cover.close).toHaveBeenCalledTimes(1)
  })
})
