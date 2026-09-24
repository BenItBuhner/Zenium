import { UPDATE_REPOSITORY } from './updates'

/**
 * Where Zenium sends people for help and to report what went wrong: the app menu's Help
 * submenu (`core/menuBar.ts`, `core/menus.ts`) and Settings › About's "Get help" and "Report
 * an issue" rows (settings-73, shortcuts-menus-164) name one pair, so the two never drift.
 */
export const HELP_URL = 'https://github.com/BenItBuhner/Zenium#readme'
export const ISSUES_URL = 'https://github.com/BenItBuhner/Zenium/issues'

/**
 * The running version's release on GitHub – its notes as the release body – where the Help
 * submenu's What's New goes on a host without the `zen://whats-new` page tab
 * (`UpdateService.openWhatsNew`, shortcuts-menus-152). The tag is the release pipeline's `v<version>`.
 */
export function releaseNotesUrl(version: string): string {
  return `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`
}
