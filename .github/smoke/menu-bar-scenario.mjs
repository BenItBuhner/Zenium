// menu-bar (shortcuts-menus-160, -162, -123; W7-4): the application menu as the main process
// holds it – `Menu.getApplicationMenu()`, read through the harness – judged against what the
// model promises (`src/core/menuBar.ts`, vitest `menuBar.test.ts`): Chrome's menus in Chrome's
// order with the Tab menu between Bookmarks and Window; the Tab menu's rows, their order, the
// chords the key table binds (the Chrome preset's, a fresh profile's) and the enabled states
// with a new tab page in front and then a site page with a tab below it; the toggles' words
// following a pick of the row itself (Pin Tab → Unpin Tab, Mute Site → Unmute Site, picked
// through the item's own `click` in the main process – the nearest a runner gets to the native
// menu without UI scripting); the Help menu's rows under the `help` role (macOS's Search field)
// with no Report Unsafe Site and no About; and About Zenium an enabled plain row of the
// application menu that opens Settings › About as a page tab, closed again with the tab's
// close chord. Off macOS Zenium draws no menu bar
// (`Menu.setApplicationMenu(null)` in `src/main/index.ts`): the one step there reads null.
//
// No screenshots judge anything here: a native menu is not on the window's pixels until it is
// open, and the readings are the main process's own.

/** The scenario's name on the command line and in result.json. */
export const MENU_BAR_SCENARIO = 'menu-bar'

/** Chrome's menus in Chrome's order (`main_menu_builder.mm`), less Profiles, which Zenium has none of. */
export const MENU_ORDER = [
  'Zenium',
  'File',
  'Edit',
  'View',
  'History',
  'Bookmarks',
  'Tab',
  'Window',
  'Help'
]

/**
 * The Tab menu's chord rows and their chords in the Chrome preset on macOS – what a fresh
 * profile shows (`shared/shortcuts.ts`; `menuBar.test.ts` holds the bar to the key table, this
 * table holds the runner to the preset's words).
 */
export const TAB_MENU_CHORDS = {
  'Select Next Tab': 'Ctrl+Tab',
  'Select Previous Tab': 'Ctrl+Shift+Tab',
  'Duplicate Tab': 'Cmd+Shift+K',
  'Pin Tab': 'Cmd+Ctrl+P',
  'Unpin Tab': 'Cmd+Ctrl+P',
  'Search Tabs…': 'Cmd+Shift+A'
}

/**
 * The Tab menu's rows in Chrome's order, as they read while the front tab is in no folder and
 * the space has none (a fresh profile): the two rows Chrome words by direction in their vertical
 * strip's words, Chrome's Group Tab as Zenium's folder rows.
 */
export const TAB_MENU_ROWS = [
  'New Tab Below',
  'Select Next Tab',
  'Select Previous Tab',
  'Duplicate Tab',
  'Mute Site',
  'Pin Tab',
  'Add Tab to New Folder',
  'Remove from Folder',
  'Close Other Tabs',
  'Close Tabs Below',
  'Move Tab to New Window',
  'Search Tabs…'
]

/** The Help menu's rows (the ⋯ menu's Help order less About Zenium, the application menu's). */
export const HELP_MENU_ROWS = [
  "What's New",
  '-',
  'Zenium Help',
  'Keyboard Shortcuts',
  'Report an Issue…'
]

/**
 * The Tab menu's expected rows for a front tab in one of two states: `new-tab-page` – a new tab
 * page alone in its window (no site to mute, nothing else to close) – and `site-among-others` –
 * a site page with another tab below it in the space. Each row: its label, whether it is
 * enabled, the chord it shows or null.
 */
export function expectedTabMenu(state) {
  if (state !== 'new-tab-page' && state !== 'site-among-others') {
    throw new Error(`no such Tab menu state: ${state}`)
  }
  const site = state === 'site-among-others'
  const enabledByLabel = {
    'New Tab Below': true,
    'Select Next Tab': true,
    'Select Previous Tab': true,
    'Duplicate Tab': true,
    'Mute Site': site,
    'Pin Tab': true,
    'Add Tab to New Folder': true,
    'Remove from Folder': false,
    'Close Other Tabs': site,
    'Close Tabs Below': site,
    'Move Tab to New Window': true,
    'Search Tabs…': true
  }
  return TAB_MENU_ROWS.map((label) => ({
    label,
    enabled: enabledByLabel[label],
    accelerator: TAB_MENU_CHORDS[label] ?? null
  }))
}

/** A menu's rows as `label`, or `-` for a separator. */
export function rowLabels(items) {
  return (items ?? []).map((i) => (i.type === 'separator' ? '-' : i.label))
}

/**
 * What is wrong with the bar's top level: the menus' labels have to be `MENU_ORDER`, the
 * Window and Help menus the host's `window` and `help` roles (the Window menu's list of
 * windows, the Help menu's Search field).
 */
export function barProblems(bar) {
  if (!bar) return ['no application menu']
  const problems = []
  const labels = bar.menus.map((m) => m.label)
  if (JSON.stringify(labels) !== JSON.stringify(MENU_ORDER)) {
    problems.push(`menus ${JSON.stringify(labels)}, expected ${JSON.stringify(MENU_ORDER)}`)
  }
  const role = (label) => bar.menus.find((m) => m.label === label)?.role ?? null
  if (role('Window') !== 'window') problems.push(`the Window menu's role is ${role('Window')}`)
  if (role('Help') !== 'help') problems.push(`the Help menu's role is ${role('Help')}`)
  return problems
}

/**
 * What is wrong with the Tab menu against `expected` (`expectedTabMenu`): the rows in order,
 * each enabled or greyed as expected, each chord row with its chord and the others without.
 */
export function tabMenuProblems(items, expected) {
  const problems = []
  const labels = rowLabels(items)
  const want = expected.map((r) => r.label)
  if (JSON.stringify(labels) !== JSON.stringify(want)) {
    problems.push(`rows ${JSON.stringify(labels)}, expected ${JSON.stringify(want)}`)
    return problems
  }
  expected.forEach((row, i) => {
    const item = items[i]
    if (Boolean(item.enabled) !== row.enabled) {
      problems.push(
        `${row.label} is ${item.enabled ? 'enabled' : 'greyed'}, expected ${row.enabled ? 'enabled' : 'greyed'}`
      )
    }
    const chord = item.accelerator ?? null
    if (chord !== row.accelerator) {
      problems.push(
        `${row.label} shows ${chord ?? 'no chord'}, expected ${row.accelerator ?? 'none'}`
      )
    }
  })
  return problems
}

/**
 * What is wrong with the Help menu: `HELP_MENU_ROWS` in order, every row enabled with no chord
 * (Chrome's Help chords name no action of the key table), no About Zenium (the application
 * menu's) and no Report Unsafe Site (Zenium has no Safe Browsing report path; services PS-01).
 */
export function helpMenuProblems(items) {
  const problems = []
  const labels = rowLabels(items)
  if (JSON.stringify(labels) !== JSON.stringify(HELP_MENU_ROWS)) {
    problems.push(`rows ${JSON.stringify(labels)}, expected ${JSON.stringify(HELP_MENU_ROWS)}`)
  }
  for (const item of items ?? []) {
    if (item.type === 'separator') continue
    if (!item.enabled) problems.push(`${item.label} is greyed`)
    if (item.accelerator) problems.push(`${item.label} shows ${item.accelerator}`)
  }
  for (const stray of ['About Zenium', 'Report Unsafe Site']) {
    if (labels.includes(stray)) problems.push(`${stray} is in the Help menu`)
  }
  return problems
}

/**
 * What is wrong with the application menu's About row: the first row, "About Zenium", enabled,
 * a plain item of Zenium's own (no `about` role – the role draws the host's panel, the row
 * opens the About page).
 */
export function aboutRowProblems(items) {
  const first = items?.[0]
  if (!first) return ['the application menu has no rows']
  const problems = []
  if (first.label !== 'About Zenium') problems.push(`the first row is ${first.label}`)
  if (!first.enabled) problems.push('About Zenium is greyed')
  if (first.role) problems.push(`About Zenium has the ${first.role} role`)
  if (first.type !== 'normal') problems.push(`About Zenium is a ${first.type} item`)
  return problems
}

/**
 * What is wrong with the page the About row's pick opened: the Settings page reading `about`,
 * as a page tab in front (`zen://settings/about` – `PageService.open` on a host with page tabs,
 * which the desktop is, opens Settings as a tab beside the one that was in front, never as an
 * overlay). `reading` is `{ section, frontTabUrl }`: the page's `data-section` and the front
 * tab's URL once the page is up.
 */
export function aboutPageProblems({ section, frontTabUrl }) {
  const problems = []
  if (section !== 'about') problems.push(`the Settings page opened at ${section}, not about`)
  if (!frontTabUrl?.startsWith('zen://settings/about')) {
    problems.push(`the front tab is ${frontTabUrl ?? 'none'}, not the Settings › About page tab`)
  }
  return problems
}

/** Off macOS: no application menu at all. */
export function noBarProblems(bar) {
  return bar ? [`an application menu is set: ${JSON.stringify(bar.menus.map((m) => m.label))}`] : []
}

/**
 * The reading of the toggles after their picks: `after` is the Tab menu's labels once the row
 * was picked, `word` the label the row has to read then, `gone` the label it read before.
 */
export function toggleProblems(after, { word, gone }) {
  const problems = []
  if (!after.includes(word)) problems.push(`no ${word} row after the pick`)
  if (after.includes(gone)) problems.push(`${gone} still reads after the pick`)
  return problems
}

/**
 * Runs in the app's main process (`s.app.evaluate`): the application menu, two submenu levels
 * deep, or null when none is set. Self-contained – nothing of this module's scope is in reach.
 */
export function readMenuBarScript({ Menu }) {
  const menu = Menu.getApplicationMenu()
  if (!menu) return null
  const item = (i, depth) => ({
    label: i.label,
    type: i.type,
    role: i.role ?? null,
    enabled: i.enabled,
    checked: i.type === 'checkbox' || i.type === 'radio' ? i.checked : undefined,
    accelerator: i.accelerator ?? null,
    submenu: depth > 0 && i.submenu ? i.submenu.items.map((sub) => item(sub, depth - 1)) : undefined
  })
  return {
    menus: menu.items.map((m) => ({
      label: m.label,
      role: m.role ?? null,
      items: (m.submenu?.items ?? []).map((i) => item(i, 1))
    }))
  }
}

/**
 * Runs in the app's main process: picks the row `label` of the top-level menu `menu` through
 * the item's own `click` (what the native menu calls), and says whether a row was there to pick.
 */
export function pickMenuRowScript({ Menu }, { menu, label }) {
  const top = Menu.getApplicationMenu()?.items.find((m) => m.label === menu)
  const row = top?.submenu?.items.find((i) => i.label === label)
  if (!row) return { picked: false, rows: (top?.submenu?.items ?? []).map((i) => i.label) }
  if (!row.enabled) return { picked: false, greyed: true }
  row.click()
  return { picked: true }
}

/** An error carrying what the step had read (`Session.step` keeps `detail`). */
function withDetail(message, detail) {
  const error = new Error(message)
  error.detail = detail
  return error
}

/**
 * Runs the scenario. `h` is what the harness lends it: `freshProfile`, `runScenario`, `waitFor`,
 * `delay`, `log`, the fixture (`startBootFixture`'s result) and `isMac`.
 */
export async function scenarioMenuBar(h) {
  const { freshProfile, runScenario, waitFor, delay, log, fixture, isMac } = h
  const userData = freshProfile(`profile-${MENU_BAR_SCENARIO}`, { onboardingDone: true })

  return runScenario(MENU_BAR_SCENARIO, userData, {}, async (s, out) => {
    out.platform = process.platform
    const read = () => s.app.evaluate(readMenuBarScript)
    const menuOf = (bar, label) => bar?.menus.find((m) => m.label === label)?.items ?? null
    const tabRows = async () => rowLabels(menuOf(await read(), 'Tab'))
    const pick = (menu, label) => s.app.evaluate(pickMenuRowScript, { menu, label })
    const invoke = (name, args) =>
      s.chrome.evaluate(({ name, args }) => window.zen.invoke(name, args), { name, args })

    if (!isMac) {
      // Zenium draws no menu bar off macOS: the main process set none (`Menu.setApplicationMenu
      // (null)`), and the host has no `setApplicationMenu` for the core to hand a template to.
      await s.step('no-bar', async () => {
        const bar = await read()
        const problems = noBarProblems(bar)
        if (problems.length) throw withDetail(problems.join('; '), { bar })
        return { bar: null, note: 'no application menu off macOS' }
      })
      return
    }

    /** The bar once the browser has built its own (the bootstrap's two menus have no Tab menu). */
    const readBuilt = () =>
      waitFor(
        async () => {
          const bar = await read()
          return bar && menuOf(bar, 'Tab') ? bar : null
        },
        15000,
        'the application menu with the Tab menu'
      )
    /** The Tab menu once it reads `label` among its rows (the bar is rebuilt 80 ms after a change). */
    const tabMenuWith = (label) =>
      waitFor(
        async () => {
          const rows = await tabRows()
          return rows.includes(label) ? rows : null
        },
        8000,
        `the Tab menu reading ${label}`
      )

    await s.step('menus', async () => {
      const bar = await readBuilt()
      const labels = bar.menus.map((m) => m.label)
      const problems = barProblems(bar)
      if (problems.length) throw withDetail(problems.join('; '), { menus: labels })
      log(`menu-bar: ${labels.join(' · ')}`)
      return { menus: labels }
    })

    await s.step('tab-menu-new-tab-page', async () => {
      // A profile past onboarding boots to one new tab page (W5-F2): no site, nothing else to
      // close, no folder in the space.
      const bar = await readBuilt()
      const items = menuOf(bar, 'Tab')
      const rows = items.map((i) => ({
        label: i.label,
        enabled: i.enabled,
        accelerator: i.accelerator
      }))
      const problems = tabMenuProblems(items, expectedTabMenu('new-tab-page'))
      if (problems.length) throw withDetail(problems.join('; '), { rows })
      return { rows }
    })

    await s.step('tab-menu-site-page', async () => {
      // The fixture's first page in a new tab in front, then another tab below it: Mute Site
      // has a site, Close Other Tabs and Close Tabs Below have a tab.
      await invoke('tab.create', { url: fixture.first.url, active: true })
      await s.waitForTab(fixture.first.url, 20000)
      // Not waited for: a tab made inactive may load no page yet; the model holds it at once.
      await invoke('tab.create', { url: fixture.second.url, active: false })
      const rows = await waitFor(
        async () => {
          const items = menuOf(await read(), 'Tab')
          return items && tabMenuProblems(items, expectedTabMenu('site-among-others')).length === 0
            ? items.map((i) => ({ label: i.label, enabled: i.enabled, accelerator: i.accelerator }))
            : null
        },
        10000,
        'the Tab menu on the site page'
      ).catch(async (e) => {
        const items = menuOf(await read(), 'Tab')
        throw withDetail(
          `${e.message}: ${tabMenuProblems(items ?? [], expectedTabMenu('site-among-others')).join('; ')}`,
          {
            rows: (items ?? []).map((i) => ({
              label: i.label,
              enabled: i.enabled,
              accelerator: i.accelerator
            }))
          }
        )
      })
      return { rows }
    })

    await s.step('tab-menu-toggles', async () => {
      // The toggles read their state: the row picked, the bar redrawn with the other word; the
      // pinned tab is one no folder takes, so the folder row greys with it.
      const readings = {}
      const pinned = await pick('Tab', 'Pin Tab')
      if (!pinned.picked) throw withDetail('Pin Tab could not be picked', pinned)
      let rows = await tabMenuWith('Unpin Tab')
      readings.afterPin = rows
      let problems = toggleProblems(rows, { word: 'Unpin Tab', gone: 'Pin Tab' })
      const folderRow = menuOf(await read(), 'Tab').find((i) => i.label === 'Add Tab to New Folder')
      if (folderRow?.enabled !== false)
        problems.push('Add Tab to New Folder is not greyed for the pinned tab')
      if (problems.length) throw withDetail(problems.join('; '), readings)
      const unpinned = await pick('Tab', 'Unpin Tab')
      if (!unpinned.picked)
        throw withDetail('Unpin Tab could not be picked', { ...readings, unpinned })
      rows = await tabMenuWith('Pin Tab')
      readings.afterUnpin = rows
      problems = toggleProblems(rows, { word: 'Pin Tab', gone: 'Unpin Tab' })
      if (problems.length) throw withDetail(problems.join('; '), readings)

      const muted = await pick('Tab', 'Mute Site')
      if (!muted.picked) throw withDetail('Mute Site could not be picked', { ...readings, muted })
      rows = await tabMenuWith('Unmute Site')
      readings.afterMute = rows
      problems = toggleProblems(rows, { word: 'Unmute Site', gone: 'Mute Site' })
      if (problems.length) throw withDetail(problems.join('; '), readings)
      const unmuted = await pick('Tab', 'Unmute Site')
      if (!unmuted.picked)
        throw withDetail('Unmute Site could not be picked', { ...readings, unmuted })
      rows = await tabMenuWith('Mute Site')
      readings.afterUnmute = rows
      problems = toggleProblems(rows, { word: 'Mute Site', gone: 'Unmute Site' })
      if (problems.length) throw withDetail(problems.join('; '), readings)
      await delay(200)
      return readings
    })

    await s.step('help-menu', async () => {
      const bar = await read()
      const items = menuOf(bar, 'Help')
      const rows = (items ?? []).map((i) => ({
        label: i.type === 'separator' ? '-' : i.label,
        enabled: i.enabled,
        accelerator: i.accelerator
      }))
      const problems = helpMenuProblems(items)
      if (problems.length) throw withDetail(problems.join('; '), { rows })
      return { role: bar.menus.find((m) => m.label === 'Help')?.role ?? null, rows }
    })

    /** The front tab of the active space, as the core's state has it. */
    const frontTab = async () => {
      const state = await s.appState()
      const space = state?.spaces?.find((sp) => sp.id === state.activeSpaceId)
      const tab = space ? state.tabs?.[space.activeTabId] : null
      return tab ? { id: tab.id, url: tab.url } : null
    }

    await s.step('about-row', async () => {
      // The application menu's About Zenium: enabled, Zenium's own row, and its pick opens the
      // About page – Settings › About as a page tab in the front window (`PageService.open`: a
      // desktop host has page tabs, so Settings is a tab beside the one that was in front, never
      // the overlay). A page is no dialog: Escape has no work on it (v2 draft §9.23 – Escape
      // closes popovers and dialogs; pages have an X or a back control), which is what the
      // step's earlier Escape and its wait for the page to hide ran out on (W7-4's runs: the
      // key reached the chrome, the page stayed, 5 s went by). The tab's close chord is the
      // page's way out, and the step takes it: the session's tabs are the two site pages again
      // for the quit.
      const bar = await read()
      const items = menuOf(bar, 'Zenium')
      const problems = aboutRowProblems(items)
      const row = items?.[0] ?? null
      if (problems.length) throw withDetail(problems.join('; '), { row })
      const before = await frontTab()
      const picked = await pick('Zenium', 'About Zenium')
      if (!picked.picked) throw withDetail('About Zenium could not be picked', { row, picked })
      const page = s.chrome.locator('[data-testid="settings-page"]').first()
      await page.waitFor({ state: 'visible', timeout: 10000 })
      const section = await page.getAttribute('data-section')
      const front = await frontTab()
      const pageProblems = aboutPageProblems({ section, frontTabUrl: front?.url ?? null })
      if (pageProblems.length) {
        throw withDetail(pageProblems.join('; '), { row, section, before, front })
      }
      const closeTab = `${isMac ? 'Meta' : 'Control'}+w`
      await s.press(closeTab)
      await page.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {
        throw withDetail(`the Settings page is still up 5 s after ${closeTab}`, {
          row,
          section,
          front
        })
      })
      const after = await frontTab()
      return { row, section, page: front, closedWith: closeTab, before, after }
    })

    // The session ends the way every scenario's does: the quit chord, the "Quit Zenium?" question
    // the open tabs earn answered, the process's exit 0 read. Without this the harness's
    // `forceClose` met that question and killed the app after its 8 s race, so the macOS legs'
    // exit column read SIGKILL though every step had passed (W7-4's runs).
    await s.step('quit', async () => s.quitGracefully())
  })
}
