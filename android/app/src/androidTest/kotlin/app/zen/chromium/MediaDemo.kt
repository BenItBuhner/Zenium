package app.zen.chromium

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.app.Notification
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.KeyEvent
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records the media engine on the phone, Chrome Android's behaviour being the bar:
 *
 *  0. the quiet notification ask (NOT-03): a page asking with no finger behind it gets the
 *     bell-off glyph in the pill's slot, not a sheet; the bell's tap opens the sheet with the
 *     quiet copy; Allow grants the site and, the first time, meets Android 13's one
 *     POST_NOTIFICATIONS prompt for the whole app (revoked after the install for the run);
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
 *     the card in the shade brings the tab up and reaches the page as `click`; then a page
 *     using the microphone (NOT-13): the grant arms "<site> is using your microphone" on a
 *     camera / microphone foreground service, the card stands while the app is behind, its
 *     tap comes back to the tab, the page's Stop takes it down; and the Updates channel
 *     (NOT-17): "Update available" whose tap opens Settings › Updates, "Update ready" in the
 *     same card;
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
        quietAskStep()
        audioStep()
        lockScreenStep()
        videoStep()
        notificationStep()
        captureStep()
        updatesStep()
        privateStep()
        closeStep()
        note("\ndone")
    }

    // --- 0. the quiet notification ask (NOT-03) ------------------------------------------------

    /**
     * A page's request with no finger behind it (the page asks at load) is Chrome's quiet ask:
     * no sheet, the bell-off glyph in the pill's slot; the bell's tap opens the §9.23 sheet with
     * the quiet copy; Allow grants the site and, the first time on Android 13+, brings the
     * system's POST_NOTIFICATIONS prompt – once for the whole app, which is why this runs first
     * with the permission revoked after the install (DEMO_REVOKE): the loud ask of step 4, on
     * another origin, meets no second prompt, and every card after this has its permission. The
     * site is the server on `localhost`, another origin than the loud scene's `127.0.0.1`, so
     * each meets the core undecided.
     */
    private fun quietAskStep() {
        note("\n0. the quiet notification ask (NOT-03): no gesture -> the bell in the pill, its tap -> the sheet, Allow -> the system's one prompt")
        frontApp()
        note("  POST_NOTIFICATIONS held before the first grant: ${notificationsPermitted()}; asked before: ${notificationsAsked()}")
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"$QUIET_ORIGIN/notify?quiet=1"}""")
        waitTitle(TAB, 20_000) { it.startsWith("NT|") && it.contains("asked:") }
        val quiet = poll(10_000) { prompt()?.optBoolean("quiet") == true }
        note("  page: ${describeTab(TAB)}; the core's prompt: ${prompt()} (quiet: $quiet)")
        if (!quiet) touchFault("the page's gestureless request did not become a quiet prompt (page: ${title()})")
        val sheetUp = waitFor("Keep blocking", 2_000) != null
        note("  a sheet up for it unasked: $sheetUp (a quiet ask shows none until the bell is tapped)")
        if (sheetUp) touchFault("the quiet ask opened a sheet without a tap on the bell")
        SystemClock.sleep(1_000)
        val bell = readBell()
        note("  the bell in the pill: $bell")
        if (bell.length() == 0) touchFault("the pill shows no bell-off glyph for the quiet ask")
        shot("00a-quiet-bell")
        beat()
        setScheme("dark")
        note("  the bell in the dark scheme: ${readBell()}")
        shot("00b-quiet-bell-dark")
        beat()
        // A finger on the bell: the sheet with the quiet copy, the bell reading expanded.
        val opened = touchTapLabelExpecting(NOTIFICATIONS_BLOCKED, "the quiet prompt's sheet opens", timeoutMs = 8_000) { readQuietSheet().length() > 0 }
        if (opened) {
            SystemClock.sleep(1_500)
            note("  the sheet: ${readQuietSheet()}; the bell: ${readBell()}")
            shot("00c-quiet-sheet-dark")
            beat()
            setScheme("light")
            shot("00d-quiet-sheet")
            beat()
            // Allow with a finger: the quiet prompt is answered (gone from the queue) and the site allowed.
            touchTapLabelExpecting("Allow", "the quiet prompt is answered", timeoutMs = 10_000) { prompt() == null }
        } else {
            setScheme("light")
        }
        // The first grant on Android 13+: the system's prompt for the app, once.
        val system = awaitSystemWindow(8_000)
        note("  Android 13's prompt after the first grant: ${if (system) "up (${ui.rootInActiveWindow?.packageName})" else "none (permission held: ${notificationsPermitted()}, asked before: ${notificationsAsked()})"}")
        if (system) {
            SystemClock.sleep(1_500)
            shot("00e-android-13-prompt")
            beat()
            if (!touchInWindows("Allow", "the app may post", timeoutMs = 10_000, matches = { it.equals("Allow", ignoreCase = true) }) { notificationsPermitted() }) {
                note("  the system prompt's Allow did not take; granting through the shell so the cards after this have their permission")
                shell("pm grant ${app.packageName} android.permission.POST_NOTIFICATIONS")
            }
        } else if (!notificationsPermitted()) {
            note("  no system prompt and no permission: granting through the shell so the cards after this have their permission")
            shell("pm grant ${app.packageName} android.permission.POST_NOTIFICATIONS")
        }
        val granted = poll(10_000) { field("permission") == "granted" }
        SystemClock.sleep(1_000)
        note("  page: permission=${field("permission")} (granted within the wait: $granted); POST_NOTIFICATIONS held: ${notificationsPermitted()}; the app's one ask spent: ${notificationsAsked()}")
        note("  rules for notifications: ${coreInvoke("permissions.listForPermission", """{"permission":"notifications"}""")}")
        note("  the bell after the answer: ${readBell()} (none: the question is answered)")
        if (readBell().length() != 0) touchFault("the bell stayed in the pill after the quiet prompt was answered")
        if (ui.rootInActiveWindow?.packageName?.toString() != app.packageName) closeShade()
        ensureForeground()
        shot("00f-quiet-allowed")
        beat()
        // Back to the seeded page for step 1.
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/audio"}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:audio") }
        SystemClock.sleep(1_000)
    }

    private fun notificationsPermitted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** The install's memory of the app's one notification ask (`Permissions.ensureNotificationsAllowed`). */
    private fun notificationsAsked(): Boolean =
        app.getSharedPreferences(Permissions.PREFS, Context.MODE_PRIVATE).getBoolean(Permissions.KEY_NOTIFICATIONS_ASKED, false)

    private fun setScheme(scheme: String) {
        coreInvoke("settings.update", """{"colorScheme":"$scheme"}""")
        // The theme blends over 240 ms (v2 §11.6); the emulator's software GPU takes its time.
        SystemClock.sleep(2_500)
    }

    /** The pill's bell-off chip (NOT-03) as the chrome draws it: its size, name, popup semantics and ink; empty when none. */
    private fun readBell(): JSONObject {
        val raw = chromeJsString(
            "(function(){var c=document.querySelector('.zen-phone-pill:not(.zen-pill-ghost) [data-quiet-bell]');" +
                "if(!c)return '';var r=c.getBoundingClientRect();" +
                "return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height),label:c.getAttribute('aria-label')||''," +
                "popup:c.getAttribute('aria-haspopup')||'',expanded:c.getAttribute('aria-expanded')||'',opacity:getComputedStyle(c).opacity})})()"
        ) ?: ""
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    /** The quiet prompt's sheet: its permission, title and the words on it; empty when none is up. */
    private fun readQuietSheet(): JSONObject {
        val raw = chromeJsString(
            "(function(){var s=document.querySelector('[data-testid=\"permission-prompt\"][data-quiet=\"true\"]');if(!s)return '';" +
                "var h=s.querySelector('h1,h2,h3');var buttons=[].map.call(s.querySelectorAll('button'),function(b){return (b.getAttribute('aria-label')||b.textContent||'').trim()}).filter(Boolean);" +
                "return JSON.stringify({permission:s.getAttribute('data-permission')||'',title:h?h.textContent.trim():'',text:(s.textContent||'').replace(/\\s+/g,' ').trim().slice(0,220),buttons:buttons})})()"
        ) ?: ""
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
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

    // --- 4b. a page using the microphone (NOT-13) -----------------------------------------------

    /**
     * "<site> is using your microphone": the grant arms the card (a camera / microphone foreground
     * service, the capture kept alive behind other apps), the page's report confirms it, the card
     * stands in the shade while the app is behind, its tap comes back to the tab, and the page's
     * Stop takes it down with the service. The emulator has no camera (`-camera-* none`), so the
     * microphone alone; its audio backend records silence, which is a capture all the same.
     */
    private fun captureStep() {
        note("\n4b. a page using the microphone (NOT-13): the grant arms the card, the page confirms it, the tap comes back, the stop takes it down")
        frontApp()
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/capture"}""")
        waitTitle(TAB, 20_000) { it.startsWith("CP|") }
        SystemClock.sleep(1_000)
        note("  page: ${describeTab(TAB)}; card before the ask: ${describe(activeNotification(CaptureService.NOTIFICATION_ID))}")
        shot("23a-capture-page")
        beat()
        tapPageButton("mic", "Use microphone", "the core shows the microphone prompt", 15_000) { prompt() != null }
        note("  prompt: ${prompt()}")
        if (prompt() != null) {
            waitFor("Allow", 8_000)
            SystemClock.sleep(1_200)
            shot("23b-capture-prompt")
            beat()
            touchTapLabelExpecting("Allow", "the site may use the microphone", timeoutMs = 15_000) { prompt() == null }
        }
        val sbn = awaitNotification(CaptureService.NOTIFICATION_ID, 15_000)
        val captured = poll(15_000) { field("capture") == "audio" || field("error") != "none" }
        note("  page: capture=${field("capture")} error=${field("error")} (settled within the wait: $captured)")
        note("  capture card: ${describe(sbn)}; service in the foreground: ${CaptureService.inForeground} type=${CaptureService.foregroundType}; ledger: ${host.capture.cards()}")
        if (sbn == null) touchFault("no capture card came up for the microphone grant")
        if (field("capture") != "audio") note("  the page holds no track (${field("error")}): the card rests on the grant and leaves at the confirm window's end")
        val channel = sbn?.notification?.channelId?.let { notificationManager.getNotificationChannel(it) }
        note("  channel: id=${channel?.id} name=\"${channel?.name}\" importance=${channel?.importance} description=\"${channel?.description}\"")
        val cardTitle = sbn?.notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            ?: CaptureLedger.card(TAB, "${server.origin}/capture", CaptureUse.MICROPHONE, private = false).title
        if (sbn != null && openShade { it.startsWith(cardTitle) }) {
            SystemClock.sleep(1_500)
            shot("23c-capture-shade")
            beat()
            closeShade()
            shell("cmd uimode night yes")
            SystemClock.sleep(2_500)
            if (openShade { it.startsWith(cardTitle) }) {
                SystemClock.sleep(1_500)
                shot("23d-capture-shade-dark")
                beat()
            }
            closeShade()
            shell("cmd uimode night no")
            SystemClock.sleep(2_500)
            // Home: the capture goes on behind the launcher on the service; the card's tap brings the tab back.
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
            val away = poll(6_000) { ui.rootInActiveWindow?.packageName?.toString() != app.packageName }
            SystemClock.sleep(2_000)
            note("  Home (away: $away): page capture=${field("capture")}; card: ${describe(activeNotification(CaptureService.NOTIFICATION_ID))}; service in the foreground: ${CaptureService.inForeground}")
            if (openShade { it.startsWith(cardTitle) }) {
                SystemClock.sleep(1_000)
                touchInWindows(cardTitle, "the app comes back on the capturing tab", timeoutMs = 12_000, matches = { it.startsWith(cardTitle) }) {
                    ui.rootInActiveWindow?.packageName?.toString() == app.packageName && activeCoreTab()?.optString("id") == TAB
                }
                SystemClock.sleep(1_500)
                note("  after the tap: front=${ui.rootInActiveWindow?.packageName}; active tab ${activeCoreTab()?.optString("id")}; card: ${describe(activeNotification(CaptureService.NOTIFICATION_ID))}")
            }
        }
        if (ui.rootInActiveWindow?.packageName?.toString() != app.packageName) closeShade()
        frontApp()
        shot("23e-capture-back")
        beat()
        // Stop: the tracks end, the page reports it, the card and the service go.
        if (field("capture") == "audio") {
            tapPageButton("stop", "Stop", "the page lets the microphone go", 10_000) { field("capture") == "none" }
        }
        val gone = poll(20_000) { activeNotification(CaptureService.NOTIFICATION_ID) == null }
        SystemClock.sleep(1_000)
        note("  after the stop: card gone=$gone; service in the foreground: ${CaptureService.inForeground}; ledger: ${host.capture.cards()}; page capture=${field("capture")}")
        if (!gone) touchFault("the capture card stayed up after the page let the microphone go")
        shot("23f-capture-ended")
        beat()
    }

    // --- 4c. the Updates channel (NOT-17) --------------------------------------------------------

    /**
     * "Update available" and "Update ready – relaunch to update", one card updated in place on the
     * low Updates channel, the tap opening Settings › Updates. The cards are posted here through
     * the host's `UpdateNotifications` for the notices the core sends over `update.notify` at its
     * phase edges (vitest pins those); the demo device has no update feed to take them from.
     */
    private fun updatesStep() {
        note("\n4c. the Updates channel (NOT-17): 'Update available', its tap -> Settings > Updates, 'Update ready' in the same card")
        frontApp()
        postUpdateNotice("""{"kind":"available","version":"9.9.9"}""")
        val available = awaitNotification(UpdateNotifications.NOTIFICATION_ID, 10_000)
        note("  update available: ${describe(available)}")
        if (available == null) touchFault("no Update available card came up for the host's notice")
        val channel = available?.notification?.channelId?.let { notificationManager.getNotificationChannel(it) }
        note("  channel: id=${channel?.id} name=\"${channel?.name}\" importance=${channel?.importance} description=\"${channel?.description}\"")
        if (available != null && openShade { it.startsWith(UpdateNotifications.TITLE_AVAILABLE) }) {
            SystemClock.sleep(1_500)
            shot("23g-update-available-shade")
            beat()
            closeShade()
            shell("cmd uimode night yes")
            SystemClock.sleep(2_500)
            if (openShade { it.startsWith(UpdateNotifications.TITLE_AVAILABLE) }) {
                SystemClock.sleep(1_500)
                shot("23h-update-available-shade-dark")
                beat()
            }
            closeShade()
            shell("cmd uimode night no")
            SystemClock.sleep(2_500)
            if (openShade { it.startsWith(UpdateNotifications.TITLE_AVAILABLE) }) {
                SystemClock.sleep(1_000)
                touchInWindows(UpdateNotifications.TITLE_AVAILABLE, "Settings > Updates opens", timeoutMs = 12_000, matches = { it.startsWith(UpdateNotifications.TITLE_AVAILABLE) }) {
                    ui.rootInActiveWindow?.packageName?.toString() == app.packageName && settingsSection() == "updates"
                }
                SystemClock.sleep(1_500)
                note("  after the tap: settings section=${settingsSection()}; card left: ${describe(activeNotification(UpdateNotifications.NOTIFICATION_ID))} (swiped or tapped, the card goes; the page keeps the state)")
                shot("23i-update-settings")
                beat()
            }
        }
        if (ui.rootInActiveWindow?.packageName?.toString() != app.packageName) closeShade()
        ensureForeground()
        postUpdateNotice("""{"kind":"ready","version":"9.9.9"}""")
        val ready = awaitNotification(UpdateNotifications.NOTIFICATION_ID, 10_000) {
            it.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() == UpdateNotifications.TITLE_READY
        }
        note("  update ready: ${describe(ready)} (the same id: one card, updated in place)")
        if (ready == null) touchFault("no Update ready card came up for the host's notice")
        if (ready != null && openShade { it.startsWith(UpdateNotifications.TITLE_READY) }) {
            SystemClock.sleep(1_500)
            shot("23j-update-ready-shade")
            beat()
            closeShade()
        }
        postUpdateNotice("null")
        val withdrawn = poll(5_000) { activeNotification(UpdateNotifications.NOTIFICATION_ID) == null }
        note("  notice withdrawn (installed, or the check found nothing): card gone=$withdrawn")
        // The deep link's Settings tab goes; the demo tab is on screen again for step 5.
        val tabs = coreState().getJSONObject("tabs")
        for (id in tabs.keys().asSequence().toList()) {
            if (id != TAB && tabs.getJSONObject(id).optString("url").startsWith("zenium://settings")) {
                coreInvoke("tab.close", """{"tabId":"$id","force":true}""")
            }
        }
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        ensureForeground()
        SystemClock.sleep(1_500)
    }

    /** The host's `update.notify` as the core sends it: a notice (`{ kind, version }`) or null for none. */
    private fun postUpdateNotice(notice: String) {
        instrumentation.runOnMainSync {
            host.updateNotifications.notify(if (notice == "null") null else JSONObject(notice))
        }
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

    private companion object {
        /** The demo server by another name: an origin of its own for the quiet ask, undecided when step 4's `127.0.0.1` is too. */
        const val QUIET_ORIGIN = "http://localhost:$PORT"
        /** The bell chip's accessible name (`pillChips.tsx` NOTIFICATIONS_BLOCKED_LABEL): a harness contract. */
        const val NOTIFICATIONS_BLOCKED = "Notifications blocked"
    }
}
