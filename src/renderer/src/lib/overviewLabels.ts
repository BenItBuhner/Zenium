/**
 * What TalkBack hears in the phone's tab overview (A11Y-01). A card is a `role="button"` – ARIA
 * gives `aria-posinset` / `aria-setsize` to list items, options and tabs, not to buttons, and a
 * grid of cards that switch, close and drag is no listbox – so a card's place is composed into
 * its name, the way Chrome's grid switcher speaks its cards: the title, then "tab 2 of 7" over
 * the pane's tabs in the order the grid shows them (essentials, pinned, the groups' members, the
 * loose cards), then "current" for the tab on show, then "sleeping" for a discarded tab (#234's
 * state, one word in the same sentence). Its close button names the tab it closes: it sits beside
 * the card's button, not inside it, since this WebView drops a button nested in a button from its
 * tree (run 1 of the device driver), and TalkBack reads it on its own with nothing of the card
 * around it.
 */
export function tabCardLabel(
  title: string,
  position: number,
  count: number,
  current = false,
  sleeping = false
): string {
  const parts = [title, `tab ${position} of ${count}`]
  if (current) parts.push('current')
  if (sleeping) parts.push('sleeping')
  return parts.join(', ')
}

export function closeTabLabel(title: string): string {
  return `Close ${title}`
}

/**
 * A group card's header, the button that folds and unfolds it: the group's name, that it is a
 * group, and how many tabs it holds ("Research, tab group, 3 tabs"); `aria-expanded` on the
 * element says whether it is open. A group with no name is "Tab group".
 */
export function groupCardLabel(name: string, count: number): string {
  const head = name.trim() ? `${name.trim()}, tab group` : 'Tab group'
  return `${head}, ${count} tab${count === 1 ? '' : 's'}`
}
