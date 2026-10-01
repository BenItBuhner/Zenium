import type { OverviewChromeCommand } from '@shared/overviewMenu'

/**
 * The tab overview's ⋯ menu rows that are the CHROME's to act on (tab overview cleanup spec
 * §4): the bar's ⋯ opens the menu through the core while the overview stands, and a picked row
 * of the overview's own state – its view, a selection, the tab search, its sheets – comes back
 * as one `overview.command` event (`useMainEvents`). The overview, while mounted, listens here;
 * a command with no overview up (the menu outlived it) is dropped, as a stale pick should be.
 */

type Handler = (command: OverviewChromeCommand) => void

const handlers = new Set<Handler>()

/** Listen for the menu's commands; returns the unsubscribe. */
export function onOverviewCommand(handler: Handler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}

/** A row was picked: every listener (the one overview) hears it. */
export function dispatchOverviewCommand(command: OverviewChromeCommand): void {
  for (const handler of [...handlers]) handler(command)
}

/** For tests: whether anything listens. */
export function overviewCommandListeners(): number {
  return handlers.size
}
