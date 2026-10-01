import type { CommandDescriptor, ShortcutAction } from '../types'

/**
 * One id per act (spec §9 item 10; the D7 proposal's `acts.ts`). The string table is keyed by
 * these and nothing else, so a surface cannot invent a word: each family module is declared
 * `satisfies Partial<Record<ActId, Entry>>`, which rejects a key that names no act, and
 * `index.ts` merges the families into one table whose key type is the acts it holds so far.
 *
 * The ids are the `ShortcutAction`s the four action tables share (`shortcuts.ts`,
 * `commands.ts`, `menuBar.ts`, the app menu), the palette's own acts beyond them, and the acts
 * only a menu row performs. Each family PR (§D) adds the menu-only ids its rows need here.
 */

/** The URL-bar palette's acts that no shortcut names (`CommandDescriptor['action']`). */
export type PaletteAct = Exclude<CommandDescriptor['action'], ShortcutAction>

/**
 * Acts a menu row performs that neither a shortcut nor a palette row names. Named after the
 * `ShortcutAction` ids (`family.verb`), one id per act, never per surface.
 */
export type MenuAct =
  /** Copy a link's or an entry row's address (Q1: "Copy Link Address"; the page's own is `tab.copyUrl`). */
  | 'link.copyAddress'
  /** The tab menu's "Add Tab to New Folder" / "… Group" (P-11, the noun axis). */
  | 'folder.addTabToNew'
  /** "Edit Folder…" / "Edit group" (P-11; §B). */
  | 'folder.edit'
  /** The history row's "Remove from History" – one visit (P-19). */
  | 'history.removeVisit'
  /** Every visit of a page (P-19, Q6: "Remove Page from History"). */
  | 'history.deleteUrls'
  /** Share the page – the OS chooser follows (P-5). */
  | 'share.open'
  /** Send the tab to another device (P-38). */
  | 'sendTab.open'
  /**
   * The strip's direction rows (P-34, `menuBar.ts`'s `tabDirectionLabels`): a new tab after this
   * one, close the tabs after it, close the tabs before it – worded by the strip's orientation.
   */
  | 'tab.newAfter'
  | 'tab.closeAfter'
  | 'tab.closeBefore'

/** Every act the string table may name. */
export type ActId = ShortcutAction | PaletteAct | MenuAct
