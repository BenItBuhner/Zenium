// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  DEFAULT_CONTAINER_ID,
  type PermissionPrompt,
  type Space,
  type Tab,
  type UIState
} from '@shared/types'

const cmd = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
const run = vi.fn<(name: string, args?: unknown) => void>()
vi.mock('@renderer/lib/api', () => ({
  cmd: (name: string, args?: unknown) => cmd(name, args),
  run: (name: string, args?: unknown) => run(name, args),
  onEvent: vi.fn(() => () => undefined)
}))

import { closeAllPopovers } from '@renderer/lib/portals'
import { openQuietPrompt } from '@renderer/lib/security'
import { uiStore } from '@renderer/lib/ui'
import { PermissionPrompts } from '../PermissionPromptBubble'

/*
 * The desktop's permission prompt bubble (§9.20, §9.22) and the quiet notification request's
 * form of it (NOT-03 / omnibox-38): a loud prompt shows in its turn under the pill's site chip,
 * a notice that takes no focus; a quiet one shows nothing until the pill's bell is pressed for
 * it (`quietPromptId`), then the same 400 bubble titled "Notifications blocked" under the
 * crossed-out bell, Keep blocking and Allow, focus on its first button – a surface the user
 * opened. Escape or an outside press puts it away and is no answer: the flag clears, the core
 * hears nothing, the bell stays. A loud prompt behind a quiet one is not held up.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null
let chip: HTMLButtonElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

/** The pill's site chip, standing in for the address pill: the bubble's anchor. */
function placeChip(): HTMLButtonElement {
  const el = document.createElement('button')
  el.setAttribute('data-pill-chip', '')
  el.setAttribute('data-site-chip', '')
  el.getBoundingClientRect = () =>
    ({ x: 20, y: 8, left: 20, top: 8, width: 24, height: 24, right: 44, bottom: 32 }) as DOMRect
  document.body.appendChild(el)
  return el
}

const page: Tab = {
  id: 't1',
  url: 'https://news.example/latest',
  containerId: DEFAULT_CONTAINER_ID,
  title: 'Latest',
  favicon: null,
  loading: false,
  blockedCount: 0
} as unknown as Tab

const space: Space = {
  id: 'space',
  name: 'Work',
  icon: '',
  containerId: DEFAULT_CONTAINER_ID,
  theme: null,
  tabIds: ['t1'],
  activeTabId: 't1',
  pinnedCollapsed: false
}

const quietAsk: PermissionPrompt = {
  id: 'perm-q1',
  tabId: 't1',
  origin: 'https://news.example',
  permission: 'notifications',
  message: 'Notifications blocked',
  detail: 'You usually block notifications. To let news.example notify you, choose Allow.',
  allowLabel: 'Allow',
  blockLabel: 'Keep blocking',
  allowOnce: false,
  requestedAt: 1,
  quiet: true
}

const loudAsk: PermissionPrompt = {
  id: 'perm-p2',
  tabId: 't1',
  origin: 'https://news.example',
  permission: 'camera',
  message: 'Allow news.example to use your camera?',
  detail: 'Zenium remembers your choice for this site.',
  allowLabel: 'Allow',
  blockLabel: 'Block',
  allowOnce: true,
  requestedAt: 2
}

function state(prompts: PermissionPrompt[]): UIState {
  return {
    platform: 'linux',
    capabilities: {},
    tabs: { t1: page },
    spaces: [space],
    activeSpaceId: 'space',
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    settings: {},
    permissionPrompts: prompts,
    securityPrompts: []
  } as unknown as UIState
}

const bubble = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="permission-prompt"]')

const buttons = (el: HTMLElement): string[] =>
  Array.from(el.querySelectorAll<HTMLButtonElement>('button')).map((b) => b.textContent ?? '')

/** The snapshot's wait and the popover's first paint settled. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const escape = (): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
}

/**
 * The bubble's leave, drawn: the collapse ends on its transition (dispatched here, as no
 * compositor runs) and the spring on its frames, each under `act` so React draws the removal.
 */
async function leave(): Promise<void> {
  const el = bubble()
  if (el?.hasAttribute('data-collapsing')) {
    act(() => {
      el.dispatchEvent(new Event('transitionend'))
    })
  }
  for (let i = 0; i < 40 && bubble(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
  }
  expect(bubble()).toBeNull()
}

beforeEach(() => {
  cmd.mockClear()
  run.mockReset()
  uiStore.set({ quietPromptId: null, permissionPromptOpen: false })
  chip = placeChip()
})

afterEach(async () => {
  act(() => root?.unmount())
  mount?.remove()
  chip?.remove()
  root = null
  mount = null
  chip = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  uiStore.set({ quietPromptId: null, permissionPromptOpen: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('the desktop permission prompt bubble', () => {
  it('shows a loud prompt in its turn as a notice under the chip: no focus taken, no quiet mark', async () => {
    render(<PermissionPrompts state={state([loudAsk])} />)
    await settle()
    const dialog = bubble()!
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('data-permission')).toBe('camera')
    expect(dialog.hasAttribute('data-chip')).toBe(true)
    expect(dialog.hasAttribute('data-quiet')).toBe(false)
    expect(dialog.style.width).toBe('400px')
    expect(dialog.querySelector('h2')?.textContent).toBe('Allow news.example to use your camera?')
    expect(buttons(dialog)).toEqual(['Block', 'Allow once', 'Allow'])
    // A notice a page event raised: the keyboard stays where it was.
    expect(dialog.contains(document.activeElement)).toBe(false)
    expect(uiStore.get().permissionPromptOpen).toBe(true)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
  })

  describe('the quiet notification request (NOT-03)', () => {
    it('shows nothing of its own: the bell in the pill is its only sign until pressed', async () => {
      render(<PermissionPrompts state={state([quietAsk])} />)
      await settle()
      expect(bubble()).toBeNull()
      expect(uiStore.get().permissionPromptOpen).toBe(false)
      expect(run).not.toHaveBeenCalled()
    })

    it('opens from the bell as the same bubble – "Notifications blocked" under the crossed-out bell, Keep blocking and Allow – with focus on its first button', async () => {
      render(<PermissionPrompts state={state([quietAsk])} />)
      await settle()
      act(() => openQuietPrompt('perm-q1'))
      await settle()
      const dialog = bubble()!
      expect(dialog).not.toBeNull()
      expect(dialog.getAttribute('data-quiet')).toBe('true')
      expect(dialog.getAttribute('data-permission')).toBe('notifications')
      expect(dialog.hasAttribute('data-chip')).toBe(true)
      expect(dialog.style.width).toBe('400px')
      expect(dialog.getAttribute('aria-labelledby')).toBe('permission-prompt-perm-q1')
      expect(dialog.querySelector('#permission-prompt-perm-q1')?.textContent).toBe(
        'Notifications blocked'
      )
      expect(dialog.querySelector('svg.lucide-bell-off')).not.toBeNull()
      expect(dialog.querySelector('svg.lucide-bell')).toBeNull()
      expect(dialog.textContent).toContain(
        'You usually block notifications. To let news.example notify you, choose Allow.'
      )
      // No Allow once: a notification permission is the site's standing right or nothing.
      expect(buttons(dialog)).toEqual(['Keep blocking', 'Allow'])
      // A surface the user opened (§9.22): the keyboard lands on its first button.
      expect(document.activeElement?.textContent).toBe('Keep blocking')
      expect(uiStore.get().permissionPromptOpen).toBe(true)
    })

    it('is put away by Escape without a word: the flag clears, the core hears nothing, the keyboard goes back to the bell', async () => {
      render(<PermissionPrompts state={state([quietAsk])} />)
      await settle()
      act(() => openQuietPrompt('perm-q1'))
      await settle()
      expect(bubble()).not.toBeNull()
      run.mockClear()
      act(() => escape())
      // The bell's flag is down at once; the bubble folds back into the chip and leaves.
      expect(uiStore.get().quietPromptId).toBeNull()
      await leave()
      expect(run).not.toHaveBeenCalledWith('permissions.respond', expect.anything())
      // The keyboard went to the bell it hung from, not the page (§9.22).
      expect(document.activeElement).toBe(chip)
      expect(run).not.toHaveBeenCalledWith('focus.content', undefined)
      expect(uiStore.get().permissionPromptOpen).toBe(false)
    })

    it('answers Allow and Keep blocking as any prompt does', async () => {
      render(<PermissionPrompts state={state([quietAsk])} />)
      await settle()
      act(() => openQuietPrompt('perm-q1'))
      await settle()
      const dialog = bubble()!
      const allow = Array.from(dialog.querySelectorAll('button')).find(
        (b) => b.textContent === 'Allow'
      )!
      act(() => allow.click())
      expect(run).toHaveBeenCalledWith('permissions.respond', { id: 'perm-q1', answer: 'allow' })
      // The core answered: the prompt leaves the queue, and the bell's flag with it.
      act(() => root!.render(<PermissionPrompts state={state([])} />))
      await leave()
      expect(uiStore.get().quietPromptId).toBeNull()
    })

    it('does not hold up a loud prompt behind it, and shows once the loud one is answered', async () => {
      render(<PermissionPrompts state={state([quietAsk, loudAsk])} />)
      await settle()
      const dialog = bubble()!
      expect(dialog.getAttribute('data-permission')).toBe('camera')
      expect(dialog.hasAttribute('data-quiet')).toBe(false)
      // The loud one answered and gone: the quiet one still waits for the bell.
      act(() => root!.render(<PermissionPrompts state={state([quietAsk])} />))
      await leave()
      act(() => openQuietPrompt('perm-q1'))
      await settle()
      expect(bubble()?.getAttribute('data-quiet')).toBe('true')
    })

    it('leaves with the flag when the page withdraws the request while the bubble is up', async () => {
      render(<PermissionPrompts state={state([quietAsk])} />)
      await settle()
      act(() => openQuietPrompt('perm-q1'))
      await settle()
      expect(bubble()).not.toBeNull()
      act(() => root!.render(<PermissionPrompts state={state([])} />))
      await leave()
      expect(uiStore.get().quietPromptId).toBeNull()
      expect(run).not.toHaveBeenCalledWith('permissions.respond', expect.anything())
    })
  })
})
