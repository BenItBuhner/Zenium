import type { MenuDescriptor } from '@shared/types'

/**
 * The generic name of a menu's source – its accessible label when the `menu.show` descriptor
 * carries no title – shared by the renderers of the core's menus (the phone's sheet, the
 * tablet's popover, the mouse's popover in `MenuSheet`).
 */
export function sourceTitle(source: MenuDescriptor['source']): string {
  switch (source) {
    case 'page':
      return 'Page'
    case 'tab':
      return 'Tab'
    case 'selection':
      return 'Selected Tabs'
    case 'space':
      return 'Space'
    case 'folder':
      return 'Folder'
    case 'newtab':
      return 'New Tab'
    case 'topsite':
      return 'Shortcut'
    case 'app':
      return 'Zenium'
    case 'bookmark':
      return 'Bookmark'
    case 'history':
      return 'History'
    case 'download':
      return 'Download'
    case 'urlbar':
      return 'Address'
    case 'translate':
      return 'Translation'
  }
}
