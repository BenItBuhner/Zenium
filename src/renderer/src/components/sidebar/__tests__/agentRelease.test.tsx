// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AwayAgentInfo, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * "Release <agent>'s tabs?" (components/sidebar/AgentReleaseDialog.tsx, lib/agentRelease.ts):
 * the folder menu's Release from <agent>… asks through `requestAgentRelease`, only while the
 * agent is away; the plain verb runs `agent.release`, and the question goes by itself when the
 * agent comes back first.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: async () => null,
  onEvent: () => () => undefined
}))

const { FrameDialogHost } = await import('@renderer/lib/portals')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { agentReleaseWords, requestAgentRelease } = await import('@renderer/lib/agentRelease')
const { AgentReleaseDialog } = await import('../AgentReleaseDialog')

const AWAY: AwayAgentInfo = {
  claimId: 'claim-1',
  name: 'Invoice reconciliation',
  color: '#3b82f6',
  groupIds: ['g'],
  tabIds: ['a', 'b'],
  lastSeenAt: 1
}

function state(awayAgents: AwayAgentInfo[]): UIState {
  return {
    platform: 'linux',
    tabs: {},
    spaces: [
      {
        id: 's',
        name: 'Work',
        containerId: DEFAULT_CONTAINER_ID,
        tabIds: [],
        activeTabId: null,
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 's',
    folders: {},
    essentialTabIds: [],
    settings: {},
    awayAgents,
    window: { kind: 'normal', fullscreen: false }
  } as unknown as UIState
}

function Dialogs(): JSX.Element {
  const s = browserStore.use((b) => b.state)
  const request = uiStore.use((u) => u.agentReleaseConfirm)
  return (
    <FrameDialogHost frame>
      {s && request && <AgentReleaseDialog key={request.claimId} state={s} request={request} />}
    </FrameDialogHost>
  )
}

let container: HTMLDivElement
let root: Root

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="alertdialog"]:not([data-leaving])')

beforeEach(() => {
  run.mockClear()
  uiStore.set({ agentReleaseConfirm: null, snapshot: null, snapshotTabId: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  uiStore.set({ agentReleaseConfirm: null })
  browserStore.set({ state: null })
})

describe('agentReleaseWords', () => {
  it('names the agent and says the tabs stay', () => {
    expect(agentReleaseWords('Invoice reconciliation', 2, 5)).toEqual({
      title: 'Release Invoice reconciliation’s tabs?',
      detail: 'Its 2 groups and 5 tabs stay open, but the agent cannot resume them.'
    })
    expect(agentReleaseWords('PR review', 1, 1).detail).toBe(
      'Its 1 group and 1 tab stay open, but the agent cannot resume them.'
    )
  })
})

describe('the "Release <agent>\'s tabs?" prompt', () => {
  it('asks only for an away agent, and its plain Release runs agent.release', async () => {
    browserStore.set({ state: state([]) })
    requestAgentRelease('claim-1', 'g', false)
    expect(uiStore.get().agentReleaseConfirm).toBeNull()

    browserStore.set({ state: state([AWAY]) })
    act(() => root.render(<Dialogs />))
    requestAgentRelease('claim-1', 'g', false)
    await settle()
    expect(uiStore.get().agentReleaseConfirm).toEqual({
      claimId: 'claim-1',
      folderId: 'g',
      keyboard: false
    })
    const d = dialog()!
    expect(d.dataset.agentRelease).toBe('claim-1')
    expect(d.querySelector('.zen-v2-title-block-title')!.textContent).toBe(
      'Release Invoice reconciliation’s tabs?'
    )
    expect(d.querySelector('.zen-v2-title-block-description')!.textContent).toBe(
      'Its 1 group and 2 tabs stay open, but the agent cannot resume them.'
    )
    const confirm = d.querySelector<HTMLButtonElement>('button[data-action="confirm"]')!
    expect(confirm.textContent).toBe('Release')
    expect(confirm.hasAttribute('data-danger')).toBe(false)
    act(() => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(run).toHaveBeenCalledWith('agent.release', { claimId: 'claim-1' })
    expect(uiStore.get().agentReleaseConfirm).toBeNull()
  })

  it('goes by itself when the agent comes back first', async () => {
    browserStore.set({ state: state([AWAY]) })
    act(() => root.render(<Dialogs />))
    requestAgentRelease('claim-1', 'g', false)
    await settle()
    expect(dialog()).not.toBeNull()
    act(() => browserStore.set({ state: state([]) }))
    await settle()
    expect(uiStore.get().agentReleaseConfirm).toBeNull()
    expect(run).not.toHaveBeenCalledWith('agent.release', expect.anything())
  })
})
