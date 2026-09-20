package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.Notification
import android.app.NotificationManager
import android.graphics.PointF
import android.graphics.Rect
import android.media.AudioManager
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.service.notification.StatusBarNotification
import android.speech.tts.TextToSpeech
import android.support.v4.media.MediaMetadataCompat
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records read aloud on the phone (A11Y-06 / EDGE-11 / MOT-35; NOT-06 through services' media
 * session) and writes what it measured to `read-aloud-findings.txt` next to the stills (one
 * `PASS` or `FAIL` per check; the test fails at the end when any did, or when a touch did not
 * take):
 *
 *  1. the device's speech engine, on record before anything runs: the engines the package
 *     manager lists, the one `TextToSpeech` binds, its installed voices and default voice (the
 *     Google APIs image carries Google's engine with an offline English voice); with none, the
 *     host's availability is overridden so the entries and the player still render, and the
 *     checks expect the player's error state in place of the speech ones;
 *  2. the app menu's Listen to This Page (a real touch; the item is enabled by the reader core's
 *     readability probe on the article served from this process): the player docks under the
 *     live page busy while the engine binds (the play box's spinner, 20 px on the phone, §9.30,
 *     when the bind lasts long enough to be caught), the engine speaks the first of the
 *     article's sentences (`speech.event start` -> `playing`, the progress line `1 / n`), word
 *     ranges come from `onRangeStart`, the core's page script paints the sentence (and the word)
 *     into the page through the CSS Custom Highlight API, the read-aloud source holds the media
 *     session (services' MediaStyle notification) and the host holds audio focus for the speech
 *     stream (2.4);
 *  3. a real touch on Pause (the engine stops, focus goes) and on Play (the sentence starts
 *     again from its beginning: `TextToSpeech` has no pause);
 *  4. NOT-06: Home while reading – the reading goes on behind the launcher on services'
 *     foreground service, the notification in the shade carries the title; back in the app the
 *     player is where it was;
 *  5. another app taking the audio (a focus request from this process's second listener) pauses
 *     the reading through `media.action pause`, and nothing resumes it when the audio comes back;
 *  6. the speed chip ("1×", the multiplication sign) under a finger steps 1x -> 1.2x -> 1.5x ->
 *     2x -> 0.5x -> 0.8x -> 1x (the model's ladder up to Edge's 2x), the state's rate following
 *     each step; the first step taken while the engine speaks sentence N, and the host's log
 *     (`ZenReadAloud`) then showing the prepared N+1 flushed and spoken again at the new rate
 *     the moment N ends – the change heard from the next sentence, not the one after;
 *  7. Previous / Next under a finger on the model's sentence walk, the walk held with a real
 *     touch on Pause before each step (the first sentence is the two-second heading): Previous
 *     disabled at the first sentence, a touch on Next speaks the sentence after the one held, a
 *     touch on Previous the one before, the highlight in the page following;
 *  8. the voice picker: a real touch on Voice opens the 9.13 sheet listing the engine's voices,
 *     a touch on a voice row sets the session's voice and closes the sheet by itself (§9.13),
 *     and with the sheet opened again the system back closes the sheet alone, the player still up;
 *  9. Close under a finger: the session ends, the panel leaves, the page grows back;
 * 10. the selection toolbar's Read Aloud (GN-13's toolbar, #206): a long press on a word, the
 *     item (behind the overflow on a phone) under a finger starts a session that reads the
 *     selection (`source: selection`; the mode's finish collapses the page's selection first,
 *     the page script stands the cleared one in, `selectionMemory.ts`, and the document is left
 *     collapsed); then the system back with the player up closes it like a page (predictive
 *     back, MOT-35);
 * 11. the player in dark, for the design record;
 * 12. no engine (interface 3.2): the app started again with the host saying the device has no
 *     speech engine, `capabilities.readAloud` off, neither Listen to This Page in the menu nor
 *     Read Aloud on the selection toolbar (Google's own process-text item left as it is).
 *
 * The article comes from a loopback server inside this process ([DemoServer]). The model behind
 * the player is services' `ReadAloudService` (#246): the page script's extraction of the
 * article's blocks, the sentence walker, the highlight and the media-session binding are its;
 * this driver records the phone's player, the entries and the `TextToSpeech` host over them.
 * See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class ReadAloudDemo : DemoHarness("read-aloud-demo-state.json", "read-aloud", "read-aloud-demo") {
    override val tag = "ReadAloudDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private val host get() = (activity as MainActivity).host
    private val notificationManager: NotificationManager by lazy { app.getSystemService(NotificationManager::class.java) }
    private val audioManager: AudioManager by lazy { app.getSystemService(AudioManager::class.java) }

    /** The device has no speech engine: the host's availability is overridden and the speech checks are skipped. */
    private var engineless = false
    private var engineReport = ""
    /** The voices the probe found, by the engine's names: `Voice.getName()` -> locale tag. */
    private val probedVoices = LinkedHashMap<String, String>()

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf("/" to ("text/html; charset=utf-8" to readAsset("read-aloud-demo-page.html").toByteArray()))
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            ReadAloud.availabilityOverride = null
        }
        if (failures > 0) throw AssertionError("$failures read-aloud check(s) failed; see read-aloud-findings.txt")
    }

    // --- 1. the engine, before the app boots ----------------------------------------------------------

    override fun beforeLaunch() {
        engineReport = probeEngine()
        if (engineless) {
            // The capability is read at boot: without an engine the entries never show, and the
            // player could not be recorded. The override makes the host say yes; every speak then
            // fails with `error` (the engine does not bind) and the checks expect that state.
            ReadAloud.availabilityOverride = true
        }
    }

    /**
     * What the device has: the engines (the package manager's list, no binding needed), then a
     * `TextToSpeech` of this process's own bound to the default one for its voices and default
     * voice (installed ones only), shut down again before the app's own instance binds.
     */
    private fun probeEngine(): String {
        val lines = ArrayList<String>()
        var tts: TextToSpeech? = null
        var status = TextToSpeech.ERROR
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            tts = TextToSpeech(app) { s ->
                status = s
                latch.countDown()
            }
        }
        val engine = tts ?: return "TextToSpeech could not be constructed"
        val engines = runCatching { engine.engines.map { "${it.name} (${it.label})" } }.getOrDefault(emptyList())
        lines += "engines: ${if (engines.isEmpty()) "NONE" else engines.joinToString(", ")}"
        val bound = latch.await(25, TimeUnit.SECONDS)
        if (!bound || status != TextToSpeech.SUCCESS) {
            engineless = true
            lines += "bind: ${if (!bound) "no onInit within 25 s" else "onInit status $status"}"
        } else {
            val default = runCatching { engine.defaultEngine }.getOrNull()
            val defaultVoice = runCatching { engine.defaultVoice }.getOrNull()
            val voices = runCatching { engine.voices?.toList() }.getOrNull().orEmpty()
                .filter { TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features }
            for (v in voices) probedVoices[v.name] = v.locale.toLanguageTag()
            val english = voices.filter { it.locale.language == Locale.ENGLISH.language }
            val offline = english.filter { !it.isNetworkConnectionRequired }
            lines += "bound: default engine $default; default voice ${defaultVoice?.name} (${defaultVoice?.locale?.toLanguageTag()}, quality ${defaultVoice?.quality}, network ${defaultVoice?.isNetworkConnectionRequired})"
            lines += "installed voices: ${voices.size} (${english.size} English, ${offline.size} of them offline)"
            lines += "language ${Locale.getDefault().toLanguageTag()}: ${voices.filter { it.locale.language == Locale.getDefault().language }.take(6).joinToString(", ") { "${it.name}${if (it.isNetworkConnectionRequired) " (network)" else ""}" }}"
            if (voices.isEmpty()) lines += "no installed voice: the speech checks will report what the engine does"
        }
        instrumentation.runOnMainSync { runCatching { engine.shutdown() } }
        return lines.joinToString("\n  ")
    }

    override fun warmUp() {
        findings = File(out, "read-aloud-findings.txt")
        findings.writeText("Zenium Android read aloud checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        finding("speech engine (before the app booted):\n  $engineReport")
        finding("host: engines ${host.readAloud.engines()}; available=${host.readAloud.available}${if (engineless) " (OVERRIDDEN: no engine on this image)" else ""}")
        val caps = coreState().getJSONObject("capabilities")
        finding("capabilities: readAloud=${caps.optBoolean("readAloud")} selectionToolbar=${caps.optBoolean("selectionToolbar")}")
        check("capabilities.readAloud is on (the host has a speech engine, or says so for the record)", caps.optBoolean("readAloud"))
        awaitLoaded("$ORIGIN/")
        val readerable = poll(15_000) { tab()?.optBoolean("readerable") == true }
        finding("article: ${describeTab()}; readerable=$readerable")
        check("the reader core finds the page readerable (what gates Listen to This Page)", readerable)
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        shot("00-article")
        beat()
        if (!startFromMenu()) {
            finding("\nthe player never came up; nothing else can be recorded")
            return
        }
        if (engineless) {
            errorState()
        } else {
            playingState()
            pauseAndResume()
            homeWhileReading()
            focusLoss()
        }
        speedChip()
        previousAndNext()
        voicePicker()
        closePanel()
        fromSelection()
        darkPlayer()
        noEngine()
        finding("\nend: session=${readAloud()}${if (failures == 0) "" else "; $failures FAIL"}")
    }

    // --- 12. no engine: the entries are absent ---------------------------------------------------------

    /**
     * Interface 3.2: without a speech engine `capabilities.readAloud` is false, `Platform.speech`
     * is not built, and both entry points are hidden. The capability is read at boot, so the app
     * is started again with the host saying no ([ReadAloud.availabilityOverride] = false: what
     * the package manager answers on a build without an engine), and the menu and the selection
     * toolbar are read for the items that must not be there. Google's own process-text item
     * ("Read aloud", sentence case) is the system's and stays whatever the app says.
     */
    private fun noEngine() {
        finding("\n3.2 no speech engine: the entries are absent")
        frontApp()
        if (readAloud() != null) {
            coreInvoke("readAloud.stop")
            poll(5_000) { readAloud() == null }
        }
        ReadAloud.availabilityOverride = false
        launch()
        awaitLoaded("$ORIGIN/")
        poll(15_000) { tab()?.optBoolean("readerable") == true }
        val caps = coreState().getJSONObject("capabilities")
        finding("  after a fresh boot with the host saying no engine: host.readAloud.available=${host.readAloud.available}; capabilities.readAloud=${caps.optBoolean("readAloud")}; ${describeTab()}")
        check("capabilities.readAloud is off when the host has no engine", !caps.optBoolean("readAloud"))
        // The menu opened and pulled up as `openMenuItem` does, the reading group scrolled into
        // view (Reader View, the row Listen to This Page sits under when it shows), nothing touched.
        tapMenuButton()
        val opened = waitFor(MENU_HANDLE_LABEL, 6_000) != null
        if (opened) {
            SystemClock.sleep(1_200)
            findByLabel(MENU_HANDLE_LABEL)?.let { handle ->
                Finger().apply {
                    down(handle.exactCenterX(), handle.exactCenterY())
                    moveBy(0f, -0.4f * height, 130)
                    up()
                }
                SystemClock.sleep(2_000)
            }
        }
        val readerView = if (opened) reveal("Reader View") else null
        val listen = findNode { it == MENU_ITEM }
        finding("  the app menu: open=$opened; Reader View ${if (readerView != null) "at $readerView" else "MISSING"}; '$MENU_ITEM' ${if (listen == null) "ABSENT" else "PRESENT"}")
        check("the app menu has no Listen to This Page without an engine (Reader View still there)", opened && readerView != null && listen == null)
        shot("16-no-engine-menu")
        if (opened) {
            back()
            SystemClock.sleep(1_200)
        }
        frontApp()
        val items = longPress("#word") { list -> list.any { it.label == "Copy" } }
        finding("  long press on 'arithmetic': toolbar ${items?.joinToString(" | ") { it.label } ?: "MISSING"}")
        if (items == null) {
            check("the selection toolbar comes up for the no-engine check", false)
        } else {
            val inBar = items.any { it.label == "Read Aloud" }
            var inOverflow = false
            val more = items.find { it.label == "More options" }
            if (more != null) {
                touchTapPoint(more.node)
                SystemClock.sleep(1_200)
                inOverflow = findInWindows { it == "Read Aloud" } != null
                val system = findInWindows { it == "Read aloud" } != null
                finding("  behind the overflow: ours ('Read Aloud') ${if (inOverflow) "PRESENT" else "absent"}; Google's process-text item ('Read aloud') ${if (system) "present (the system's, left alone)" else "absent"}")
                shot("17-no-engine-toolbar")
                findInWindows { it == "Close overflow" }?.let { touchTapPoint(it) } ?: back()
                SystemClock.sleep(600)
            } else {
                shot("17-no-engine-toolbar")
            }
            check("the selection toolbar has no Read Aloud without an engine", !inBar && !inOverflow)
        }
        clearSelection()
        ReadAloud.availabilityOverride = null
        beat()
    }

    // --- 2. Listen to This Page -----------------------------------------------------------------

    private fun startFromMenu(): Boolean {
        finding("\nA11Y-06 the app menu's Listen to This Page")
        val opened = openMenuItem(MENU_ITEM)
        if (!opened) {
            finding("  the menu never listed '$MENU_ITEM' (${if (findByLabel(MENU_HANDLE_LABEL) != null) "menu open without it" else "menu did not open"})")
            check("Listen to This Page is in the menu and enabled for the article", false)
            back()
            return false
        }
        val came = poll(10_000) { readAloud() != null }
        val session = readAloud()
        finding("  real touch on '$MENU_ITEM': session ${session?.let { "up: status=${it.optString("status")} source=${it.optString("source")} title=\"${it.optString("title").take(60)}…\"" } ?: "MISSING"}")
        if (!came) touchFault("a touch on '$MENU_ITEM' started no read-aloud session")
        // The busy state (§9.30) while the engine binds on first use: the play box's spinner, at
        // the phone's glyph size (20 px, not the primitive's 16). Caught while the bind lasts.
        var size = 0.0
        val spinner = poll(3_000) { size = spinnerSize(); size > 0 }
        if (spinner) {
            shot("00b-busy")
            finding("  busy while the engine binds: the play box's spinner is $size CSS px (status ${status()})")
            check("the busy spinner is 20 px on the phone (§9.30: the row glyph size)", Math.abs(size - 20.0) < 0.6)
        } else {
            finding("  NOTE the engine bound before the busy state could be measured (status ${status()}); the design still busy-light.png stands for it")
        }
        check("a real touch on Listen to This Page starts a session on the article's tab", came && session?.optString("tabId") == TAB)
        check("the session's source is the page (from: top), not the reader document", session?.optString("source") == "page")
        val panel = poll(8_000) { panelUp() }
        finding("  the docked player: ${if (panel) "in the tree ('$PANEL_LABEL' region, ${panelBounds()})" else "NOT in the tree"}; chrome surface up=${chromeSurfaceUp()}")
        check("the player docks under the page (the Read aloud region, a back surface)", panel && chromeSurfaceUp())
        SystemClock.sleep(600)
        return came
    }

    // --- the engine speaking ---------------------------------------------------------------------

    private fun playingState() {
        finding("\nA11Y-06 the engine speaks the article sentence by sentence (services' model)")
        val t0 = SystemClock.uptimeMillis()
        val playing = awaitStatus("playing", 30_000)
        val took = SystemClock.uptimeMillis() - t0
        finding("  status -> playing: $playing after $took ms (the engine binds on first use); session=${readAloud()}")
        check("speech.event start arrives and the player reads playing", playing)
        if (!playing) {
            finding("  the player reads '${progressText()}' (status ${status()})")
            return
        }
        val count = readAloud()?.optInt("sentenceCount") ?: 0
        val painted = poll(6_000) { pageHighlight().optBoolean("sentence") }
        finding("  the page's highlight (CSS Custom Highlight API, the core's page script): ${pageHighlight()}")
        check("the article splits into sentences and the walk starts at the first ($count sentences)", count > 1 && readAloud()?.optInt("sentenceIndex") == 0)
        check("the current sentence is highlighted in the page behind the player", painted)
        shot("01-playing")
        val word = poll(6_000) { readAloud()?.optJSONObject("word") != null }
        val range = readAloud()?.optJSONObject("word")
        finding("  word ranges (onRangeStart): ${if (word) "yes, e.g. $range; the word highlight in the page: ${pageHighlight().optBoolean("word")}" else "none within 6 s (an engine without ranges; the model highlights sentences alone)"}")
        if (!word) finding("  NOTE word ranges not reported by this engine; not a failure")
        finding("  audio focus while playing: ${audioFocus()}")
        check("the host holds audio focus for the speech stream while the source plays (2.4)", audioFocus().contains(app.packageName) && audioFocus().contains("USAGE_MEDIA"))
        val notification = awaitMediaNotification(8_000)
        finding("  media notification (services' MediaStyle, the read-aloud source): ${describe(notification)}")
        check("the read-aloud source is on the media notification with the article's title", notification != null && notification.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.startsWith("The lighthouse keeper") == true)
        finding("  session (the OS's controller): ${describeSession()}")
        val progress = progressText()
        finding("  progress line reads '$progress'")
        check("the progress line reads the sentence over the count (1 / $count)", progress == "1 / $count" || (count > 1 && Regex("\\d+ / $count").matches(progress)))
        beat()
    }

    private fun errorState() {
        finding("\nno engine on this image: the player's error state stands in for the speech checks")
        val error = awaitStatus("error", 20_000)
        finding("  status -> error: $error; session=${readAloud()}; the header reads '${progressText()}'")
        check("without an engine the speak fails at once and the player shows its error line", error && progressText().isNotEmpty())
        shot("01-error")
        beat()
    }

    // --- 3. pause and resume ---------------------------------------------------------------------

    private fun pauseAndResume() {
        finding("\nA11Y-06 Pause and Play under a finger")
        frontApp()
        if (status() != "playing" && !ensurePlaying()) return
        touchTapLabelExpecting("Pause", "the session reads paused", timeoutMs = 6_000) { status() == "paused" }
        finding("  after Pause: status=${status()} word=${readAloud()?.opt("word")}; focus: ${audioFocus()}")
        check("a real touch on Pause pauses the session (the engine stops)", status() == "paused")
        check("the focus is let go when the source pauses (2.4)", !audioFocus().contains(app.packageName))
        SystemClock.sleep(800)
        shot("02-paused")
        beat()
        val toggle = awaitNode(4_000) { it == "Play" }
        finding("  the toggle reads '${toggle?.let(::label) ?: "?"}' while paused")
        check("the play / pause control reads Play while paused", toggle != null)
        touchTapLabelExpecting("Play", "the sentence is spoken again from its start", timeoutMs = 15_000) { status() == "playing" }
        finding("  after Play: status=${status()} (TextToSpeech has no pause: the model speaks the sentence again from its start)")
        check("a real touch on Play resumes (loading, then playing again)", status() == "playing")
        beat()
    }

    // --- 4. NOT-06: Home while reading ---------------------------------------------------------------

    private fun homeWhileReading() {
        finding("\nNOT-06 Home while reading: the session goes on behind the launcher")
        if (status() != "playing" && !ensurePlaying()) return
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        SystemClock.sleep(3_000)
        val away = ui.rootInActiveWindow?.packageName?.toString()
        val status = status()
        finding("  after Home: front window $away; status=$status; focus: ${audioFocus()}")
        check("the reading is not paused by Home (playing, or ended once the sentence is through)", status == "playing" || status == "ended")
        val notification = awaitMediaNotification(6_000)
        finding("  notification behind the launcher: ${describe(notification)}")
        check("the media notification stands while the app is behind the launcher", notification != null)
        shot("03-home")
        val shade = openShade(8_000) { it.startsWith("The lighthouse keeper") }
        finding("  the shade shows the title: $shade")
        if (shade) {
            SystemClock.sleep(1_000)
            shot("04-shade")
        }
        closeShade()
        bringToFront()
        var back = poll(8_000) { ui.rootInActiveWindow?.packageName?.toString() == app.packageName }
        if (!back) {
            finding("  the app is not in front after am start (window of ${ui.rootInActiveWindow?.packageName}); once more")
            frontApp()
            back = ui.rootInActiveWindow?.packageName?.toString() == app.packageName
        }
        SystemClock.sleep(1_500)
        finding("  back in the app: front=$back; panel up=${panelUp()}; status=${status()}")
        check("back in the app the player is still docked", back && panelUp())
        shot("05-back-in-app")
        beat()
    }

    // --- 5. focus loss -------------------------------------------------------------------------------

    private fun focusLoss() {
        finding("\n2.4 another app takes the audio: the reading pauses, nothing resumes it")
        frontApp()
        if (status() != "playing" && !ensurePlaying()) return
        val changes = ArrayList<Int>()
        val request = ReadAloud.focusForTest(app) { changes += it }
        finding("  focus requested by a second listener (as another app's player would): ${if (request != null) "granted" else "REFUSED"}; now ${audioFocus()}")
        val paused = poll(6_000) { status() == "paused" }
        finding("  status after the loss: ${status()} (paused=$paused); the second listener heard $changes")
        check("audio-focus loss pauses the reading through media.action pause", paused)
        if (request != null) audioManager.abandonAudioFocusRequest(request)
        SystemClock.sleep(2_500)
        finding("  after the other app lets go: status=${status()}; focus: ${audioFocus()}")
        check("no auto-resume after the loss (Chrome's read aloud stays paused)", status() == "paused")
        shot("06-paused-by-focus-loss")
        beat()
    }

    // --- 6. the speed chip ---------------------------------------------------------------------------

    private fun speedChip() {
        finding("\nEDGE-11 the speed chip: 1x -> 1.2x -> 1.5x -> 2x -> 0.5x -> 0.8x -> 1x (READ_ALOUD_RATE_STEPS)")
        frontApp()
        val before = rate()
        val label0 = chipLabel()
        finding("  chip reads '$label0' (rate $before)")
        check("the chip's label is the rate with the multiplication sign (§9.32, lead nit 2: '1×')", label0 == "Speed 1×")
        // The first step is taken while the engine speaks, so the change can be heard from the
        // very next sentence: the tap lands during sentence N, and the host's log then shows the
        // prepared N+1 – queued at 1x while N spoke – flushed and spoken again at 1.2x the moment
        // the core asks for it (`ReadAloudLogic.speakPlan`'s restart rule; run 4 read the chip
        // and the state's rate alone, and the engine heard a change one sentence late).
        val speaking = engineless || ensurePlaying()
        val logBefore = hostLog().size
        val ladder = listOf(1.2, 1.5, 2.0, 0.5, 0.8, 1.0)
        var all = true
        for ((i, expected) in ladder.withIndex()) {
            val label = chipLabel()
            if (label == null) {
                finding("  no speed chip in the tree")
                all = false
                break
            }
            val took = touchTapLabelExpecting(label, "the rate reads $expected", timeoutMs = 5_000) { Math.abs(rate() - expected) < 0.001 }
            // The sentence the finger came down in (read as the touch registers, so a sentence
            // ending while the chip was looked up does not shift the count).
            val n = sentenceIndex()
            finding("  touch on '$label' -> rate ${rate()}, chip '${chipLabel()}'${if (i == 0) " (during sentence ${n + 1})" else ""}")
            all = all && took
            if (i == 0 && speaking && !engineless) nextSentenceAtTheNewRate(n, expected, logBefore)
            if (i == 1) {
                SystemClock.sleep(600)
                shot("07-speed-1-5x")
            }
            if (i == 2) {
                SystemClock.sleep(600)
                shot("08-speed-2x")
            }
            SystemClock.sleep(400)
        }
        check("the chip steps the rate through the ladder and back to 1x", all && Math.abs(rate() - 1.0) < 0.001)
        beat()
    }

    /**
     * The engine's side of a speed change made during sentence [n]: once the walk has moved on to
     * n + 1, the host's log (`ZenReadAloud`, one line per utterance the engine is handed) must
     * show that utterance FLUSHed at [rate] – the prepared one restarted with the change – and no
     * utterance spoken at the old rate after it.
     */
    private fun nextSentenceAtTheNewRate(n: Int, rate: Double, logBefore: Int) {
        val tapped = SystemClock.uptimeMillis()
        val moved = poll(25_000) { sentenceIndex() >= n + 1 || status() != "playing" }
        SystemClock.sleep(600)
        val at = sentenceIndex()
        val since = hostLog().drop(logBefore)
        // The lines for utterances the engine was handed (a `speak` for one it already has is a
        // "nothing to do" line and hands it nothing).
        val handed = since.filter { ": FLUSH at " in it || ": ADD at " in it }
        val restart = handed.filter { "FLUSH at ${rate}x" in it && "restarted with the change" in it }
        finding("  the walk after the tap during sentence ${n + 1}: index $n -> $at (moved=$moved, ${SystemClock.uptimeMillis() - tapped} ms, status ${status()})")
        finding("  the host's log since the tap (${since.size} speak lines):\n    ${since.joinToString("\n    ") { it.substringAfter("$HOST_TAG").trimStart(':', ' ') }}")
        check("the speed tap during sentence ${n + 1} is heard from sentence ${n + 2}: the engine log shows N+1 flushed and spoken again at ${rate}x", moved && at == n + 1 && restart.isNotEmpty())
        // Nothing the engine was handed after the change is at the old rate (the sentence after it is prepared at the new one).
        val afterRestart = handed.dropWhile { it !in restart }.drop(1)
        check("every utterance the engine is handed after the change is at ${rate}x (${afterRestart.size} since)", restart.isNotEmpty() && afterRestart.all { "at ${rate}x" in it })
    }

    /** The host's log lines about utterances (`ReadAloud.speakNow`, tag `ZenReadAloud`), oldest first. */
    private fun hostLog(): List<String> = shell("logcat -d -s $HOST_TAG:*").lines().filter { "speak " in it }

    // --- 7. previous / next --------------------------------------------------------------------------

    private fun previousAndNext() {
        finding("\nEDGE-11 Previous / Next sentence under a finger (the model's sentence walk)")
        frontApp()
        if (engineless) {
            // No voice, no walk: the model's `error` state, both steps disabled with it.
            val previous = awaitNode(4_000) { it == "Previous sentence" }
            val next = awaitNode(4_000) { it == "Next sentence" }
            finding("  without an engine: Previous ${previous?.let { "enabled=${it.isEnabled}" } ?: "MISSING"}; Next ${next?.let { "enabled=${it.isEnabled}" } ?: "MISSING"}")
            check("without a voice the sentence steps are disabled with the error state", previous != null && !previous.isEnabled && next != null && !next.isEnabled)
            return
        }
        // The walk put at the first sentence first, so the steps read the same on every run (the
        // reading has gone on through the steps before this one); a seek speaks that sentence.
        // Then a real touch on Pause holds the walk still: the first sentence is the article's
        // heading, two seconds of speech, and run 4 tapped Next after the model had walked on by
        // itself (the tap moved 1 -> 2, read against 0 -> 1). Each step is read against the
        // sentence the walk stood at just before the finger came down; a step speaks (playing).
        coreInvoke("readAloud.seek", "{\"sentenceIndex\":0}")
        val atFirst = poll(6_000) { readAloud()?.optInt("sentenceIndex") == 0 && status() == "playing" }
        val held = holdTheWalk()
        val count = readAloud()?.optInt("sentenceCount") ?: 0
        val previous = awaitNode(4_000) { it == "Previous sentence" }
        val next = awaitNode(4_000) { it == "Next sentence" }
        finding("  at the first sentence (seek: $atFirst, held: $held, status ${status()}, index ${sentenceIndex()}): Previous ${previous?.let { "enabled=${it.isEnabled}" } ?: "MISSING"}; Next ${next?.let { "enabled=${it.isEnabled}" } ?: "MISSING"}; $count sentences")
        check("Previous is disabled at the first sentence", previous != null && !previous.isEnabled)
        check("Next is enabled before the last sentence", next != null && next.isEnabled)
        val before = sentenceIndex()
        val forward = touchTapLabelExpecting("Next sentence", "the walk moves on one sentence", timeoutMs = 8_000) { sentenceIndex() == before + 1 && status() == "playing" }
        val after = sentenceIndex()
        finding("  real touch on Next: index $before -> $after, status ${status()}; progress '${progressText()}'; highlight ${pageHighlight()}")
        check("a real touch on Next speaks the next sentence (${before + 1}, playing)", forward)
        check("the progress line follows the step (${after + 1} / $count)", poll(3_000) { progressText() == "${sentenceIndex() + 1} / $count" })
        val followed = poll(6_000) { pageHighlight().optBoolean("sentence") }
        check("the page's highlight follows the walk to the next sentence", followed)
        SystemClock.sleep(600)
        shot("09-next-sentence")
        val heldAgain = holdTheWalk()
        val at = sentenceIndex()
        val backward = touchTapLabelExpecting("Previous sentence", "the walk goes back one sentence", timeoutMs = 8_000) { sentenceIndex() == at - 1 && status() == "playing" }
        finding("  real touch on Previous (held: $heldAgain): index $at -> ${sentenceIndex()}, status ${status()}; progress '${progressText()}'")
        check("a real touch on Previous speaks the sentence before (${at - 1}, playing)", backward)
        if (at - 1 == 0) {
            val previousAgain = awaitNode(4_000) { it == "Previous sentence" }
            check("Previous is disabled again at the first sentence", previousAgain != null && !previousAgain.isEnabled)
        } else {
            finding("  NOTE the walk had moved on past the first sentence while the step was recorded; Previous stays enabled at $at")
        }
        beat()
    }

    private fun sentenceIndex(): Int = readAloud()?.optInt("sentenceIndex") ?: -1

    /**
     * A real touch on Pause (the walk holds at its sentence; the engine stops), so a step is
     * read against a sentence that stays put. True when the session reads paused after it.
     */
    private fun holdTheWalk(): Boolean {
        if (status() == "paused") return true
        return touchTapLabelExpecting("Pause", "the session pauses", timeoutMs = 6_000) { status() == "paused" }
    }

    // --- 8. the voice picker -------------------------------------------------------------------------

    private fun voicePicker() {
        finding("\nA11Y-06 the voice picker (a 9.13 sheet of the engine's voices)")
        frontApp()
        val hostVoices = runCatching { JSONObject(coreInvoke("readAloud.voices")).optJSONArray("voices") }.getOrNull() ?: JSONArray()
        val names = (0 until hostVoices.length()).map { hostVoices.getJSONObject(it) }
        finding("  readAloud.voices: ${names.size} voice(s): ${names.take(8).joinToString(" | ") { "${it.optString("name")} [${it.optString("id")}, ${it.optString("lang")}, ${if (it.optBoolean("local")) "local" else "network"}, ${it.optString("quality")}${if (it.optBoolean("default")) ", default" else ""}]" }}")
        check("the host lists the engine's installed voices (${names.size}; the probe saw ${probedVoices.size})", engineless || names.isNotEmpty())
        check("the engine's default voice is first", engineless || names.isEmpty() || names.first().optBoolean("default"))
        val first = names.firstOrNull()?.optString("name")
        val opened = touchTapLabelExpecting("Voice", "the picker lists the voices", timeoutMs = 10_000) {
            if (first != null) rowNode(first) != null else findNode { it == "No voices installed" || it.startsWith("Loading voices") } != null
        }
        finding("  real touch on Voice: sheet ${if (opened) "up" else "did not list a voice"}; rows on screen: ${voiceRowsOnScreen(names).joinToString(" | ")}")
        SystemClock.sleep(1_200)
        shot("10-voice-picker")
        beat()
        if (!opened) {
            dumpLabels("voice picker")
            back()
            return
        }
        // The second voice when there is one (so the change shows), else the first.
        val pick = names.getOrNull(1) ?: names.first()
        val pickName = pick.optString("name")
        val pickId = pick.optString("id")
        val node = rowNode(pickName)
        if (node == null) {
            finding("  the row '$pickName' is not on screen")
            check("a voice row can be touched", false)
        } else {
            val point = touchTapPoint(node)
            val set = poll(6_000) { readAloud()?.optString("voiceId") == pickId }
            finding("  real touch on '$pickName' at ${point?.let { "${it.x.toInt()},${it.y.toInt()}" } ?: "NOWHERE"}: voiceId=${readAloud()?.optString("voiceId")} (expected $pickId)")
            if (point != null && !set) touchFault("a touch on the voice row '$pickName' did not set the session's voice")
            check("a real touch on a voice row sets the session's voice", set)
            // §9.13: a pick closes the sheet by itself; the player stays. (Run 2 pressed Back here,
            // with no sheet left to take it: the Back went to the player and ended the session.)
            val pickClosed = poll(6_000) { rowNode(pickName) == null && panelUp() && readAloud() != null }
            finding("  after the pick: picker gone=${rowNode(pickName) == null}; player up=${panelUp()}; session=${if (readAloud() != null) "on" else "GONE"}")
            check("the pick closes the picker on its own and leaves the player", pickClosed)
            SystemClock.sleep(800)
            shot("11-voice-picked")
        }
        // Back with the picker up closes the picker alone: the sheet is the top back surface, the
        // player under it stays (its own Back is the Close step's, and the selection step's).
        val again = first != null && touchTapLabelExpecting("Voice", "the picker lists the voices again", timeoutMs = 10_000) { rowNode(first) != null }
        if (!again) {
            finding("  the picker did not open a second time; Back is not tried on it")
            check("the picker opens again for the Back check", false)
            beat()
            return
        }
        SystemClock.sleep(600)
        back()
        val closed = poll(8_000) { rowNode(first) == null }
        // Longer than the player's leave spring: a Back that had gone to the player shows here.
        SystemClock.sleep(1_500)
        val stayed = panelUp() && readAloud() != null && chromeSurfaceUp()
        finding("  back: picker gone=$closed; player still up=${panelUp()}; session ${if (readAloud() != null) "on" else "GONE"}; chrome surface up=${chromeSurfaceUp()}")
        check("back closes the picker and leaves the player", closed && stayed)
        beat()
    }

    // --- 9. close --------------------------------------------------------------------------------------

    private fun closePanel() {
        finding("\nMOT-35 Close under a finger: the panel leaves, the session ends")
        frontApp()
        if (readAloud() == null || !panelUp()) {
            // A step before this one lost the player: said here in its own words, not as Close's.
            finding("  the player is not up for the Close step (session=${readAloud()}; panel up=${panelUp()})")
            check("the player is up for the Close step", false)
            return
        }
        val pageBefore = pageHeight()
        touchTapLabelExpecting("Close", "the session ends", timeoutMs = 6_000) { readAloud() == null }
        val gone = poll(6_000) { !panelUp() && !chromeSurfaceUp() }
        // The page takes the panel's space back once the panel's leave spring has run (§9.32).
        val grew = poll(6_000) { pageHeight() > pageBefore }
        val pageAfter = pageHeight()
        finding("  after Close: session=${readAloud()}; panel gone=$gone; page height ${pageBefore} -> $pageAfter; focus: ${audioFocus()}")
        check("Close ends the session and the panel leaves", readAloud() == null && gone)
        check("the page grows back into the panel's space", grew)
        check("no focus is held once the session is gone", !audioFocus().contains(app.packageName))
        shot("12-closed")
        beat()
    }

    // --- 10. the selection toolbar's Read Aloud ------------------------------------------------------

    private fun fromSelection() {
        finding("\nEDGE-11 / GN-13 Read Aloud from the selection toolbar (the model reads the selection alone, as Chrome does)")
        frontApp()
        val items = longPress("#word") { list -> list.any { it.label == "Read Aloud" || it.label == "More options" } }
        val selected = jsonString(pageJs("String(getSelection())"))
        finding("  long press on 'arithmetic': selection '$selected'; toolbar: ${items?.joinToString(" | ") { it.label } ?: "MISSING"}")
        if (items == null) {
            check("the selection toolbar comes up", false)
            return
        }
        val inBar = items.find { it.label == "Read Aloud" }
        val point = inBar?.let { touchTapPoint(it.node) } ?: touchInOverflow(items, "Read Aloud")
        finding("  real touch on Read Aloud ${point?.let { "at ${it.x.toInt()},${it.y.toInt()}${if (inBar == null) " (behind the overflow)" else ""}" } ?: "NOT POSSIBLE (item missing)"}")
        val came = point != null && poll(10_000) { readAloud()?.optString("source") == "selection" }
        finding("  session: ${readAloud()}")
        if (point != null && !came) touchFault("a touch on the toolbar's Read Aloud started no session from the selection")
        check("Read Aloud is on the toolbar and a touch on it starts a session from the selection", came)
        if (came) {
            val up = poll(8_000) { panelUp() }
            // The mode's finish collapsed the page's selection before the core's extraction
            // reached the document; the page script stands the cleared selection in for it
            // (`selectionMemory.ts`: run 4 read `no-text` here). The text is the selection alone.
            val spoke = engineless || awaitStatus("playing", 20_000)
            val session = readAloud()
            finding("  player up=$up; status after a moment: ${status()}; sentences ${session?.optInt("sentenceCount")}; error ${session?.optString("error")}")
            check("the selection's text is what the session reads (playing, no 'no-text')", engineless || (spoke && (session?.optInt("sentenceCount") ?: 0) >= 1))
            check("the session's source is the selection", session?.optString("source") == "selection")
            // The mode's finish collapsed the selection and the page script put it back only for
            // the extraction's duration: the document is left with a collapsed selection, no
            // handles, the highlight on the sentence read.
            val collapsed = poll(3_000) { jsonString(pageJs("String(getSelection().isCollapsed)")) == "true" }
            val selectedNow = jsonString(pageJs("String(getSelection())"))
            finding("  the document's selection after the touch: collapsed=$collapsed, text '$selectedNow'; highlight ${pageHighlight()}")
            check("the document's selection is left collapsed (no handles stay up)", collapsed && selectedNow.isEmpty())
            SystemClock.sleep(800)
            shot("13-from-selection")
            beat()
            // The selection put away first, so the toolbar is not what the Back finds; then the
            // system back with the player up: the player is the top back surface and leaves like
            // a page (predictive back, MOT-35) – what run 2 saw by accident after the voice pick.
            clearSelection()
            if (up && panelUp()) {
                back()
                val left = poll(8_000) { readAloud() == null && !panelUp() }
                finding("  back with the player up: session=${readAloud()}; panel up=${panelUp()}; chrome surface up=${chromeSurfaceUp()}")
                check("the system back closes the player and ends the session (MOT-35)", left)
            } else {
                check("the player is up for the Back check", false)
            }
            if (readAloud() != null) {
                coreInvoke("readAloud.stop")
                poll(5_000) { readAloud() == null }
            }
            return
        }
        clearSelection()
    }

    // --- 11. dark ---------------------------------------------------------------------------------------

    private fun darkPlayer() {
        finding("\ndesign record: the player in dark")
        frontApp()
        shell("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(4_000)
        ensureForeground()
        if (!openMenuItem(MENU_ITEM)) {
            finding("  the menu did not list '$MENU_ITEM' in dark")
            check("dark: Listen to This Page starts the player", false)
            back()
        } else {
            val came = poll(10_000) { readAloud() != null && panelUp() }
            if (!engineless) awaitStatus("playing", 20_000)
            finding("  dark: session=${readAloud()}")
            check("dark: Listen to This Page starts the player", came)
            SystemClock.sleep(1_000)
            shot("14-playing-dark")
            beat()
            touchTapLabelExpecting("Pause", "paused in dark", timeoutMs = 6_000) { status() == "paused" || engineless }
            SystemClock.sleep(800)
            shot("15-paused-dark")
            beat()
            touchTapLabelExpecting("Close", "the session ends", timeoutMs = 6_000) { readAloud() == null }
            SystemClock.sleep(1_500)
        }
        shell("cmd uimode night no")
        coreInvoke("settings.update", "{\"colorScheme\":\"light\"}")
        SystemClock.sleep(1_500)
    }

    // --- the session ---------------------------------------------------------------------------------

    private fun readAloud(): JSONObject? = coreState().optJSONObject("readAloud")

    private fun status(): String = readAloud()?.optString("status").orEmpty()

    private fun rate(): Double = readAloud()?.optDouble("rate", Double.NaN) ?: Double.NaN

    private fun awaitStatus(status: String, timeoutMs: Long): Boolean = poll(timeoutMs) { status() == status }

    /** Playing before a step that needs it: a touch on Play when paused or ended (its own assertion). */
    private fun ensurePlaying(): Boolean {
        if (status() == "playing") return true
        if (status() == "loading") return awaitStatus("playing", 20_000)
        val ok = touchTapLabelExpecting("Play", "the reading goes on for the step", timeoutMs = 20_000) { status() == "playing" }
        if (!ok) finding("  could not get the reading going for the step (status ${status()})")
        return ok
    }

    private fun tab(): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(TAB)

    private fun describeTab(): String {
        val tab = tab() ?: return "tab $TAB gone"
        return "url=${tab.optString("url")} title=\"${tab.optString("title").take(50)}…\" readerable=${tab.optBoolean("readerable")}"
    }

    // --- the player in the tree ----------------------------------------------------------------------

    private fun panelUp(): Boolean = findNode { it == PANEL_LABEL } != null || findNode { it == "Previous sentence" } != null

    private fun panelBounds(): Rect? = findNode { it == PANEL_LABEL }?.let { Rect().also(it::getBoundsInScreen) }

    private fun chipLabel(): String? = findNode { it.startsWith("Speed ") }?.let(::label)

    /** The play box's busy spinner's width in CSS px (`.zen-read-aloud-toggle > .zen-v2-spinner`), 0 while there is none. */
    private fun spinnerSize(): Double =
        jsonString(chromeJs("(function(){var e=document.querySelector('.zen-read-aloud-toggle > .zen-v2-spinner');return e?String(e.getBoundingClientRect().width):'0'})()"))
            .toDoubleOrNull() ?: 0.0

    /** The header's trailing line, from the chrome's own document (the tree runs the title and it together). */
    private fun progressText(): String =
        jsonString(chromeJs("(function(){var e=document.querySelector('.zen-read-aloud-progress');return e?e.textContent.trim():''})()"))

    /** The page's height in CSS px as the frame gives it (the docked panel shortens it, §9.32). */
    private fun pageHeight(): Int {
        var h = 0
        instrumentation.runOnMainSync { h = host.tabs.get(TAB)?.height ?: 0 }
        return h
    }

    private fun label(node: AccessibilityNodeInfo): String = (node.contentDescription ?: node.text)?.toString().orEmpty()

    /**
     * The row (or control) reading `label`: a sheet's row is one button whose text runs its label
     * and description together, so the clickable node reading the label alone or the label and a
     * space wins (the media UI demo's shape).
     */
    private fun rowNode(label: String): AccessibilityNodeInfo? {
        val reads = { node: AccessibilityNodeInfo ->
            val text = (node.text ?: node.contentDescription)?.toString()
            text != null && (text == label || text.startsWith("$label "))
        }
        return findNodeWhere { node -> node.isClickable && reads(node) } ?: findNodeWhere(reads)
    }

    private fun voiceRowsOnScreen(voices: List<JSONObject>): List<String> =
        voices.map { it.optString("name") }.filter { rowNode(it) != null }

    private fun dumpLabels(why: String) {
        val labels = ArrayList<String>()
        val root = ui.rootInActiveWindow ?: return
        val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
        var visited = 0
        while (queue.isNotEmpty() && visited < 1_500 && labels.size < 60) {
            val node = queue.removeFirst()
            visited++
            val text = (node.contentDescription ?: node.text)?.toString()?.trim()
            if (!text.isNullOrEmpty()) labels += text.take(50)
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        finding("  tree ($why): $labels")
    }

    // --- the system: focus, the notification, the shade -------------------------------------------

    /** `adb shell` from inside the instrumentation (UiAutomation's shell): the command's output. */
    private fun shell(command: String): String = runCatching {
        val fd = ui.executeShellCommand(command)
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }
    }.getOrElse { "shell failed: $it" }

    /** Who holds the system's audio focus, from `dumpsys audio`'s focus stack (the media demos' reading of it). */
    private fun audioFocus(): String {
        val dump = shell("dumpsys audio")
        val start = dump.indexOf("Audio Focus stack entries")
        if (start < 0) return "no focus stack in dumpsys audio"
        val entries = dump.substring(start).lineSequence().drop(1).takeWhile { it.isNotBlank() }
            .map { line ->
                val pack = Regex("pack: (\\S+)").find(line)?.groupValues?.get(1) ?: "?"
                val gain = Regex("gain: (\\S+)").find(line)?.groupValues?.get(1) ?: "?"
                val usage = Regex("usage=(\\S+)").find(line)?.groupValues?.get(1) ?: "?"
                "$pack $gain $usage"
            }.toList()
        return if (entries.isEmpty()) "held by nobody" else "held by ${entries.joinToString("; ")}"
    }

    private fun awaitMediaNotification(timeoutMs: Long): StatusBarNotification? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            runCatching { notificationManager.activeNotifications.firstOrNull { it.notification.extras.containsKey(Notification.EXTRA_MEDIA_SESSION) } }
                .getOrNull()?.let { return it }
            SystemClock.sleep(250)
        }
        return null
    }

    private fun describe(sbn: StatusBarNotification?): String {
        if (sbn == null) return "none"
        val n = sbn.notification
        val extras = n.extras
        val actions = n.actions?.map { it.title?.toString() ?: "?" } ?: emptyList()
        return "id=${sbn.id} channel=${n.channelId} title=\"${extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.take(50)}…\" " +
            "text=\"${extras.getCharSequence(Notification.EXTRA_TEXT)}\" actions=$actions ongoing=${n.flags and Notification.FLAG_ONGOING_EVENT != 0} " +
            "foregroundService=${n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0}"
    }

    private fun describeSession(): String = runCatching {
        val controller = host.media.controller
        val state = controller.playbackState
        val metadata = controller.metadata
        "state=${state?.state} actions=0x${state?.actions?.toString(16)} title=\"${metadata?.getString(MediaMetadataCompat.METADATA_KEY_TITLE)?.take(50)}…\" " +
            "artist=\"${metadata?.getString(MediaMetadataCompat.METADATA_KEY_ARTIST)}\""
    }.getOrElse { "unreadable: $it" }

    private fun openShade(timeoutMs: Long, matches: (String) -> Boolean): Boolean {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findInWindows(matches) != null) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /**
     * The shade down again, and proven down: the accessibility action first, which an image may
     * not honour (run 1's `SystemActionPerformer: Invalid action id: 15` – SystemUI had registered
     * no dismiss action, the shade stayed over the resumed app and every check after it read the
     * shade's tree), then the status bar's own shell command, then Back.
     */
    private fun closeShade() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        } else {
            back()
        }
        if (poll(2_500) { !shadeUp() }) return
        finding("  the shade did not take the dismiss action; collapsing it through the status bar")
        shell("cmd statusbar collapse")
        if (poll(2_500) { !shadeUp() }) return
        back()
        val down = poll(2_500) { !shadeUp() }
        finding("  the shade is ${if (down) "down after Back" else "STILL UP"}")
    }

    /** The shade is up while SystemUI's window is the active one (the notification list, the quick settings). */
    private fun shadeUp(): Boolean = ui.rootInActiveWindow?.packageName?.toString() == SYSTEM_UI

    /** The browser's task to the front through the shell (an activity start from behind the launcher is refused to the app itself). */
    private fun bringToFront() {
        val started = shell("am start -W -a android.intent.action.MAIN -f 0x20000000 -n ${app.packageName}/${MainActivity::class.java.name}")
        if (!started.contains("Status: ok")) finding("  am start: ${started.trim().lines().joinToString(" | ")}")
        SystemClock.sleep(1_500)
    }

    /**
     * The app in front before a step touches its chrome, whatever the last step left on the screen
     * (the launcher after Home, the shade): one step's leftovers must not read as the next step's
     * failure (the media demos' `frontApp`).
     */
    private fun frontApp() {
        if (ui.rootInActiveWindow?.packageName?.toString() == app.packageName) return
        closeShade()
        if (ui.rootInActiveWindow?.packageName?.toString() == app.packageName) return
        bringToFront()
        val front = poll(8_000) { ui.rootInActiveWindow?.packageName?.toString() == app.packageName }
        finding("  the app brought to the front for the step: $front")
        SystemClock.sleep(1_000)
    }

    // --- the selection toolbar (the selection demo's shapes) ------------------------------------------

    private class ToolbarItem(val label: String, val bounds: Rect, val node: AccessibilityNodeInfo)

    /** The floating toolbar's buttons, left to right, in the window that holds the system's Copy; null while none is up. */
    private fun toolbarItems(): List<ToolbarItem>? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            val items = ArrayList<ToolbarItem>()
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var visited = 0
            while (queue.isNotEmpty() && visited < 3_000) {
                val node = queue.removeFirst()
                visited++
                val label = node.contentDescription?.toString()?.trim().orEmpty()
                if (label.isNotEmpty() && node.isClickable && node.isVisibleToUser) {
                    items += ToolbarItem(label, Rect().also { node.getBoundsInScreen(it) }, node)
                }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            if (items.any { it.label == "Copy" }) return items.sortedBy { it.bounds.left }
        }
        return null
    }

    private fun longPress(selector: String, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        val p = pagePoint(selector) ?: run {
            finding("  no $selector on the page")
            return null
        }
        Finger().apply {
            down(p.x, p.y)
            hold(1_200)
            up()
        }
        val deadline = SystemClock.uptimeMillis() + 12_000
        var last: List<ToolbarItem>? = null
        while (SystemClock.uptimeMillis() < deadline) {
            toolbarItems()?.let { items ->
                last = items
                if (ready(items)) return items
            }
            SystemClock.sleep(250)
        }
        return last
    }

    /** A real touch on the overflow button, then on `label` in the list behind it; where the finger landed, or null. */
    private fun touchInOverflow(items: List<ToolbarItem>, label: String): PointF? {
        val more = items.find { it.label == "More options" } ?: return null
        touchTapPoint(more.node) ?: return null
        val deadline = SystemClock.uptimeMillis() + 5_000
        var node: AccessibilityNodeInfo? = null
        while (SystemClock.uptimeMillis() < deadline && node == null) {
            node = findInWindows { it == label }
            if (node == null) SystemClock.sleep(200)
        }
        if (node == null) {
            finding("  '$label' is not behind the overflow either")
            findInWindows { it == "Close overflow" }?.let { touchTapPoint(it) }
            return null
        }
        return touchTapPoint(node)
    }

    private fun clearSelection() {
        pagePoint("#tail")?.let { Finger().tap(it.x, it.y) }
        SystemClock.sleep(1_000)
    }

    // --- the page -----------------------------------------------------------------------------------

    /** Evaluate in the demo tab's page; the raw JSON-encoded result ("" when it never answered). */
    private fun pageJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB)
            if (view == null) latch.countDown()
            else view.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    /**
     * What the core's page script has painted into the article (`readAloudScript.ts`): whether
     * the document has the CSS Custom Highlight API, whether the sentence and the word highlights
     * are registered on it, and whether the highlight's style element is in the head
     * (`view.insertCSS`, `zen-css-*`). `{}` when the page never answered.
     */
    private fun pageHighlight(): JSONObject {
        val raw = pageJs(
            "(function(){var h=window.CSS&&CSS.highlights;return JSON.stringify({api:!!h," +
                "sentence:!!(h&&h.has('zenium-read-sentence')),word:!!(h&&h.has('zenium-read-word'))," +
                "style:!!document.querySelector('style[id^=\"zen-css-\"]')})})()"
        )
        return runCatching { JSONObject(jsonString(raw)) }.getOrDefault(JSONObject())
    }

    /** Where the middle of the first element matching `selector` is on screen (device px), or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = pageJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return JSON.stringify([r.left+r.width/2,r.top+r.height/2])})()"
        )
        val json = (JSONTokener(raw).nextValue() as? String)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return null
        var origin: IntArray? = null
        var scale = 0f
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB) ?: return@runOnMainSync
            origin = IntArray(2).also { view.getLocationOnScreen(it) }
            @Suppress("DEPRECATION")
            scale = view.scale
        }
        val at = origin ?: return null
        if (scale <= 0f) scale = density
        return PointF((at[0] + json.getDouble(0) * scale).toFloat(), (at[1] + json.getDouble(1) * scale).toFloat())
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = tab()
            if (tab != null && tab.optString("url") == url && !tab.optBoolean("loading")) {
                SystemClock.sleep(800)
                return
            }
            SystemClock.sleep(400)
        }
        finding("  the article never finished loading: ${describeTab()}")
    }

    // --- findings -------------------------------------------------------------------------------------

    private fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(200)
        }
        return condition()
    }

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        finding("  ${if (ok) "PASS" else "FAIL"}: $what")
    }

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18148
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val TAB = "tab_demo"
        private const val MENU_ITEM = "Listen to This Page"
        /** The player's `role=region` label (`ReadAloudPanel`). */
        private const val PANEL_LABEL = "Read aloud"
        private const val SYSTEM_UI = "com.android.systemui"
        /** The host's log tag (`ReadAloud.kt`): one line per utterance the engine is handed. */
        private const val HOST_TAG = "ZenReadAloud"
    }
}
