package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.KeyEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

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
 * artwork are generated here, the clip is an asset – VP8 / Vorbis in WebM, the free codecs every
 * Chromium build decodes: the snapshot WebView the demo runs on is built without the
 * proprietary ones and refuses an H.264 MP4 with `NotSupportedError`) and report what they see through their
 * titles (`MD|kind:audio|state:playing|t:12|last:nexttrack`), which the driver reads from the
 * core's state. Everything measured goes to `<shotPrefix>-notes.txt` next to the stills. Every
 * control pressed – on the page, in a sheet, in the shade, on the lock screen, on the
 * picture-in-picture window – is a real injected touch with an assertion on what it did (the
 * rule in [DemoHarness]); a media key that does nothing fails the run the same way.
 */
@RunWith(AndroidJUnit4::class)
class MediaDemo : MediaDemoBase("services-android-media-android") {
    override val tag = "MediaDemo"

    @Test
    fun record() = recordWithServer()

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
        // Metadata alone brings no controls up (Chrome's rule: the notification comes with the first playback).
        val early = activeNotification(MediaPlaybackService.NOTIFICATION_ID)
        note("  before play (the page set its Media Session metadata already): media notification ${describe(early)}; session ${describeSession()}")
        if (early != null) touchFault("a media notification stood before anything played")
        tapPageButton("play", "Play track", "the page reports the track playing", 15_000) { field("state") == "playing" }
        val sbn = awaitNotification(MediaPlaybackService.NOTIFICATION_ID, 15_000)
        note("  media notification: ${describe(sbn)}")
        // The page stays playing: the engine's own audio focus request is the only one in this
        // process (a second one from the host would take the focus and pause the page).
        val stillPlaying = poll(3_000) { field("state") != "playing" }.not()
        note("  three seconds on: state=${field("state")} t=${field("t")} (kept playing: $stillPlaying)")
        if (!stillPlaying) touchFault("the track did not stay playing after the play (page: ${title()})")
        note("  foreground service: ${MediaPlaybackService.inForeground}; audio focus: ${audioFocus()}")
        note("  session: ${describeSession()}")
        note("  core media state: ${mediaState(TAB)}")
        if (sbn == null) touchFault("no media notification came up for the playing track")
        SystemClock.sleep(1_000)
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
        ensurePlaying()
        // The emulator boots with its lock screen disabled (ro.lockscreen.disable.default); a
        // phone has one, so the step turns it on (swipe, no credential) and off again after.
        note("  lock screen enabled for the step: ${shell("locksettings set-disabled false").trim()}")
        val tBefore = field("t")?.toIntOrNull() ?: -1
        key(KeyEvent.KEYCODE_SLEEP)
        SystemClock.sleep(5_000)
        val tDark = field("t")?.toIntOrNull() ?: -1
        val wentOn = tDark > tBefore && field("state") == "playing"
        note("  screen off: interactive=${power.isInteractive}; position $tBefore -> $tDark (the track went on: $wentOn); state=${field("state")}; audio focus: ${audioFocus()}")
        if (!wentOn) touchFault("the track did not go on with the screen off (position $tBefore -> $tDark, state=${field("state")})")
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
            } else {
                touchFault("the lock screen showed no media controls for the playing track")
            }
            unlock(keyguard)
        } else {
            note("  no lock screen came up on wake (the device setting, not the app's); its controls could not be tried")
        }
        shell("locksettings set-disabled true")
        ensureForeground()
        SystemClock.sleep(1_500)
        note("  back in the app: ${describeTab(TAB)}; keyguard locked=${keyguard.isKeyguardLocked}")
        shot("07-back-from-lock-screen")
    }

    // --- 3. video and picture-in-picture --------------------------------------------------------

    private fun videoStep() {
        note("\n3. video: picture-in-picture (MW-08)")
        frontApp()
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/video"}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:video") }
        SystemClock.sleep(1_500)
        note("  video page: ${describeTab(TAB)}")
        note("  the audio page left behind: notification ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}; session ${describeSession()}")
        shot("08-video-page")
        tapPageButton("play", "Play video", "the page reports the video playing", 15_000) { field("state") == "playing" }
        SystemClock.sleep(2_000)
        note("  playing: ${title()}; session ${describeSession()}")
        note("  notification: ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}; audio focus: ${audioFocus()}")
        if (field("state") != "playing") touchFault("the video did not stay playing (page: ${title()})")
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
            // The window's own controls: a tap on the window shows its menu, whose Pause / Play is the session's.
            if (win != null) {
                if (field("state") == "playing") {
                    touchPipMenu(win, "Pause", "the small window's Pause pauses the video", shotAfter = "11-pip-menu") { field("state") == "paused" }
                    SystemClock.sleep(1_500)
                    shot("12-pip-paused")
                    touchPipMenu(win, "Play", "the small window's Play plays the video again") { field("state") == "playing" }
                } else {
                    touchPipMenu(win, "Play", "the small window's Play plays the video", shotAfter = "11-pip-menu") { field("state") == "playing" }
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
        if (field("state") != "playing") {
            note("  the video is not playing fullscreen (state=${field("state")}); a media key plays it for the auto-enter")
            ensurePlaying()
            SystemClock.sleep(1_000)
        }
        note("  fullscreen: page fs=${field("fs")} host fullscreenTab=${host.fullscreenTab?.tabId} state=${field("state")}")
        shot("14-video-fullscreen")
        beat()
        val playingFullscreen = field("state") == "playing" && (field("fs") == "1" || host.fullscreenTab?.tabId == TAB)
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val auto = awaitPip(true, 10_000)
        note("  Home with the video playing fullscreen (${if (playingFullscreen) "it was" else "it was NOT: state=${field("state")} fs=${field("fs")}"}) -> picture-in-picture by itself: $auto")
        if (!auto) touchFault("Home with the video playing fullscreen did not enter picture-in-picture")
        SystemClock.sleep(3_000)
        val win = appWindowBounds()
        note("  window now $win (${ratio(win)}); state=${field("state")}")
        shot("15-pip-auto-enter")
        beat()
        // Closed with its X rather than expanded: the video pauses, as Chrome's does.
        var closed = false
        if (auto && win != null) {
            closed = touchPipMenu(win, "Close", "the window closes and the video pauses", timeoutMs = 10_000) { !inPip() && field("state") == "paused" }
            SystemClock.sleep(1_500)
            note("  after Close: in pip=${inPip()} state=${field("state")} notification ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}")
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
        frontApp()
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
        frontApp()
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
        frontApp()
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
        frontApp()
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/audio"}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:audio") }
        SystemClock.sleep(1_000)
        tapPageButton("play", "Play track", "the page plays", 15_000) { field("state") == "playing" }
        val sbn = awaitNotification(MediaPlaybackService.NOTIFICATION_ID, 10_000)
        SystemClock.sleep(1_500)
        note("  playing again: notification ${describe(sbn)}; foreground=${MediaPlaybackService.inForeground}; state=${field("state")}; audio focus: ${audioFocus()}")
        shot("28-audio-before-close")
        beat()
        coreInvoke("tab.close", """{"tabId":"$TAB","force":true}""")
        val gone = poll(10_000) { activeNotification(MediaPlaybackService.NOTIFICATION_ID) == null }
        SystemClock.sleep(1_000)
        note("  tab closed: notification gone=$gone; session=${describeSession()}; host session=${host.media.current?.tabId}; foreground=${MediaPlaybackService.inForeground}; audio focus: ${audioFocus()}")
        if (!gone) touchFault("the media notification stayed up after its tab closed")
        SystemClock.sleep(2_000)
        shot("29-after-tab-close")
        beat()
    }
}
