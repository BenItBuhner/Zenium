import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
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
import type { MediaState, UIState } from '@shared/types'
import { useMediaSeek } from '@renderer/hooks/useMediaSeek'
import { run } from '@renderer/lib/api'
import { formatMediaTime, handlesAction, mediaDetail, mediaOf } from '@renderer/lib/media'
import { activeTab } from '@renderer/lib/selectors'
import { closeMediaSheet, uiStore } from '@renderer/lib/ui'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { ListRow } from '../siteControls/primitives'
import { Slider } from '../ui/slider'
import { V2_GLYPH } from '../v2/controls'
import { PhoneSheet } from './PhoneSheet'

/** The step of the seek buttons, Chrome's default for `seekbackward` / `seekforward`. */
const SEEK_STEP_S = 10

/** The media sheet while its request stands, in the frame dialog host `TabDialogs` mounts. */
export function MediaLayer({ state }: { state: UIState }): JSX.Element | null {
  const tabId = uiStore.use((s) => s.mediaSheet)
  return tabId ? <MediaSheet key={tabId} state={state} tabId={tabId} /> : null
}

/**
 * The in-app player (MW-16), the phone's shared `PhoneSheet` (grip, the 48 header, body at the
 * 16 gutter; placed through `FrameDialogHost`, drawing the stack's one scrim itself, the system
 * back and Escape). It shows the tab's media as the OS controls do – artwork, title, artist and site
 * – with the seek row of §10.4 (44 px step buttons at the row's ends, the track between them, the
 * times in `tabular-nums` above) and the transport row (previous track, play / pause, next
 * track; the track buttons at .4 when the page handles neither, §9.30), then the rows that lead
 * elsewhere: picture-in-picture of a video where the host has it (`capabilities
 * .pictureInPicture`), and the tab itself when another one is on screen. Every control sends the
 * Media Session action the OS controls send (`media.action` / `media.toggle`: the page's handler
 * when it has one, the element otherwise); the sheet leaves with the media – a closed tab, a clip that ended and left the
 * list – and every other way out (scrim, drag, back, Escape) simply closes it.
 */
function MediaSheet({ state, tabId }: { state: UIState; tabId: string }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const media = mediaOf(state, tabId)
  const tab = state.tabs[tabId]
  const dismiss = useCallback(() => sheet.current?.dismiss(), [])

  // The media went (its tab closed, the element gone): the sheet has nothing to show and leaves.
  useEffect(() => {
    if (!media) sheet.current?.dismiss()
  }, [media])

  const pip = Boolean(state.capabilities.pictureInPicture && media?.video && !media?.private)
  const elsewhere = activeTab(state)?.id !== tabId
  const contentKey = `${tabId}:${pip ? 'pip' : ''}:${elsewhere ? 'switch' : ''}`

  return (
    <PhoneSheet
      name="media"
      title={{ pose: 'header', text: 'Now playing' }}
      fitContent
      className="zen-media-sheet"
      onClose={closeMediaSheet}
      contentKey={contentKey}
      sheetRef={sheet}
    >
      {media && (
        <div className="zen-media-body" data-testid="media-sheet">
          <NowPlaying media={media} tab={tab} />
          <SeekRow media={media} />
          <Transport media={media} />
          {(pip || elsewhere) && <div className="zen-sheet-sep" aria-hidden />}
          {pip && (
            <ListRow
              label="Picture in picture"
              leading={<PictureInPicture2 className={V2_GLYPH} />}
              data-testid="media-pip"
              onClick={() => {
                // The window shrinks to the video: the sheet is gone with it.
                run('media.pictureInPicture', { tabId })
                dismiss()
              }}
            />
          )}
          {elsewhere && (
            <ListRow
              label="Switch to tab"
              leading={<ArrowUpRight className={V2_GLYPH} />}
              data-testid="media-switch-tab"
              onClick={() => {
                run('tab.activate', { tabId })
                dismiss()
              }}
            />
          )}
        </div>
      )}
    </PhoneSheet>
  )
}

/**
 * What plays: the artwork (the page's, else a glyph on a fill tile – a film strip for a video, a
 * note for audio) beside the title and, under it, the artist and the site – the composition of
 * the media notification's header. A page without metadata shows its title over its site, and
 * never the site twice (`mediaDetail` skips what the title already says).
 */
function NowPlaying({
  media,
  tab
}: {
  media: MediaState
  tab: UIState['tabs'][string] | undefined
}): JSX.Element {
  const [broken, setBroken] = useState(false)
  const artwork = media.artwork && !broken ? media.artwork : null
  const title = media.title?.trim() || tab?.title || 'Media'
  const detail = mediaDetail(media, tab, title)
  return (
    <div className="zen-media-now">
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
      <div className="min-w-0 flex-1">
        <div className="zen-media-name truncate" data-testid="media-title">
          {title}
        </div>
        {detail && <div className="zen-media-detail truncate">{detail}</div>}
      </div>
    </div>
  )
}

/**
 * The seek row (§10.4's slider row): the times above the track in `tabular-nums` – where
 * playback stands, carried forward from the report while it plays, and the duration – then a
 * 44 px step button at each end (ten seconds back and on, Chrome's default seek) with the range
 * between them. A finger on the thumb scrubs; letting go seeks there, and the display holds the
 * target until the page reports the new position. Absent for a stream without a duration.
 */
function SeekRow({ media }: { media: MediaState }): JSX.Element | null {
  // The row's state – the clock, the scrub, the seek held until the page answers, the Radix
  // commit workaround – is the hook's, shared with the desktop hub's row.
  const { duration, shown, seekTo, slider } = useMediaSeek(media)
  if (!(duration > 0)) return null

  return (
    <div className="zen-media-seek" data-testid="media-seek">
      <div className="zen-media-times" aria-hidden>
        <span>{formatMediaTime(shown)}</span>
        <span>{formatMediaTime(duration)}</span>
      </div>
      <div className="zen-media-seek-row">
        <button
          type="button"
          className="zen-v2-icon-button"
          aria-label="Seek backward"
          data-testid="media-seek-backward"
          onClick={() => seekTo(shown - SEEK_STEP_S)}
        >
          <RotateCcw />
        </button>
        {/* The §10.4 slider row's track and thumb, the rules the zoom row draws them by. */}
        <Slider
          className="zen-zoom-slider min-w-0 flex-1"
          aria-label="Position"
          aria-valuetext={`${formatMediaTime(shown)} of ${formatMediaTime(duration)}`}
          data-testid="media-position"
          {...slider}
        />
        <button
          type="button"
          className="zen-v2-icon-button"
          aria-label="Seek forward"
          data-testid="media-seek-forward"
          onClick={() => seekTo(shown + SEEK_STEP_S)}
        >
          <RotateCw />
        </button>
      </div>
    </div>
  )
}

/**
 * The transport row: previous track, play or pause, next track – three §9.3 icon buttons in the
 * one box, the toggle's solid glyph between the outlined skips its only emphasis (no fill at
 * rest: `--v2-fill` is the press fill, and the primitive's own 120 ms press draws it), as
 * Chrome's global media controls draw theirs. The track buttons work only through the page's
 * own handlers (an element has no next track), so they are disabled at .4 (§9.30) until the
 * page registers one.
 */
function Transport({ media }: { media: MediaState }): JSX.Element {
  const act = (action: 'previoustrack' | 'nexttrack'): void =>
    run('media.action', { tabId: media.tabId, action })
  return (
    <div className="zen-media-transport" data-testid="media-transport">
      <button
        type="button"
        className="zen-v2-icon-button"
        aria-label="Previous track"
        disabled={!handlesAction(media, 'previoustrack')}
        onClick={() => act('previoustrack')}
      >
        <SkipBack />
      </button>
      <button
        type="button"
        className="zen-v2-icon-button"
        aria-label={media.playing ? 'Pause' : 'Play'}
        data-testid="media-toggle"
        // The sidebar's control: the Media Session's toggle where the page reports one, the
        // element itself otherwise.
        onClick={() => run('media.toggle', { tabId: media.tabId })}
      >
        {media.playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
      </button>
      <button
        type="button"
        className="zen-v2-icon-button"
        aria-label="Next track"
        disabled={!handlesAction(media, 'nexttrack')}
        onClick={() => act('nexttrack')}
      >
        <SkipForward />
      </button>
    </div>
  )
}
