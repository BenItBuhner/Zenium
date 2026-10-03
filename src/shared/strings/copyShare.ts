import type { ActId } from './acts'
import type { Entry } from './index'

/**
 * The copy-and-share family's first slice (the D7 proposal §D, PR-3a / P-1): the act a link or
 * an entry row uses to copy its address (`Menus.linkCopyItem`). Q1 – a link or an entry row
 * uses this; the page's own address stays `tab.copyUrl`. The count axis is the phone's plural
 * when several entries are picked (no `{n}`: the words change, not a number). mailto/tel labels
 * stay in `linkCopyItem` until a later slice. Confirmation 'Link copied' stays a literal here
 * (P-4 is PR-3c).
 */
export const COPY_SHARE = {
  'link.copyAddress': {
    menu: 'Copy Link Address',
    count: { one: 'Copy Link Address', other: 'Copy Link Addresses' }
  }
} satisfies Partial<Record<ActId, Entry>>
