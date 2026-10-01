import type { AwayAgentInfo } from '@shared/types'
import { openedFromKeyboard } from './popover'
import { activeTab } from './selectors'
import { browserStore, openAgentReleaseConfirm } from './ui'

/*
 * Releasing a disconnected agent's tab groups: the folder menu's "Release from <agent>…" (the
 * core's `agent.confirmRelease`) and Settings › AI Agents › Disconnected agents. Both ask the
 * same question before `agent.release` runs.
 */

/** The question and its one line: what stays (everything) and what the agent loses. */
export function agentReleaseWords(
  name: string,
  groups: number,
  tabs: number
): { title: string; detail: string } {
  const g = `${groups} group${groups === 1 ? '' : 's'}`
  const t = `${tabs} tab${tabs === 1 ? '' : 's'}`
  return {
    title: `Release ${name}’s tabs?`,
    detail: `Its ${g} and ${t} stay open, but the agent cannot resume them.`
  }
}

/** The away agent behind `claimId`, if it is still away. */
export function awayAgent(claimId: string): AwayAgentInfo | undefined {
  return browserStore.get().state?.awayAgents.find((a) => a.claimId === claimId)
}

/** Ask before releasing; nothing when the agent came back or released meanwhile. */
export function requestAgentRelease(
  claimId: string,
  folderId: string,
  keyboard = openedFromKeyboard()
): void {
  const state = browserStore.get().state
  if (!state || !awayAgent(claimId)) return
  void openAgentReleaseConfirm(claimId, folderId, activeTab(state)?.id ?? null, keyboard)
}
