import type { SharePanelRequest, SharePanelTarget, Tab } from '@shared/types'
import type { PreviewShareKind } from './previewSpec'

/*
 * The browser's own share panel staged for the preview host (`share=<kind>` in a preview state,
 * and the stand-in host's `app.share` below Android 14): the request `Share.kt` would send for
 * the active page, a selection's text or an image, with a row of stand-in apps in place of the
 * device's – drawn launcher icons as `data:` URLs, the shapes adaptive icons come in – so the
 * panel is looked at with no emulator involved.
 */

/** A stand-in launcher icon: a coloured disc with the app's initial, at the row's 40. */
function launcherIcon(fill: string, letter: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">` +
    `<circle cx="20" cy="20" r="20" fill="${fill}"/>` +
    `<text x="20" y="26" text-anchor="middle" font-family="Roboto, sans-serif" font-size="18" font-weight="600" fill="#fff">${letter}</text>` +
    `</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/** The row Zenium's history would rank: the apps a phone shares to, most used first. */
export const PREVIEW_SHARE_TARGETS: readonly SharePanelTarget[] = [
  {
    component: 'com.example.messages/.ShareActivity',
    label: 'Messages',
    icon: launcherIcon('#1a73e8', 'M')
  },
  {
    component: 'com.example.mail/.ComposeActivity',
    label: 'Mail',
    icon: launcherIcon('#d93025', 'M')
  },
  {
    component: 'com.example.notes/.ShareReceiverActivity',
    label: 'Notes',
    icon: launcherIcon('#f9ab00', 'N')
  },
  {
    component: 'com.example.drive/.UploadActivity',
    label: 'Drive',
    icon: launcherIcon('#188038', 'D')
  },
  {
    component: 'com.example.chat/.ShareToChatActivity',
    label: 'Team Chat',
    icon: launcherIcon('#7b1fa2', 'T')
  },
  {
    component: 'com.example.reader/.SaveActivity',
    label: 'Read Later',
    icon: launcherIcon('#e8710a', 'R')
  },
  {
    component: 'com.example.bluetooth/.OppLauncherActivity',
    label: 'Bluetooth',
    icon: launcherIcon('#5f6368', 'B')
  }
]

/** The shared picture, small, as the host's sampled decode: a drawn landscape at 40. */
const PREVIEW_SHARE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">` +
    `<rect width="40" height="40" fill="#8ab4f8"/>` +
    `<circle cx="30" cy="11" r="5" fill="#fde293"/>` +
    `<path d="M0 40 L14 20 L22 31 L28 25 L40 40 Z" fill="#137333"/>` +
    `</svg>`
)}`

const PREVIEW_SHARE_TEXT =
  'The quick brown fox jumps over the lazy dog while the panel shows what a selection shares.'

/**
 * The link to the selection's highlight (`#:~:text=`, SH-11), as the core's `shareSelection`
 * sends it with the text (`menus.ts`): the host relays the two and no title or favicon.
 */
function highlightLink(url: string): string {
  return `${url}#:~:text=The%20quick%20brown%20fox,a%20selection%20shares.`
}

let seq = 0

/**
 * The request for a share of `kind` from `tab` (the page, its favicon and its id; none when no
 * tab is open), as the host builds it (`Share.kt`): a page's share carries its title, link and
 * favicon; a selection's its text and the link to its highlight, no title and no favicon; an
 * image the picture alone.
 */
export function previewShareRequest(
  kind: PreviewShareKind,
  tab: Tab | null,
  isPrivate: boolean
): SharePanelRequest {
  const base = {
    id: `preview-share-${++seq}`,
    tabId: tab?.id ?? null,
    private: isPrivate,
    targets: [...PREVIEW_SHARE_TARGETS]
  }
  if (kind === 'image') {
    return {
      ...base,
      kind,
      title: null,
      url: null,
      text: null,
      favicon: null,
      image: PREVIEW_SHARE_IMAGE
    }
  }
  if (kind === 'text') {
    return {
      ...base,
      kind,
      title: null,
      url: highlightLink(tab && /^https?:\/\//i.test(tab.url) ? tab.url : 'https://example.com/'),
      text: PREVIEW_SHARE_TEXT,
      favicon: null,
      image: null
    }
  }
  return {
    ...base,
    kind,
    title: tab?.title ?? 'Example Domain',
    url: tab?.url ?? 'https://example.com/',
    text: null,
    favicon: tab?.favicon ?? null,
    image: null
  }
}
