package app.zen.chromium

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaControllerCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import android.util.Rational
import android.view.View
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import app.zen.chromium.ext.ExtensionNotifications
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executor

/**
 * The pages' media on the OS controls, the Kotlin half of the core's `MediaSessionHost`
 * (`Platform.mediaSession` in `src/core/platform.ts`, `AndroidPlatform` in
 * `src/android/platform.ts`): the core resolves one session from the pages' reports – the page
 * playing, or the last one that did – and hands it over as `media.update`; this shows it as
 * Chrome Android does. One [MediaSessionCompat] carries the metadata and the playback state to
 * the system (the lock screen, the headset buttons, Android 13's media player in the shade, a
 * car's or a watch's controls), a media-style notification carries the buttons, and while the
 * session plays the notification is a foreground service's ([MediaPlaybackService]) so the
 * audio outlives the app's time on screen. Every control – a button on the notification, the
 * lock screen or the headset, a seek on the bar – goes back to the core as `media.action`, and
 * the tab's page carries it out (`MediaSessionService.act`).
 *
 * Audio focus is the engine's: the WebView's content layer (`org.chromium.content.browser
 * .AudioFocusDelegate`, the same code Chrome runs) requests it when a page's media starts and
 * answers its loss – another app's music pauses the page for good, a call or an assistant pauses
 * it for the moment and resumes it after, a navigation prompt has it duck. Nothing here requests
 * focus of its own: a second request from this process would take the focus from the engine's
 * listener, which then pauses the very page the session shows (the first emulator run did).
 *
 * Picture-in-picture is the activity's window: `media.pip` asks for it with the video's aspect
 * ratio and play / pause (and previous / next when the page handles them) as the window's
 * actions; on Android 12+ the window enters it by itself when the user goes Home from a video
 * playing fullscreen ([PictureInPictureParams.Builder.setAutoEnterEnabled]), on Android 8-11
 * [onUserLeaveHint] asks the same. The mode changes come back through
 * [onPictureInPictureModeChanged], which reports `media.pip` to the core (whose page lays the
 * video over the viewport for the small window) and pauses the video when the window was closed
 * rather than expanded, as Chrome's does.
 *
 * A session that is not a page's – a chrome player's, `source: "chrome"` (the read-aloud
 * player, registered with the core's `registerSource`) – shows and behaves like a page's audio:
 * the same metadata, playback state and notification, the foreground service while it plays,
 * its buttons back as `media.action` on its tab; only the picture-in-picture paths skip it (no
 * video: the window's params are those of no session while it holds the controls, `media.pip`
 * is refused, Home enters nothing).
 */
class MediaSessions(private val host: Host, private val io: Executor) {
    private val activity = host.activity
    private val context: Context = activity.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val manager = NotificationManagerCompat.from(context)
    private val session = MediaSessionCompat(context, "zenium")

    /** The session as the core last described it; null when the controls are down. */
    var current: MediaSessionInfo? = null
        private set
    private var artwork: Bitmap? = null
    private var artworkUrl: String? = null
    private var destroyed = false

    /** The tab whose page the window shows as picture-in-picture, once the system said it does. */
    var pictureInPictureTab: String? = null
        private set
    /** The tab a `media.pip` (or an auto-enter) asked the window into picture-in-picture for, until the system answers. */
    private var pictureInPictureRequested: String? = null

    /** Whether this device has picture-in-picture at all (Android TV and some Go devices do not). */
    val pictureInPictureSupported: Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    /** The session as the system sees it (its metadata and playback state), for diagnostics and the demos. */
    val controller: MediaControllerCompat get() = session.controller

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            val name = intent.getStringExtra(EXTRA_CONTROL) ?: return
            val control = MediaControl.entries.firstOrNull { it.name == name } ?: return
            act(control)
        }
    }

    private val callback = object : MediaSessionCompat.Callback() {
        override fun onPlay() = act(MediaControl.PLAY)
        override fun onPause() = act(MediaControl.PAUSE)
        override fun onStop() = act(MediaControl.STOP)
        override fun onSkipToNext() = act(MediaControl.NEXT)
        override fun onSkipToPrevious() = act(MediaControl.PREVIOUS)
        override fun onFastForward() = act(MediaControl.SEEK_FORWARD)
        override fun onRewind() = act(MediaControl.SEEK_BACKWARD)

        override fun onSeekTo(pos: Long) {
            val tabId = current?.tabId ?: return
            host.hostEvent("media.action", json("tabId" to tabId, "action" to "seekto", "seekTime" to pos / 1000.0))
        }

        override fun onCustomAction(action: String, extras: Bundle?) {
            MediaControl.entries.firstOrNull { customActionId(it) == action }?.let(::act)
        }
    }

    init {
        ContextCompat.registerReceiver(context, receiver, IntentFilter(ACTION_CONTROL), ContextCompat.RECEIVER_NOT_EXPORTED)
        session.setCallback(callback, main)
        session.setSessionActivity(openIntent(null))
    }

    // --- the core's MediaSessionHost -------------------------------------------------------------

    /** `media.update`: show `json` (a `MediaSessionInfo`) on the OS controls, or take them down with null. */
    fun update(json: JSONObject?) {
        if (destroyed) return
        val info = MediaSessionInfo.parse(json)
        if (info == null) {
            clear()
            return
        }
        val before = current
        current = info
        if (before?.tabId != info.tabId || info.private) {
            artwork = null
            artworkUrl = null
        }
        if (!info.private) loadArtwork(info)
        publish(info)
        updatePictureInPictureParams()
    }

    /** The controls go: the session ended (its tab closed, its media gone). */
    private fun clear() {
        val had = current != null
        current = null
        artwork = null
        artworkUrl = null
        MediaPlaybackService.background(keepNotification = false)
        manager.cancel(MediaPlaybackService.NOTIFICATION_ID)
        if (session.isActive) session.isActive = false
        session.setPlaybackState(PlaybackStateCompat.Builder().setState(PlaybackStateCompat.STATE_NONE, 0L, 0f).build())
        if (had) updatePictureInPictureParams()
    }

    /**
     * The session, as the system and the notification see it now. Playing, the notification is
     * the foreground service's – with the app's notifications turned off the card stays unseen,
     * but the service still keeps the process, and the audio, running behind other apps.
     */
    private fun publish(info: MediaSessionInfo) {
        session.setMetadata(metadataOf(info))
        session.setPlaybackState(playbackStateOf(info))
        if (!session.isActive) session.isActive = true
        val notification = notificationOf(info)
        if (info.playing) {
            if (!MediaPlaybackService.foreground(context, notification)) post(notification)
        } else {
            MediaPlaybackService.background(keepNotification = true)
            post(notification)
        }
    }

    private fun post(notification: Notification) {
        if (!manager.areNotificationsEnabled()) return
        runCatching { manager.notify(MediaPlaybackService.NOTIFICATION_ID, notification) }
    }

    /** A control pressed (on the notification, the lock screen, a headset, the picture-in-picture window): the core's page carries it out. */
    private fun act(control: MediaControl) {
        val tabId = current?.tabId ?: return
        host.hostEvent("media.action", MediaControls.payload(tabId, control))
    }

    // --- what the system sees ----------------------------------------------------------------------

    private fun metadataOf(info: MediaSessionInfo): MediaMetadataCompat {
        val builder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, MediaControls.title(info))
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, MediaControls.title(info))
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, if (info.private) "" else info.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, MediaControls.text(info))
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, if (info.private) "" else info.album)
            // -1: unknown, no seek bar (a live stream, or an element with no duration yet).
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, if (info.seekable) (info.duration * 1000).toLong() else -1L)
        val art = artwork?.takeIf { !info.private && artworkUrl == info.artwork }
        if (art != null) {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art)
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, art)
        }
        return builder.build()
    }

    private fun playbackStateOf(info: MediaSessionInfo): PlaybackStateCompat {
        val controls = MediaControls.controls(info)
        var actions = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP
        if (info.seekable) actions = actions or PlaybackStateCompat.ACTION_SEEK_TO
        if (MediaControl.NEXT in controls) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
        if (MediaControl.PREVIOUS in controls) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        if (MediaControl.SEEK_FORWARD in controls) actions = actions or PlaybackStateCompat.ACTION_FAST_FORWARD or PlaybackStateCompat.ACTION_REWIND
        val now = System.currentTimeMillis()
        val builder = PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(
                if (info.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                info.positionMs(now),
                if (info.playing) info.playbackRate.toFloat() else 0f,
                SystemClock.elapsedRealtime()
            )
        // Android 13's media player draws its buttons from the state, not the notification: the
        // seek buttons (and a paused session's dismiss) ride along as custom actions.
        for (control in controls) {
            if (control == MediaControl.SEEK_BACKWARD || control == MediaControl.SEEK_FORWARD || control == MediaControl.STOP) {
                builder.addCustomAction(customActionId(control), control.label, iconOf(control))
            }
        }
        return builder.build()
    }

    private fun notificationOf(info: MediaSessionInfo): Notification {
        ensureChannel(context)
        val controls = MediaControls.controls(info)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_zenium)
            .setContentTitle(MediaControls.title(info))
            .setContentText(MediaControls.text(info))
            .setContentIntent(openIntent(info.tabId))
            .setDeleteIntent(controlIntent(MediaControl.STOP))
            .setOngoing(info.playing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(*MediaControls.compact(controls))
            )
        if (!info.private && info.album.isNotEmpty()) builder.setSubText(info.album)
        artwork?.takeIf { !info.private && artworkUrl == info.artwork }?.let(builder::setLargeIcon)
        for (control in controls) builder.addAction(iconOf(control), control.label, controlIntent(control))
        return builder.build()
    }

    private fun iconOf(control: MediaControl): Int = when (control) {
        MediaControl.PREVIOUS -> R.drawable.ic_media_previous
        MediaControl.SEEK_BACKWARD -> R.drawable.ic_media_replay
        MediaControl.PLAY -> R.drawable.ic_media_play
        MediaControl.PAUSE -> R.drawable.ic_media_pause
        MediaControl.SEEK_FORWARD -> R.drawable.ic_media_forward
        MediaControl.NEXT -> R.drawable.ic_media_next
        MediaControl.STOP -> R.drawable.ic_media_close
    }

    private fun controlIntent(control: MediaControl): PendingIntent {
        val intent = Intent(ACTION_CONTROL).setPackage(context.packageName).putExtra(EXTRA_CONTROL, control.name)
        return PendingIntent.getBroadcast(context, CONTROL_REQUEST_BASE + control.ordinal, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** A tap on the notification (or the system's media player) brings the app to the session's tab. */
    private fun openIntent(tabId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(ACTION_OPEN)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        if (tabId != null) intent.putExtra(EXTRA_TAB, tabId)
        return PendingIntent.getActivity(context, OPEN_REQUEST, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** [MainActivity] got the notification's tap: the session's tab comes to the front. */
    fun onOpenIntent(intent: Intent) {
        val tabId = intent.getStringExtra(EXTRA_TAB) ?: current?.tabId ?: return
        host.hostEvent("media.reveal", json("tabId" to tabId))
    }

    /**
     * The artwork the page offered, fetched off the main thread and scaled to what the controls
     * show (the lock screen's background wants no more than [MAX_ART_PX]); the controls are
     * republished with it once it is here. `data:` URLs are decoded in place; `blob:` ones cannot
     * be read from here and are left out.
     */
    private fun loadArtwork(info: MediaSessionInfo) {
        val url = info.artwork ?: return
        if (url == artworkUrl) return
        artworkUrl = url
        io.execute {
            val bitmap = fetchBitmap(url)
            main.post {
                if (destroyed || bitmap == null) return@post
                val now = current ?: return@post
                if (now.artwork != url || now.private) return@post
                artwork = bitmap
                publish(now)
                updatePictureInPictureParams()
            }
        }
    }

    // --- picture-in-picture ----------------------------------------------------------------------

    /** `media.pip`: the window into picture-in-picture for the video of `json`'s tab; answers whether it went (never for a chrome player). */
    fun enterPictureInPicture(json: JSONObject, reply: (Any?) -> Unit) {
        val info = MediaSessionInfo.parse(json)
        if (info == null || info.chrome || !pictureInPictureSupported || destroyed) {
            reply(false)
            return
        }
        if (activity.isInPictureInPictureMode) {
            reply(pictureInPictureTab == info.tabId)
            return
        }
        pictureInPictureRequested = info.tabId
        val entered = runCatching { activity.enterPictureInPictureMode(paramsOf(info, autoEnter = false)) }
            .onFailure { Log.w(TAG, "picture-in-picture refused: $it") }
            .getOrDefault(false)
        if (!entered) pictureInPictureRequested = null
        reply(entered)
    }

    /**
     * Android 8-11 have no auto-enter: when the user leaves for Home while a video plays
     * fullscreen, the activity's `onUserLeaveHint` asks for the small window here (on Android 12+
     * the params carry [PictureInPictureParams.Builder.setAutoEnterEnabled] instead, and the
     * system does it with the Home animation).
     */
    fun onUserLeaveHint() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S || !pictureInPictureSupported || destroyed) return
        val info = current ?: return
        if (!autoEnter(info) || activity.isInPictureInPictureMode) return
        pictureInPictureRequested = info.tabId
        val entered = runCatching { activity.enterPictureInPictureMode(paramsOf(info, autoEnter = false)) }.getOrDefault(false)
        if (!entered) pictureInPictureRequested = null
    }

    /**
     * The window entered or left picture-in-picture ([MainActivity.onPictureInPictureModeChanged]).
     * In: the tab's view alone fills the small window (unless its video is fullscreen already,
     * whose view fills it as it is) and the core hears `media.pip`, whose page lays the video
     * over the viewport. Out: the view goes back to where the chrome puts it, and the core hears
     * the same; a window closed with its X rather than expanded – the activity is stopping – also
     * pauses the video, as Chrome does.
     */
    fun onPictureInPictureModeChanged(active: Boolean) {
        if (active) {
            val tabId = pictureInPictureRequested ?: current?.tabId ?: return
            pictureInPictureRequested = null
            pictureInPictureTab = tabId
            if (host.fullscreenTab?.tabId != tabId) host.tabs.fillWindow(tabId)
            host.hostEvent("media.pip", json("tabId" to tabId, "active" to true))
            return
        }
        pictureInPictureRequested = null
        val tabId = pictureInPictureTab ?: return
        pictureInPictureTab = null
        host.tabs.fillWindow(null)
        val dismissed = !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        host.hostEvent("media.pip", json("tabId" to tabId, "active" to false, "dismissed" to dismissed))
        if (dismissed && current?.tabId == tabId && current?.playing == true) act(MediaControl.PAUSE)
    }

    /** A page's element went fullscreen or came back ([Host.enterFullscreen] / [Host.exitFullscreen]): the auto-enter rule follows. */
    fun onFullscreenChanged() = updatePictureInPictureParams()

    /**
     * Chrome's rule for going into the small window by itself when the user leaves: a video
     * playing fullscreen – by the page's own word ([MediaSessionInfo.fullscreen]) or the
     * WebView's (the tab's element is in the host's fullscreen layer). Never for a chrome player.
     */
    private fun autoEnter(info: MediaSessionInfo?): Boolean {
        if (info == null || info.chrome) return false
        return MediaControls.autoEnterPictureInPicture(info) ||
            (info.video && info.playing && host.fullscreenTab?.tabId == info.tabId)
    }

    /**
     * The activity's params, kept current with the session: the auto-enter rule and the window's
     * actions. While a chrome player holds the controls they are those of no session (as after
     * [clear]): no video to frame, and a page's auto-enter from before must not linger and pull
     * the player's tab into the small window from Home.
     */
    private fun updatePictureInPictureParams() {
        if (!pictureInPictureSupported || destroyed) return
        val info = current?.takeIf(MediaControls::pictureInPictureEligible)
        runCatching { activity.setPictureInPictureParams(paramsOf(info, autoEnter(info))) }
    }

    private fun paramsOf(info: MediaSessionInfo?, autoEnter: Boolean): PictureInPictureParams {
        val builder = PictureInPictureParams.Builder()
        if (info != null) {
            val (width, height) = MediaControls.aspectRatio(info.width, info.height)
            builder.setAspectRatio(Rational(width, height))
            builder.setActions(MediaControls.pictureInPictureControls(info).map(::remoteAction))
            sourceRect(info.tabId)?.let(builder::setSourceRectHint)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(autoEnter)
            builder.setSeamlessResizeEnabled(true)
        }
        return builder.build()
    }

    /** Where the video is on screen, for the system's animation into the small window. */
    private fun sourceRect(tabId: String): Rect? {
        val view: View = host.fullscreenTab?.takeIf { it.tabId == tabId }?.let { host.fullscreenView } ?: host.tabs.get(tabId) ?: return null
        if (view.width <= 0 || view.height <= 0) return null
        val out = IntArray(2)
        view.getLocationInWindow(out)
        return Rect(out[0], out[1], out[0] + view.width, out[1] + view.height)
    }

    private fun remoteAction(control: MediaControl): RemoteAction =
        RemoteAction(Icon.createWithResource(context, iconOf(control)), control.label, control.label, controlIntent(control))

    fun destroy() {
        destroyed = true
        clear()
        runCatching { context.unregisterReceiver(receiver) }
        session.release()
    }

    companion object {
        private const val TAG = "ZenMedia"
        /** Chrome's channel for its media notification: "Media playback", silent. */
        const val CHANNEL_ID = "zenium.media"
        const val CHANNEL_NAME = "Media playback"
        /** The buttons' broadcasts (the notification's, the picture-in-picture window's). */
        const val ACTION_CONTROL = "app.zen.chromium.MEDIA_CONTROL"
        /** The notification's tap: `MainActivity.handleIntent` hands it to [onOpenIntent]. */
        const val ACTION_OPEN = "app.zen.chromium.MEDIA_OPEN"
        const val EXTRA_CONTROL = "control"
        const val EXTRA_TAB = "tabId"
        private const val CONTROL_REQUEST_BASE = 700
        private const val OPEN_REQUEST = 799
        /** The lock screen's background is the artwork; more pixels than this buy nothing. */
        private const val MAX_ART_PX = 512
        private const val MAX_ART_BYTES = 8L * 1024 * 1024
        private const val FETCH_TIMEOUT_MS = 10_000

        fun customActionId(control: MediaControl): String = "zenium.media.${control.action}"

        fun ensureChannel(context: Context) {
            val system = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (system.getNotificationChannel(CHANNEL_ID) != null) return
            system.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Controls for audio and video playing in Zenium"
                    setShowBadge(false)
                    enableVibration(false)
                    setSound(null, null)
                }
            )
        }

        /** The picture at `url` (`https:`, `http:` or `data:`), decoded to at most [MAX_ART_PX] a side, or null. */
        fun fetchBitmap(url: String, maxPx: Int = MAX_ART_PX): Bitmap? {
            val bytes = runCatching {
                if (url.startsWith("data:", ignoreCase = true)) ExtensionNotifications.imageBytes(null, url)
                else if (url.startsWith("http://", ignoreCase = true) || url.startsWith("https://", ignoreCase = true)) {
                    val connection = URL(url).openConnection() as HttpURLConnection
                    connection.connectTimeout = FETCH_TIMEOUT_MS
                    connection.readTimeout = FETCH_TIMEOUT_MS
                    connection.instanceFollowRedirects = true
                    try {
                        if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
                        if (connection.contentLengthLong > MAX_ART_BYTES) return null
                        connection.inputStream.use { stream ->
                            val out = java.io.ByteArrayOutputStream()
                            val buffer = ByteArray(16 * 1024)
                            var total = 0L
                            while (true) {
                                val n = stream.read(buffer)
                                if (n < 0) break
                                total += n
                                if (total > MAX_ART_BYTES) return null
                                out.write(buffer, 0, n)
                            }
                            out.toByteArray()
                        }
                    } finally {
                        connection.disconnect()
                    }
                } else null
            }.getOrNull() ?: return null
            return runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
                val options = BitmapFactory.Options().apply { inSampleSize = ExtensionNotifications.sampleSize(bounds.outWidth, bounds.outHeight, maxPx) }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            }.getOrNull()
        }
    }
}
