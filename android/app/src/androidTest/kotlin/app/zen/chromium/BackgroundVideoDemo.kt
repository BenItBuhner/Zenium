package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.os.PowerManager
import android.os.SystemClock
import androidx.lifecycle.LifecycleOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URL

/**
 * Background video per site on Android (MED-08 / EDGE-32, services pass 10): what stops a playing
 * clip when the user leaves, and the `background-video` content setting that keeps it playing.
 *
 * Scenes, on the loopback `/background` page (the WebM clip with sound, inline, its own word on its
 * visibility in its title: `vis`, `hidden`, `vc`, `pauses`, `plays`, `sitepaused`):
 *  1. the default (block), a plain `<video>` with sound and no script (`?handler=0`), Home: the
 *     fact of what pauses it – the engine's own background-video pause (`pauses` 1, `sitepaused` 0,
 *     `vis:hidden`), and whether the engine brings it back on return;
 *  2. the default, the site that pauses itself on `visibilitychange` (`?handler=1`), Home: the site's
 *     pause (`sitepaused` 1) – and the return, where the engine has nothing of its own to resume;
 *  3. the site allowed (`permissions.set`, the core's command – no UI), the same page, Home: the audio
 *     keeps playing for 30 s – the page `playing` and `vis:visible` with no `visibilitychange`, the
 *     notification the session's with Pause, the foreground service up, the view holding the hide;
 *     the screen locked (`KeyguardManager`): still playing; the unlock and the return: visible,
 *     playing, the page having heard no change at all;
 *  4. the same with picture-in-picture denied to the app (`appops`): the hold owes nothing to PiP;
 *  5. Pause from the notification while away: the held hide goes through (`vis:hidden`, one
 *     `visibilitychange`), the return brings one more, to visible – one, not two.
 *
 * Every check goes to the notes; one that did not hold fails the run at its end. Every touch injected
 * has an assertion on what it did (the rule in [DemoHarness]).
 */
@RunWith(AndroidJUnit4::class)
class BackgroundVideoDemo : MediaDemoBase("services-pass-10-media-android") {
    override val tag = "BackgroundVideoDemo"
    private var failures = 0
    private val keyguard: KeyguardManager by lazy { app.getSystemService(KeyguardManager::class.java) }
    private val power: PowerManager by lazy { app.getSystemService(PowerManager::class.java) }

    @Test
    fun record() {
        recordWithServer()
        assertEquals("checks that did not hold (see services-pass-10-media-android-notes.txt)", 0, failures)
    }

    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val tabs = state.getJSONArray("tabs")
        for (i in 0 until tabs.length()) {
            val tab = tabs.getJSONObject(i)
            if (tab.optString("id") == TAB) {
                tab.put("url", "$PAGE?handler=0")
                tab.put("title", "Zenium background video demo")
            }
        }
        state.getJSONObject("settings").put("gestureHintDone", true)
        return state.toString()
    }

    override fun warmUp() {
        super.warmUp()
        shell("cmd uimode night no")
        poll(10_000) { pageJs("document.getElementById('media').videoWidth") != "0" }
        note("clip: ${pageJs("document.getElementById('media').videoWidth")}x${pageJs("document.getElementById('media').videoHeight")}; page ${title()}")
        note("site: $ORIGIN; background-video resolves ${resolution()} (the catalogue's default)")
    }

    override fun demo() {
        blockedPlainVideo()
        blockedSitePauses()
        allowedKeepsPlaying()
        allowedWithoutPictureInPicture()
        pausedFromTheNotificationWhileAway()
        note("\nend: ${describeTab(TAB)}; keyguard locked=${keyguard.isKeyguardLocked}; interactive=${power.isInteractive}; holding=${holding()}")
    }

    // --- 1. the default, a plain video with sound: what pauses it ----------------------------------

    private fun blockedPlainVideo() {
        note("\n1. the default (block), a plain <video> with sound and no script: Home")
        onPage(handler = false)
        play()
        note("  before Home: ${visibility()}; session ${describeSession()}; notification ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}")
        check("1: the clip plays with sound before Home (state playing, the session's notification up)", field("state") == "playing" && activeNotification(MediaPlaybackService.NOTIFICATION_ID) != null)
        shot("01-blocked-plain-playing")
        home()
        SystemClock.sleep(4_000)
        val after = snapshot()
        note("  4 s after Home: ${visibility()}; keeps=${keeps()} holding=${holding()}; foreground service=${MediaPlaybackService.inForeground}; notification ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}; lifecycle ${lifecycleState()}")
        check("1 (fact a): with no script of the page's, the ENGINE pauses the hidden video: paused, one pause event, none of the site's, vis hidden", after.state == "paused" && after.pauses == 1 && after.sitepaused == 0 && after.vis == "hidden" && after.vc == 1)
        check("1: the default holds nothing back from the engine", !keeps() && !holding())
        val t = after.t
        SystemClock.sleep(3_000)
        check("1: the paused clip does not advance while away", snapshot().t == t)
        shot("02-blocked-plain-home")
        returnToApp()
        SystemClock.sleep(3_000)
        val returned = snapshot()
        note("  back: ${visibility()}; lifecycle ${lifecycleState()}")
        check("1: back, the page hears one visibilitychange to visible", returned.vis == "visible" && returned.vc == 2)
        note("  fact: on return the engine ${if (returned.state == "playing") "RESUMES the video it paused itself (paused_when_hidden_)" else "leaves the video paused"} (state ${returned.state}, plays ${returned.plays})")
        shot("03-blocked-plain-back")
        pause()
    }

    // --- 2. the default, the site pauses itself ----------------------------------------------------

    private fun blockedSitePauses() {
        note("\n2. the default (block), the site pausing on visibilitychange: Home")
        onPage(handler = true)
        play()
        check("2: the clip plays before Home", field("state") == "playing")
        home()
        SystemClock.sleep(4_000)
        val after = snapshot()
        note("  4 s after Home: ${visibility()}; keeps=${keeps()} holding=${holding()}; notification ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}")
        check("2 (fact b): the site's visibilitychange handler pauses the video (sitepaused 1), the page hidden", after.state == "paused" && after.sitepaused == 1 && after.vis == "hidden" && after.vc == 1)
        note("  fact: the element heard ${after.pauses} pause event(s) – ${if (after.pauses == 1) "the site's pause came first, the engine's found it paused" else "the engine's and the site's both"}")
        shot("04-blocked-handler-home")
        returnToApp()
        SystemClock.sleep(3_000)
        val returned = snapshot()
        note("  back: ${visibility()}")
        check("2: back, one visibilitychange to visible", returned.vis == "visible" && returned.vc == 2)
        note("  fact: on return the video ${if (returned.state == "playing") "PLAYS again (the engine's resume, though the site paused it)" else "stays paused: the site paused it and nothing of the engine's resumes it"} (state ${returned.state})")
        pause()
    }

    // --- 3. the site allowed: Home for 30 s, the lock screen, the return --------------------------

    private fun allowedKeepsPlaying() {
        note("\n3. the site allowed (permissions.set background-video allow, the core's command), the same page: Home, 30 s, the lock screen, the return")
        onPage(handler = true)
        val set = coreInvoke("permissions.set", """{"origin":${JSONObject.quote(ORIGIN)},"permission":"background-video","decision":"allow"}""")
        note("  permissions.set -> $set; background-video resolves ${resolution()}")
        check("3: the setting resolves allow for the site once set through the core", resolution() == "allow")
        play()
        SystemClock.sleep(1_500)
        note("  playing: ${visibility()}; keeps=${keeps()} holding=${holding()}; session ${describeSession()}")
        check("3: the session carries the site's allow to the view before Home (keepsVideoInBackground)", keeps() && !holding())
        shot("05-allowed-playing")
        home()
        val started = snapshot()
        SystemClock.sleep(2_000)
        note("  2 s after Home: ${visibility()}; keeps=${keeps()} holding=${holding()}; foreground service=${MediaPlaybackService.inForeground}; lifecycle ${lifecycleState()}; in front: ${ui.rootInActiveWindow?.packageName}")
        check("3: Home with the site allowed: the view holds the window's hide from the engine", holding())
        var playedOn = true
        var lastT = started.t
        val deadline = SystemClock.uptimeMillis() + 30_000
        var samples = 0
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(5_000)
            val s = snapshot()
            samples++
            val advancing = s.t > lastT || (s.t < lastT && s.state == "playing") // the loop wraps
            note("  +${samples * 5} s: state ${s.state} t ${s.t} vis ${s.vis} vc ${s.vc} pauses ${s.pauses} sitepaused ${s.sitepaused}; service=${MediaPlaybackService.inForeground}; focus ${audioFocus()}")
            if (s.state != "playing" || s.vis != "visible" || s.vc != 0 || !advancing) playedOn = false
            lastT = s.t
        }
        val sbn = activeNotification(MediaPlaybackService.NOTIFICATION_ID)
        note("  after 30 s: ${visibility()}; notification ${describe(sbn)}; session ${describeSession()}")
        check("3: the audio keeps playing for 30 s in the background: the page playing, visible, no visibilitychange, the time advancing", playedOn)
        check("3: the media notification stays the session's and says playing (a Pause action, the foreground service's)", sbn != null && (sbn.notification.actions?.any { it.title?.toString() == "Pause" } == true) && MediaPlaybackService.inForeground)
        check("3: the page's own video is not paused by anyone (no pause event since Home)", snapshot().pauses == started.pauses && snapshot().sitepaused == 0)
        openShade { it.contains("Zenium background clip") }
        shot("06-allowed-home-30s-shade")
        outputSwitcherChip()
        closeShade()
        lockScreen()
        returnToApp()
        SystemClock.sleep(3_000)
        val returned = snapshot()
        note("  back: ${visibility()}; keeps=${keeps()} holding=${holding()}; lifecycle ${lifecycleState()}")
        check("3: the return: visible and playing, the page having heard no visibilitychange at all (never hidden, nothing to report)", returned.state == "playing" && returned.vis == "visible" && returned.vc == 0 && !holding())
        shot("09-allowed-back")
        pause()
    }

    private fun lockScreen() {
        note("  the lock screen: locksettings ${shell("locksettings set-disabled false").trim()}")
        try {
            shell("svc power stayon false")
            shell("input keyevent KEYCODE_SLEEP")
            val dark = poll(6_000) { !power.isInteractive }
            SystemClock.sleep(6_000)
            val locked = snapshot()
            note("  screen off 6 s: interactive=${power.isInteractive} (went dark: $dark) keyguard locked=${keyguard.isKeyguardLocked}; ${visibility()}; holding=${holding()}; service=${MediaPlaybackService.inForeground}; lifecycle ${lifecycleState()}")
            check("3: the screen locked (KeyguardManager): still playing, still visible to the page, the hide still held", dark && keyguard.isKeyguardLocked && locked.state == "playing" && locked.vis == "visible" && locked.vc == 0 && holding())
            shell("input keyevent KEYCODE_WAKEUP")
            poll(6_000) { power.isInteractive }
            SystemClock.sleep(2_500)
            note("  awake under the keyguard: locked=${keyguard.isKeyguardLocked}; ${visibility()}; in front: ${ui.rootInActiveWindow?.packageName}")
            shot("07-allowed-lock-screen")
            shell("wm dismiss-keyguard")
            val unlocked = poll(8_000) { !keyguard.isKeyguardLocked }
            if (!unlocked) unlock(keyguard)
            SystemClock.sleep(2_000)
            note("  unlocked: locked=${keyguard.isKeyguardLocked}; ${visibility()}; in front: ${ui.rootInActiveWindow?.packageName}; lifecycle ${lifecycleState()}")
            shot("08-allowed-after-unlock")
        } finally {
            shell("locksettings set-disabled true")
            shell("svc power stayon true")
        }
    }

    // --- 4. the same with picture-in-picture denied ------------------------------------------------

    private fun allowedWithoutPictureInPicture() {
        note("\n4. the site allowed, picture-in-picture denied to the app (appops): Home 10 s, the return")
        note("  appops: ${shell("appops set ${app.packageName} PICTURE_IN_PICTURE deny").trim()}")
        try {
            onPage(handler = true)
            play()
            home()
            SystemClock.sleep(10_000)
            val s = snapshot()
            note("  10 s after Home: ${visibility()}; pip=${inPip()} holding=${holding()}; service=${MediaPlaybackService.inForeground}; notification ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}")
            check("4: with PiP denied the clip still plays in the background: no window, playing, visible, no visibilitychange", !inPip() && s.state == "playing" && s.vis == "visible" && s.vc == 0 && holding())
            shot("10-allowed-pip-denied-home")
            returnToApp()
            SystemClock.sleep(2_500)
            val r = snapshot()
            check("4: the return: playing, visible, nothing heard", r.state == "playing" && r.vis == "visible" && r.vc == 0)
            pause()
        } finally {
            note("  appops restored: ${shell("appops set ${app.packageName} PICTURE_IN_PICTURE allow").trim()}")
        }
    }

    // --- 5. paused from the notification while away: the held hide goes through -------------------

    private fun pausedFromTheNotificationWhileAway() {
        note("\n5. the site allowed, paused from the notification while away: the held hide goes through, the return brings one change")
        onPage(handler = true)
        play()
        home()
        SystemClock.sleep(4_000)
        val playing = snapshot()
        check("5: playing on in the background before the pause", playing.state == "playing" && playing.vis == "visible" && holding())
        val shade = openShade { it == "Pause" }
        val paused = shade && touchInWindows("Pause", "the notification's Pause pauses the page", 10_000) { field("state") == "paused" }
        if (!paused) {
            note("  the shade's Pause could not be reached; the session's own pause instead")
            instrumentation.runOnMainSync { host.media.controller.transportControls.pause() }
            poll(8_000) { field("state") == "paused" }
        }
        SystemClock.sleep(2_500)
        val after = snapshot()
        note("  paused while away: ${visibility()}; keeps=${keeps()} holding=${holding()}; service=${MediaPlaybackService.inForeground}; notification ${describe(activeNotification(MediaPlaybackService.NOTIFICATION_ID))}")
        check("5: the pause takes the hold down: the page now hidden, one visibilitychange", after.state == "paused" && after.vis == "hidden" && after.vc == 1 && !holding())
        shot("11-allowed-paused-away")
        closeShade()
        returnToApp()
        SystemClock.sleep(3_000)
        val r = snapshot()
        note("  back: ${visibility()}")
        check("5: the return: one more visibilitychange, to visible – two in all, not three", r.vis == "visible" && r.vc == 2)
        shot("12-allowed-paused-back")
    }

    /**
     * MED-10, read while the shade shows the session's card: the Android 11+ output-switcher chip on
     * the system's media player – "This phone" on API 34 (SettingsLib's `media_transfer_this_device_name`;
     * "Phone speaker" on 12 and 13) on an emulator without Bluetooth, or the chip's own description
     * "Media device" – as the accessibility tree has it, whole labels only (the status bar's "Phone
     * signal full." is not it), and the card's labels for the record (a still goes with it).
     */
    private fun outputSwitcherChip() {
        val chip = awaitInWindows(4_000) {
            it.equals("This phone", ignoreCase = true) || it.equals("Phone speaker", ignoreCase = true) ||
                it.equals("Media device", ignoreCase = true) || it.endsWith(" speaker", ignoreCase = true)
        }
        val playback = runCatching { host.media.controller.playbackInfo }.getOrNull()
        note("  MED-10 output switcher: chip ${chip?.let { "\"${label(it)}\" (class ${it.className}, id ${it.viewIdResourceName}, clickable=${it.isClickable}, enabled=${it.isEnabled})" } ?: "NOT FOUND in any window"}; playbackInfo type=${playback?.playbackType} volumeControl=${playback?.volumeControl} sdk ${android.os.Build.VERSION.SDK_INT}")
        dumpWindows("MED-10: the shade with the session's card")
        note("  FACT  MED-10: the output-switcher chip is ${if (chip != null) "PRESENT" else "ABSENT"} on the session's card in the shade")
    }

    // --- helpers -----------------------------------------------------------------------------------

    private class Snapshot(val state: String, val t: Int, val vis: String, val vc: Int, val pauses: Int, val plays: Int, val sitepaused: Int)

    private fun snapshot() = Snapshot(
        state = field("state") ?: "?",
        t = field("t")?.toIntOrNull() ?: -1,
        vis = field("vis") ?: "?",
        vc = field("vc")?.toIntOrNull() ?: -1,
        pauses = field("pauses")?.toIntOrNull() ?: -1,
        plays = field("plays")?.toIntOrNull() ?: -1,
        sitepaused = field("sitepaused")?.toIntOrNull() ?: -1
    )

    private fun visibility(): String {
        val s = snapshot()
        return "state ${s.state} t ${s.t} vis ${s.vis} hidden ${field("hidden")} vc ${s.vc} pauses ${s.pauses} plays ${s.plays} sitepaused ${s.sitepaused} handler ${field("handler")}"
    }

    /** The demo tab on the page, `handler` the site's pause on visibilitychange or none; the title's fields fresh. */
    private fun onPage(handler: Boolean) {
        frontApp()
        val url = "$PAGE?handler=${if (handler) 1 else 0}&n=${SystemClock.uptimeMillis()}"
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":${JSONObject.quote(url)}}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:video") && "handler:${if (handler) 1 else 0}" in it && "vc:0" in it }
        poll(10_000) { pageJs("document.getElementById('media').videoWidth") != "0" }
        SystemClock.sleep(800)
        note("  on ${field("handler")?.let { if (it == "1") "the self-pausing site" else "the plain video" }}: ${visibility()}")
    }

    private fun play() {
        if (field("state") == "playing") return
        tapPageButton("play", "Play video", "the clip plays", 15_000) { field("state") == "playing" }
        SystemClock.sleep(1_200)
    }

    private fun pause() {
        if (field("state") != "playing") return
        frontApp()
        tapPageButton("play", "Pause video", "the clip pauses", 10_000) { field("state") == "paused" }
    }

    private fun home() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val left = poll(8_000) { ui.rootInActiveWindow?.packageName?.toString() != app.packageName && lifecycleState() == "CREATED" }
        note("  Home: left=$left; in front: ${ui.rootInActiveWindow?.packageName}; lifecycle ${lifecycleState()}")
    }

    /** The app back in front from the launcher or the lock screen (`am start`, then the front-app check). */
    private fun returnToApp() {
        bringToFront()
        frontApp()
    }

    private fun keeps(): Boolean {
        var v = false
        instrumentation.runOnMainSync { v = host.tabs.get(TAB)?.keepsVideoInBackground == true }
        return v
    }

    private fun holding(): Boolean {
        var v = false
        instrumentation.runOnMainSync { v = host.tabs.get(TAB)?.holdingWindowHide == true }
        return v
    }

    /** The site's stored `background-video` decision as the core lists it (`permissions.listForPermission`), or the default, block. */
    private fun resolution(): String {
        val rules = runCatching { org.json.JSONArray(coreInvoke("permissions.listForPermission", """{"permission":"background-video"}""")) }.getOrNull()
            ?: return "deny (default; no list)"
        for (i in 0 until rules.length()) {
            val rule = rules.getJSONObject(i)
            if (rule.optString("origin") == ORIGIN) return rule.optString("decision")
        }
        return "deny (default)"
    }

    private fun lifecycleState(): String {
        var state = "?"
        instrumentation.runOnMainSync { state = (activity as? LifecycleOwner)?.lifecycle?.currentState?.name ?: "no lifecycle owner" }
        return state
    }

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        note("  ${if (ok) "PASS" else "FAIL"}  $what")
    }

    companion object {
        private const val PAGE = "http://127.0.0.1:$PORT/background"
        private val ORIGIN = URL(PAGE).let { "${it.protocol}://${it.host}:${it.port}" }
    }
}
