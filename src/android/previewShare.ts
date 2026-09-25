import type { SharePanelRequest, SharePanelTarget, Tab } from '@shared/types'
import type { PreviewShareKind } from './previewSpec'

/*
 * The browser's own share panel staged for the preview host (`share=<kind>` in a preview state,
 * and the stand-in host's `app.share` below Android 14): the request `Share.kt` would send for
 * the active page, a selection's text or an image – or for a page's `navigator.share` of a link,
 * text, or the two (`page-*`) – with a row of stand-in apps in place of the device's – drawn
 * launcher icons as `data:` URLs, the shapes adaptive icons come in – so the panel is looked at
 * with no emulator involved.
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

/**
 * What a page hands `navigator.share` in the preview's page shares (`share=page-*`): a link with
 * its title (Chrome's `LINK_PAGE_NOT_VISIBLE`), text alone (`TEXT`), or text with a link
 * (`LINK_AND_TEXT`) – the shapes a page's call takes to the panel below Android 14 (SH-03),
 * each shared as the page handed it over rather than as the page. The link is the host's own
 * stand-in article's (`PREVIEW_SAMPLE_ORIGIN`, `preview.ts`), so a still over that page reads
 * as the page sharing itself.
 */
const PREVIEW_PAGE_SHARE = {
  title: 'How the tides work',
  text: 'Worth a read: the moon does most of it, the sun the rest.',
  url: 'https://sample.example/how-the-tides-work'
} as const

let seq = 0

/**
 * The request for a share of `kind` from `tab` (the page, its favicon and its id; none when no
 * tab is open), as the host builds it (`Share.kt`): a page's share carries its title, link and
 * favicon; a selection's its text and the link to its highlight, no title and no favicon; an
 * image the picture alone. A page's `navigator.share` (`page-*`, `source: 'page'`) carries what
 * the page handed over – `text` making it the host's `text` kind, as `Share.shareText` sorts it –
 * with the tab's favicon beside it, which the panel draws for a link and not for text.
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
    source: 'menu' as const,
    targets: [...PREVIEW_SHARE_TARGETS]
  }
  if (kind === 'page-link' || kind === 'page-text' || kind === 'page-text-link') {
    const text = kind === 'page-link' ? null : PREVIEW_PAGE_SHARE.text
    return {
      ...base,
      source: 'page',
      kind: text === null ? 'link' : 'text',
      title: kind === 'page-text' ? null : PREVIEW_PAGE_SHARE.title,
      url: kind === 'page-text' ? null : PREVIEW_PAGE_SHARE.url,
      text,
      favicon: tab?.favicon ?? null,
      image: null
    }
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

/** What a page's `navigator.share` promise hears: the share taken, or `AbortError`. */
export type PreviewShareOutcome = 'shared' | 'aborted'

/**
 * What a page's awaited share hears for the panel's action (`share.panelAction`), as the Kotlin
 * host answers it (`Share.awaitedPanelAnswer`, after Chrome's hub and a Web Share's
 * `TargetChosenCallback`): `shared` for an app that took the share (`started`), for one of the
 * browser's own chips, for QR code and Copy image; `aborted` for a dismissal or an app that would
 * not start; nothing for More, whose word is the system sheet's.
 */
export function awaitedPanelAnswer(kind: string, started = true): PreviewShareOutcome | null {
  switch (kind) {
    case 'target':
      return started ? 'shared' : 'aborted'
    case 'chip':
    case 'qr':
    case 'copyImage':
      return 'shared'
    case 'more':
      return null
    default:
      return 'aborted'
  }
}
