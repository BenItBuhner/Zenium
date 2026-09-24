import type { Tab, UIState } from '@shared/types'
import { run } from './api'
import { activeTab, tabTitle } from './selectors'
import { captureActiveTab, invalidateSnapshot, returnFocusToPage, uiStore } from './ui'

/*
 * The "Page unresponsive" prompt's facts (tabs-45, Chrome's hung-renderer dialog): which pages
 * it names and what it says, and the page's way under it. The core marks a tab whose renderer
 * stopped answering (`Tab.unresponsive`, from the host's hang monitor – every page of the hung
 * renderer at once); the chrome of the window looking at one of them asks whether to wait or
 * exit, and lists them all, as Chrome's dialog lists the pages sharing the renderer.
 */

/**
 * How long the prompt waits for the page's picture before it shows over a blank one. The hung
 * renderer paints nothing new; the capture is the compositor's last frame of it, which is
 * exactly what the user was looking at when the page stopped.
 */
const SNAPSHOT_WAIT_MS = 250

/**
 * The pages the prompt is about, in the strip's order the state holds them: every tab marked
 * unresponsive that still has a page (a sleeping one has no renderer to be hung) – or none,
 * when this window is not looking at one of them (the tab in front, or a pane of its split
 * group): the prompt belongs to the window whose page stands still.
 */
export function unresponsiveTabs(state: UIState): Tab[] {
  const hung = Object.values(state.tabs).filter((t) => t.unresponsive === true && !t.discarded)
  if (hung.length === 0) return []
  const front = activeTab(state)
  if (!front) return []
  const looking = hung.some(
    (t) =>
      t.id === front.id || (front.splitGroupId !== null && t.splitGroupId === front.splitGroupId)
  )
  return looking ? hung : []
}

export interface UnresponsiveWords {
  title: string
  description: string
  action: string
}

/**
 * Chrome's words: one page – "Page unresponsive / You can wait for it to become responsive or
 * exit the page. / Exit page"; several – "Pages unresponsive", the pages named in the one
 * description (§9.23's composed prompt: every fact as peers in one paragraph), "Exit pages".
 * The prompt's way out is Wait, not Cancel (the primitive's `cancel`, §9.23 as amended: named
 * for what it does, since nothing is cancelled when the user waits) – the dialog's word, as the
 * verb's counterpart is the primitive's to draw.
 */
export function unresponsiveWords(titles: readonly string[]): UnresponsiveWords {
  if (titles.length <= 1)
    return {
      title: 'Page unresponsive',
      description: 'You can wait for it to become responsive or exit the page.',
      action: 'Exit page'
    }
  const named = titles.map((t) => `“${t}”`).join(', ')
  return {
    title: 'Pages unresponsive',
    description: `${named} are not responding. You can wait for them to become responsive or exit the pages.`,
    action: 'Exit pages'
  }
}

/** The prompt's words for these tabs, their titles as the rows show them. */
export function unresponsiveWordsFor(tabs: readonly Tab[]): UnresponsiveWords {
  return unresponsiveWords(tabs.map((t) => tabTitle(t)))
}

/**
 * Which open of the prompt is current: an open that finishes after a close (the page answered,
 * or was answered for, within the wait for its picture) must not hide the page under a prompt
 * that has gone.
 */
let generation = 0

/**
 * The prompt is about to show over `tabId`, the page in front: the page's view composites above
 * the chrome, so it gives way to its picture (the view hides behind the capture while
 * `unresponsivePromptOpen` stands, `overlayCoversContent`) and the chrome takes the keyboard
 * for the prompt.
 */
export async function openUnresponsivePrompt(tabId: string): Promise<void> {
  const current = ++generation
  await Promise.race([
    captureActiveTab(tabId),
    new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))
  ])
  if (current !== generation) return
  run('focus.chrome', undefined)
  uiStore.set({ unresponsivePromptOpen: true })
}

/** The prompt has left the screen: the live page comes back, and the keyboard with it. */
export function closeUnresponsivePrompt(): void {
  generation++
  if (uiStore.get().unresponsivePromptOpen) uiStore.set({ unresponsivePromptOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}
