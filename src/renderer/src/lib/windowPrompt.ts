import type { WindowPrompt, WindowPromptDownloads } from '@shared/types'

/**
 * The words of a window prompt (v2 draft §9.23): the two questions the core may ask at once –
 * the tabs that close ("Close N tabs?", "Quit Zenium?") and the downloads the answer would end
 * (downloads-35) – as one prompt with ONE description. The two facts are peers, one sentence
 * each in the one paragraph, the tabs sentence first (§9.23's composed-prompt rule, the lead's
 * for #357): §9.23's body copy introduces other content, and neither sentence introduces
 * anything – the checkbox is the tabs warning's. Alone, the download sentence is the description.
 */
export interface WindowPromptText {
  title: string
  /**
   * The title block's one description: the tabs sentence, then the download sentence when both
   * are asked; the download sentence alone when nothing about the tabs is.
   */
  description: string
  /** The primary button. */
  verb: string
  /** Whether the "Confirm before closing multiple tabs" checkbox belongs. */
  tabsWarning: boolean
}

/**
 * What the answer does to the downloads, said in the verb's own word (§9.1: quit, as the button
 * and the menu say) and as it happens: quitting interrupts them – the regular ones park
 * resumable, the private session's end takes its own – and closing the last private window
 * cancels the private ones, which cannot resume. The strings live here alone, so the lead's
 * ruling on the final sentence (#357, Q3) lands as one edit.
 */
export function downloadsSentence(downloads: WindowPromptDownloads): string {
  const one = downloads.count === 1
  const state = one ? '1 download is in progress' : `${downloads.count} downloads are in progress`
  const them = one ? 'it' : 'them'
  const outcome =
    downloads.end === 'quit' ? `quitting interrupts ${them}` : `closing this window cancels ${them}`
  return `${state}; ${outcome}.`
}

export function windowPromptText(prompt: WindowPrompt): WindowPromptText {
  const quit = prompt.kind === 'quit'
  const tabsWarning = prompt.count > 1
  const tabs = `${prompt.count} tabs`
  const downloads = prompt.downloads
  if (tabsWarning) {
    // The prompt as it was; with downloads, their sentence follows the tabs' in the one paragraph.
    const tabsSentence = quit
      ? `You are about to quit with ${tabs} open.`
      : `You are about to close this window and its ${tabs}.`
    return {
      title: quit ? 'Quit Zenium?' : `Close ${tabs}?`,
      description: downloads ? `${tabsSentence} ${downloadsSentence(downloads)}` : tabsSentence,
      verb: quit ? 'Quit' : 'Close tabs',
      tabsWarning
    }
  }
  // The downloads alone: a window whose close quits (the last one, off macOS) says so.
  const quitting = quit || downloads?.end === 'quit'
  return {
    title: quitting ? 'Quit Zenium?' : 'Close private window?',
    description: downloads ? downloadsSentence(downloads) : '',
    verb: quitting ? 'Quit' : 'Close window',
    tabsWarning
  }
}
