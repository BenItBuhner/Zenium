package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.Rect
import android.media.AudioManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.service.notification.StatusBarNotification
import android.support.v4.media.MediaMetadataCompat
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.pow
import kotlin.math.sin

/**
 * Records the media engine on the phone, Chrome Android's behaviour being the bar:
 *
 *  1. a page playing a track with Media Session metadata -> the media notification (a foreground
 *     `mediaPlayback` service, audio focus), the system's media player in the shade worked with
 *     real fingers (Pause, Seek forward, Next track – the page's own handler –, Play), the
 *     headset / media buttons through the input pipeline, then the lock screen: the track goes
 *     on with the screen off and its controls stand on the lock screen;
 *  2. a video: picture-in-picture on request with the clip's aspect ratio, the small window's
 *     Pause / Play under a finger, back to full size, then the auto-enter – the video playing
 *     fullscreen and Home – and the window closed with its X pausing the video;
 *  3. the Notification API: the page asks, the in-chrome prompt is answered with a finger, the
 *     notification lands under a channel of the site's own (the "Sites" group), and a finger on
 *     the card in the shade brings the tab up and reaches the page as `click`;
 *  4. private browsing: a private tab on its own profile (the normal profile's cookie is not
 *     there), the window secured while it shows (Chrome's FLAG_SECURE: the stills of that part
 *     are black by design), the "Close all private tabs" card in the shade under a finger, and
 *     the wipe once every private tab is gone (a new private tab finds no cookie);
 *  5. the session ends with its tab: the notification and the service go when the tab closes.
 *
 * The pages come from a loopback server inside this process ([DemoServer]; the track and the
 * artwork are generated here, the clip is an asset) and report what they see through their
 * titles (`MD|kind:audio|state:playing|t:12|last:nexttrack`), which the driver reads from the
 * core's state. Everything measured goes to `<shotPrefix>-notes.txt` next to the stills. Every
 * control pressed – on the page, in a sheet, in the shade, on the lock screen, on the
 * picture-in-picture window – is a real injected touch with an assertion on what it did (the
 * rule in [DemoHarness]); a media key that does nothing fails the run the same way.
 */
@RunWith(AndroidJUnit4::class)
class MediaDemo : DemoHarness("media-demo-state.json", "services-android-media-android", "media-demo") {
    override val tag = "MediaDemo"
    private lateinit var server: DemoServer
    private lateinit var notes: File
    private val notificationManager: NotificationManager by lazy { app.getSystemService(NotificationManager::class.java) }
    private val audioManager: AudioManager by lazy { app.getSystemService(AudioManager::class.java) }
    private val host: Host get() = (activity as MainActivity).host

    @Test
    fun record() {
        val page = "text/html; charset=utf-8" to readAsset("media-demo-page.html").toByteArray()
        server = DemoServer(
            PORT,
            mapOf(
                "/audio" to page,
                "/video" to page,
                "/notify" to page,
                "/private" to page,
                "/tone.wav" to ("audio/wav" to tone()),
                "/clip.mp4" to ("video/mp4" to readAssetBytes("media-demo-clip.mp4")),
                "/art.png" to ("image/png" to art())
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun warmUp() {
        notes = File(out, "services-android-media-android-notes.txt")
        notes.writeText("Zenium Android media demo\n\n")
        note("demo server: ${server.selfCheck()}")
        val webView = runCatching { WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull()
        note("webview: ${webView ?: "unknown"}; sdk ${Build.VERSION.SDK_INT}")
        note("profiles (WebViewFeature.MULTI_PROFILE): ${Profiles.supported}; picture-in-picture feature: ${host.media.pictureInPictureSupported}")
        val caps = coreState().getJSONObject("capabilities")
        note("capabilities: pictureInPicture=${caps.optBoolean("pictureInPicture")} privateTabs=${caps.optBoolean("privateTabs")}")
        note("notifications enabled: ${notificationManager.areNotificationsEnabled()}")
        waitTitle(TAB, 20_000) { it.startsWith("MD|") }
        note("seeded tab: ${describeTab(TAB)}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        audioStep()
        lockScreenStep()
        videoStep()
        notificationStep()
        privateStep()
        closeStep()
        note("\ndone")
    }

    // --- 1. background audio and the media notification -----------------------------------------

    private fun audioStep() {
        note("\n1. background audio: a page playing a track -> the media notification (MW-07, MW-17, MW-16)")
        shot("01-audio-page")
        beat()
        note("  before play: media notification ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}; session ${describeSession()}")
        tapPageButton("play", "Play track", "the page reports the track playing", 15_000) { field("state") == "playing" }
        val sbn = awaitNotification(MediaPlaybackService.NOTIFICATION_ID, 15_000)
        note("  media notification: ${describe(sbn)}")
        note("  foreground service: ${MediaPlaybackService.inForeground}; audio focus held: ${host.media.hasAudioFocus}")
        note("  session: ${describeSession()}")
        note("  core media state: ${mediaState(TAB)}")
        if (sbn == null) touchFault("no media notification came up for the playing track")
        SystemClock.sleep(1_500)
        shot("02-audio-playing")
        beat()

        // The shade: the system's media player draws the session; every button is a finger.
        if (openShade { it == "Pause" }) {
            SystemClock.sleep(1_500)
            shot("03-shade-media-playing")
            beat()
            touchInWindows("Pause", "the page pauses") { field("state") == "paused" }
            SystemClock.sleep(1_500)
            note("  after Pause: ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}; service foreground=${MediaPlaybackService.inForeground}")
            shot("04-shade-media-paused")
            beat()
            val t0 = field("t")?.toIntOrNull() ?: 0
            touchInWindows("Seek forward", "the position moves on by ten seconds (the browser's default seek)") {
                (field("t")?.toIntOrNull() ?: 0) >= t0 + 8
            }
            note("  after Seek forward: t $t0 -> ${field("t")}")
            touchInWindows("Next track", "the page's nexttrack handler runs") { field("last") == "nexttrack" }
            note("  after Next track: last=${field("last")} track=${field("track")}; the session's title now \"${sessionTitle()}\"")
            touchInWindows("Play", "the page plays again") { field("state") == "playing" }
            SystemClock.sleep(1_500)
            shot("05-shade-media-next-track")
            beat()
        } else {
            note("  the shade never showed the media player's Pause button")
        }
        closeShade()

        // The headset / media buttons: KEYCODE_MEDIA_* through the input pipeline reach the session's callback.
        note("  media buttons:")
        mediaKeyExpecting(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, "pauses the page") { field("state") == "paused" }
        mediaKeyExpecting(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, "plays the page again") { field("state") == "playing" }
        mediaKeyExpecting(KeyEvent.KEYCODE_MEDIA_PREVIOUS, "runs the page's previoustrack handler") { field("last") == "previoustrack" }
        note("  page now: ${title()}")
    }

    // --- 2. the lock screen ---------------------------------------------------------------------

    private fun lockScreenStep() {
        note("\n2. the lock screen: the screen goes off with the track playing; its controls stand on the lock screen (MW-07)")
        val keyguard = app.getSystemService(KeyguardManager::class.java)
        val power = app.getSystemService(PowerManager::class.java)
        val tBefore = field("t")?.toIntOrNull() ?: -1
        key(KeyEvent.KEYCODE_SLEEP)
        SystemClock.sleep(5_000)
        val tDark = field("t")?.toIntOrNull() ?: -1
        note("  screen off: interactive=${power.isInteractive}; position $tBefore -> $tDark (the track went on: ${tDark > tBefore}); state=${field("state")}")
        key(KeyEvent.KEYCODE_WAKEUP)
        SystemClock.sleep(3_000)
        val locked = keyguard.isKeyguardLocked
        note("  awake: interactive=${power.isInteractive} keyguard locked=$locked")
        if (locked) {
            val card = awaitInWindows(10_000) { it == "Pause" || it == "Play" }
            note("  lock screen media controls: ${if (card != null) "'${label(card)}' at ${bounds(card)}" else "none in any window"}")
            if (card == null) dumpWindows("lock screen")
            shot("06-lock-screen-media")
            beat()
            if (card != null) {
                if (field("state") == "playing") {
                    touchInWindows("Pause", "the lock screen's Pause pauses the page") { field("state") == "paused" }
                    SystemClock.sleep(1_200)
                    touchInWindows("Play", "the lock screen's Play plays the page again") { field("state") == "playing" }
                } else {
                    touchInWindows("Play", "the lock screen's Play plays the page") { field("state") == "playing" }
                }
            }
            unlock(keyguard)
        }
        ensureForeground()
        SystemClock.sleep(1_500)
        note("  back in the app: ${describeTab(TAB)}; keyguard locked=${keyguard.isKeyguardLocked}")
        shot("07-back-from-lock-screen")
    }

    /** A swipe up on the (insecure) keyguard; the activity asks for its dismissal when the swipe did not take. */
    private fun unlock(keyguard: KeyguardManager) {
        Finger().apply {
            down(width / 2f, height * 0.85f)
            moveBy(0f, -height * 0.6f, 260)
            up()
        }
        if (poll(6_000) { !keyguard.isKeyguardLocked }) {
            note("  unlocked with a swipe")
            return
        }
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            keyguard.requestDismissKeyguard(activity, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = latch.countDown()
                override fun onDismissCancelled() = latch.countDown()
                override fun onDismissError() = latch.countDown()
            })
        }
        latch.await(8, TimeUnit.SECONDS)
        note("  unlocked through requestDismissKeyguard: locked=${keyguard.isKeyguardLocked}")
    }

    // --- 3. video and picture-in-picture --------------------------------------------------------

    private fun videoStep() {
        note("\n3. video: picture-in-picture (MW-08)")
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/video"}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:video") }
        SystemClock.sleep(1_500)
        note("  video page: ${describeTab(TAB)}")
        note("  the audio page left behind: notification ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}; session ${describeSession()}")
        shot("08-video-page")
        tapPageButton("play", "Play video", "the page reports the video playing", 15_000) { field("state") == "playing" }
        SystemClock.sleep(2_000)
        note("  playing: ${title()}; session ${describeSession()}")
        note("  notification: ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}")
        shot("09-video-playing")
        beat()

        // Into the small window on request: the path the in-app control takes (`media.pictureInPicture`).
        val entered = coreInvoke("media.pictureInPicture", """{"tabId":"$TAB"}""")
        note("  media.pictureInPicture -> $entered")
        if (awaitPip(true, 10_000)) {
            SystemClock.sleep(3_000)
            val win = appWindowBounds()
            note(
                "  in picture-in-picture: window $win (${ratio(win)}; the clip is ${field("size")}), host pip tab=${host.media.pictureInPictureTab}, " +
                    "core media pictureInPicture=${mediaState(TAB)?.optBoolean("pictureInPicture")}, fill attribute on the video: ${pageJs("document.getElementById('media').hasAttribute('data-zenium-pip')")}"
            )
            shot("10-pip-window")
            beat()
            // The window's own controls: a tap on the window shows its menu, whose Pause is the session's.
            if (win != null) {
                Finger().tap(win.exactCenterX(), win.exactCenterY())
                val pause = awaitInWindows(6_000) { it == "Pause" }
                note("  pip menu: ${if (pause != null) "Pause at ${bounds(pause)}" else "no Pause in any window"}")
                if (pause == null) dumpWindows("pip menu")
                shot("11-pip-menu")
                if (pause != null) {
                    touchInWindows("Pause", "the small window's Pause pauses the video") { field("state") == "paused" }
                    SystemClock.sleep(1_500)
                    shot("12-pip-paused")
                    if (awaitInWindows(3_000) { it == "Play" } == null) {
                        Finger().tap(win.exactCenterX(), win.exactCenterY())
                    }
                    touchInWindows("Play", "the small window's Play plays the video again") { field("state") == "playing" }
                }
            } else {
                dumpWindows("pip window")
            }
            // Back to full size: the app's task to the front expands the window, as the menu's expand button does.
            bringToFront()
            note("  expanded back into the app: left pip=${awaitPip(false, 8_000)}; host pip tab=${host.media.pictureInPictureTab}; fill attribute: ${pageJs("document.getElementById('media').hasAttribute('data-zenium-pip')")}")
        } else {
            note("  the window never entered picture-in-picture (isInPictureInPictureMode stayed false)")
            touchFault("media.pictureInPicture did not put the window into picture-in-picture")
        }
        ensureForeground()
        SystemClock.sleep(2_000)
        shot("13-video-back-in-app")
        beat()

        // Chrome's auto-enter: the video playing fullscreen, and Home.
        tapPageButton("fullscreen", "Play fullscreen", "the video goes fullscreen", 15_000) {
            field("fs") == "1" || host.fullscreenTab?.tabId == TAB
        }
        SystemClock.sleep(2_500)
        note("  fullscreen: page fs=${field("fs")} host fullscreenTab=${host.fullscreenTab?.tabId} state=${field("state")}")
        shot("14-video-fullscreen")
        beat()
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val auto = awaitPip(true, 10_000)
        note("  Home with the video playing fullscreen -> picture-in-picture by itself: $auto")
        if (!auto) touchFault("Home with the video playing fullscreen did not enter picture-in-picture")
        SystemClock.sleep(3_000)
        val win = appWindowBounds()
        note("  window now $win (${ratio(win)}); state=${field("state")}")
        shot("15-pip-auto-enter")
        beat()
        // Closed with its X rather than expanded: the video pauses, as Chrome's does.
        var closed = false
        if (auto && win != null) {
            Finger().tap(win.exactCenterX(), win.exactCenterY())
            val close = awaitInWindows(6_000) { it == "Close" }
            if (close != null) {
                closed = touchInWindows("Close", "the window closes and the video pauses", timeoutMs = 10_000) { !inPip() && field("state") == "paused" }
                SystemClock.sleep(1_500)
                note("  after Close: in pip=${inPip()} state=${field("state")} notification ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}")
            } else {
                note("  no Close button in the pip menu")
                dumpWindows("pip menu (close)")
            }
        }
        if (closed) {
            // The app is stopped behind the launcher now: the media notification's tap is the way back, as for a user.
            if (openShade { it.startsWith("Zenium demo clip") }) {
                SystemClock.sleep(1_500)
                shot("16-shade-after-pip-close")
                touchInWindows("Zenium demo clip", "the app comes back to the front on the clip's tab", timeoutMs = 12_000, matches = { it.startsWith("Zenium demo clip") }) {
                    ui.rootInActiveWindow?.packageName?.toString() == app.packageName && !inPip()
                }
            }
            if (ui.rootInActiveWindow?.packageName?.toString() != app.packageName) {
                closeShade()
                bringToFront()
            }
        } else if (inPip()) {
            bringToFront()
        }
        awaitPip(false, 8_000)
        ensureForeground()
        SystemClock.sleep(1_500)
        if (host.fullscreenTab != null) {
            back()
            SystemClock.sleep(2_000)
            if (host.fullscreenTab != null) pageJs("document.exitFullscreen && document.exitFullscreen()")
            SystemClock.sleep(1_500)
        }
        note("  back in the app: fullscreenTab=${host.fullscreenTab?.tabId} pip=${inPip()} ${describeTab(TAB)}")
        shot("17-video-after-pip")
        beat()
    }

    // --- 4. web notifications -------------------------------------------------------------------

    private fun notificationStep() {
        note("\n4. web notifications: the page asks, the prompt answers, the site's own channel, the tap (MW-05)")
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/notify"}""")
        waitTitle(TAB, 20_000) { it.startsWith("NT|") }
        SystemClock.sleep(1_500)
        note("  page: ${describeTab(TAB)} (Notification.permission before asking)")
        shot("18-notify-page")
        beat()
        tapPageButton("ask", "Ask and notify", "the core shows the permission prompt", 15_000) { prompt() != null }
        val prompt = prompt()
        note("  prompt: ${prompt?.toString() ?: "none"}")
        if (prompt != null) {
            waitFor("Allow", 8_000)
            SystemClock.sleep(1_500)
            shot("19-notification-prompt")
            beat()
            // A real finger on Allow (the prompt sheet's touch under the rule in DemoHarness): the page reads granted and posts.
            if (!touchTapLabelExpecting("Allow", "the page reads granted", timeoutMs = 15_000, took = { field("permission") == "granted" })) {
                note("  Allow did not take under a finger; the page reads ${field("permission")}")
            }
        }
        val sbn = awaitNotification(WebNotifications.NOTIFICATION_ID, 15_000) { it.tag?.contains(server.origin) == true }
        note("  web notification: ${describe(sbn)}")
        if (sbn == null) touchFault("the page's notification never reached the notification manager")
        note("  page: ${title()}")
        val channel = sbn?.notification?.channelId?.let { notificationManager.getNotificationChannel(it) }
        val group = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) channel?.group?.let { notificationManager.getNotificationChannelGroup(it) } else null
        note("  channel: id=${channel?.id} name=\"${channel?.name}\" importance=${channel?.importance} group=${group?.id} \"${group?.name}\"")
        note("  rules for notifications: ${coreInvoke("permissions.listForPermission", """{"permission":"notifications"}""")}")
        SystemClock.sleep(1_500)
        shot("20-notification-granted")
        beat()
        if (sbn != null && openShade { it.startsWith("Hello from a page in Zenium") }) {
            SystemClock.sleep(1_500)
            shot("21-shade-web-notification")
            beat()
            // A finger on the card: the app comes up on the page's tab and the page hears click.
            touchInWindows("Hello from a page in Zenium", "the page hears the click", timeoutMs = 12_000, matches = { it.startsWith("Hello from a page in Zenium") }) {
                field("clicked") == "1"
            }
            SystemClock.sleep(1_500)
            note("  after the tap: ${title()}; active tab ${activeCoreTab()?.optString("id")}; card left: ${describe(activeNotification(WebNotifications.NOTIFICATION_ID))}; front=${ui.rootInActiveWindow?.packageName}")
        }
        if (ui.rootInActiveWindow?.packageName?.toString() != app.packageName) closeShade()
        ensureForeground()
        SystemClock.sleep(1_000)
        shot("22-notify-page-clicked")
        beat()

        // The system's word on the channel: the app's notification settings list the site under Sites.
        runCatching {
            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, app.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            app.startActivity(intent)
        }.onFailure { note("  notification settings refused: $it") }
        if (awaitSystemWindow(8_000)) {
            SystemClock.sleep(3_000)
            val site = awaitInWindows(6_000) { it == SitesChannels.displayName(server.origin) }
            note("  system notification settings: the site's channel \"${SitesChannels.displayName(server.origin)}\" ${if (site != null) "listed" else "not in the tree (may be below the fold)"}; Sites group ${if (findInWindows { it == SitesChannels.GROUP_NAME } != null) "listed" else "not in the tree"}")
            shot("23-system-notification-channels")
            beat()
            back()
            SystemClock.sleep(2_000)
        }
        if (ui.rootInActiveWindow?.packageName?.toString() != app.packageName) bringToFront()
        ensureForeground()
        SystemClock.sleep(1_500)
    }

    // --- 5. private browsing --------------------------------------------------------------------

    private fun privateStep() {
        note("\n5. private browsing: its own profile, the secured window, the 'Close all private tabs' card, the wipe (ID-07)")
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/private?set=1"}""")
        waitTitle(TAB, 20_000) { it.startsWith("PV|") }
        note("  normal tab, its cookie stored on the default profile: ${describeTab(TAB)}; FLAG_SECURE=${secure()}")
        val privateId = newPrivateTab("${server.origin}/private?peek=1&who=incognito")
        if (privateId == null) {
            note("  tab.newPrivate returned null (capabilities.privateTabs=${coreState().getJSONObject("capabilities").optBoolean("privateTabs")})")
            return
        }
        waitTitle(privateId, 20_000) { it.startsWith("PV|") }
        SystemClock.sleep(2_000)
        note("  fresh private tab: ${describeTab(privateId)} (the default profile's cookie is not there)")
        note("  window FLAG_SECURE=${secure()} (Chrome's incognito: no screenshots, a blank Recents card – this still is black by design)")
        note("  private card: ${describe(activeNotification(PrivateSession.NOTIFICATION_ID))}")
        if (field("cookie", privateId) != "no") touchFault("the private tab saw the default profile's cookie: ${title(privateId)}")
        shot("24-private-tab-secured")
        beat()
        coreInvoke("tab.navigate", """{"tabId":"$privateId","input":"${server.origin}/private?set=1&who=incognito"}""")
        waitTitle(privateId, 20_000) { it.contains("cookie:yes") }
        note("  private tab after storing its own cookie: ${describeTab(privateId)}")
        note("  history entries for 'incognito' (the private tab's URLs; none expected): ${coreInvoke("history.search", """{"query":"incognito","limit":20}""")}")

        // The card in the shade, under a finger: every private tab closes and the profile is wiped.
        if (openShade { it == PrivateSession.TITLE }) {
            SystemClock.sleep(1_500)
            shot("25-shade-private-card")
            beat()
            touchInWindows(PrivateSession.TITLE, "every private tab closes", timeoutMs = 12_000) { privateTabs().isEmpty() }
            SystemClock.sleep(2_500)
            note("  after the card: private tabs=${privateTabs().size}, card ${describe(activeNotification(PrivateSession.NOTIFICATION_ID))}, FLAG_SECURE=${secure()}, tabs=${coreState().getJSONObject("tabs").length()}")
            note("  recently closed lists the private tab: ${if (coreInvoke("session.recentlyClosed").contains("incognito")) "YES" else "no"}")
        } else {
            note("  the shade never showed the private card")
            dumpWindows("shade (private)")
            coreInvoke("tab.close", """{"tabId":"$privateId"}""")
            SystemClock.sleep(3_000)
        }
        if (ui.rootInActiveWindow?.packageName?.toString() != app.packageName) closeShade()
        ensureForeground()
        SystemClock.sleep(2_500)
        val again = newPrivateTab("${server.origin}/private?peek=1&who=incognito")
        if (again != null) {
            waitTitle(again, 20_000) { it.startsWith("PV|") }
            SystemClock.sleep(1_500)
            note("  new private tab after the wipe: ${describeTab(again)} (cookie:no and storage:no = the private profile was wiped)")
            if (field("cookie", again) != "no" || field("storage", again) != "no") touchFault("the private profile kept its data across the wipe: ${title(again)}")
            shot("26-private-tab-after-wipe")
            beat()
            coreInvoke("tab.close", """{"tabId":"$again"}""")
            SystemClock.sleep(2_500)
        }
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/private?peek=1"}""")
        waitTitle(TAB, 15_000) { it.startsWith("PV|") }
        note("  normal tab meanwhile: ${describeTab(TAB)} (its cookie stayed); FLAG_SECURE=${secure()}; private card ${describe(activeNotification(PrivateSession.NOTIFICATION_ID))}")
        SystemClock.sleep(1_000)
        shot("27-normal-tab-after-private")
        beat()
    }

    // --- 6. the session ends with its tab -------------------------------------------------------

    private fun closeStep() {
        note("\n6. the session ends with its tab (MW-07)")
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/audio"}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:audio") }
        SystemClock.sleep(1_000)
        tapPageButton("play", "Play track", "the page plays", 15_000) { field("state") == "playing" }
        val sbn = awaitNotification(MediaPlaybackService.NOTIFICATION_ID, 10_000)
        note("  playing again: notification ${describe(sbn)}; foreground=${MediaPlaybackService.inForeground}; focus=${host.media.hasAudioFocus}")
        SystemClock.sleep(1_500)
        shot("28-audio-before-close")
        beat()
        coreInvoke("tab.close", """{"tabId":"$TAB","force":true}""")
        val gone = poll(10_000) { activeNotification(MediaPlaybackService.NOTIFICATION_ID) == null }
        SystemClock.sleep(1_000)
        note("  tab closed: notification gone=$gone; session=${describeSession()}; host session=${host.media.current?.tabId}; foreground=${MediaPlaybackService.inForeground}; focus=${host.media.hasAudioFocus}")
        if (!gone) touchFault("the media notification stayed up after its tab closed")
        SystemClock.sleep(2_000)
        shot("29-after-tab-close")
        beat()
    }

    // --- the page -------------------------------------------------------------------------------

    /** The demo tab's title as the core has it ("" when the tab is gone). */
    private fun title(tabId: String = TAB): String =
        coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("title").orEmpty()

    /** The `key:value` field of the page's title, or null. */
    private fun field(key: String, tabId: String = TAB): String? =
        title(tabId).split('|').firstOrNull { it.startsWith("$key:") }?.substringAfter(':')

    private fun describeTab(tabId: String): String {
        val tab = coreState().getJSONObject("tabs").optJSONObject(tabId) ?: return "tab $tabId gone"
        return "tab $tabId containerId=${tab.optString("containerId")} url=${tab.optString("url")} title=\"${tab.optString("title")}\""
    }

    /** Poll the tab's title until `accept`s it (and the tab is not loading); the title then, or the last seen. */
    private fun waitTitle(tabId: String, timeoutMs: Long, accept: (String) -> Boolean): String {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = coreState().getJSONObject("tabs").optJSONObject(tabId)
            last = tab?.optString("title").orEmpty()
            if (tab != null && accept(last) && !tab.optBoolean("loading")) {
                SystemClock.sleep(600)
                return last
            }
            SystemClock.sleep(400)
        }
        Log.w(tag, "the title of $tabId never satisfied the wait; last \"$last\"")
        return last
    }

    /** The core's media entry for the tab (`UIState.media`), or null. */
    private fun mediaState(tabId: String): JSONObject? {
        val media = coreState().optJSONArray("media") ?: return null
        for (i in 0 until media.length()) {
            val entry = media.getJSONObject(i)
            if (entry.optString("tabId") == tabId) return entry
        }
        return null
    }

    private fun prompt(): JSONObject? {
        val prompts = coreState().getJSONArray("permissionPrompts")
        for (i in 0 until prompts.length()) {
            val p = prompts.getJSONObject(i)
            if (p.optString("tabId") == TAB) return p
        }
        return null
    }

    private fun privateTabs(): List<String> {
        val tabs = coreState().getJSONObject("tabs")
        return tabs.keys().asSequence().filter { tabs.getJSONObject(it).optString("containerId") == Profiles.PRIVATE_CONTAINER }.toList()
    }

    private fun newPrivateTab(url: String): String? {
        val result = coreInvoke("tab.newPrivate", """{"url":"$url"}""")
        if (result == "null") return null
        val id = (JSONTokener(result).nextValue() as? String) ?: return null
        note("  tab.newPrivate -> $id containerId=${coreState().getJSONObject("tabs").optJSONObject(id)?.optString("containerId")}")
        return id
    }

    /** Evaluate in the demo tab's page; the raw JSON-encoded result ("" when it never answered). */
    private fun pageJs(code: String, tabId: String = TAB): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            if (view == null) latch.countDown()
            else view.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** Where the page's element `id` is on screen (its CSS box scaled to the view, offset by the view), or null. */
    private fun pageElementRect(id: String, tabId: String = TAB): Rect? {
        val raw = pageJs("(function(){var e=document.getElementById(${JSONObject.quote(id)});if(!e)return null;var r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height})})()", tabId)
        val json = (JSONTokener(raw).nextValue() as? String)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
        var origin: IntArray? = null
        var scale = 0f
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId) ?: return@runOnMainSync
            origin = IntArray(2).also { view.getLocationOnScreen(it) }
            @Suppress("DEPRECATION")
            scale = view.scale
        }
        val at = origin ?: return null
        if (scale <= 0f) scale = density
        return Rect(
            (at[0] + json.getDouble("x") * scale).toInt(),
            (at[1] + json.getDouble("y") * scale).toInt(),
            (at[0] + (json.getDouble("x") + json.getDouble("w")) * scale).toInt(),
            (at[1] + (json.getDouble("y") + json.getDouble("h")) * scale).toInt()
        )
    }

    /**
     * A real finger on the page's button `id` (labelled `label`; the accessibility tree's node
     * when it carries one, the element's box on screen otherwise), then up to `timeoutMs` for
     * `took` – the step's claim, named by `effect`. A touch that went in and did nothing is a
     * touch fault; the recording goes on.
     */
    private fun tapPageButton(id: String, label: String, effect: String, timeoutMs: Long, took: () -> Boolean): Boolean {
        var point: PointF? = null
        val node = awaitNode(4_000) { it == label }
        if (node != null) point = touchTapPoint(node)
        if (point == null) {
            val rect = pageElementRect(id) ?: run {
                note("  no '$label' to touch: not in the tree, and the page has no element '$id'")
                return false
            }
            point = touchPoint(rect) ?: run {
                note("  '$label' at $rect is outside the touchable window")
                return false
            }
            Finger().tap(point.x, point.y)
        }
        if (poll(timeoutMs, took)) {
            note("  finger on '$label' at ${point.x.toInt()},${point.y.toInt()}: $effect")
            return true
        }
        touchFault("a touch on the page's '$label' did not take: not $effect within $timeoutMs ms (page: ${title()})")
        note("  TOUCH FAULT: '$label' did not $effect (page: ${title()})")
        return false
    }

    // --- notifications and the shade ------------------------------------------------------------

    private fun activeNotification(id: Int, match: (StatusBarNotification) -> Boolean = { true }): StatusBarNotification? =
        runCatching { notificationManager.activeNotifications.firstOrNull { it.id == id && match(it) } }.getOrNull()

    private fun awaitNotification(id: Int, timeoutMs: Long, match: (StatusBarNotification) -> Boolean = { true }): StatusBarNotification? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            activeNotification(id, match)?.let { return it }
            SystemClock.sleep(250)
        }
        return null
    }

    private fun describe(sbn: StatusBarNotification?): String {
        if (sbn == null) return "none"
        val n = sbn.notification
        val extras = n.extras
        val actions = n.actions?.map { it.title?.toString() ?: "?" } ?: emptyList()
        return "id=${sbn.id} tag=${sbn.tag} channel=${n.channelId} title=\"${extras.getCharSequence(Notification.EXTRA_TITLE)}\" " +
            "text=\"${extras.getCharSequence(Notification.EXTRA_TEXT)}\" actions=$actions ongoing=${n.flags and Notification.FLAG_ONGOING_EVENT != 0} " +
            "foregroundService=${n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0} mediaSession=${extras.containsKey(Notification.EXTRA_MEDIA_SESSION)} " +
            "largeIcon=${n.getLargeIcon() != null}"
    }

    /** The session as the system sees it (through the session's own controller). */
    private fun describeSession(): String = runCatching {
        val controller = host.media.controller
        val state = controller.playbackState
        val metadata = controller.metadata
        "state=${state?.state} position=${state?.position} rate=${state?.playbackSpeed} actions=0x${state?.actions?.toString(16)} " +
            "custom=${state?.customActions?.map { it.name }} title=\"${metadata?.getString(MediaMetadataCompat.METADATA_KEY_TITLE)}\" " +
            "artist=\"${metadata?.getString(MediaMetadataCompat.METADATA_KEY_ARTIST)}\" album=\"${metadata?.getString(MediaMetadataCompat.METADATA_KEY_ALBUM)}\" " +
            "duration=${metadata?.getLong(MediaMetadataCompat.METADATA_KEY_DURATION)} art=${metadata?.getBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART) != null} " +
            "active=${controller.sessionToken != null}"
    }.getOrElse { "unreadable: $it" }

    private fun sessionTitle(): String =
        runCatching { host.media.controller.metadata?.getString(MediaMetadataCompat.METADATA_KEY_TITLE) }.getOrNull().orEmpty()

    /** Pull the shade down and wait for a node in any window whose label `matches`. */
    private fun openShade(timeoutMs: Long = 10_000, matches: (String) -> Boolean): Boolean {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        val node = awaitInWindows(timeoutMs, matches)
        if (node == null) {
            note("  the shade showed nothing that was looked for within $timeoutMs ms")
            dumpWindows("shade")
        }
        return node != null
    }

    private fun closeShade() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        } else {
            back()
        }
        SystemClock.sleep(1_500)
        ensureForeground()
    }

    /** Poll up to `timeoutMs` for a node in any window on screen whose label or text `matches`. */
    private fun awaitInWindows(timeoutMs: Long, matches: (String) -> Boolean): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findInWindows(matches)?.let { return it }
            SystemClock.sleep(250)
        }
        return null
    }

    /**
     * A real touch on the node in any window reading `label` (or whose label `matches`), then
     * up to `timeoutMs` for `took` – the step's claim, named by `effect`. The shape of a step on
     * the shade, the lock screen or the picture-in-picture menu: false and a touch fault when the
     * touch went in and nothing came of it; false and a note when there was nothing to touch.
     */
    private fun touchInWindows(
        label: String,
        effect: String,
        timeoutMs: Long = 8_000,
        matches: (String) -> Boolean = { it == label },
        took: () -> Boolean
    ): Boolean {
        val node = awaitInWindows(6_000, matches) ?: run {
            note("  nothing in any window reads '$label'")
            dumpWindows("looking for '$label'")
            return false
        }
        val point = touchTapPoint(node) ?: run {
            note("  '$label' has no bounds a finger can reach")
            return false
        }
        if (poll(timeoutMs, took)) {
            note("  finger on '$label' at ${point.x.toInt()},${point.y.toInt()}: $effect")
            return true
        }
        touchFault("a touch on '$label' did not take: not $effect within $timeoutMs ms")
        note("  TOUCH FAULT: '$label' did not $effect (page: ${title()})")
        return false
    }

    private fun label(node: AccessibilityNodeInfo): String = (node.contentDescription ?: node.text)?.toString().orEmpty()

    private fun bounds(node: AccessibilityNodeInfo): Rect = Rect().also { node.getBoundsInScreen(it) }

    /** The labels on screen, window by window, into the notes (what the tree really says when a label is not found). */
    private fun dumpWindows(why: String) {
        val lines = ArrayList<String>()
        for (window in ui.windows) {
            val root = window.root ?: continue
            val labels = ArrayList<String>()
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            var visited = 0
            while (queue.isNotEmpty() && visited < 1_500 && labels.size < 40) {
                val node = queue.removeFirst()
                visited++
                val text = (node.contentDescription ?: node.text)?.toString()?.trim()
                if (!text.isNullOrEmpty()) labels += text.take(60)
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            lines += "    window type=${window.type} pkg=${root.packageName} pip=${window.isInPictureInPictureMode} labels=$labels"
        }
        note("  windows ($why):\n${lines.joinToString("\n")}")
    }

    // --- keys, picture-in-picture, the window ---------------------------------------------------

    /** A key press (down and up) through the input pipeline, the way `adb shell input keyevent` sends one. */
    private fun key(keyCode: Int) {
        val downTime = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(
                downTime, SystemClock.uptimeMillis(), action, keyCode, 0, 0,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD
            )
            ui.injectInputEvent(event, true)
        }
    }

    /**
     * A media button (a headset's, a keyboard's) pressed: through the input pipeline first, the
     * way a wired headset's reaches the app, and when that did not take, through
     * `AudioManager.dispatchMediaKeyEvent`, the route a Bluetooth headset's takes into the
     * session service. Neither doing what the step claims fails the run.
     */
    private fun mediaKeyExpecting(keyCode: Int, effect: String, took: () -> Boolean) {
        val name = KeyEvent.keyCodeToString(keyCode)
        key(keyCode)
        if (poll(5_000, took)) {
            note("    $name $effect (through the input pipeline)")
            return
        }
        val downTime = SystemClock.uptimeMillis()
        audioManager.dispatchMediaKeyEvent(KeyEvent(downTime, downTime, KeyEvent.ACTION_DOWN, keyCode, 0))
        audioManager.dispatchMediaKeyEvent(KeyEvent(downTime, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, keyCode, 0))
        if (poll(5_000, took)) {
            note("    $name $effect (through AudioManager.dispatchMediaKeyEvent; the injected key alone did not reach the session)")
            return
        }
        touchFault("the media key $name did not take: not $effect (page: ${title()})")
        note("    FAULT: $name did not $effect (page: ${title()})")
    }

    private fun inPip(): Boolean {
        var value = false
        instrumentation.runOnMainSync { value = activity.isInPictureInPictureMode }
        return value
    }

    private fun awaitPip(active: Boolean, timeoutMs: Long): Boolean = poll(timeoutMs) { inPip() == active }

    /** The app's window on screen (the small one while in picture-in-picture), or null. */
    private fun appWindowBounds(): Rect? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            if (root.packageName?.toString() != app.packageName) continue
            return Rect().also { window.getBoundsInScreen(it) }
        }
        return null
    }

    private fun ratio(rect: Rect?): String {
        if (rect == null || rect.height() <= 0) return "no window"
        return "%.3f".format(rect.width().toDouble() / rect.height())
    }

    /** The app's task to the front: an activity in picture-in-picture expands, a stopped one comes back. */
    private fun bringToFront() {
        val intent = Intent(app, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        runCatching { app.startActivity(intent) }.onFailure { note("  startActivity refused: $it") }
        SystemClock.sleep(1_500)
    }

    private fun secure(): Boolean {
        var value = false
        instrumentation.runOnMainSync {
            value = (activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) != 0
        }
        return value
    }

    private fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(200)
        }
        return condition()
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    private fun readAssetBytes(name: String): ByteArray =
        instrumentation.context.assets.open(name).use { it.readBytes() }

    // --- the fixtures ---------------------------------------------------------------------------

    /** A two-minute 16 kHz mono PCM WAV: a pentatonic run, one note every half second, each fading out. */
    private fun tone(): ByteArray {
        val rate = 16_000
        val seconds = 120
        val samples = rate * seconds
        val data = ByteArray(samples * 2)
        val scale = intArrayOf(0, 2, 4, 7, 9, 12, 9, 7, 4, 2)
        for (i in 0 until samples) {
            val t = i.toDouble() / rate
            val step = (t * 2).toInt()
            val semitone = scale[step % scale.size] + if ((step / scale.size) % 2 == 1) 5 else 0
            val f = 220.0 * 2.0.pow(semitone / 12.0)
            val envelope = 1.0 - (t * 2 - step)
            val v = (sin(2 * PI * f * t) * 0.5 + sin(2 * PI * f * 2 * t) * 0.15) * envelope * 0.6
            val s = (v * Short.MAX_VALUE).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            data[i * 2] = (s and 0xff).toByte()
            data[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
        }
        val out = ByteArrayOutputStream(44 + data.size)
        fun ascii(s: String) = out.write(s.toByteArray(Charsets.US_ASCII))
        fun int32(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff); out.write((v shr 16) and 0xff); out.write((v shr 24) and 0xff) }
        fun int16(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff) }
        ascii("RIFF"); int32(36 + data.size); ascii("WAVE")
        ascii("fmt "); int32(16); int16(1); int16(1); int32(rate); int32(rate * 2); int16(2); int16(16)
        ascii("data"); int32(data.size)
        out.write(data)
        return out.toByteArray()
    }

    /** The track's artwork: a 256 px square, the demo's colours, a letter. */
    private fun art(): ByteArray {
        val bitmap = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.rgb(0x1b, 0x43, 0x32))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = Color.rgb(0xf4, 0xa2, 0x61)
        canvas.drawCircle(128f, 128f, 96f, paint)
        paint.color = Color.WHITE
        paint.textSize = 150f
        paint.textAlign = Paint.Align.CENTER
        paint.isFakeBoldText = true
        canvas.drawText("Z", 128f, 128f + 54f, paint)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        return out.toByteArray()
    }

    companion object {
        private const val PORT = 18136
        private const val TAB = "tab_demo"
    }
}
