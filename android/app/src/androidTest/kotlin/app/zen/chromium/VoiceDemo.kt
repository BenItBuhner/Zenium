package app.zen.chromium

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.SpeechRecognizer
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.sin

/**
 * Drives voice search (OMN-19) on the phone chrome for the `android-voice-demo` recording and
 * writes what it measured to `voice-findings.txt` next to the screenshots (one `PASS` or `FAIL`
 * per check; the test fails at the end when a check did not hold, after the recording is over):
 *
 *  - the microphone refused at the system prompt: the toast; refused for good: the toast with
 *    Open settings, which opens the app's details screen;
 *  - the microphone granted at the prompt: the listening sheet up with its title block, the mic's
 *    halo pulsing with the level, the partial transcript in the body, Cancel taking it down and
 *    stopping the recogniser;
 *  - a final transcript from the new tab page's mic submitted as a search through the profile's
 *    engine (DuckDuckGo, so the routing is the core's, not a hard-coded engine);
 *  - an address from the omnibox's mic navigated to;
 *  - a recogniser that heard nothing: the "Didn't catch that" state, Try again listening anew;
 *  - a network error as a toast.
 *
 * Every mic – the bar's Voice search control (the seeded bar carries it left of the pill), the
 * new tab page's button, the omnibox's – and every sheet action is pressed with an INJECTED
 * TOUCH ([touchTapLabel]), so the hit test has its say; the outcome is read afterwards from the
 * tree, the chrome's DOM or the core's state.
 *
 * The emulator has no microphone and its image no recogniser service, so the run installs a
 * stand-in ([FakeRecognizer]) through `Voice.recognizerFactory` before the activity starts (the
 * driver runs in the app's process) and forces `Voice.availabilityOverride`. The permission
 * flow is real: the driver script revokes `RECORD_AUDIO` after the install (`DEMO_REVOKE`), so
 * the system's prompt shows and is answered with touches; the two refusals fix the permission,
 * `pm clear-permission-flags` lifts that so the third request prompts again and is granted at
 * the dialog. The recogniser's reports – levels, partials, the result, an error – are what the
 * driver plays into the stand-in's [RecognitionListener] on the main thread, which is the same
 * listener `Voice` hands the platform's recogniser: from there the events cross the bridge as
 * `voice.event` exactly as a device that can hear would send them, so what the recording shows
 * of the sheet and the submit is the shipped path from the listener on.
 */
@RunWith(AndroidJUnit4::class)
class VoiceDemo : DemoHarness("voice-demo-state.json", "android-voice", "voice-demo") {
    override val tag = "VoiceDemo"
    private lateinit var findings: File
    private var failures = 0
    private val fake = FakeRecognizer()

    @Test
    fun record() {
        runDemo()
        assertEquals("checks that did not hold (see voice-findings.txt)", 0, failures)
    }

    override fun beforeLaunch() {
        Voice.availabilityOverride = true
        Voice.recognizerFactory = { fake }
    }

    override fun warmUp() {
        findings = File(out, "voice-findings.txt")
        findings.writeText("Zenium Android voice search checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("start: ${describeActive()}")
        check("the chrome boots with the voiceSearch capability", coreState().getJSONObject("capabilities").optBoolean("voiceSearch"))
        check("RECORD_AUDIO starts out not granted (DEMO_REVOKE)", !micGranted())
        check("the bar shows the Voice search control", waitFor(BAR_MIC_LABEL, 8_000) != null)
        // The first new tab page pays for its layout: open and close one off camera.
        if (touchTapLabel(NEW_TAB_LABEL)) {
            awaitUrl({ it == BLANK_URL }, 8_000)
            SystemClock.sleep(2_000)
            activeCoreTab()?.optString("id")?.takeIf { it.isNotEmpty() && activeCoreTab()?.optString("url") == BLANK_URL }?.let { id ->
                coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(id)}}")
                SystemClock.sleep(2_000)
            }
        }
        if (activeCoreTab()?.optString("id") != EXAMPLE_TAB) {
            coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(EXAMPLE_TAB)}}")
            settle()
        }
        finding("warm-up done: ${describeActive()}")
    }

    override fun demo() {
        shot("00-page")
        refusedOnce()
        refusedForGood()
        grantedAndListening()
        searchFromNewTabPage()
        addressFromOmnibox()
        noMatchAndTryAgain()
        networkErrorToast()
        finding("\nend: ${describeActive()}; recogniser starts ${fake.starts}, cancels ${fake.cancels}")
    }

    // --- the sequence ----------------------------------------------------------------------------

    /** The bar's mic, the system's prompt, Don't allow: the sheet goes again, the toast says why. */
    private fun refusedOnce() {
        finding("\nmicrophone refused once")
        check("a touch on the bar's Voice search starts the request", touchTapLabel(BAR_MIC_LABEL))
        val prompted = awaitSystemWindow(10_000)
        check("the system's microphone prompt shows", prompted)
        if (prompted) {
            SystemClock.sleep(1_200)
            shot("01-permission-prompt")
            check("Don't allow is touched", touchDialog(DENY_LABELS))
        }
        val toast = waitFor(DENIED_TOAST, 8_000) != null
        check("the refusal's toast: '$DENIED_TOAST'", toast)
        check("the sheet is down after the refusal", awaitSurface(false, 4_000))
        if (toast) shot("02-denied-toast")
        SystemClock.sleep(3_500)
    }

    /**
     * Refused again: Android 11+ stops asking after the second Don't allow, and the request comes
     * back as fixed – the toast then carries Open settings, which opens the app's details screen.
     * A third request auto-refuses without a dialog, should the second one not yet count as fixed.
     */
    private fun refusedForGood() {
        finding("\nmicrophone refused for good")
        var fixed = false
        for (attempt in 1..3) {
            if (!touchTapLabel(BAR_MIC_LABEL)) {
                finding("  attempt $attempt: no Voice search control to touch")
                break
            }
            if (awaitSystemWindow(6_000)) {
                SystemClock.sleep(800)
                if (!touchDialog(DENY_LABELS)) finding("  attempt $attempt: Don't allow not touched")
            } else {
                finding("  attempt $attempt: no prompt (auto-refused)")
            }
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (SystemClock.uptimeMillis() < deadline) {
                if (findByLabel(FIXED_TOAST) != null) {
                    fixed = true
                    break
                }
                if (findByLabel(DENIED_TOAST) != null) break
                SystemClock.sleep(200)
            }
            if (fixed) break
            SystemClock.sleep(3_500)
        }
        check("the fixed refusal's toast: '$FIXED_TOAST'", fixed)
        if (!fixed) return
        SystemClock.sleep(600)
        shot("03-denied-for-good-toast")
        val opened = touchTapLabel(OPEN_SETTINGS_LABEL, timeoutMs = 3_000) && awaitSystemWindow(8_000)
        check("Open settings (touched) opens the app's details screen", opened)
        if (opened) {
            SystemClock.sleep(2_500)
            shot("04-app-settings")
            back()
            SystemClock.sleep(2_000)
            ensureForeground()
        }
        SystemClock.sleep(1_500)
    }

    /**
     * The prompt again (the fixed flag lifted through the shell), While using the app: the sheet
     * stays, the halo follows the levels, the words come into the body, Cancel stops it all.
     */
    private fun grantedAndListening() {
        finding("\nmicrophone granted, the sheet listens")
        val lifted = liftFixedRefusal()
        check("a touch on the bar's Voice search starts the request", touchTapLabel(BAR_MIC_LABEL))
        if (lifted && awaitSystemWindow(8_000)) {
            SystemClock.sleep(1_000)
            check("While using the app is touched", touchDialog(ALLOW_LABELS))
        } else {
            finding("  no prompt: the permission was granted through UiAutomation instead")
        }
        check("RECORD_AUDIO is granted", awaitMicGranted(8_000))
        val up = awaitPhase(setOf("starting", "listening"), 10_000)
        check("the listening sheet is up (phase ${phase()})", up)
        if (!up) {
            shot("05-no-sheet")
            return
        }
        fake.ready()
        fake.begin()
        check("the sheet reads Listening", waitFor(LISTENING_TITLE, 5_000) != null)
        // Levels as a voice would give them, on the recogniser's own clock: the halo swells and
        // settles on the shared spring; the driver reads its scale as it goes.
        val scales = pulse(3_200) { i -> if (i == 22) shot("05-listening") }
        val spread = (scales.maxOrNull() ?: 1f) - (scales.minOrNull() ?: 1f)
        finding("  halo scales seen: ${scales.size}, from ${scales.minOrNull()} to ${scales.maxOrNull()}")
        check("the halo moves with the level (spread ${"%.2f".format(spread)} over 1.0 to 1.8)", spread > 0.2f)
        fake.partial("weather in")
        pulse(900)
        fake.partial("weather in Lisbon")
        pulse(600)
        val partial = waitFor("weather in Lisbon", 4_000) != null
        check("the partial transcript is the body copy", partial)
        SystemClock.sleep(800)
        shot("06-partial-transcript")
        val cancelsBefore = fake.cancels
        check("Cancel is touched", touchTapLabel(CANCEL_LABEL))
        check("the sheet is down after Cancel", awaitSurface(false, 6_000))
        check("Cancel stopped the recogniser", awaitCancels(cancelsBefore + 1, 3_000))
        SystemClock.sleep(1_500)
        shot("07-cancelled")
    }

    /** The new tab page's mic: the result goes through the profile's engine as a search. */
    private fun searchFromNewTabPage() {
        finding("\na search from the new tab page's mic")
        check("New tab is touched", touchTapLabel(NEW_TAB_LABEL))
        check("the new tab page is up", awaitUrl({ it == BLANK_URL }, 8_000))
        SystemClock.sleep(2_500)
        shot("08-new-tab-page")
        check("the page's mic is touched", touchTapLabel(PAGE_MIC_LABEL))
        val up = awaitPhase(setOf("starting", "listening"), 10_000)
        check("the sheet is up from the page's mic (phase ${phase()})", up)
        if (!up) return
        fake.ready()
        fake.begin()
        pulse(1_400)
        fake.partial("weather in")
        pulse(700)
        fake.partial("weather in Lisbon this")
        pulse(700)
        fake.end()
        SystemClock.sleep(500)
        check("the sheet is finishing after the end of speech (phase ${phase()})", awaitPhase(setOf("finishing"), 3_000))
        shot("09-finishing")
        fake.result(SEARCH_TEXT)
        val searched = awaitUrl({ it.contains("duckduckgo.com") && it.contains("weather") && it.contains("Lisbon") }, 15_000)
        check("the result is searched through the profile's engine: ${activeCoreTab()?.optString("url")}", searched)
        check("the sheet is down after the result", awaitSurface(false, 6_000))
        SystemClock.sleep(6_000)
        shot("10-search-result")
    }

    /** The omnibox's mic (the field cleared): an address as the result is navigated to. */
    private fun addressFromOmnibox() {
        finding("\nan address from the omnibox's mic")
        Finger().tap(pillCenterX, pillY)
        check("the omnibox opens from the pill", awaitNode(8_000) { it == CLEAR_LABEL } != null)
        SystemClock.sleep(1_000)
        check("Clear is touched", touchTapLabel(CLEAR_LABEL))
        SystemClock.sleep(800)
        shot("11-omnibox-mic")
        check("the omnibox's mic is touched", touchTapLabel(OMNIBOX_MIC_LABEL))
        val up = awaitPhase(setOf("starting", "listening"), 10_000)
        check("the sheet is up from the omnibox (phase ${phase()})", up)
        check("the keyboard is down under the sheet", awaitIme(false, 6_000))
        if (!up) {
            closeUrlbar()
            return
        }
        fake.ready()
        fake.begin()
        pulse(1_200)
        fake.partial("example dot org")
        pulse(600)
        fake.end()
        fake.result(ADDRESS_TEXT)
        val navigated = awaitUrl({ it.contains("example.org") }, 15_000)
        check("the address is navigated to: ${activeCoreTab()?.optString("url")}", navigated)
        check("the sheet is down after the address", awaitSurface(false, 6_000))
        SystemClock.sleep(5_000)
        shot("12-address-loaded")
    }

    /** Nothing heard: the sheet turns into Didn't catch that; Try again listens anew. */
    private fun noMatchAndTryAgain() {
        finding("\nno match, then Try again")
        check("a touch on the bar's Voice search starts the request", touchTapLabel(BAR_MIC_LABEL))
        val up = awaitPhase(setOf("starting", "listening"), 10_000)
        check("the sheet is up (phase ${phase()})", up)
        if (!up) return
        fake.ready()
        fake.begin()
        pulse(1_000)
        fake.end()
        fake.error(SpeechRecognizer.ERROR_NO_MATCH)
        check("the sheet reads Didn't catch that", waitFor(NO_MATCH_TITLE, 6_000) != null)
        check("the sheet's phase is no-match", awaitPhase(setOf("no-match"), 3_000))
        SystemClock.sleep(1_000)
        shot("13-no-match")
        val startsBefore = fake.starts
        check("Try again is touched", touchTapLabel(TRY_AGAIN_LABEL))
        check("Try again starts the recogniser anew", awaitStarts(startsBefore + 1, 6_000))
        check("the sheet listens again", awaitPhase(setOf("starting", "listening"), 6_000) && waitFor(LISTENING_TITLE, 4_000) != null)
        fake.ready()
        fake.begin()
        pulse(1_200)
        shot("14-listening-again")
        check("Cancel is touched", touchTapLabel(CANCEL_LABEL))
        check("the sheet is down after Cancel", awaitSurface(false, 6_000))
        SystemClock.sleep(1_500)
    }

    /** An error the user cannot answer in the sheet is a toast. */
    private fun networkErrorToast() {
        finding("\na network error")
        check("a touch on the bar's Voice search starts the request", touchTapLabel(BAR_MIC_LABEL))
        val up = awaitPhase(setOf("starting", "listening"), 10_000)
        check("the sheet is up (phase ${phase()})", up)
        if (!up) return
        fake.ready()
        pulse(600)
        fake.error(SpeechRecognizer.ERROR_NETWORK)
        val toast = waitFor(NETWORK_TOAST, 6_000) != null
        check("the network error's toast: '$NETWORK_TOAST'", toast)
        check("the sheet is down after the error", awaitSurface(false, 6_000))
        if (toast) shot("15-network-toast")
        SystemClock.sleep(2_000)
    }

    // --- the stand-in recogniser ------------------------------------------------------------------

    /**
     * Levels for `durationMs` as a voice would give them (a swell every 1.4 s, silence between),
     * one every 60 ms – the platform reports about that often – and the halo's scale read from the
     * chrome after each; `at` runs with the index for a still mid-pulse.
     */
    private fun pulse(durationMs: Long, at: (Int) -> Unit = {}): List<Float> {
        val scales = ArrayList<Float>()
        val start = SystemClock.uptimeMillis()
        var i = 0
        while (SystemClock.uptimeMillis() - start < durationMs) {
            val t = (SystemClock.uptimeMillis() - start) / 1_400.0
            val wave = (sin(t * 2 * Math.PI) * 0.5 + 0.5).toFloat()
            fake.rms(-2f + 12f * wave * wave)
            haloScale()?.let(scales::add)
            at(i++)
            SystemClock.sleep(60)
        }
        return scales
    }

    /** The halo's scale as the spring has it now, from its inline transform; null when there is no halo. */
    private fun haloScale(): Float? {
        val raw = chromeJs("(function(){var h=document.querySelector('[data-testid=voice-halo]');return h?h.style.transform:''})()")
        val text = (JSONTokener(raw).nextValue() as? String).orEmpty()
        return Regex("""scale\(([0-9.]+)\)""").find(text)?.groupValues?.get(1)?.toFloatOrNull()
    }

    /** The sheet's phase as the chrome's DOM has it (`data-voice-phase`), "" when no sheet is up. */
    private fun phase(): String {
        val raw = chromeJs("(function(){var s=document.querySelector('[data-testid=voice-sheet]');return s?(s.dataset.voicePhase||''):''})()")
        return (JSONTokener(raw).nextValue() as? String).orEmpty()
    }

    private fun awaitPhase(phases: Set<String>, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (phase() in phases) return true
            SystemClock.sleep(150)
        }
        return phase() in phases
    }

    private fun awaitStarts(n: Int, timeoutMs: Long): Boolean = awaitCount(timeoutMs) { fake.starts >= n }

    private fun awaitCancels(n: Int, timeoutMs: Long): Boolean = awaitCount(timeoutMs) { fake.cancels >= n }

    private fun awaitCount(timeoutMs: Long, reached: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (reached()) return true
            SystemClock.sleep(100)
        }
        return reached()
    }

    /**
     * The platform's recogniser as the driver plays it. `Voice` calls [start] with the session's
     * listener and [cancel] / [destroy] when it lets the session go; the driver's reports go to the
     * listener of the live session on the main thread, as the platform's service would deliver them.
     */
    private class FakeRecognizer : Voice.Recognizer {
        private val main = Handler(Looper.getMainLooper())
        @Volatile private var listener: RecognitionListener? = null
        @Volatile var starts = 0
        @Volatile var cancels = 0
        @Volatile var lastIntent: Intent? = null

        override fun start(intent: Intent, listener: RecognitionListener) {
            starts++
            lastIntent = intent
            this.listener = listener
        }

        override fun cancel() {
            cancels++
            listener = null
        }

        override fun destroy() {
            listener = null
        }

        private fun report(deliver: (RecognitionListener) -> Unit) {
            val live = listener ?: return
            main.post { deliver(live) }
        }

        fun ready() = report { it.onReadyForSpeech(Bundle()) }
        fun begin() = report { it.onBeginningOfSpeech() }
        fun rms(db: Float) = report { it.onRmsChanged(db) }
        fun partial(text: String) = report { it.onPartialResults(results(text)) }
        fun end() = report { it.onEndOfSpeech() }
        fun result(text: String) = report { it.onResults(results(text)) }
        fun error(code: Int) = report { it.onError(code) }

        private fun results(text: String) = Bundle().apply {
            putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf(text))
            putFloatArray(SpeechRecognizer.CONFIDENCE_SCORES, floatArrayOf(0.9f))
        }
    }

    // --- the permission ----------------------------------------------------------------------------

    private fun micGranted(): Boolean =
        ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun awaitMicGranted(timeoutMs: Long): Boolean = awaitCount(timeoutMs) { micGranted() }

    /**
     * Two refusals fix the permission (the system auto-refuses from then on); `pm
     * clear-permission-flags` lifts the fixing so the next request prompts again and the grant
     * can be a touch on the dialog. Where the shell has no such command the permission is granted
     * through UiAutomation instead (said in the findings); true when the prompt is to be expected.
     */
    private fun liftFixedRefusal(): Boolean {
        val out = shell("pm clear-permission-flags ${app.packageName} ${Manifest.permission.RECORD_AUDIO} user-fixed user-set 2>&1; echo \"exit=$?\"")
        finding("  pm clear-permission-flags: ${out.trim().replace('\n', ' ')}")
        if (out.contains("exit=0") && !out.contains("Error", ignoreCase = true) && !out.contains("Unknown", ignoreCase = true)) return true
        ui.grantRuntimePermission(app.packageName, Manifest.permission.RECORD_AUDIO)
        return false
    }

    /**
     * A real touch on the first of `labels` the dialog in front shows (the system spells "Don't"
     * with a typographic apostrophe on recent releases, so the match folds the two), else its
     * accessibility click, logged as such.
     */
    private fun touchDialog(labels: List<String>): Boolean {
        for (label in labels) {
            val node = awaitNode(2_000) { sameLabel(it, label) } ?: continue
            if (touchTap(node)) return true
        }
        for (label in labels) {
            val node = findNode { sameLabel(it, label) } ?: continue
            var clickable = node
            while (!clickable.isClickable) clickable = clickable.parent ?: break
            if (clickable.isClickable && clickable.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)) {
                finding("  '$label' was clicked through the tree, not touched")
                return true
            }
        }
        val seen = ArrayList<String>()
        findNodeWhere { node ->
            (node.text ?: node.contentDescription)?.toString()?.takeIf { it.isNotBlank() }?.let(seen::add)
            false
        }
        finding("  none of $labels in the window in front; it reads: ${seen.take(12)}")
        return false
    }

    private fun sameLabel(a: String, b: String): Boolean =
        a.replace('\u2019', '\'').trim().equals(b.replace('\u2019', '\''), ignoreCase = true)

    /**
     * Run a shell command as adb would. UiAutomation hands the string to `Runtime.exec`, which
     * splits on whitespace and knows nothing of quotes, so the script travels base64-encoded in a
     * single token and `sh` decodes it.
     */
    private fun shell(script: String): String {
        val encoded = Base64.encodeToString(script.toByteArray(), Base64.NO_WRAP)
        val descriptor = ui.executeShellCommand("sh -c echo\${IFS}$encoded|base64\${IFS}-d|sh")
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.bufferedReader().readText() }
    }

    // --- the core ----------------------------------------------------------------------------------

    private fun awaitUrl(matches: (String) -> Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val url = runCatching { activeCoreTab()?.optString("url").orEmpty() }.getOrDefault("")
            if (matches(url)) return true
            SystemClock.sleep(300)
        }
        return false
    }

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}" }

    // --- findings ----------------------------------------------------------------------------------

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        finding("  ${if (ok) "PASS" else "FAIL"}  $what")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val EXAMPLE_TAB = "tab_example"
        private const val BLANK_URL = "zen://blank"
        private const val NEW_TAB_LABEL = "New tab"
        /** The bar's control (`barItems.tsx`), the new tab page's button and the omnibox's (both "Search by voice"). */
        private const val BAR_MIC_LABEL = "Voice search"
        private const val PAGE_MIC_LABEL = "Search by voice"
        private const val OMNIBOX_MIC_LABEL = "Search by voice"
        private const val CLEAR_LABEL = "Clear"
        private const val CANCEL_LABEL = "Cancel"
        private const val TRY_AGAIN_LABEL = "Try again"
        private const val LISTENING_TITLE = "Listening"
        private const val NO_MATCH_TITLE = "Didn't catch that"
        private const val OPEN_SETTINGS_LABEL = "Open settings"
        /** The toasts (`voiceStartMessage`, `voiceErrorMessage` in `src/shared/voice.ts`). */
        private const val DENIED_TOAST = "Microphone access is needed to search by voice"
        private const val FIXED_TOAST = "Microphone access is turned off for Zenium"
        private const val NETWORK_TOAST = "Voice search needs an internet connection"
        private const val SEARCH_TEXT = "weather in Lisbon this weekend"
        private const val ADDRESS_TEXT = "example.org"
        /** The system prompt's buttons, by release (API 30+ first). */
        private val DENY_LABELS = listOf("Don't allow", "Deny")
        private val ALLOW_LABELS = listOf("While using the app", "Only this time", "Allow")
    }
}
