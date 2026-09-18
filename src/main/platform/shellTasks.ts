import { app, Menu } from 'electron'
import { dockMenuTemplate, jumpListCategories } from './appShell'

/**
 * The shell's "new window" entries: the taskbar jump list on Windows (set after the
 * AppUserModelId, which is what ties it to the pinned shortcut) and the Dock menu on macOS.
 */
export function installShellTasks(open: (kind: 'synced' | 'private') => void): void {
  if (process.platform === 'win32') {
    const result = app.setJumpList(jumpListCategories(process.execPath))
    if (result !== 'ok') console.warn('[zen] shell: jump list not set:', result)
  } else if (process.platform === 'darwin') {
    app.dock?.setMenu(Menu.buildFromTemplate(dockMenuTemplate(open)))
  }
}
