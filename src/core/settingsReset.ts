/**
 * Settings › Reset settings › "Restore settings to their original defaults" (settings-70;
 * Chrome's `chrome://settings/reset` and its `ProfileResetter`). The row's §9.23 confirmation
 * carries Chrome's sentence with two clauses of the house's own in Chrome's register – "This
 * will reset your startup page, home page, new tab page, search engine, pinned tabs, and site
 * permissions. It will also disable all extensions and clear temporary data like cookies. Your
 * bookmarks, history, and saved passwords will not be cleared." – and the reset does what the
 * sentence says and nothing else, each clause a step through the core's existing service:
 *
 * - the startup pages → the default `startup` model (`updateSettings`, #525);
 * - the home page → the new tab page (`DEFAULT_HOMEPAGE`; Chrome's `ResetHomepage`, which its
 *   sentence does not name – the clause is the W7-6 round's);
 * - the new tab page → its defaults (`NewTabService.reset`, the Reset new tab page row's act);
 * - the search engine → the shipped default, the user's own engines kept as Chrome's
 *   `RepairPrepopulatedSearchEngines` keeps them; the EEA's choice record goes with it
 *   (`searchChoice: null`, Chrome's `WipeSearchEngineChoicePrefs`), so the choice screen is
 *   owed again – at the next run, as Chrome shows it at the next startup, not over the
 *   Settings page the reset was asked from (`searchChoiceSession.skipped`);
 * - the pinned tabs → regular tabs (`TabManager.togglePin`); Zen's Essentials are not Chrome's
 *   pinned tabs and stay;
 * - the site permissions → every per-site decision, every device grant and the per-type
 *   defaults chosen in Settings › Site settings go (`PermissionService.reset`, the whole of
 *   Chrome's `ResetContentSettings` – its exceptions and its defaults both; the root's ruling
 *   on #553). Clear browsing data's "Site settings" kind clears the exceptions alone
 *   (`resetSites`), as Chrome's does; the reset is the wider act;
 * - the extensions → disabled, every enabled one (`ExtensionHost.setEnabled`), installed still;
 * - the temporary data → cookies, site data and the cache of every container
 *   (`PrivacyService.clearBrowsingData('all', ['cookies', 'cache'])`, Chrome's
 *   `ResetCookiesAndSiteData`).
 *
 * Bookmarks, history, saved passwords, autofill and downloads are not touched. Chrome's
 * resetter also puts back the languages, which its sentence does not name; they are left as
 * they are by design (the #553 lead check). The act done, the chrome says so in one toast
 * ("Settings reset", §9.33, no action), since the page under the prompt shows nothing of what
 * moved.
 *
 * `planSettingsReset` is the pure reading of the state – what each step will do, in the
 * sentence's order – and `resetSettings` runs the plan over the services; a test reads the
 * plan for a state and the services for the run.
 */
import type {
  BrowsingDataType,
  ExtensionInfo,
  PermissionRule,
  Settings,
  Tab
} from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/defaults'
import { DEFAULT_HOMEPAGE } from '../shared/homepage'
import type { Browser } from './browser'
import { isEeaRegion } from './searchChoice'
import type { ZenWindow } from './window'

/** What the reset clears of the engine's data: Chrome's `ResetCookiesAndSiteData`. */
export const SETTINGS_RESET_DATA: readonly BrowsingDataType[] = ['cookies', 'cache']

/** The chrome's one word once the reset has run (§9.33: a plain toast, no action). */
export const SETTINGS_RESET_TOAST = 'Settings reset'

/** One clause of the dialog's sentence, as the state makes it concrete. */
export type SettingsResetStep =
  /** The startup pages back to the default model. */
  | { kind: 'startup'; patch: Pick<Settings, 'startup'> }
  /** The home page back to the new tab page. */
  | { kind: 'homepage'; patch: Pick<Settings, 'homepage'> }
  /** The new tab page back to its defaults (whether a new tab opens it at all stays). */
  | { kind: 'newTab' }
  /**
   * The default search engine back to the shipped one, the choice record cleared; `reAsk` when
   * the device is in the EEA, where clearing the record owes the choice screen again.
   */
  | {
      kind: 'searchEngine'
      patch: Pick<Settings, 'searchEngineId' | 'searchChoice'>
      reAsk: boolean
    }
  /** The pinned tabs (not the Essentials) that become regular tabs. */
  | { kind: 'unpin'; tabIds: string[] }
  /**
   * Every per-site decision, every device grant and the per-type defaults go; `origins` lists
   * the sites that held an answer – the plan's evidence of what stood, not the run's bound.
   */
  | { kind: 'sitePermissions'; origins: string[] }
  /** The enabled extensions that are disabled. */
  | { kind: 'disableExtensions'; ids: string[] }
  /** The engine data cleared, every range. */
  | { kind: 'clearData'; types: readonly BrowsingDataType[] }

/** What the plan reads: the settings the sentence names, the tabs, the site rules, the extensions, the region. */
export interface SettingsResetTerms {
  settings: Pick<Settings, 'startup' | 'homepage' | 'searchEngineId' | 'searchChoice'>
  tabs: ReadonlyArray<Pick<Tab, 'id' | 'pinned' | 'essential'>>
  /** Every remembered per-site answer (`PermissionService.rules`). */
  rules: ReadonlyArray<Pick<PermissionRule, 'origin'>>
  extensions: ReadonlyArray<Pick<ExtensionInfo, 'id' | 'enabled'>>
  /** The device's region is the EEA's (`UIState.searchChoice.eea`). */
  eea: boolean
}

/**
 * The reset as steps, in the order the sentence names them: always the eight, each saying what
 * it does to this state – a step with nothing of its own to do (no pinned tab, no site with an
 * answer, no enabled extension) still stands, empty, so a reader of the plan sees every clause
 * answered.
 */
export function planSettingsReset(terms: SettingsResetTerms): SettingsResetStep[] {
  return [
    { kind: 'startup', patch: { startup: structuredClone(DEFAULT_SETTINGS.startup) } },
    { kind: 'homepage', patch: { homepage: { ...DEFAULT_HOMEPAGE } } },
    { kind: 'newTab' },
    {
      kind: 'searchEngine',
      patch: { searchEngineId: DEFAULT_SETTINGS.searchEngineId, searchChoice: null },
      reAsk: terms.eea
    },
    {
      kind: 'unpin',
      tabIds: terms.tabs.filter((tab) => tab.pinned && !tab.essential).map((tab) => tab.id)
    },
    {
      kind: 'sitePermissions',
      origins: [...new Set(terms.rules.map((rule) => rule.origin))].sort()
    },
    {
      kind: 'disableExtensions',
      ids: terms.extensions.filter((ext) => ext.enabled).map((ext) => ext.id)
    },
    { kind: 'clearData', types: SETTINGS_RESET_DATA }
  ]
}

/** The plan for the browser as it stands. */
export function settingsResetPlan(browser: Browser): SettingsResetStep[] {
  const state = browser.state
  return planSettingsReset({
    settings: state.settings,
    tabs: Object.values(state.model.tabs),
    rules: browser.permissions.rules(),
    extensions: browser.extensions.list(),
    eea: isEeaRegion(state.searchChoiceRegion)
  })
}

/**
 * Run the reset (`settings.reset`, after the row's confirmation): the plan's steps through the
 * services that own each setting, so every sanitiser, listener and commit the setting has runs
 * as it does for the row that sets it alone. The settings steps go in one `updateSettings`
 * patch and one commit; the tabs, the site permissions, the extensions and the data follow,
 * and the toast says the act is done. Returns the plan run.
 */
export async function resetSettings(
  browser: Browser,
  win: ZenWindow
): Promise<SettingsResetStep[]> {
  const plan = settingsResetPlan(browser)
  const patch: Partial<Settings> = {}
  for (const step of plan) {
    if (step.kind === 'startup' || step.kind === 'homepage' || step.kind === 'searchEngine')
      Object.assign(patch, step.patch)
  }
  // The choice screen is owed again once the record is gone (an EEA device); it waits for the
  // next run rather than covering the Settings page the reset was asked from, as a skip does.
  if (plan.some((step) => step.kind === 'searchEngine' && step.reAsk))
    browser.state.searchChoiceSession.skipped = true
  browser.updateSettings(patch, win)
  for (const step of plan) {
    switch (step.kind) {
      case 'startup':
      case 'homepage':
      case 'searchEngine':
        break
      case 'newTab':
        await browser.newTab.reset()
        break
      case 'unpin':
        for (const tabId of step.tabIds) browser.tabs.togglePin(tabId)
        break
      case 'sitePermissions':
        browser.permissions.reset()
        break
      case 'disableExtensions':
        for (const id of step.ids) await browser.extensions.setEnabled(id, false, win)
        break
      case 'clearData':
        await browser.privacy.clearBrowsingData('all', [...step.types], undefined, win)
        break
    }
  }
  browser.toast(SETTINGS_RESET_TOAST, 'info', win)
  return plan
}
