import type { JSX } from 'react'
import { useEffect } from 'react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { agentReleaseWords } from '@renderer/lib/agentRelease'
import { closeAgentReleaseConfirm, type UiState } from '@renderer/lib/ui'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'

/**
 * "Release <agent>'s tabs?" (the folder menu's Release from <agent>…): the §9.23 confirmation
 * over the page, as "Delete <folder>?" is. The verb is the plain second secondary (`verbTone`):
 * nothing of the user's goes – the groups and their tabs stay open – only the agent's hold on
 * them. The question goes by itself when the agent comes back or is released meanwhile. A
 * keyboard's Cancel hands the keyboard back to the folder's header, as the delete prompt does.
 */
export function AgentReleaseDialog({
  state,
  request
}: {
  state: UIState
  request: NonNullable<UiState['agentReleaseConfirm']>
}): JSX.Element | null {
  const agent = state.awayAgents.find((a) => a.claimId === request.claimId)
  useEffect(() => {
    if (!agent) closeAgentReleaseConfirm(request.keyboard)
  }, [agent, request.keyboard])
  if (!agent) return null
  const words = agentReleaseWords(agent.name, agent.groupIds.length, agent.tabIds.length)
  return (
    <ConfirmDialog
      name="agent-release"
      title={words.title}
      description={words.detail}
      action="Release"
      verbTone="plain"
      onCancel={() => {
        closeAgentReleaseConfirm(request.keyboard)
      }}
      onConfirm={() => {
        closeAgentReleaseConfirm(request.keyboard)
        run('agent.release', { claimId: agent.claimId })
      }}
      returnFocus={() =>
        request.keyboard
          ? document.querySelector<HTMLElement>(`[data-tab-folder="${request.folderId}"]`)
          : false
      }
      data={{ 'data-agent-release': agent.claimId }}
    />
  )
}
