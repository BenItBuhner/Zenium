package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.sin

/**
 * Records "Lock private tabs when you leave Zenium" on the phone (INC-05, SET-17; Chrome's "Lock
 * Incognito tabs when you leave Chrome") with a device PIN set for the run: the Settings switch
 * under a finger, confirmed by the system's credential prompt (on; a cancel leaves it; off and on
 * again with a private tab open, the prompt never arming the lock); Home and back to a private
 * page shows the lock cover over it – the host's own hide of the page view read every 8 ms from
 * the departure to the cover, so no frame of the live page is on screen, the pill reading
 * "Private tab", FLAG_SECURE on the window as a release build has it, the accessibility tree
 * carrying nothing of the page; the overview's Private pane under its own cover with the grid
 * inert and every card a "Private tab", the Tabs pane and a regular tab usable with the guard off
 * there; a locked private tab brought to the front again kept hidden by the host until the cover
 * is up; Unlock under a finger – the prompt cancelled keeps the cover, a wrong PIN keeps it with
 * the prompt's own message, the PIN lifts it on the spring, `--zen-lock-p` written down to 0
 * before the cover goes; services' "Close all private tabs" card pressed in the shade while
 * locked ends the session without a prompt, as does the menu's Close Private Tabs under the
 * cover; the #232 rider – a Settings tab opened from a private tab sits on the Tabs pane with
 * the regular surface, and is usable under the lock with no cover; the private media
 * notification's tap under the lock brings the tab to the front under the cover, its view never
 * shown (the first-line review's gate 2); and with the screen lock cleared while the app is away
 * the lock comes off on return, the switch reads disabled with "Needs a screen lock on this
 * device." and a finger on it asks nothing.
 *
 * The credential prompt: the emulator has no enrolled biometric, so `BiometricPrompt` (with
 * `BIOMETRIC_WEAK or DEVICE_CREDENTIAL`) falls back to the device credential – SystemUI's PIN
 * view, a window of its own with an `EditText` – and the driver answers it the way the passwords
 * demos do (`AutofillDemo.answerPin`): the digits as key events through UiAutomation, then Enter.
 * A real finger cannot press a PIN pad that is not there (the credential view takes the keyboard's
 * digits, it draws no pad of its own); nothing of the product is stubbed for it.
 *
 * Driven by the `android-private-lock-demo` workflow, on the same engine as the private tabs demo
 * (a Chromium snapshot WebView on the AOSP image: private tabs need multi-profile WebView). See
 * [DemoHarness] for the plumbing; findings land in `private-lock-findings.txt`, a check that
 * fails there fails the run. The recorder sees the private surface because
 * `PrivateBrowsing.captureForRecording` is on for the run; the guard's real state is read with
 * the override dropped for a moment each time ([guardNow]). One consequence to read the video
 * with: as the window leaves (scene 2's Home) FLAG_SECURE is off, so the system keeps its task
 * snapshot of the live page and shows it as the starting window on the way back, ahead of the
 * app's own first frame – that is the OS's picture, not a frame of ours (the visibility watch has
 * the view GONE then); a release build has the guard up at the departure and no snapshot is kept.
 */
@RunWith(AndroidJUnit4::class)
class PrivateLockDemo : DemoHarness("private-demo-state.json", "private-lock", "private-lock-demo") {
    override val tag = "PrivateLockDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private val host get() = (activity as MainActivity).host
    private var pinSet = false

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        var fault: Throwable? = null
        try {
            runDemo()
        } catch (e: Throwable) {
            fault = e
        } finally {
            server.close()
            PrivateBrowsing.captureForRecording = false
            if (pinSet) shell("locksettings clear --old $PIN")
        }
        if (failures.isNotEmpty() || fault != null) {
            throw AssertionError(
                "${failures.size} check(s) failed: ${failures.joinToString("; ")}" +
                    (fault?.let { "; and: ${it.message}" } ?: "")
            )
        }
    }

    /** The recording must show the private surface (see the class comment); the PIN is the lock the switch needs. */
    override fun beforeLaunch() {
        PrivateBrowsing.captureForRecording = true
        // The credential prompt is a window of its own (SystemUI's): findInWindows must see it.
        val info = ui.serviceInfo
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        ui.serviceInfo = info
        Log.i(tag, "set-pin: ${shell("locksettings set-pin $PIN").trim()}")
        pinSet = true
        shell("wm dismiss-keyguard")
    }

    // --- the pages -------------------------------------------------------------------------------

    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/" to DemoServer.page("Cookie jar", "<p>The regular tab the profile opens on.</p>"),
        "/notes.html" to DemoServer.page("Notes", "<p>A second regular tab, so the Tabs pane has two cards.</p>"),
        // Large, readable text: what the cover hides, and what a leaked frame would show.
        "/secret.html" to ("text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>$SECRET_TITLE</title>" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff7e6}main{padding:36px 24px}" +
                "h1{font-size:34px;margin:0 0 20px;color:#7a3e00}p{font-size:24px;line-height:1.45;margin:0 0 18px}" +
                ".tag{display:inline-block;padding:8px 14px;border-radius:12px;background:#ffd9a3;font-size:20px}</style></head>" +
                "<body><main><h1>$SECRET_TITLE</h1><p class=tag>Only a private tab reads this</p>" +
                "<p>Dentist on Thursday at 9. Gift for June: the blue kettle. Passport renewal by the 14th.</p>" +
                "<p>The lock cover must hide every word of this page until the screen lock is passed.</p></main></body></html>"
            ).toByteArray()),
        // A track behind a button (the WebView wants a gesture before a page plays): the private
        // media notification's tap under the lock is what this page is for.
        "/audio.html" to ("text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Private audio</title>" +
                "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#eef3ff}main{padding:36px 24px}" +
                "h1{font-size:30px;margin:0 0 20px}#play{display:block;width:100%;height:96px;font-size:24px;border:0;" +
                "border-radius:16px;background:#1d3557;color:#fff}#state{margin-top:20px;font-size:20px}</style></head>" +
                "<body><main><h1>Private audio</h1><button id=play type=button>Play the track</button>" +
                "<p id=state>stopped</p><audio id=media src=/tone.wav loop preload=auto></audio></main><script>" +
                "var m=document.getElementById('media');document.getElementById('play').addEventListener('click',function(){m.play()});" +
                "['playing','pause'].forEach(function(e){m.addEventListener(e,function(){document.getElementById('state').textContent=m.paused?'paused':'playing'})});" +
                "</script></body></html>"
            ).toByteArray()),
        "/tone.wav" to ("audio/wav" to tone())
    )

    /** A twenty-second 16 kHz mono PCM WAV: a soft two-note pulse, for the media session to have a track. */
    private fun tone(): ByteArray {
        val rate = 16_000
        val samples = rate * 20
        val data = ByteArray(samples * 2)
        for (i in 0 until samples) {
            val t = i.toDouble() / rate
            val f = if ((t * 2).toInt() % 2 == 0) 330.0 else 440.0
            val envelope = 1.0 - (t * 2 - (t * 2).toInt())
            val s = (sin(2 * PI * f * t) * 0.4 * envelope * Short.MAX_VALUE).toInt()
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

    // --- sequence --------------------------------------------------------------------------------

    /**
     * The seeded tabs get their pages, the Settings chunk, the overview and the menu come up once
     * each off camera (the first of each pays for layout and compilation), and the private
     * profile is created once and wiped (the first private tab's profile creation is the slow one).
     */
    override fun warmUp() {
        findings = File(out, "private-lock-findings.txt")
        findings.writeText(
            "Zenium Android private tab lock (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, " +
                "WebView ${WebViewCompat.getCurrentWebViewPackage(app)?.versionName ?: "?"})\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        finding("multi-profile WebView: ${onMain { Profiles.supported }}; device PIN set: $pinSet; screen lock per the host (reauth.available): ${onMain { host.reauth.available() }}")
        awaitLoaded(REGULAR_TAB, "$ORIGIN/")
        coreInvoke("tab.activate", json("tabId" to NOTES_TAB).toString())
        awaitLoaded(NOTES_TAB, "$ORIGIN/notes.html")
        SystemClock.sleep(800)
        coreInvoke("tab.activate", json("tabId" to REGULAR_TAB).toString())
        awaitLoaded(REGULAR_TAB, "$ORIGIN/")
        val warm = coreInvoke("page.open", "{\"id\":\"settings\",\"section\":null}")
        awaitChrome("!!document.querySelector('$SETTINGS_SEARCH')", 12_000)
        SystemClock.sleep(600)
        coreInvoke("tab.close", "{\"tabId\":$warm}")
        SystemClock.sleep(1_000)
        if (openOverview()) {
            SystemClock.sleep(1_200)
            back()
            awaitOverviewGone()
        }
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(800)
            back()
            waitForGone(MENU_HANDLE_LABEL)
        }
        coreInvoke("tab.newPrivate", "{}")
        awaitPrivateActive()
        SystemClock.sleep(1_500)
        coreInvoke("tab.closePrivate")
        awaitNoPrivateTabs()
        settle()
        ensureForeground()
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        ensureForeground()
        // Whichever regular tab the core left active after the warm-up's private session closed
        // (run 1: the notes tab, not the seeded first one) – the scenes activate what they need.
        val active = activeCoreTab()?.optString("id")
        val activeView = active?.let { host.tabs.get(it) }
        expect("set-up: the active regular tab's view is on screen", active in setOf(REGULAR_TAB, NOTES_TAB) && activeView != null && onMain { activeView.visibility == View.VISIBLE })
        finding("  set-up: active tab $active")

        // 1. The switch (SET-17): Settings > Privacy and Security under a finger, the row reads
        //    off with its description; a finger on it brings the system's credential prompt; the
        //    PIN turns it on (the row, the core's device-local state); a second finger and a
        //    cancelled prompt leave it on. Then with a private tab open: off through the prompt –
        //    the prompt's own activity stops ours, and the lock must not arm under it – and on again.
        scene("1. The switch with the credential (SET-17)") {
            expect("the switch is off by default", !lockOnLeave())
            expect("Settings > Privacy and Security opens under a finger", openPrivacySettings())
            val rest = switchRow()
            shot("01-switch-rest")
            expect("the row reads off, enabled, with its description", rest.checked == "false" && !rest.disabled && rest.text.contains(SWITCH_DESCRIPTION))
            finding("  row at rest: $rest; core privateLockOnLeave ${lockOnLeave()}; store screenLock ${storeField("screenLock")}")
            expect("a finger on the row brings the credential prompt", touchSwitchRow() && awaitCredentialPrompt(10_000))
            SystemClock.sleep(1_200)
            shot("02-pin-prompt")
            expect("the PIN is accepted", answerPin("the switch on"))
            expect("the PIN turns the switch on: the row and the core agree", awaitSwitch(checked = true))
            SystemClock.sleep(1_000)
            shot("03-switch-on")
            finding("  after the PIN: ${switchRow()}; core privateLockOnLeave ${lockOnLeave()}")
            expect("a second finger brings the prompt again", touchSwitchRow() && awaitCredentialPrompt(10_000))
            SystemClock.sleep(800)
            expect("the prompt cancelled (back) leaves the switch on", cancelPrompt() && awaitSwitch(checked = true) && lockOnLeave())
            finding("  after the cancel: ${switchRow()}; core privateLockOnLeave ${lockOnLeave()}; lock ${host.privateLock.locked}")
            // A private tab open, then back on the Settings tab for the flip off and on.
            val settingsTab = activeCoreTab()?.optString("id").orEmpty()
            coreInvoke("tab.newPrivate", "{}")
            expect("set-up: a private tab is open", awaitPrivateActive())
            val p1 = activeCoreTab()?.optString("id").orEmpty()
            settle()
            coreInvoke("tab.activate", json("tabId" to settingsTab).toString())
            expect("set-up: back on the Settings tab", awaitActiveTab(settingsTab))
            SystemClock.sleep(1_200)
            expect("a finger on the row (off) brings the prompt with a private tab open", touchSwitchRow() && awaitCredentialPrompt(10_000))
            SystemClock.sleep(600)
            val armedUnderPrompt = host.privateLock.locked
            expect("our own prompt in front does not arm the lock (the tabs stay unlocked)", !armedUnderPrompt)
            expect("the PIN turns the switch off", answerPin("the switch off") && awaitSwitch(checked = false) && !lockOnLeave())
            expect("nothing is locked after the flip off", !host.privateLock.locked && !storeLocked())
            finding("  flip off with private tab $p1 open: lock armed under the prompt $armedUnderPrompt; after: ${switchRow()}, lock ${host.privateLock.locked}")
            expect("a finger and the PIN turn it on again", touchSwitchRow() && awaitCredentialPrompt(10_000) && answerPin("the switch on again") && awaitSwitch(checked = true))
            finding("  on again: ${switchRow()}; core ${lockOnLeave()}; host switch ${host.privateLock.enabled}, open private tabs ${host.privateLock.openTabs}")
            expect("the host mirrors the switch and the count", host.privateLock.enabled && host.privateLock.openTabs == 1)
            // The switch's Settings tab goes: the scenes after this one count the seeded regular
            // pair on the Tabs pane, and the #232 rider wants Settings to open afresh from its
            // private tab (Settings is one per window – an open one is activated, its opener kept).
            closeSettingsTabs()
            finding("  set-up: the switch's Settings tab closed; regular tabs ${regularTabIds()}")
        }

        // 2. Home and back (INC-05): the private tab on the secret page, Home, back – the cover.
        //    The private view's visibility is read every 8 ms from before the departure until
        //    the cover is confirmed: after the stop, no sample may have it VISIBLE with the
        //    activity started (the host hides it as the lock arms, ahead of the chrome).
        val privateTab = privateTabIds().firstOrNull().orEmpty()
        scene("2. Home and back: the lock cover over the private page (INC-05)") {
            expect("set-up: the private tab exists", privateTab.isNotEmpty())
            coreInvoke("tab.activate", json("tabId" to privateTab).toString())
            awaitActiveTab(privateTab)
            coreInvoke("tab.navigate", json("tabId" to privateTab, "input" to "$ORIGIN/secret.html").toString())
            expect("set-up: the private tab shows the secret page", awaitLoaded(privateTab, "$ORIGIN/secret.html"))
            settle()
            touchWithoutGesture()
            SystemClock.sleep(1_500)
            shot("04-private-page-before-leaving")
            val view = host.tabs.get(privateTab)
            expect("set-up: the private page's view is on screen", view != null && onMain { view!!.visibility == View.VISIBLE })
            val watch = view?.let { VisibilityWatch(it, armAtStart = false).also(Thread::start) }
            home()
            expect("Home puts Zenium in the background", awaitFront(ours = false))
            val lockedAway = awaitLocked(4_000)
            SystemClock.sleep(1_500)
            returnToApp()
            expect("Zenium is back in front", awaitFront(ours = true))
            val coverAt = awaitCover(12_000)
            val watchReport = watch?.finish()
            expect("the lock armed as the window left", lockedAway)
            expect("the lock cover is over the private page on return", coverAt)
            expect("the host holds the lock and the chrome's store agrees", host.privateLock.locked && storeLocked())
            expect("the private page's view is hidden under the cover", view != null && onMain { view!!.visibility != View.VISIBLE })
            expect("no frame of the live page: the view was never VISIBLE with the activity started after the stop", watch != null && watch.leaks == 0 && watch.sawStop)
            finding("  visibility watch (private view, 8 ms samples): $watchReport")
            finding(
                "  note on the recording: the return frames before the app's own first frame show the OS task-snapshot starting window, " +
                    "a picture the system took at the departure – present only because this run has captureForRecording on, so FLAG_SECURE was off as the window left; " +
                    "the watch above says the view was GONE then. A release build has the guard up on the private surface at the departure (#203), the system keeps no snapshot, and that starting window is blank. Not a product leak."
            )
            expect("the pill reads Private tab and asks for the unlock", awaitChrome("!!document.querySelector('[data-private-locked]')", 4_000) && findByLabel(PILL_LOCKED_LABEL) != null)
            expect("no Site information control under the lock", findByLabel("Site information") == null)
            val guard = guardNow()
            expect("FLAG_SECURE is on the window under the cover (a release build's read)", guard)
            val picture = coverHasPicture()
            val a11y = a11yLabels()
            expect("the accessibility tree carries nothing of the page under the cover", a11y.none { it.contains(SECRET_TITLE, ignoreCase = true) || it.contains(HOST) })
            finding(
                "  cover: ${coverState()}; the tab's picture under the veil: $picture; FLAG_SECURE ${onOff(guard)}; private surface ${host.privateSurface}; " +
                    "pill '${pillText()}'; a11y labels (${a11y.size}): ${a11y.take(30)}"
            )
            SystemClock.sleep(800)
            shot("05-cover-over-page")
        }

        // 3. The regular surfaces under the lock: the overview opens on the Private pane under its
        //    cover (the grid inert, every card a Private tab); Tabs shows the regular cards with the
        //    guard off; a regular card opens its page. Back to the private tab (set-up, through the
        //    core): the host keeps its view hidden until the cover is up (gate 2's invariant).
        scene("3. Regular surfaces usable under the lock") {
            expect("the overview opens from the covered private tab", openOverview())
            expect("the overview opens on the Private pane", awaitPane("private"))
            SystemClock.sleep(1_500)
            val paneCover = paneCoverUp()
            val inert = gridInert()
            val masked = cardsMasked()
            val labels = a11yLabels()
            expect("the Private pane is under the cover", paneCover)
            expect("the covered grid is inert and hidden from accessibility", inert)
            expect("every private card reads Private tab, masked", masked)
            expect("nothing of the page and no card control reaches the accessibility tree", labels.none { it.contains(SECRET_TITLE, ignoreCase = true) || it.contains(HOST) || it == "Close tab" })
            finding("  Private pane: cover $paneCover, grid inert $inert, cards ${cards()} masked $masked; a11y labels (${labels.size}): ${labels.take(30)}")
            shot("06-cover-over-private-pane")
            tapSegment("tabs")
            expect("a finger on Tabs shows the regular pane", awaitPane("tabs"))
            SystemClock.sleep(1_500)
            val regularCards = cards()
            val guardOnTabs = guardNow()
            val privateIds = privateTabIds()
            expect(
                "the Tabs pane shows the regular cards and no private one, no cover",
                regularCards.containsAll(setOf(REGULAR_TAB, NOTES_TAB)) && regularCards.none { it in privateIds } && !paneCoverUp()
            )
            expect("FLAG_SECURE is off on the regular pane", !guardOnTabs)
            finding("  Tabs pane: cards $regularCards, cover ${paneCoverUp()}, FLAG_SECURE ${onOff(guardOnTabs)}, lock still held ${host.privateLock.locked}")
            shot("07-regular-pane-under-lock")
            chromeRect(card(REGULAR_TAB))?.let { Finger().tap(it.exactCenterX(), it.exactCenterY()) }
            expect("a finger on the regular card opens its page", awaitActiveTab(REGULAR_TAB) && awaitOverviewGone())
            settle()
            val regularShown = host.tabs.get(REGULAR_TAB)?.let { v -> onMain { v.visibility == View.VISIBLE } } ?: false
            val guardOnRegular = guardNow()
            expect("the regular page is on screen with no cover and the guard off, the lock still held", regularShown && !coverUp() && !guardOnRegular && host.privateLock.locked)
            finding("  regular tab: view visible $regularShown, cover ${coverUp()}, FLAG_SECURE ${onOff(guardOnRegular)}, lock ${host.privateLock.locked}")
            shot("08-regular-tab-under-lock")
            // Back to the locked private tab (set-up through the core, as a card's or a
            // notification's activation would): the host refuses to show its view under the lock.
            val view = host.tabs.get(privateTab)
            val watch = view?.let { VisibilityWatch(it, armAtStart = true).also(Thread::start) }
            coreInvoke("tab.activate", json("tabId" to privateTab).toString())
            val covered = awaitActiveTab(privateTab) && awaitCover(10_000)
            val report = watch?.finish()
            expect("the private tab activated under the lock shows the cover, its view never VISIBLE meanwhile (the host's invariant)", covered && watch != null && watch.leaks == 0)
            finding("  activation under the lock: cover $covered; visibility watch: $report")
            SystemClock.sleep(1_000)
        }

        // 4. Unlock under a finger: the prompt cancelled keeps the cover; a wrong PIN keeps it
        //    with the prompt's own message; the PIN lifts it on the spring, every write of
        //    `--zen-lock-p` on record – the last one 0 before the cover goes – the page back in
        //    view and FLAG_SECURE on for the private surface.
        scene("4. Unlock: a cancel, a wrong PIN, the pass and the lift") {
            expect("set-up: the cover is up over the private tab", coverUp() && activeCoreTab()?.optString("id") == privateTab)
            expect("a finger on Unlock brings the credential prompt", touchTapLabel(UNLOCK_LABEL) && awaitCredentialPrompt(10_000))
            SystemClock.sleep(1_200)
            shot("09-unlock-prompt")
            expect("the prompt cancelled keeps the cover and the lock", cancelPrompt() && coverUp() && host.privateLock.locked && storeLocked())
            finding("  after the cancel: cover ${coverState()}, lock ${host.privateLock.locked}, prompting ${storeField("prompting")}")
            SystemClock.sleep(800)
            expect("Unlock again brings the prompt", touchTapLabel(UNLOCK_LABEL) && awaitCredentialPrompt(10_000))
            SystemClock.sleep(800)
            keys(WRONG_PIN)
            pressKey(KeyEvent.KEYCODE_ENTER)
            SystemClock.sleep(1_500)
            val stillUp = credentialPromptShowing()
            shot("10-wrong-pin")
            expect("a wrong PIN leaves the prompt up with its own message, the cover behind it", stillUp && coverUp() && host.privateLock.locked)
            finding("  wrong PIN: prompt still up $stillUp; prompt labels ${promptLabels().take(12)}")
            expect("the prompt cancelled after the wrong PIN keeps the cover", cancelPrompt() && coverUp() && host.privateLock.locked)
            SystemClock.sleep(800)
            watchLift()
            expect("Unlock once more brings the prompt", touchTapLabel(UNLOCK_LABEL) && awaitCredentialPrompt(10_000))
            SystemClock.sleep(800)
            expect("the PIN is accepted", answerPin("unlock"))
            val gone = awaitCoverGone(10_000)
            val lift = liftTrace()
            expect("the lock comes off: the host and the chrome's store", awaitUnlocked(5_000))
            expect("the cover lifts and goes", gone)
            expect("the lift runs on the spring and lands at 0 (${lift.frames} writes, last ${lift.last})", lift.frames >= 3 && lift.landed)
            settle()
            val view = host.tabs.get(privateTab)
            val shown = view != null && onMain { view.visibility == View.VISIBLE }
            val guard = guardNow()
            expect("the private page is back in view", shown)
            expect("FLAG_SECURE stays on for the private surface after the unlock", guard && host.privateSurface)
            finding("  lift: $lift; view visible $shown; FLAG_SECURE ${onOff(guard)}; pill '${pillText()}'")
            shot("11-unlocked")
        }

        // 5. Services' notification and the last tab's close under the lock: locked again, a
        //    finger on the "Close all private tabs" card in the shade ends the session – no
        //    prompt, the lock released with the count, the card gone, the guard off, the chrome
        //    back on the space theme; Home and back with no private tab locks nothing. Then the
        //    in-app path: a private tab, locked, the menu's Close Private Tabs under the cover.
        scene("5. Close all private tabs under the lock: the notification, then the menu") {
            expect("set-up: the session's card stands", awaitCard(6_000) != null)
            lockAgain()
            expect("locked again: the cover is over the private tab", coverUp() && host.privateLock.locked)
            val cardNode = openShade { it == PrivateSession.TITLE }
            expect("the shade shows the Close all private tabs card", cardNode != null)
            var pressed = false
            if (cardNode != null) {
                SystemClock.sleep(1_500)
                shot("12-shade-private-card-under-lock")
                val bounds = steadyBounds(cardNode) ?: Rect().also { cardNode.getBoundsInScreen(it) }
                Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
                finding("  finger on the card at ${bounds.centerX()},${bounds.centerY()}")
                pressed = awaitNoPrivateTabs(12_000)
                if (!pressed) touchFault("a touch on the private session's card did not take: private tabs remain")
            }
            val promptCame = credentialPromptShowing()
            expect("a finger on the card closes every private tab with no prompt asked", pressed && !promptCame)
            expect("the lock is released with the count", awaitUnlocked(6_000) && host.privateLock.openTabs == 0)
            expect("the card comes down", awaitCardGone(8_000))
            if (frontPackage() != app.packageName) closeShade()
            ensureForeground()
            settle()
            val guard = guardNow()
            expect("the guard is off and the chrome back on the space theme", !guard && !host.privateSurface && !host.themeDark && !coverUp())
            finding("  after the card: private tabs ${privateTabIds()}, lock ${host.privateLock.locked}, FLAG_SECURE ${onOff(guard)}, chrome dark ${host.themeDark}, active ${activeCoreTab()?.optString("id")}")
            shot("13-after-close-all")
            lockAgain(expectLock = false)
            expect("Home and back with no private tab locks nothing", !host.privateLock.locked && !coverUp())
            // The in-app path under the cover: the menu is a regular surface.
            coreInvoke("tab.newPrivate", "{}")
            expect("set-up: a private tab again", awaitPrivateActive())
            val p2 = activeCoreTab()?.optString("id").orEmpty()
            coreInvoke("tab.navigate", json("tabId" to p2, "input" to "$ORIGIN/secret.html").toString())
            awaitLoaded(p2, "$ORIGIN/secret.html")
            settle()
            lockAgain()
            expect("locked: the cover over the new private tab", coverUp() && host.privateLock.locked)
            val went = openMenuItem(MENU_CLOSE_PRIVATE)
            val ended = awaitNoPrivateTabs()
            if (went && !ended) touchFault("a touch on '$MENU_CLOSE_PRIVATE' did not take: private tabs remain")
            expect("the menu's Close Private Tabs under the cover ends the session, no prompt", went && ended && !credentialPromptShowing())
            expect("the last private tab closed clears the lock", awaitUnlocked(6_000))
            settle()
            expect("no cover, the chrome on the space theme", !coverUp() && !host.themeDark)
            finding("  after Close Private Tabs: lock ${host.privateLock.locked}, open ${host.privateLock.openTabs}, cover ${coverUp()}, active ${activeCoreTab()?.optString("id")}")
            shot("14-menu-close-private-under-lock")
        }

        // 6. The #232 rider: a Settings tab opened from a private tab is a regular tab – on the
        //    Tabs pane, with the regular surface – and stays usable under the lock, no cover.
        scene("6. #232 rider: Settings from a private tab sits on the Tabs pane") {
            coreInvoke("tab.newPrivate", "{}")
            expect("set-up: a private tab", awaitPrivateActive())
            val p3 = activeCoreTab()?.optString("id").orEmpty()
            coreInvoke("tab.navigate", json("tabId" to p3, "input" to "$ORIGIN/secret.html").toString())
            awaitLoaded(p3, "$ORIGIN/secret.html")
            settle()
            // No Settings tab may stand: the page is one per window, and the menu would activate
            // the open one – with the opener it had (run 3: scene 1's, opened from the notes tab).
            // The rider is a fresh open from the private tab.
            val standing = closeSettingsTabs()
            expect("set-up: no Settings tab open before the menu's Settings", settingsTabIds().isEmpty())
            if (standing.isNotEmpty()) finding("  set-up: Settings tab(s) $standing closed first")
            val picked = pickMenuRow("Settings")
            finding("  Settings row: $picked")
            val settingsTab = awaitPage(SETTINGS_URL, 12_000)
            if (picked.startsWith("a finger") && settingsTab == null) touchFault("the touch on the menu's Settings did not open the Settings tab")
            val settingsId = settingsTab?.optString("id").orEmpty()
            settle()
            expect("the menu's Settings from a private tab opens a Settings tab", settingsTab != null)
            expect("the Settings tab is a regular tab (the default container) that remembers its private opener", settingsTab?.optString("containerId") == Profiles.DEFAULT_CONTAINER && settingsTab?.optString("openerTabId") == p3)
            expect("the chrome shows the regular surface on it: no private surface, the space theme", !host.privateSurface && !host.themeDark && chromeScheme() != "dark")
            finding("  Settings tab $settingsId: containerId '${settingsTab?.optString("containerId")}', opener '${settingsTab?.optString("openerTabId")}', private surface ${host.privateSurface}, chrome scheme '${chromeScheme()}'")
            expect("the overview opens from the Settings tab", openOverview())
            expect("on the Tabs pane", awaitPane("tabs"))
            SystemClock.sleep(1_500)
            val tabsCards = cards()
            expect("the Settings card sits on the Tabs pane, the private card does not", settingsId in tabsCards && p3 !in tabsCards)
            finding("  Tabs pane cards $tabsCards (Settings $settingsId, private $p3)")
            shot("15-settings-from-private-on-tabs-pane")
            back()
            awaitOverviewGone()
            expect("set-up: back on the Settings tab", awaitActiveTab(settingsId))
            lockAgain()
            expect("locked with Settings in front: no cover over Settings, the guard off, the lock held for the private tab", !coverUp() && !guardNow() && host.privateLock.locked)
            expect("Settings stays usable under the lock: a finger on Privacy and Security opens the section", touchTapLabel("Privacy and Security", prefix = true) && awaitSurface(up = true, timeoutMs = 8_000))
            SystemClock.sleep(1_200)
            shot("16-settings-under-lock")
            finding("  Settings under the lock: cover ${coverUp()}, lock ${host.privateLock.locked}, section up ${chromeSurfaceUp()}")
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
            coreInvoke("tab.closePrivate")
            expect("set-up: the session ends (the lock with it)", awaitNoPrivateTabs() && awaitUnlocked(6_000))
            settle()
        }

        // 7. Gate 2: the private media notification's tap under the lock. A private tab plays a
        //    track (a finger on the page's button), a regular tab in front, Home and back (the
        //    lock armed, no cover over the regular page); the shade's media card reads "A site is
        //    playing media"; a finger on it brings the private tab to the front under the cover,
        //    its view read every 8 ms from the touch: never VISIBLE.
        scene("7. The media notification's tap under the lock (gate 2)") {
            coreInvoke("tab.newPrivate", "{}")
            expect("set-up: a private tab", awaitPrivateActive())
            val p4 = activeCoreTab()?.optString("id").orEmpty()
            coreInvoke("tab.navigate", json("tabId" to p4, "input" to "$ORIGIN/audio.html").toString())
            expect("set-up: the audio page loads", awaitLoaded(p4, "$ORIGIN/audio.html"))
            settle()
            expect("a finger on Play starts the track", tapPage(p4, "#play") && awaitPageState(p4, "playing", 10_000))
            val media = awaitNotification(MediaPlaybackService.NOTIFICATION_ID, 15_000) { cardTitle(it) == MediaControls.PRIVATE_TITLE }
            expect("the private media notification is posted, reading A site is playing media", media != null)
            finding("  media card: ${describeCard(media)}")
            SystemClock.sleep(1_000)
            shot("17-private-audio-playing")
            coreInvoke("tab.activate", json("tabId" to REGULAR_TAB).toString())
            expect("set-up: the regular tab in front", awaitActiveTab(REGULAR_TAB))
            settle()
            lockAgain()
            expect("locked with the regular tab in front: the lock held, no cover", host.privateLock.locked && !coverUp())
            val view = host.tabs.get(p4)
            val watch = view?.let { VisibilityWatch(it, armAtStart = true).also(Thread::start) }
            val cardNode = openShade { it == MediaControls.PRIVATE_TITLE }
            expect("the shade shows the media card", cardNode != null)
            var revealed = false
            if (cardNode != null) {
                SystemClock.sleep(1_200)
                shot("18-shade-media-card-under-lock")
                val bounds = steadyBounds(cardNode) ?: Rect().also { cardNode.getBoundsInScreen(it) }
                Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
                finding("  finger on the media card at ${bounds.centerX()},${bounds.centerY()}")
                revealed = awaitActiveTab(p4, 10_000)
                if (!revealed) touchFault("a touch on the media card did not bring the private tab to the front")
            }
            val covered = revealed && awaitCover(10_000)
            val report = watch?.finish()
            if (frontPackage() != app.packageName) closeShade()
            ensureForeground()
            expect("the card's tap brings the private tab to the front under the cover", covered)
            expect("the private view was never VISIBLE between the tap and the cover (the host's invariant)", watch != null && watch.leaks == 0)
            expect("the view is hidden and the lock held", view != null && onMain { view!!.visibility != View.VISIBLE } && host.privateLock.locked)
            val guard = guardNow()
            expect("FLAG_SECURE is on under the cover", guard)
            finding("  media reveal under the lock: active ${activeCoreTab()?.optString("id")}, cover ${coverState()}, FLAG_SECURE ${onOff(guard)}, page state '${pageState(p4)}'; visibility watch: $report")
            SystemClock.sleep(800)
            shot("19-media-reveal-under-cover")
            coreInvoke("tab.closePrivate")
            expect("set-up: the session ends", awaitNoPrivateTabs() && awaitUnlocked(6_000))
            settle()
        }

        // 8. No screen lock. Locked (the PIN set) and the PIN cleared while the app is away: the
        //    lock comes off on return (nothing could pass it). The row then reads on but disabled
        //    with "Needs a screen lock on this device."; a finger on it asks nothing; Home and
        //    back with a private tab open locks nothing.
        scene("8. No screen lock: the lock lets go on return, the switch disabled") {
            coreInvoke("tab.newPrivate", "{}")
            expect("set-up: a private tab", awaitPrivateActive())
            val p5 = activeCoreTab()?.optString("id").orEmpty()
            coreInvoke("tab.navigate", json("tabId" to p5, "input" to "$ORIGIN/secret.html").toString())
            awaitLoaded(p5, "$ORIGIN/secret.html")
            settle()
            home()
            expect("Home puts Zenium in the background", awaitFront(ours = false))
            val armed = awaitLocked(4_000)
            val cleared = shell("locksettings clear --old $PIN").trim()
            pinSet = false
            finding("  away: lock armed $armed; locksettings clear: '$cleared'")
            SystemClock.sleep(1_500)
            returnToApp()
            expect("Zenium is back in front", awaitFront(ours = true))
            SystemClock.sleep(2_500)
            expect("the lock armed on the way out", armed)
            expect("the screen lock removed while away: the lock comes off on return, no cover", awaitUnlocked(6_000) && !coverUp())
            expect("the chrome hears there is no screen lock", awaitStore("screenLock", "false", 6_000))
            val view = host.tabs.get(p5)
            expect("the private page is in view", view != null && onMain { view!!.visibility == View.VISIBLE })
            finding("  on return: lock ${host.privateLock.locked}, store screenLock ${storeField("screenLock")}, host reauth.available ${onMain { host.reauth.available() }}")
            shot("20-lock-off-without-screen-lock")
            expect("Settings > Privacy and Security opens", openPrivacySettings())
            val row = awaitSwitchRow(disabled = true, 8_000)
            shot("21-switch-disabled")
            expect("the row reads on but disabled, needing a screen lock", row.checked == "true" && row.disabled && row.text.contains(SWITCH_NO_SCREEN_LOCK))
            finding("  row without a screen lock: $row")
            touchSwitchRow()
            val prompted = awaitCredentialPrompt(4_000)
            expect("a finger on the disabled row asks nothing and changes nothing", !prompted && switchRow().checked == "true" && lockOnLeave())
            if (prompted) cancelPrompt()
            coreInvoke("tab.activate", json("tabId" to p5).toString())
            awaitActiveTab(p5)
            settle()
            lockAgain(expectLock = false)
            expect("Home and back without a screen lock locks nothing", !host.privateLock.locked && !coverUp())
            finding("  no screen lock, private tab in front, Home and back: lock ${host.privateLock.locked}, cover ${coverUp()}")
            shot("22-no-lock-without-screen-lock")
            coreInvoke("tab.closePrivate")
            awaitNoPrivateTabs()
        }
        finding("\nchecks failed: ${failures.size}${if (failures.isEmpty()) "" else " – " + failures.joinToString("; ")}")
    }

    // --- scenes and their recovery ----------------------------------------------------------------

    /** A scene: its failures are recorded and the next scene runs on what is left; a thrown error fails the scene, not the run. */
    private fun scene(title: String, block: () -> Unit) {
        finding("\n$title")
        try {
            block()
        } catch (e: Throwable) {
            Log.e(tag, "$title threw", e)
            expect("$title ran through (${e.javaClass.simpleName}: ${e.message})", false)
        }
        recover()
    }

    /** Whatever a scene left standing goes: a credential prompt, the shade, a chrome surface. */
    private fun recover() {
        if (credentialPromptShowing()) cancelPrompt()
        if (frontPackage() == SYSTEM_UI) closeShade()
        ensureForeground()
        if (chromeSurfaceUp()) {
            back()
            awaitSurface(up = false, timeoutMs = 4_000)
        }
    }

    // --- the lock, read from the host and the chrome -------------------------------------------

    private fun lockOnLeave(): Boolean = coreState().optBoolean("privateLockOnLeave")

    /** A field of the chrome's `privateLockStore` (`window.__zenStores['private-lock']`), as text. */
    private fun storeField(name: String): String =
        jsString("(function(){var s=(window.__zenStores||{})['private-lock'];return s?String(s.get()[${JSONObject.quote(name)}]):'?'})()")

    private fun storeLocked(): Boolean = storeField("locked") == "true"

    private fun awaitStore(name: String, value: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (storeField(name) == value) return true
            SystemClock.sleep(200)
        }
        return storeField(name) == value
    }

    private fun awaitUnlocked(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (!host.privateLock.locked && !storeLocked()) return true
            SystemClock.sleep(150)
        }
        return !host.privateLock.locked && !storeLocked()
    }

    /**
     * The host's lock armed, waited for: the launcher is in front the moment its window has the
     * focus, our activity's stop – where the lock goes on – follows its first frame a little
     * later, so a read the instant the launcher is in front can come too early.
     */
    private fun awaitLocked(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (host.privateLock.locked) return true
            SystemClock.sleep(50)
        }
        return host.privateLock.locked
    }

    /** A lock cover at rest is in the chrome's DOM (the frame's or the pane's), not one on its way out. */
    private fun coverUp(): Boolean =
        jsString("(function(){var e=document.querySelector('$COVER');return e&&!e.hasAttribute('data-leaving')?'up':''})()") == "up"

    private fun paneCoverUp(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview-pane $COVER');return e&&!e.hasAttribute('data-leaving')?'up':''})()") == "up"

    private fun coverState(): String =
        jsString("(function(){var e=document.querySelector('$COVER');if(!e)return 'none';return 'up'+(e.hasAttribute('data-leaving')?' leaving':'')+' p='+(e.style.getPropertyValue('--zen-lock-p')||'rest')})()")

    /** The cover in the content frame stands on the tab's blurred picture (an `img` in it), or on the panel base alone. */
    private fun coverHasPicture(): Boolean =
        jsString("(function(){return document.querySelector('$COVER .zen-private-lock-picture img')?'picture':''})()") == "picture"

    private fun awaitCover(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (coverUp()) return true
            SystemClock.sleep(100)
        }
        return coverUp()
    }

    private fun awaitCoverGone(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (jsString("document.querySelector('$COVER')?'up':''") == "") return true
            SystemClock.sleep(100)
        }
        return false
    }

    /** The covered Private pane's grid is out of reach: `inert` and `aria-hidden`. */
    private fun gridInert(): Boolean =
        jsString("(function(){var g=document.querySelector('.zen-overview-pane .zen-overview-grid');return g&&g.hasAttribute('inert')&&g.getAttribute('aria-hidden')==='true'?'inert':''})()") == "inert"

    /**
     * Every card on the pane shown is masked and named Private tab. The cell carries the tab id;
     * the card inside it (`.zen-overview-card`) carries `data-masked` and the name – composed
     * since #237 as "Private tab, tab 1 of 2" (run 3 read the cell for both and found neither).
     */
    private fun cardsMasked(): Boolean =
        jsString(
            "(function(){var cs=Array.prototype.slice.call(document.querySelectorAll('.zen-overview-pane [data-tab-id]'))" +
                ".map(function(cell){return cell.querySelector('.zen-overview-card')||cell});" +
                "if(!cs.length)return '';return cs.every(function(c){return c.hasAttribute('data-masked')&&(c.getAttribute('aria-label')||'').indexOf('Private tab')===0})?'masked':''})()"
        ) == "masked"

    private fun pillText(): String =
        jsString("(function(){var e=document.querySelector('[data-private-locked]');return e?e.textContent.trim():''})()")

    /** The colour scheme the chrome's root carries (`data-theme`): `dark` on the private theme. */
    private fun chromeScheme(): String = jsString("document.documentElement.dataset.theme||''")

    /**
     * Whether FLAG_SECURE is on the window for the surface in view, read as a release build has
     * it: the recording override is dropped for the look and put back after.
     */
    private fun guardNow(): Boolean {
        PrivateBrowsing.captureForRecording = false
        onMain { host.setPrivateSurface(host.privateSurface) }
        SystemClock.sleep(600)
        val guarded = onMain { PrivateBrowsing.guarded(activity.window) }
        PrivateBrowsing.captureForRecording = true
        onMain { host.setPrivateSurface(host.privateSurface) }
        SystemClock.sleep(600)
        return guarded
    }

    // --- the lift, every write of --zen-lock-p on record ------------------------------------------

    /**
     * Put the cover's lift on record: a MutationObserver notes every write of `--zen-lock-p` on
     * the cover's inline style (the spring's frames) and the cover's removal. Attribute mutations
     * are delivered whole, unlike a sampler that could miss the last frame before the unmount.
     */
    private fun watchLift() {
        chromeJs(
            "(function(){window.__lift=[];var t0=performance.now();if(window.__liftWatch)window.__liftWatch.disconnect();" +
                "var isCover=function(n){return n&&n.getAttribute&&n.getAttribute('data-testid')==='private-lock-cover'};" +
                "window.__liftWatch=new MutationObserver(function(ms){ms.forEach(function(m){" +
                "if(m.type==='attributes'&&isCover(m.target)){window.__lift.push([Math.round(performance.now()-t0),m.target.style.getPropertyValue('--zen-lock-p')||'rest'])}" +
                "if(m.type==='childList'){Array.prototype.forEach.call(m.removedNodes,function(n){if(isCover(n)||(n.querySelector&&n.querySelector('[data-testid=\"private-lock-cover\"]')))window.__lift.push([Math.round(performance.now()-t0),'gone'])})}})});" +
                "window.__liftWatch.observe(document.body,{attributes:true,attributeFilter:['style'],subtree:true,childList:true})})()"
        )
    }

    private class Lift(val frames: Int, val last: String, val landed: Boolean, val summary: String) {
        override fun toString() = summary
    }

    /** The lift as recorded: the numeric writes (frames), the last of them, whether it reached 0 before the cover went. */
    private fun liftTrace(): Lift {
        val raw = jsString("JSON.stringify(window.__lift||[])")
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return Lift(0, "", false, "no record")
        val values = ArrayList<String>()
        var gone = -1
        var lastNumeric = -1
        for (i in 0 until array.length()) {
            val entry = array.getJSONArray(i)
            val value = entry.getString(1)
            if (value == "gone") { if (gone < 0) gone = entry.getInt(0) }
            else if (value != "rest" && value.toFloatOrNull() != null) {
                values += value
                lastNumeric = entry.getInt(0)
            }
        }
        val distinct = values.distinct()
        val last = values.lastOrNull().orEmpty()
        val landed = (last.toFloatOrNull() ?: 1f) <= 0.004f && gone >= 0 && gone >= lastNumeric
        val steps = values.mapNotNull { it.toFloatOrNull() }.zipWithNext { a, b -> a - b }
        val maxStep = steps.maxOrNull() ?: 0f
        return Lift(
            distinct.size, last, landed,
            "${values.size} writes (${distinct.size} distinct) from ${values.firstOrNull() ?: "?"} to $last over " +
                "${if (values.isNotEmpty()) lastNumeric - array.getJSONArray(0).getInt(0) else 0} ms, largest step ${"%.3f".format(maxStep)}, " +
                "cover gone at ${if (gone >= 0) "$gone ms" else "never"} ${if (landed) "(landed at 0)" else "(did NOT land at 0)"}; values ${values.take(40)}"
        )
    }

    // --- the private view's visibility, sampled -----------------------------------------------

    /**
     * Reads a tab view's visibility and the activity's lifecycle state every 8 ms on a thread of
     * its own. A leak is a sample with the view VISIBLE while the activity is at least STARTED
     * (on screen) – counted from the first sample after a stop (`armAtStart` false: a departure
     * is expected first), or from the first sample (`armAtStart` true: the view starts hidden and
     * must stay so until the caller stops the watch, once the cover is confirmed).
     */
    private inner class VisibilityWatch(private val view: TabWebView, private val armAtStart: Boolean) : Thread("visibility-watch") {
        @Volatile private var stopped = false
        @Volatile var leaks = 0
        @Volatile var sawStop = false
        private var samples = 0
        private var visibleSamples = 0
        private val runs = ArrayList<String>()
        private var startedAt = 0L

        override fun run() {
            startedAt = SystemClock.uptimeMillis()
            var armed = armAtStart
            var lastKey = ""
            var runStart = 0L
            while (!stopped) {
                val now = SystemClock.uptimeMillis() - startedAt
                val visibility = view.visibility
                val state = runCatching { (activity as? FragmentActivity)?.lifecycle?.currentState }.getOrNull()
                val onScreen = state != null && state.isAtLeast(Lifecycle.State.STARTED)
                if (!onScreen) { sawStop = true; armed = true }
                samples++
                if (visibility == View.VISIBLE) visibleSamples++
                if (armed && onScreen && visibility == View.VISIBLE) leaks++
                val key = "${visibilityName(visibility)}/${state ?: "?"}"
                if (key != lastKey) {
                    if (lastKey.isNotEmpty()) runs += "$lastKey $runStart-$now ms"
                    lastKey = key
                    runStart = now
                }
                SystemClock.sleep(8)
            }
            runs += "$lastKey $runStart-${SystemClock.uptimeMillis() - startedAt} ms"
        }

        /** Stop sampling and describe what was seen. */
        fun finish(): String {
            stopped = true
            join(3_000)
            return "$samples samples, $visibleSamples with the view VISIBLE, $leaks VISIBLE while on screen${if (!armAtStart) " after the stop (stop seen: $sawStop)" else ""}; " +
                "timeline ${runs.take(12)}"
        }

        private fun visibilityName(v: Int) = when (v) {
            View.VISIBLE -> "VISIBLE"
            View.INVISIBLE -> "INVISIBLE"
            else -> "GONE"
        }
    }

    // --- Home, back, the shade ----------------------------------------------------------------------

    private fun home() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    }

    /**
     * Zenium back in front: the running activity's task (singleTask) comes forward, no relaunch.
     * Through the shell, as the media demos do – an activity start from this process while the
     * app stands behind the launcher is a background start the system may refuse (Android 10+,
     * outside its ten-second grace); `am start` from the shell is not. The in-process start is
     * the fallback when the shell's answer is not ok.
     */
    private fun returnToApp() {
        val started = shell("am start -W -a android.intent.action.MAIN -f 0x20000000 -n ${app.packageName}/${MainActivity::class.java.name}")
        if (!started.contains("Status: ok")) {
            finding("  am start: ${started.trim().lines().joinToString(" | ")}; starting from the process instead")
            app.startActivity(Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    /** Home and back; with `expectLock` the lock cover is waited for on return. */
    private fun lockAgain(expectLock: Boolean = true) {
        home()
        expect("Home puts Zenium in the background", awaitFront(ours = false))
        SystemClock.sleep(1_500)
        returnToApp()
        expect("Zenium is back in front", awaitFront(ours = true))
        if (expectLock) awaitCover(10_000) else SystemClock.sleep(2_500)
        ensureForeground()
    }

    private fun frontPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

    private fun awaitFront(ours: Boolean, timeoutMs: Long = 10_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val front = frontPackage()
            if (front != null && (front == app.packageName) == ours) return true
            SystemClock.sleep(200)
        }
        return (frontPackage() == app.packageName) == ours
    }

    /** Pull the shade down and wait for a node of the system UI whose label `matches`. */
    private fun openShade(timeoutMs: Long = 10_000, matches: (String) -> Boolean): AccessibilityNodeInfo? {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findInWindows(SYSTEM_UI, matches)?.let { return it }
            SystemClock.sleep(250)
        }
        finding("  the shade showed nothing that was looked for within $timeoutMs ms; labels: ${windowLabels(SYSTEM_UI).take(40)}")
        return null
    }

    private fun closeShade() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        } else {
            back()
        }
        SystemClock.sleep(1_500)
    }

    // --- the credential prompt --------------------------------------------------------------------

    /** BiometricPrompt fallen back to the device credential: a system window with a text field for the PIN. */
    private fun credentialPromptShowing(): Boolean = nodesInWindows { node ->
        node.packageName?.toString() in CREDENTIAL_PACKAGES && node.className?.toString() == "android.widget.EditText"
    }.isNotEmpty()

    private fun awaitCredentialPrompt(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (credentialPromptShowing()) return true
            SystemClock.sleep(200)
        }
        return false
    }

    /** The prompt's own words (the credential view's labels), for the findings. */
    private fun promptLabels(): List<String> = CREDENTIAL_PACKAGES.flatMap { windowLabels(it) }

    /** Type the PIN into the prompt (key events through UiAutomation) and Enter; true once the prompt has gone. */
    private fun answerPin(why: String): Boolean {
        if (!credentialPromptShowing()) {
            finding("  no credential prompt to answer for $why")
            return false
        }
        keys(PIN)
        pressKey(KeyEvent.KEYCODE_ENTER)
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (credentialPromptShowing() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        val gone = !credentialPromptShowing()
        finding("  credential prompt for $why: ${if (gone) "accepted the PIN" else "still up after the PIN"}")
        SystemClock.sleep(800)
        return gone
    }

    /**
     * The system's back on the prompt: it closes with the user's cancel. Back closes the PIN
     * field's keyboard first and the prompt itself next (the passwords demos' finding), so it is
     * pressed until the prompt is gone, a clickable Cancel of the prompt the fallback on the
     * third try. True once it has gone. With no prompt up nothing is pressed and it is false:
     * back with no prompt in front lands on the app (run 1: four of them closed the private tab
     * whose Unlock had brought no prompt, and the scenes after it lost their session).
     */
    private fun cancelPrompt(): Boolean {
        if (!credentialPromptShowing()) {
            finding("  no credential prompt to cancel")
            return false
        }
        for (attempt in 1..4) {
            val cancel = if (attempt == 3) nodesInWindows { node ->
                node.packageName?.toString() in CREDENTIAL_PACKAGES && node.isClickable &&
                    listOf(node.text, node.contentDescription).any { it?.toString()?.trim() == "Cancel" }
            }.firstOrNull() else null
            if (cancel != null) cancel.performAction(AccessibilityNodeInfo.ACTION_CLICK) else back()
            val deadline = SystemClock.uptimeMillis() + 2_500
            while (credentialPromptShowing() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
            if (!credentialPromptShowing()) {
                if (attempt > 1) finding("  the credential prompt went after $attempt presses")
                break
            }
        }
        SystemClock.sleep(800)
        ensureForeground()
        return !credentialPromptShowing()
    }

    /** One character's events at a time, each stamped as it goes (a burst is dropped as stale on the slow emulator). */
    private fun keys(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (char in text) {
            val events = map.getEvents(charArrayOf(char)) ?: error("no key events for '$char'")
            for (event in events) {
                ui.injectInputEvent(event, true)
                SystemClock.sleep(25)
            }
        }
        SystemClock.sleep(200)
    }

    private fun pressKey(keyCode: Int) {
        val now = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(now, SystemClock.uptimeMillis(), action, keyCode, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD)
            ui.injectInputEvent(event, true)
            SystemClock.sleep(30)
        }
        SystemClock.sleep(300)
    }

    // --- Settings and the switch row ---------------------------------------------------------------

    /**
     * Settings > Privacy and Security under fingers: the app menu's Settings row, then the
     * landing's section row (skipped when the section is already in view, as when the Settings
     * tab is back on it). True once the switch row is in the chrome's DOM.
     */
    private fun openPrivacySettings(): Boolean {
        if (!switchRowPresent()) {
            // The row sits below the fold and the sheet's accessibility nodes keep their
            // pre-scroll bounds on this engine (run 1: on screen, no node with bounds on it):
            // pickMenuRow locates the row's box in the chrome's DOM when the tree has none.
            val picked = pickMenuRow("Settings")
            finding("  Settings row: $picked")
            if (!picked.startsWith("a finger")) return false
            if (!awaitChrome("!!document.querySelector('$SETTINGS_SEARCH')||!!document.querySelector('$SWITCH_ROW')", 12_000)) return false
            SystemClock.sleep(1_000)
            if (!switchRowPresent()) {
                if (!touchTapLabel("Privacy and Security", prefix = true)) return false
                awaitSurface(up = true, timeoutMs = 8_000)
            }
        }
        val present = awaitChrome("!!document.querySelector('$SWITCH_ROW')", 10_000)
        chromeJs("(function(){var e=document.querySelector('$SWITCH_ROW');if(e)e.scrollIntoView({block:'center'})})()")
        SystemClock.sleep(1_200)
        return present
    }

    private fun switchRowPresent(): Boolean = jsString("document.querySelector('$SWITCH_ROW')?'yes':''") == "yes"

    private class SwitchRow(val checked: String, val disabled: Boolean, val text: String) {
        override fun toString() = "aria-checked '$checked', disabled $disabled, text '$text'"
    }

    /** The row in the DOM: `aria-checked`, `aria-disabled`, and its text (the label and the description run together). */
    private fun switchRow(): SwitchRow {
        val raw = jsString(
            "(function(){var e=document.querySelector('$SWITCH_ROW');if(!e)return '';" +
                "return JSON.stringify([e.getAttribute('aria-checked')||'',e.getAttribute('aria-disabled')==='true',(e.textContent||'').trim()])})()"
        )
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return SwitchRow("", false, "")
        return SwitchRow(array.getString(0), array.getBoolean(1), array.getString(2))
    }

    private fun awaitSwitchRow(disabled: Boolean, timeoutMs: Long): SwitchRow {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val row = switchRow()
            if (row.disabled == disabled) return row
            SystemClock.sleep(200)
        }
        return switchRow()
    }

    /** The row's `aria-checked` and the core's device-local state agree on `checked`, within 8 s. */
    private fun awaitSwitch(checked: Boolean, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (switchRow().checked == checked.toString() && lockOnLeave() == checked) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /** A real touch on the middle of the switch row, scrolled into view first: the whole row is the switch (§10.4). */
    private fun touchSwitchRow(): Boolean {
        chromeJs("(function(){var e=document.querySelector('$SWITCH_ROW');if(e)e.scrollIntoView({block:'center'})})()")
        SystemClock.sleep(800)
        val row = chromeRect(SWITCH_ROW) ?: run {
            finding("  no switch row in the Settings DOM")
            return false
        }
        val point = touchPoint(row) ?: run {
            finding("  the switch row is outside the touchable window: $row")
            return false
        }
        Log.i(tag, "touch at ${point.x},${point.y} on the switch row $row")
        Finger().tap(point.x, point.y)
        return true
    }

    // --- the menu's Settings row from a private tab (the #232 rider) --------------------------------

    /**
     * The app menu's row `label` under a finger, wherever it sits: the menu is opened from the
     * bar's button and pulled to its full height as the harness's `openMenuItem` does; the row is
     * looked for once with bounds on screen in the accessibility tree, and when the tree has
     * none for it – on this engine the sheet's nodes keep their pre-scroll bounds, so a row that
     * is plainly on screen answers to no node (run 1) – the row is located in the chrome's DOM,
     * scrolled into view there (`scrollIntoView`), and the finger lands on its box: a real touch
     * either way. Only a row the DOM does not have yet gets the list (`.zen-sheet-scroll`) scrolled
     * by a finger and the search again – with a private tab open the menu gains Close Private
     * Tabs and Settings sits below the fold. How it went, for the findings ("a finger …" on
     * success). From the #232 scratch driver.
     */
    private fun pickMenuRow(label: String): String {
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) return "the menu never opened"
        SystemClock.sleep(1_200)
        findByLabel(MENU_HANDLE_LABEL)?.let { handle ->
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.4f * height, 130)
                up()
            }
            SystemClock.sleep(2_000)
        }
        val find = "var q=" + JSONObject.quote(label) + ";var b=Array.prototype.slice.call(document.querySelectorAll('.zen-sheet-item'))" +
            ".filter(function(e){return (e.textContent||'').trim()===q})[0];"
        var swipes = 0
        repeat(4) { attempt ->
            val node = awaitNode(if (attempt == 0) 3_000 else 1_000) { it == label }
            if (node != null) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                if (touchTap(node)) return "a finger on the '$label' row at $bounds after $swipes scroll(s) of the list"
                Log.w(tag, "the '$label' row at $bounds could not be touched; the DOM next")
            }
            chromeJs("(function(){${find}if(b)b.scrollIntoView({block:'center'})})()")
            SystemClock.sleep(1_200)
            val box = chromeRectBy(find)
            if (box != null && box.centerY() in touchable.top until touchable.bottom) {
                Finger().tap(box.exactCenterX(), box.exactCenterY())
                return "a finger on the '$label' row at $box, located through the chrome's DOM after $swipes scroll(s) of the list"
            }
            if (box != null) Log.w(tag, "the '$label' row's box $box is outside the touchable window $touchable; scrolling on")
            val list = chromeRect(".zen-sheet-scroll") ?: return "the sheet's list is not in the chrome's DOM (menu closed?)"
            val top = maxOf(list.top, touchable.top) + 24f
            val bottom = minOf(list.bottom, touchable.bottom) - 24f
            if (bottom - top < 120f) return "the sheet's list ($list) leaves no room to scroll"
            val from = top + (bottom - top) * 0.85f
            val to = top + (bottom - top) * 0.15f
            Finger().apply {
                down(list.exactCenterX(), from)
                moveBy(0f, to - from, 260)
                up()
            }
            swipes++
            SystemClock.sleep(1_600)
        }
        return "no touchable '$label' row in the sheet after $swipes scroll(s) of the list"
    }

    /** The on-screen box of the element the statements `find` leave in `b`; null when none. */
    private fun chromeRectBy(find: String): Rect? {
        val raw = jsString("(function(){${find}if(!b)return '';var r=b.getBoundingClientRect();return JSON.stringify([r.left,r.top,r.right,r.bottom])})()")
        return rectFromBox(raw)
    }

    /** The active tab once its URL starts with `url`, within `timeoutMs`; null when none comes. */
    private fun awaitPage(url: String, timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            activeCoreTab()?.takeIf { it.optString("url").startsWith(url) }?.let { return it }
            SystemClock.sleep(250)
        }
        return activeCoreTab()?.takeIf { it.optString("url").startsWith(url) }
    }

    // --- accessibility: what a screen reader would find --------------------------------------------

    /** Every label and text in the app's own windows, breadth first (capped), for the leak checks. */
    private fun a11yLabels(): List<String> = windowLabels(app.packageName)

    private fun windowLabels(packageName: String): List<String> {
        val labels = ArrayList<String>()
        for (window in ui.windows) {
            val root = window.root ?: continue
            if (root.packageName?.toString() != packageName) continue
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            var visited = 0
            while (queue.isNotEmpty() && visited < 4_000) {
                val node = queue.removeFirst()
                visited++
                node.contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { labels += it }
                node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { labels += it }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
        }
        return labels
    }

    private fun nodesInWindows(predicate: (AccessibilityNodeInfo) -> Boolean): List<AccessibilityNodeInfo> {
        val roots = ArrayList<AccessibilityNodeInfo>()
        for (window in ui.windows) window.root?.let(roots::add)
        if (roots.isEmpty()) ui.rootInActiveWindow?.let(roots::add)
        val found = ArrayList<AccessibilityNodeInfo>()
        for (root in roots) {
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            var visited = 0
            while (queue.isNotEmpty() && visited < 3_000) {
                val node = queue.removeFirst()
                visited++
                if (predicate(node)) found += node
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
        }
        return found
    }

    // --- notifications ----------------------------------------------------------------------------

    private val notifications: NotificationManager by lazy { app.getSystemService(NotificationManager::class.java) }

    private fun privateCard(): StatusBarNotification? =
        runCatching { notifications.activeNotifications.firstOrNull { it.id == PrivateSession.NOTIFICATION_ID } }.getOrNull()

    private fun awaitCard(timeoutMs: Long): StatusBarNotification? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            privateCard()?.let { return it }
            SystemClock.sleep(250)
        }
        return privateCard()
    }

    private fun awaitCardGone(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (privateCard() == null) return true
            SystemClock.sleep(250)
        }
        return privateCard() == null
    }

    private fun awaitNotification(id: Int, timeoutMs: Long, match: (StatusBarNotification) -> Boolean): StatusBarNotification? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            runCatching { notifications.activeNotifications.firstOrNull { it.id == id && match(it) } }.getOrNull()?.let { return it }
            SystemClock.sleep(250)
        }
        return null
    }

    private fun cardTitle(sbn: StatusBarNotification?): String? =
        sbn?.notification?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()

    private fun describeCard(sbn: StatusBarNotification?): String {
        if (sbn == null) return "none"
        val n = sbn.notification
        return "id=${sbn.id} channel=${n.channelId} title=\"${cardTitle(sbn)}\" text=\"${n.extras?.getCharSequence(Notification.EXTRA_TEXT)}\" " +
            "ongoing=${n.flags and Notification.FLAG_ONGOING_EVENT != 0} press=${n.contentIntent != null}"
    }

    // --- the private tabs, the overview, the pages -------------------------------------------------

    private fun privateActive(): Boolean = activeCoreTab()?.optString("containerId") == Profiles.PRIVATE_CONTAINER

    private fun awaitPrivateActive(timeoutMs: Long = 10_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (privateActive()) return true
            SystemClock.sleep(200)
        }
        return privateActive()
    }

    private fun privateTabIds(state: JSONObject = coreState()): List<String> {
        val tabs = state.optJSONObject("tabs") ?: return emptyList()
        return tabs.keys().asSequence()
            .filter { tabs.optJSONObject(it)?.optString("containerId") == Profiles.PRIVATE_CONTAINER }
            .sorted()
            .toList()
    }

    private fun regularTabIds(state: JSONObject = coreState()): List<String> {
        val tabs = state.optJSONObject("tabs") ?: return emptyList()
        return tabs.keys().asSequence()
            .filter { tabs.optJSONObject(it)?.optString("containerId") != Profiles.PRIVATE_CONTAINER }
            .sorted()
            .toList()
    }

    /** The core's Settings tabs (`zen://settings…`), in any container. */
    private fun settingsTabIds(state: JSONObject = coreState()): List<String> {
        val tabs = state.optJSONObject("tabs") ?: return emptyList()
        return tabs.keys().asSequence()
            .filter { tabs.optJSONObject(it)?.optString("url").orEmpty().startsWith(SETTINGS_URL) }
            .sorted()
            .toList()
    }

    /** Close every Settings tab through the core and wait for the core to drop them; the ids closed. */
    private fun closeSettingsTabs(): List<String> {
        val ids = settingsTabIds()
        for (id in ids) coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(id)},\"force\":true}")
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (settingsTabIds().isNotEmpty() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
        if (ids.isNotEmpty()) SystemClock.sleep(800)
        return ids
    }

    private fun awaitNoPrivateTabs(timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (privateTabIds().isEmpty()) return true
            SystemClock.sleep(200)
        }
        return privateTabIds().isEmpty()
    }

    private fun awaitActiveTab(tabId: String, timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeCoreTab()?.optString("id") == tabId) return true
            SystemClock.sleep(200)
        }
        return activeCoreTab()?.optString("id") == tabId
    }

    private fun awaitLoaded(tabId: String, url: String, timeoutMs: Long = 20_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val view = host.tabs.get(tabId)
            val loaded = view != null && onMain { view.url == url && view.progress == 100 }
            if (loaded) return true
            SystemClock.sleep(300)
        }
        Log.w(tag, "$tabId never finished loading $url: ${host.tabs.get(tabId)?.let { onMain { "${it.url} ${it.progress}%" } }}")
        return false
    }

    private fun card(tabId: String) = "[data-tab-id=\"$tabId\"]"

    /** Open the overview from the bar's Tabs button; a tap read as a hold (its quick menu) is dismissed and tried again. */
    private fun openOverview(): Boolean {
        if (overviewOpen()) return true
        repeat(3) {
            val tabs = tabsButton()
            if (tabs != null) {
                Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            } else {
                val f = Finger()
                f.down(pillCenterX, pillY)
                f.settleIn(0f, -NUDGE)
                f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 400)
                f.up()
            }
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (SystemClock.uptimeMillis() < deadline) {
                if (overviewOpen()) {
                    SystemClock.sleep(1_500)
                    return true
                }
                if (heldInstead()) {
                    Log.w(tag, "the tap on Tabs was read as a hold; dismissing and trying again")
                    back()
                    SystemClock.sleep(1_500)
                    break
                }
                SystemClock.sleep(200)
            }
        }
        return overviewOpen()
    }

    private fun tabsButton(): Rect? =
        findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
            ?: chromeRect("[aria-label^=\"Tabs (\"]")

    private fun heldInstead(): Boolean =
        jsString("(function(){return document.querySelector('.zen-quick-menu, .zen-sheet') ? 'held' : ''})()") == "held"

    private fun overviewOpen(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    private fun awaitOverviewGone(timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (jsString("document.querySelector('.zen-overview')?'up':''") == "") return true
            SystemClock.sleep(200)
        }
        return false
    }

    private fun pane(): String =
        jsString("(function(){var p=document.querySelector('.zen-overview-pane [data-pane]');return p?(p.getAttribute('data-pane')||''):''})()")

    private fun awaitPane(pane: String, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (pane() == pane) return true
            SystemClock.sleep(150)
        }
        return pane() == pane
    }

    private fun cards(): List<String> {
        val raw = jsString(
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-overview-pane [data-tab-id]')," +
                "function(e){return e.getAttribute('data-tab-id')}))"
        )
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return (0 until array.length()).map { array.getString(it) }
    }

    /** A real touch on the segment's tab `id` (`tabs` or `private`). */
    private fun tapSegment(id: String) {
        val r = chromeRect("[data-testid=\"overview-pane-$id\"]") ?: run {
            finding("  no segment tab for $id on screen")
            return
        }
        Finger().tap(r.exactCenterX(), r.exactCenterY())
    }

    /** The on-screen box of the first chrome element `selector` matches (device px); null when none does. */
    private fun chromeRect(selector: String): Rect? {
        val raw = jsString(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';" +
                "var r=e.getBoundingClientRect();return JSON.stringify([r.left,r.top,r.right,r.bottom])})()"
        )
        return rectFromBox(raw)
    }

    private fun rectFromBox(raw: String): Rect? {
        val box = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 4 } ?: return null
        val origin = onMain { IntArray(2).also(host.chrome::getLocationOnScreen) }
        return Rect(
            (origin[0] + box.getDouble(0) * density).toInt(),
            (origin[1] + box.getDouble(1) * density).toInt(),
            (origin[0] + box.getDouble(2) * density).toInt(),
            (origin[1] + box.getDouble(3) * density).toInt()
        )
    }

    /** A real touch on the middle of the page element `selector` matches, in the tab's view. */
    private fun tapPage(tabId: String, selector: String): Boolean {
        val view = host.tabs.get(tabId) ?: run {
            finding("  no page view for $tabId to touch $selector in")
            return false
        }
        val raw = pageJs(
            view,
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';" +
                "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();" +
                "return JSON.stringify([r.left+r.width/2,r.top+r.height/2])})()"
        )
        val point = runCatching { JSONArray(jsonString(raw)) }.getOrNull()?.takeIf { it.length() == 2 } ?: run {
            finding("  nothing matches $selector on the page of $tabId")
            return false
        }
        val (origin, scale) = onMain {
            @Suppress("DEPRECATION")
            IntArray(2).also(view::getLocationOnScreen) to (view.scale.takeIf { it > 0f } ?: density)
        }
        val x = origin[0] + point.getDouble(0).toFloat() * scale
        val y = origin[1] + point.getDouble(1).toFloat() * scale
        Log.i(tag, "touch at $x,$y on $selector of $tabId")
        Finger().tap(x, y)
        return true
    }

    /** The audio page's `#state` text. */
    private fun pageState(tabId: String): String {
        val view = host.tabs.get(tabId) ?: return ""
        return jsonString(pageJs(view, "(function(){var e=document.getElementById('state');return e?e.textContent:''})()"))
    }

    private fun awaitPageState(tabId: String, state: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (pageState(tabId) == state) return true
            SystemClock.sleep(250)
        }
        return pageState(tabId) == state
    }

    private fun pageJs(view: WebView, code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            view.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    // --- plumbing --------------------------------------------------------------------------------

    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (jsString("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return jsString("String(!!($code))") == "true"
    }

    private fun jsString(code: String): String = jsonString(chromeJs(code))

    private fun jsonString(raw: String): String =
        runCatching { JSONTokener(raw).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun json(vararg pairs: Pair<String, Any?>): JSONObject =
        JSONObject().also { for ((key, value) in pairs) it.put(key, value ?: JSONObject.NULL) }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(ui.executeShellCommand(command)).use { it.bufferedReader().readText() }

    private fun expect(name: String, ok: Boolean) {
        Log.i(tag, "check \"$name\": ${if (ok) "ok" else "FAILED"}")
        finding("  $name ${if (ok) "PASS" else "FAIL"}")
        if (!ok) failures.add(name)
    }

    private fun onOff(on: Boolean) = if (on) "on" else "off"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18141
        private const val HOST = "127.0.0.1:$PORT"
        private const val ORIGIN = "http://$HOST"
        /** The seeded regular tabs (`private-demo-state.json`). */
        private const val REGULAR_TAB = "tab_demo"
        private const val NOTES_TAB = "tab_notes"
        /** Set with `locksettings set-pin` before the app starts; cleared for the last scene. */
        private const val PIN = "1234"
        private const val WRONG_PIN = "0000"
        private val CREDENTIAL_PACKAGES = setOf("com.android.systemui", "com.android.settings")
        private const val SYSTEM_UI = "com.android.systemui"
        private const val SECRET_TITLE = "Secret notes"
        private const val SETTINGS_URL = "zen://settings"
        private const val SETTINGS_SEARCH = ".zen-settings-search-field"
        /** The switch row in the Settings DOM (`rows.tsx` `data-row`, `sections.tsx` `private-lock-on-leave`). */
        private const val SWITCH_ROW = "[data-row=\"private-lock-on-leave\"]"
        private const val SWITCH_DESCRIPTION = "Use your screen lock to see them again."
        private const val SWITCH_NO_SCREEN_LOCK = "Needs a screen lock on this device."
        private const val COVER = "[data-testid=\"private-lock-cover\"]"
        private const val UNLOCK_LABEL = "Unlock"
        /** The pill's label over a locked private tab (`PhoneShell`). */
        private const val PILL_LOCKED_LABEL = "Private tab locked, unlock"
        private const val MENU_CLOSE_PRIVATE = "Close Private Tabs"
    }
}
