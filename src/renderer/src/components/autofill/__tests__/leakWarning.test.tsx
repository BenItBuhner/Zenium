// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect, useImperativeHandle, useRef, type JSX, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CredentialLeakWarning, Tab, UIState } from '@shared/types'
import { viewportStore } from '@renderer/lib/formFactor'
import { uiStore } from '@renderer/lib/ui'
import type { BottomSheetHandle } from '../../sheet/BottomSheet'

/*
 * The sign-in leak warning (ID-31, `LeakWarning.tsx`): Chrome's dialog on a mouse, a prompt
 * sheet on a phone, every way out answering the core once (`passwords.leakRespond`), the page's
 * cover up while it shows.
 */

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: vi.fn(async () => null),
  onEvent: vi.fn(() => () => undefined)
}))

const cover = { open: vi.fn<(tabId: string) => Promise<void>>(), close: vi.fn() }
vi.mock('@renderer/lib/credentialLeak', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@renderer/lib/credentialLeak')>()
  return {
    ...mod,
    openLeakWarning: (tabId: string) => cover.open(tabId),
    closeLeakWarning: () => cover.close()
  }
})

/** A stand-in for the sheet chassis: the leave is a step the test completes. */
interface FakeSheet {
  id: number
  leaving: boolean
  unmounted: boolean
  onDismissed: () => void
  hosted: boolean
  fitContent: boolean
}
const sheets: FakeSheet[] = []
let nextSheet = 0
vi.mock('../../sheet/BottomSheet', () => ({
  BottomSheet: ({
    ref,
    children,
    onDismissed,
    hosted,
    fitContent
  }: {
    ref: React.Ref<BottomSheetHandle>
    children: ReactNode
    onDismissed: () => void
    hosted?: boolean
    fitContent?: boolean
  }): JSX.Element => {
    const me = useRef<FakeSheet | null>(null)
    if (!me.current) {
      me.current = {
        id: ++nextSheet,
        leaving: false,
        unmounted: false,
        onDismissed,
        hosted: hosted === true,
        fitContent: fitContent === true
      }
      sheets.push(me.current)
    }
    me.current.onDismissed = onDismissed
    useImperativeHandle(ref, () => ({
      dismiss: () => {
        me.current!.leaving = true
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
    return <div data-fake-sheet={me.current.id}>{children}</div>
  }
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { LeakWarnings } = await import('../LeakWarning')

const warning: CredentialLeakWarning = {
  id: 'L1',
  tabId: 't1',
  origin: 'https://shop.example',
  site: 'shop.example',
  username: 'ada@example.com',
  breachCount: 3,
  credentialId: 'c1',
  private: false
}

function state(leaks: CredentialLeakWarning[]): UIState {
  return {
    tabs: { t1: { id: 't1', url: 'https://shop.example/account' } as Tab },
    spaces: [{ id: 's1', activeTabId: 't1', tabIds: ['t1'] }],
    activeSpaceId: 's1',
    securityPrompts: [],
    permissionPrompts: [],
    passwords: { leaks }
  } as unknown as UIState
}

let container: HTMLDivElement
let root: Root
const show = (s: UIState): void => {
  act(() => root.render(<LeakWarnings state={s} />))
}
const panel = (): HTMLElement | null => container.querySelector('[data-credential-leak]')
const button = (label: string): HTMLButtonElement => {
  const b = Array.from(container.querySelectorAll('button')).find(
    (el) => el.textContent?.trim() === label
  )
  if (!b) throw new Error(`no button "${label}"`)
  return b
}
const press = (el: HTMLElement): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const answers = (): Array<{ id: string; action: string }> =>
  run.mock.calls
    .filter(([name]) => name === 'passwords.leakRespond')
    .map(([, args]) => args as { id: string; action: string })

beforeEach(() => {
  run.mockClear()
  cover.open.mockClear()
  cover.close.mockClear()
  sheets.length = 0
  nextSheet = 0
  uiStore.set({ autofillPrompt: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the desktop dialog (§9.5)', () => {
  beforeEach(() => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  })

  it('is Chrome’s: the title, the sentence, the account, the manager link, Ignore and Change password', () => {
    show(state([warning]))
    const dialog = panel()!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)
    expect(title?.textContent).toBe('Change your password')
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)
    expect(description?.textContent).toBe(
      'The password you just used was found in a data breach. Zenium recommends changing it now.'
    )
    expect(container.querySelector('.zen-v2-af-preview')?.textContent).toBe(
      'ada@example.comshop.example'
    )
    expect(container.querySelector('[data-leak-manager]')?.textContent).toBe('password manager')
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Ignore',
      'Change password'
    ])
    expect(button('Change password').hasAttribute('data-primary')).toBe(true)
    expect(button('Ignore').hasAttribute('data-primary')).toBe(false)
    // The dialog itself takes the focus (a title-and-notice dialog, §9.22).
    expect(document.activeElement).toBe(dialog)
    // The page's cover went up for the warning's tab.
    expect(cover.open).toHaveBeenCalledWith('t1')
  })

  it('answers once: the primary, and a second press or Escape after it changes nothing', () => {
    show(state([warning]))
    press(button('Change password'))
    expect(answers()).toEqual([{ id: 'L1', action: 'changePassword' }])
    press(button('Ignore'))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(answers()).toEqual([{ id: 'L1', action: 'changePassword' }])
    // The core drops the warning; the cover comes down with the dialog.
    show(state([]))
    expect(panel()).toBeNull()
    expect(cover.close).toHaveBeenCalledTimes(1)
  })

  it('Ignore, the manager link and Escape each carry their action', () => {
    show(state([warning]))
    press(button('Ignore'))
    expect(answers()).toEqual([{ id: 'L1', action: 'ignore' }])

    show(state([]))
    show(state([{ ...warning, id: 'L2' }]))
    press(container.querySelector<HTMLElement>('[data-leak-manager]')!)
    expect(answers().at(-1)).toEqual({ id: 'L2', action: 'openManager' })

    show(state([]))
    show(state([{ ...warning, id: 'L3' }]))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(answers().at(-1)).toEqual({ id: 'L3', action: 'dismiss' })
  })

  it('names a sign-in without a username the manager’s way', () => {
    show(state([{ ...warning, username: '' }]))
    expect(container.querySelector('.zen-v2-af-row-title')?.textContent).toBe('No username')
  })

  it('shows nothing for another tab’s warning', () => {
    show(state([{ ...warning, tabId: 't2' }]))
    expect(panel()).toBeNull()
    expect(cover.open).not.toHaveBeenCalled()
  })
})

describe('the phone sheet (§9.23)', () => {
  beforeEach(() => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  })

  it('rides the hosted BottomSheet chassis at its content’s height, and answers once the sheet has left', () => {
    show(state([warning]))
    expect(sheets.length).toBe(1)
    expect(sheets[0]).toMatchObject({ hosted: true, fitContent: true })
    expect(panel()).not.toBeNull()
    expect(container.textContent).toContain('Change your password')
    expect(cover.open).toHaveBeenCalledWith('t1')

    press(button('Change password'))
    // The button only sends the sheet away; the answer follows its departure.
    expect(sheets[0].leaving).toBe(true)
    expect(answers()).toEqual([])
    act(() => sheets[0].onDismissed())
    expect(answers()).toEqual([{ id: 'L1', action: 'changePassword' }])
  })

  it('a drag away, the scrim or back – a departure no button asked for – is a dismissal', () => {
    show(state([warning]))
    act(() => sheets[0].onDismissed())
    expect(answers()).toEqual([{ id: 'L1', action: 'dismiss' }])
  })

  it('waits behind a save sheet that is already up, and shows once it has gone', () => {
    uiStore.set({ autofillPrompt: { id: 'save-1' } as never })
    show(state([warning]))
    expect(sheets.length).toBe(0)
    expect(panel()).toBeNull()
    act(() => uiStore.set({ autofillPrompt: null }))
    expect(sheets.length).toBe(1)
    expect(panel()).not.toBeNull()
  })
})
