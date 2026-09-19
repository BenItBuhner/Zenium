package app.zen.chromium

import org.json.JSONObject

/**
 * The session the core hands the host for the OS controls (`MediaSessionInfo` in
 * `src/shared/mediaSession.ts`), parsed: one page's media, resolved – the metadata the page set
 * through `navigator.mediaSession` or the tab's title and site, the artwork picked, where
 * playback stood at [positionAt] (epoch ms), the actions the page handles itself.
 */
class MediaSessionInfo(
    val tabId: String,
    val title: String,
    val artist: String,
    val album: String,
    /** The artwork's URL, or null for none. */
    val artwork: String?,
    val playing: Boolean,
    /** The element is a `<video>` with picture. */
    val video: Boolean,
    val width: Int,
    val height: Int,
    /** The element's duration in seconds (0: unknown or a live stream), position and rate as of [positionAt]. */
    val duration: Double,
    val position: Double,
    val playbackRate: Double,
    /** The page reported a position at all (an element with a duration, or `setPositionState`). */
    val hasPosition: Boolean,
    val positionAt: Long,
    /** Actions the page registered handlers for (`play`, `nexttrack`, …). */
    val actions: Set<String>,
    /** The element is fullscreen in its page. */
    val fullscreen: Boolean,
    /** A private tab: the controls show no title, artist or artwork. */
    val private: Boolean
) {
    /** Whether the controls may move playback: a known, finite duration (Chrome offers no seek on a live stream). */
    val seekable: Boolean get() = hasPosition && duration > 0 && duration.isFinite()

    /** Where playback stands `now` (epoch ms): moved on at the playback rate while playing, never past the end. */
    fun positionMs(now: Long): Long {
        if (!hasPosition) return 0L
        var seconds = position
        if (playing) seconds += (now - positionAt).coerceAtLeast(0L) / 1000.0 * playbackRate
        if (duration > 0 && seconds > duration) seconds = duration
        return (seconds.coerceAtLeast(0.0) * 1000).toLong()
    }

    companion object {
        fun parse(json: JSONObject?): MediaSessionInfo? {
            if (json == null) return null
            val tabId = json.strOrNull("tabId") ?: return null
            val position = json.optJSONObject("position")
            val actions = json.arr("actions")
            return MediaSessionInfo(
                tabId = tabId,
                title = json.str("title"),
                artist = json.str("artist"),
                album = json.str("album"),
                artwork = json.strOrNull("artwork")?.takeIf { it.isNotEmpty() },
                playing = json.bool("playing"),
                video = json.bool("video"),
                width = json.num("width").toInt(),
                height = json.num("height").toInt(),
                duration = position?.num("duration")?.takeIf { it.isFinite() } ?: 0.0,
                position = position?.num("position") ?: 0.0,
                playbackRate = position?.num("playbackRate", 1.0) ?: 1.0,
                hasPosition = position != null,
                positionAt = json.num("positionAt").toLong(),
                actions = (0 until actions.length()).mapNotNullTo(HashSet()) { actions.optString(it).takeIf(String::isNotEmpty) },
                fullscreen = json.bool("fullscreen"),
                private = json.bool("private")
            )
        }
    }
}

/** A control on the media notification, in the order Chrome lays them out. */
enum class MediaControl(
    /** The Media Session action the control sends back to the page. */
    val action: String,
    /** What the button says (its content description). */
    val label: String
) {
    PREVIOUS("previoustrack", "Previous track"),
    SEEK_BACKWARD("seekbackward", "Seek backward"),
    PLAY("play", "Play"),
    PAUSE("pause", "Pause"),
    SEEK_FORWARD("seekforward", "Seek forward"),
    NEXT("nexttrack", "Next track"),
    /** Chrome's X on a paused notification: the session goes until the page plays again. */
    STOP("stop", "Dismiss")
}

/**
 * What the OS controls show for a session, by Chrome's rules, kept free of Android so it runs
 * under plain JUnit: which buttons the notification carries and in what order, which of them
 * the collapsed notification keeps, and what the session tells the system it can do.
 */
object MediaControls {
    /** Chrome's seek buttons move by this much when the page handles no seek itself. */
    const val SEEK_OFFSET_S = 10.0

    /** The notification's title for a private tab's media: Chrome's, in place of the page's own. */
    const val PRIVATE_TITLE = "A site is playing media"

    /** The most buttons a media-style notification carries. */
    const val MAX_ACTIONS = 5

    /**
     * The buttons, in order: previous and next when the page handles them; seek backward and
     * forward when it handles them or the media can be seeked (the default handlers move the
     * element by [SEEK_OFFSET_S]); play or pause by the state; and, on a paused session, the
     * dismiss that Chrome's paused notification carries – when there is room for it.
     */
    fun controls(session: MediaSessionInfo): List<MediaControl> {
        val out = ArrayList<MediaControl>(MAX_ACTIONS)
        val seeks = session.seekable || "seekbackward" in session.actions || "seekforward" in session.actions
        if ("previoustrack" in session.actions) out += MediaControl.PREVIOUS
        if (seeks) out += MediaControl.SEEK_BACKWARD
        out += if (session.playing) MediaControl.PAUSE else MediaControl.PLAY
        if (seeks) out += MediaControl.SEEK_FORWARD
        if ("nexttrack" in session.actions) out += MediaControl.NEXT
        if (!session.playing && out.size < MAX_ACTIONS) out += MediaControl.STOP
        return out
    }

    /**
     * Which of [controls] the collapsed notification keeps (at most three): play / pause in the
     * middle with the track buttons when the page has them, else the seek buttons.
     */
    fun compact(controls: List<MediaControl>): IntArray {
        val toggle = controls.indexOfFirst { it == MediaControl.PLAY || it == MediaControl.PAUSE }
        val tracks = listOf(MediaControl.PREVIOUS, MediaControl.NEXT).map(controls::indexOf).filter { it >= 0 }
        val seeks = listOf(MediaControl.SEEK_BACKWARD, MediaControl.SEEK_FORWARD).map(controls::indexOf).filter { it >= 0 }
        val picked = (if (tracks.isNotEmpty()) tracks else seeks) + toggle
        return picked.filter { it >= 0 }.sorted().take(3).toIntArray()
    }

    /** The picture-in-picture window's buttons: play / pause, with previous and next when the page handles them (Chrome's set). */
    fun pictureInPictureControls(session: MediaSessionInfo): List<MediaControl> = controls(session).filter {
        it == MediaControl.PLAY || it == MediaControl.PAUSE || it == MediaControl.PREVIOUS || it == MediaControl.NEXT
    }

    /**
     * The Media Session action a control sends, with the details the page's default handler
     * needs: the seek buttons carry [SEEK_OFFSET_S] as `seekOffset`.
     */
    fun payload(tabId: String, control: MediaControl): JSONObject {
        val out = json("tabId" to tabId, "action" to control.action)
        if (control == MediaControl.SEEK_BACKWARD || control == MediaControl.SEEK_FORWARD) out.put("seekOffset", SEEK_OFFSET_S)
        return out
    }

    /** The notification's title: the page's, or Chrome's stand-in for a private tab's. */
    fun title(session: MediaSessionInfo): String = when {
        session.private -> PRIVATE_TITLE
        session.title.isNotEmpty() -> session.title
        else -> session.artist
    }

    /** The line under the title: the artist (the site when the page named none); nothing for a private tab. */
    fun text(session: MediaSessionInfo): String = when {
        session.private -> ""
        session.title.isNotEmpty() -> session.artist
        else -> ""
    }

    /**
     * Whether the window should go into picture-in-picture by itself when the user leaves for
     * Home: Chrome does it for a video playing fullscreen, and for nothing else.
     */
    fun autoEnterPictureInPicture(session: MediaSessionInfo?): Boolean =
        session != null && session.video && session.playing && session.fullscreen

    /** The picture-in-picture window's aspect ratio: the video's, within what Android accepts (1:2.39 … 2.39:1). */
    fun aspectRatio(width: Int, height: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return 16 to 9
        val ratio = width.toDouble() / height
        return when {
            ratio > MAX_ASPECT -> 239 to 100
            ratio < 1 / MAX_ASPECT -> 100 to 239
            else -> width to height
        }
    }

    private const val MAX_ASPECT = 2.39
}
