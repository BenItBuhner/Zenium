import type { ActId } from './acts'
import type { Entry } from './index'

/**
 * The app menu's family (the D7 proposal §D, PR-2b): the acts only the ⋯ menu's rows perform –
 * `Menus.showAppMenu` on the sidebar layouts and the phone – and the rows of the page that open
 * a settings page (§A's P-36: a destination, not an ask, so no ellipsis). The rows the app menu
 * shares with the key table, the palette and the mac menu bar read `actions.ts`'s entry
 * (`tab.search`, `page.fullscreen`, `translate.open`, `addons.open`, `settings.open`, …): one
 * entry per act, so the four tables and the menu cannot part again (P-6, P-10, P-22, P-33).
 *
 * The private session's rows are the touch hosts' (Android keeps private browsing in tabs);
 * the private window's counted verb is Firefox's, "Close Private Window" for one and "Close 2
 * Private Windows" for more (profiles-25). The Help menu's report form asks (Google's Safe
 * Browsing form takes the address and more), so its row carries the ellipsis, as Chrome's does.
 */
export const APP_MENU = {
  // --- The private session (hosts without private windows) ----------------------------------
  'tab.newPrivate': { menu: 'New Private Tab' },
  'tab.closePrivate': { menu: 'Close Private Tabs' },
  'window.closePrivate': {
    menu: 'Close Private Window',
    count: { one: 'Close Private Window', other: 'Close {n} Private Windows' }
  },

  // --- The page's reader and speech -----------------------------------------------------------
  'reader.textPreferences': { menu: 'Text Preferences', ask: true },
  'readAloud.start': { menu: 'Listen to This Page' },

  // --- Help -----------------------------------------------------------------------------------
  'help.reportUnsafeSite': { menu: 'Report an Unsafe Site', ask: true },

  // --- Rows that open a settings page (P-36) --------------------------------------------------
  'newTab.customise': { menu: 'Customise New Tab Page' },
  'languages.open': { menu: 'Language Settings' },
  // Not P-36's: the pinned control's row opens the Customise Toolbar dialog, not a settings
  // page, so the dialog rule keeps its ellipsis (the Design Lead's ruling on #784).
  'toolbar.customise': { menu: 'Customise Toolbar', ask: true }
} satisfies Partial<Record<ActId, Entry>>
