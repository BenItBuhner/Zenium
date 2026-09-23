import type { WindowPrompt, WindowPromptDownloads } from '@shared/types'

/**
 * The words of a window prompt (v2 draft §9.23): the two questions the core may ask at once –
 * the tabs that close ("Close N tabs?", "Quit Zenium?") and the downloads the answer would end
 * (downloads-35) – as one prompt. Both are the title block's. With the tabs warning the download
 * sentence is a second description paragraph under the warning's, at the description's own size
 * and ink: §9.23's body copy introduces other content, and the sentence introduces nothing – the
 * checkbox is the tabs warning's. Alone, the sentence is the block's one description.
 */
export interface WindowPromptText {
  title: string
  /** The title block's description. */
  description: string
  /**
   * The download sentence as the title block's second description paragraph, when the first is
   * the tabs warning's; null with no download, or when the sentence is the description itself.
   */
  downloadDescription: string | null
  /** The primary button. */
  verb: string
  /** Whether the "Warn before closing a window with multiple tabs" checkbox belongs. */
  tabsWarning: boolean
}

/** Chrome's sentence, the plural form for several; what "and …" names is what ends them. */
export function downloadsSentence(downloads: WindowPromptDownloads): string {
  const end = downloads.end === 'quit' ? 'exit Zenium' : 'close the private window'
  return downloads.count === 1
    ? `A download is currently in progress. Do you want to cancel the download and ${end}?`
    : `${downloads.count} downloads are currently in progress. Do you want to cancel the downloads and ${end}?`
}

export function windowPromptText(prompt: WindowPrompt): WindowPromptText {
  const quit = prompt.kind === 'quit'
  const tabsWarning = prompt.count > 1
  const tabs = `${prompt.count} tabs`
  const downloads = prompt.downloads
  if (tabsWarning) {
    // The prompt as it was, the download sentence a second paragraph under its description.
    return {
      title: quit ? 'Quit Zenium?' : `Close ${tabs}?`,
      description: quit
        ? `You are about to quit with ${tabs} open.`
        : `You are about to close this window and its ${tabs}.`,
      downloadDescription: downloads ? downloadsSentence(downloads) : null,
      verb: quit ? 'Quit' : 'Close tabs',
      tabsWarning
    }
  }
  // The downloads alone: a window whose close quits (the last one, off macOS) says so.
  const quitting = quit || downloads?.end === 'quit'
  return {
    title: quitting ? 'Quit Zenium?' : 'Close private window?',
    description: downloads ? downloadsSentence(downloads) : '',
    downloadDescription: null,
    verb: quitting ? 'Quit' : 'Close window',
    tabsWarning
  }
}
