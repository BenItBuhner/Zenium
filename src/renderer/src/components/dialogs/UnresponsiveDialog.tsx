import type { JSX } from 'react'
import { useEffect } from 'react'
import type { Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { activeTab } from '@renderer/lib/selectors'
import {
  closeUnresponsivePrompt,
  openUnresponsivePrompt,
  unresponsiveTabs,
  unresponsiveWordsFor
} from '@renderer/lib/unresponsive'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * "Page unresponsive" (tabs-45, Chrome's hung-renderer dialog): the §9.23 confirmation
 * (`ConfirmDialog`) at §9.20's 320 over the page's picture in the content frame, for the
 * window looking at a page whose renderer stopped answering – the question at 17/600, one line
 * at 15 in the deemphasised ink ("You can wait for it to become responsive or exit the page."),
 * then Wait and the danger verb "Exit page", no primary and no default key (§6, §9.22: the app
 * recommends neither answer). Wait is the way out – the primitive's `cancel`, named for what it
 * does (§9.23 as amended: nothing is cancelled when the user waits, and the phone's sheet says
 * Wait – the two hosts are one composition): the prompt goes and the host's hang monitor
 * brings it back should the page stay still, as Chrome's does. Exit page ends the renderer;
 * the page shows the crash page for a page ended for not responding (ERR-15).
 *
 * Several pages sharing the hung renderer are one prompt – "Pages unresponsive", the pages
 * named in the description, "Exit pages" – answered together, as Chrome lists them. The prompt
 * goes by itself when the page answers again (the core clears the mark on `responsive`), when
 * the pages navigate, or when they go.
 *
 * The page's view composites above the chrome, so while the prompt is up the page in front
 * gives way to its picture (`openUnresponsivePrompt`: the capture, then `unresponsivePromptOpen`
 * hides the view), and the live page comes back as the prompt leaves. The prompt opens
 * unbidden, so the keyboard's return is the primitive's default: whatever had it as the prompt
 * opened.
 */
export function UnresponsiveDialog({ state }: { state: UIState }): JSX.Element | null {
  const tabs = unresponsiveTabs(state)
  if (tabs.length === 0) return null
  const front = activeTab(state)?.id ?? tabs[0]!.id
  return <UnresponsivePrompt tabs={tabs} frontTabId={front} />
}

function UnresponsivePrompt({
  tabs,
  frontTabId
}: {
  tabs: readonly Tab[]
  frontTabId: string
}): JSX.Element {
  const tabIds = tabs.map((t) => t.id)
  const words = unresponsiveWordsFor(tabs)

  // The page in front hides under its picture while the prompt is up; a second page joining the
  // prompt (its renderer's) changes the words, not the page under it, so the cover holds.
  useEffect(() => {
    void openUnresponsivePrompt(frontTabId)
    return () => closeUnresponsivePrompt()
  }, [frontTabId])

  return (
    <ConfirmDialog
      name="unresponsive"
      title={words.title}
      description={words.description}
      action={words.action}
      cancel="Wait"
      destructive
      onCancel={() => run('tab.waitUnresponsive', { tabIds })}
      onConfirm={() => run('tab.exitUnresponsive', { tabIds })}
      data={{ 'data-unresponsive': tabIds.join(' ') }}
    />
  )
}
