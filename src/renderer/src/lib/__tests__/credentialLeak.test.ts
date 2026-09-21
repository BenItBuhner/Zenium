import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import type { CredentialLeakWarning, HttpAuthPrompt, UIState } from '@shared/types'
import { run } from '../api'
import {
  LEAK_HOLD_MS,
  LEAK_WARNING_BODY,
  LEAK_WARNING_TITLE,
  closeLeakWarning,
  currentLeakWarning,
  openLeakWarning,
  respondToLeak,
  savePromptHold
} from '../credentialLeak'
import { chromeNeedsKeyboard, overlayCoversContent, panelAloneOverContent, uiStore } from '../ui'

const warning = (patch: Partial<CredentialLeakWarning> = {}): CredentialLeakWarning => ({
  id: 'leak-1',
  tabId: 't1',
  origin: 'https://shop.example',
  site: 'shop.example',
  username: 'ada@example.com',
  breachCount: 3,
  credentialId: 'c1',
  private: false,
  ...patch
})

function state(patch: Partial<UIState> = {}): UIState {
  return {
    tabs: { t1: { id: 't1', url: 'https://shop.example/account' } },
    spaces: [{ id: 's1', activeTabId: 't1', tabIds: ['t1', 't2'] }],
    activeSpaceId: 's1',
    securityPrompts: [],
    permissionPrompts: [],
    passwords: { leaks: [warning()] },
    ...patch
  } as unknown as UIState
}

afterEach(() => {
  closeLeakWarning()
  vi.mocked(run).mockClear()
  vi.unstubAllGlobals()
})

describe('the words', () => {
  it('are Chrome’s, the title in sentence case and Zenium where the manager’s name stands', () => {
    expect(LEAK_WARNING_TITLE).toBe('Change your password')
    expect(LEAK_WARNING_BODY).toBe(
      'The password you just used was found in a data breach. Zenium recommends changing it now.'
    )
  })
})

describe('currentLeakWarning', () => {
  it('is the active tab’s warning, and nothing for another tab’s or with no leaks', () => {
    expect(currentLeakWarning(state())?.id).toBe('leak-1')
    expect(
      currentLeakWarning(state({ passwords: { leaks: [warning({ tabId: 't2' })] } } as never))
    ).toBeNull()
    expect(currentLeakWarning(state({ passwords: { leaks: [] } } as never))).toBeNull()
    expect(currentLeakWarning(state({ passwords: undefined } as never))).toBeNull()
  })

  it('yields to a security prompt on the same tab: the page is stuck on that request', () => {
    const auth = {
      kind: 'httpAuth',
      id: 'a1',
      tabId: 't1',
      url: 'https://shop.example/',
      host: 'shop.example',
      realm: null,
      isProxy: false,
      failedBefore: false
    } as unknown as HttpAuthPrompt
    expect(currentLeakWarning(state({ securityPrompts: [auth] }))).toBeNull()
    // Another tab's prompt does not stand in the way.
    expect(currentLeakWarning(state({ securityPrompts: [{ ...auth, tabId: 't2' }] }))?.id).toBe(
      'leak-1'
    )
  })
})

describe('savePromptHold: the phone save sheet waits for the warning, Chrome’s order', () => {
  it('holds for a warning up on its tab, and for the tab’s check while it runs', () => {
    expect(savePromptHold(state(), 't1')).toBe('warning')
    expect(
      savePromptHold(state({ passwords: { leaks: [], leakChecks: ['t1'] } } as never), 't1')
    ).toBe('check')
    // The warning outranks the check when a stale entry lists both.
    expect(
      savePromptHold(
        state({ passwords: { leaks: [warning()], leakChecks: ['t1'] } } as never),
        't1'
      )
    ).toBe('warning')
  })

  it('holds for nothing on another tab, with no tab, with no check and with no passwords state', () => {
    expect(
      savePromptHold(state({ passwords: { leaks: [], leakChecks: ['t2'] } } as never), 't1')
    ).toBeNull()
    expect(savePromptHold(state(), 't2')).toBeNull()
    expect(savePromptHold(state(), null)).toBeNull()
    expect(
      savePromptHold(state({ passwords: { leaks: [], leakChecks: [] } } as never), 't1')
    ).toBeNull()
    // A state from before the field existed.
    expect(savePromptHold(state({ passwords: { leaks: [] } } as never), 't1')).toBeNull()
    expect(savePromptHold(state({ passwords: undefined } as never), 't1')).toBeNull()
  })

  it('bounds the hold: a lookup is one range request, so three seconds is more than any network worth waiting for', () => {
    expect(LEAK_HOLD_MS).toBe(3000)
  })
})

describe('openLeakWarning / closeLeakWarning', () => {
  it('hides the page behind its picture once the capture is in, takes the keyboard, and gives both back on close', async () => {
    vi.stubGlobal('window', { zen: { invoke: async () => null } })
    expect(uiStore.get().credentialLeakOpen).toBe(false)
    expect(overlayCoversContent(uiStore.get())).toBe(false)

    await openLeakWarning('t1')
    expect(uiStore.get().credentialLeakOpen).toBe(true)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    // The warning is what dims the page and the one thing over it (its scrim is the host's).
    expect(overlayCoversContent(uiStore.get())).toBe(true)
    expect(panelAloneOverContent(uiStore.get())).toBe(true)
    expect(chromeNeedsKeyboard()).toBe(true)

    vi.mocked(run).mockClear()
    closeLeakWarning()
    expect(uiStore.get().credentialLeakOpen).toBe(false)
    expect(overlayCoversContent(uiStore.get())).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('a close overtakes an open still waiting for the picture', async () => {
    vi.stubGlobal('window', { zen: { invoke: async () => null } })
    const opening = openLeakWarning('t1')
    closeLeakWarning()
    await opening
    expect(uiStore.get().credentialLeakOpen).toBe(false)
  })
})

describe('respondToLeak', () => {
  it('answers the core with the warning’s id and the action', () => {
    respondToLeak('leak-1', 'changePassword')
    expect(run).toHaveBeenCalledWith('passwords.leakRespond', {
      id: 'leak-1',
      action: 'changePassword'
    })
    respondToLeak('leak-1', 'dismiss')
    expect(run).toHaveBeenLastCalledWith('passwords.leakRespond', {
      id: 'leak-1',
      action: 'dismiss'
    })
  })
})
