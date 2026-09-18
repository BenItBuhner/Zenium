import type { JumpListCategory, MenuItemConstructorOptions } from 'electron'

/** The Windows build number in an `os.release()` string such as `10.0.22631`; null elsewhere. */
export function windowsBuild(release: string): number | null {
  const m = /^10\.0\.(\d+)/.exec(release)
  return m ? Number(m[1]) : null
}

/**
 * The first Windows 11 build whose DWM takes a system backdrop request (`DWMWA_SYSTEMBACKDROP_TYPE`,
 * 22H2). Electron's `backgroundMaterial` is a no-op before it, so the Settings toggle is only
 * offered where Mica can actually show.
 */
export const MICA_MIN_BUILD = 22621

/** Whether the host can draw Mica behind windows: Windows 11 22H2 or later. */
export function supportsWindowMaterial(platform: string, release: string): boolean {
  if (platform !== 'win32') return false
  const build = windowsBuild(release)
  return build !== null && build >= MICA_MIN_BUILD
}

/** Flags `zenium <flag>` understands for the shell's "new window" entries. */
export const NEW_WINDOW_FLAG = '--new-window'
export const PRIVATE_WINDOW_FLAG = '--private-window'

/**
 * The taskbar jump list: Zenium's two "new window" tasks plus the recent documents Windows keeps
 * for the app. Icons come from the executable itself.
 */
export function jumpListCategories(exePath: string): JumpListCategory[] {
  const task = (title: string, description: string, args: string): Electron.JumpListItem => ({
    type: 'task',
    title,
    description,
    program: exePath,
    args,
    iconPath: exePath,
    iconIndex: 0
  })
  return [
    {
      type: 'tasks',
      items: [
        task('New Window', 'Open a new Zenium window', NEW_WINDOW_FLAG),
        task('New Private Window', 'Open a new private Zenium window', PRIVATE_WINDOW_FLAG)
      ]
    },
    { type: 'recent' }
  ]
}

/** The macOS Dock menu (right-click the icon): the same two entries in the platform's title case. */
export function dockMenuTemplate(
  open: (kind: 'synced' | 'private') => void
): MenuItemConstructorOptions[] {
  return [
    { label: 'New Window', click: () => open('synced') },
    { label: 'New Private Window', click: () => open('private') }
  ]
}
