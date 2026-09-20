import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMediaSeek } from '@renderer/hooks/useMediaSeek'
import {
  Film,
  Music,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward
} from 'lucide-react'
import type { MediaState, Rect, Tab, UIState } from '@shared/types'
import { DEFAULT_SEEK_OFFSET_S } from '@shared/mediaSession'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { usePopover } from '@renderer/hooks/usePopover'
import { anchorOf, placeUnder } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { formatMediaTime, handlesAction, mediaDetail } from '@renderer/lib/media'
import {
  MEDIA_HUB_NAME,
  closeMediaHub,
  mediaHubEntries,
  mediaHubUi,
  mediaTitle
} from '@renderer/lib/mediaHub'
import { useLightDismiss } from '@renderer/lib/popoverStore'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  type PopoverBox,
  placePopover,
  popoverStyle,
  viewportSize
} from '@renderer/lib/portals'
import { browserStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { V2IconButton } from '../extensions/v2'
import { Slider } from '../ui/slider'
import { V2_GLYPH } from '../v2/controls'
import { MEDIA_HUB_BUTTON } from './MediaHubButton'

/** Rows with trailing controls: the 400 popover (§9.20). */
const WIDTH = POPOVER_WIDTH.form

/** The hub while it is open, above whichever shell is up (mounted once in `Root`). */
export function MediaHubLayer(): JSX.Element | null {
  const open = mediaHubUi.use((s) => s.open)
  const state = browserStore.use((s) => s.state)
  if (!open || !state) return null
  return <MediaHubPopover state={state} />
}

/**
 * Chrome's global media controls (MW-16) as a §9.20 popover 400 wide hanging from the toolbar
 * button's row, end-aligned with the button, through the chrome layer over a picture of the
 * page (`useFloatingChrome`; it holds its first paint until the picture is in place). It opens
 * on its cards with no title block, like a menu (§9.7: the cards name themselves, and the
 * hub's name lives on the button that opens it – `aria-label` here): one player per tab with
 * media, the session first, parted by air alone: the artwork (the page's, else the kind's glyph
 * on the players' shared tile) beside the title and the artist and site – the title is the way
 * to the tab, as Chrome's card is – with picture-in-picture trailing for a video where the host
 * has it; the seek row (§10.4's slider row: the times in tabular numerals at the track's ends,
 * the position carried forward from the report while it plays, a drag scrubbing and a release
 * seeking there) when the media has a duration; and the transport – previous track, ten seconds
 * back, play or pause, ten seconds on, next track – as §9.3 icon buttons, the track buttons at
 * .4 (§9.30) until the page handles them. Every control sends the Media Session action the OS
 * controls send (`media.action`, `media.toggle`). The popover leaves with the last player;
 * Escape returns the keyboard to the button, a press anywhere else, a resize and another
 * popover opening put it away (§9.22).
 */
function MediaHubPopover({ state }: { state: UIState }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [fromKeyboard] = useState(() => mediaHubUi.get().fromKeyboard)
  const ready = useFloatingChrome({ pageHadFocus: !fromKeyboard })
  const [box, setBox] = useState<PopoverBox>(place)
  const entries = mediaHubEntries(state)

  // Hangs from the button in its row, measured again on every state push (the row's buttons
  // come and go with the tab) and on resize; the box only changes when the measurement does.
  useLayoutEffect(() => {
    const measure = (): void => setBox((prev) => (sameBox(prev, place()) ? prev : place()))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [state])

  // Nothing left to control: the hub goes with the last player, as Chrome's does.
  useEffect(() => {
    if (entries.length === 0) closeMediaHub()
  }, [entries.length])

  // Escape (and a press on the button) puts the keyboard back on the button (§9.22); the button
  // is looked up on each render since the row remounts it with the tab.
  usePopover(ref, {
    onClose: closeMediaHub,
    active: ready,
    returnTo: document.querySelector<HTMLElement>(MEDIA_HUB_BUTTON)
  })
  useLightDismiss(ref, closeMediaHub, { anchor: () => document.querySelector(MEDIA_HUB_BUTTON) })

  if (!ready) return null
  return (
    <ChromePortal>
      <div
        ref={ref}
        role="dialog"
        aria-label={MEDIA_HUB_NAME}
        data-zen-media-hub
        className="zen-v2 zen-animate-pop zen-bm-popover zen-mhub fixed z-[70] flex flex-col outline-none"
        style={popoverStyle(box)}
        tabIndex={-1}
      >
        <div className="zen-bm-popover-body zen-mhub-body">
          {entries.map((media) => (
            <Player
              key={media.tabId}
              media={media}
              tab={state.tabs[media.tabId]}
              pip={Boolean(state.capabilities.pictureInPicture && media.video)}
            />
          ))}
        </div>
      </div>
    </ChromePortal>
  )
}

/** One tab's player: what plays, where it stands, and the transport. */
function Player({
  media,
  tab,
  pip
}: {
  media: MediaState
  tab: Tab | undefined
  pip: boolean
}): JSX.Element {
  const [broken, setBroken] = useState(false)
  const artwork = media.artwork && !broken ? media.artwork : null
  const title = mediaTitle(media, tab)
  const detail = mediaDetail(media, tab, title)
  return (
    <section
      className="zen-mhub-player"
      data-media-player={media.tabId}
      data-playing={media.playing || undefined}
      aria-label={title}
    >
      <div className="zen-mhub-now">
        {/* The players' one artwork tile: the phone sheet's rule, the §9.3 glyph without a picture. */}
        {artwork ? (
          <img
            className="zen-media-art"
            src={artwork}
            alt=""
            draggable={false}
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="zen-media-art zen-media-art-empty" aria-hidden>
            {media.video ? <Film className={V2_GLYPH} /> : <Music className={V2_GLYPH} />}
          </span>
        )}
        <button
          type="button"
          className="zen-mhub-text"
          title="Switch to tab"
          data-media-switch=""
          onClick={() => {
            run('tab.activate', { tabId: media.tabId })
            closeMediaHub()
          }}
        >
          <span className="zen-mhub-name truncate">{title}</span>
          {detail && <span className="zen-mhub-detail truncate">{detail}</span>}
        </button>
        {pip && (
          <V2IconButton
            icon={PictureInPicture2}
            label="Picture in picture"
            data-media-pip=""
            onClick={() => {
              // The window shrinks to the video: the hub is gone with it.
              run('media.pictureInPicture', { tabId: media.tabId })
              closeMediaHub()
            }}
          />
        )}
      </div>
      <SeekRow media={media} />
      <Transport media={media} />
    </section>
  )
}

/**
 * The seek row (§10.4's slider row): where playback stands, carried forward from the report
 * while it plays, at the track's start and the duration at its end in tabular numerals, the
 * range between them. A drag on the thumb scrubs; letting go seeks there, and the display holds
 * the target until the page reports the new position (`useMediaSeek`, the state the phone's
 * sheet draws its row from too). Absent for a stream without a duration.
 */
function SeekRow({ media }: { media: MediaState }): JSX.Element | null {
  const { duration, shown, slider } = useMediaSeek(media)
  if (!(duration > 0)) return null
  return (
    <div className="zen-mhub-seek" data-media-seek="">
      <span className="zen-mhub-time" aria-hidden>
        {formatMediaTime(shown)}
      </span>
      {/* The §10.4 slider row's track and thumb, the rules the zoom row draws them by. */}
      <Slider
        className="zen-zoom-slider min-w-0 flex-1"
        aria-label="Position"
        aria-valuetext={`${formatMediaTime(shown)} of ${formatMediaTime(duration)}`}
        data-media-position=""
        {...slider}
      />
      <span className="zen-mhub-time" aria-hidden>
        {formatMediaTime(duration)}
      </span>
    </div>
  )
}

/**
 * The transport: previous track, ten seconds back, play or pause, ten seconds on, next track –
 * §9.3 icon buttons centred. The track buttons work only through the page's own handlers (an
 * element has no next track), so they are disabled at .4 (§9.30) until the page registers one;
 * the seek buttons move the element itself when the page handles no seek (Chrome's default of
 * ten seconds), so they stay while the media has a duration.
 */
function Transport({ media }: { media: MediaState }): JSX.Element {
  const seekable = (media.position?.duration ?? 0) > 0
  const act = (action: 'previoustrack' | 'nexttrack' | 'seekbackward' | 'seekforward'): void =>
    run('media.action', { tabId: media.tabId, action, seekOffset: DEFAULT_SEEK_OFFSET_S })
  return (
    <div className="zen-mhub-transport" data-media-transport="">
      <V2IconButton
        icon={SkipBack}
        label="Previous track"
        disabled={!handlesAction(media, 'previoustrack')}
        onClick={() => act('previoustrack')}
      />
      <V2IconButton
        icon={RotateCcw}
        label="Seek backward"
        disabled={!seekable}
        onClick={() => act('seekbackward')}
      />
      <button
        type="button"
        className={cn('zen-v2-icon-button zen-mhub-toggle')}
        aria-label={media.playing ? 'Pause' : 'Play'}
        title={media.playing ? 'Pause' : 'Play'}
        data-media-toggle=""
        // The Media Session's toggle where the page reports one, the element itself otherwise.
        onClick={() => run('media.toggle', { tabId: media.tabId })}
      >
        {media.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
      </button>
      <V2IconButton
        icon={RotateCw}
        label="Seek forward"
        disabled={!seekable}
        onClick={() => act('seekforward')}
      />
      <V2IconButton
        icon={SkipForward}
        label="Next track"
        disabled={!handlesAction(media, 'nexttrack')}
        onClick={() => act('nexttrack')}
      />
    </div>
  )
}

/**
 * Where the hub goes: hanging from the row the toolbar button sits in, end-aligned with the
 * button (it sits in the row's trailing half); a button not on screen puts it in the window's
 * top trailing corner.
 */
function place(): PopoverBox {
  const button = document.querySelector(MEDIA_HUB_BUTTON)
  if (button) return placeUnder(anchorOf(button), WIDTH)
  const viewport = viewportSize()
  const corner: Rect = { x: viewport.width - POPOVER_MARGIN - 28, y: 28, width: 28, height: 28 }
  return placePopover(corner, corner, viewport, WIDTH)
}

function sameBox(a: PopoverBox, b: PopoverBox): boolean {
  if (a.left !== b.left || a.width !== b.width || a.maxHeight !== b.maxHeight) return false
  return a.side === 'below'
    ? b.side === 'below' && a.top === b.top
    : b.side === 'above' && a.bottom === b.bottom
}
