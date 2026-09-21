package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records three small pieces of the phone chrome on one boot, each under a real finger, and
 * writes what it measured to `bar-star-listen-on-findings.txt` next to the stills (one `PASS` or
 * `FAIL` per check; the run fails at the end when any did, or when a touch did not take):
 *
 *  A. the bar's optional Bookmark star (the lead's ruling on #236: the bar star follows the menu
 *     star): outlined and named "Bookmark" on a page that is not bookmarked, with no
 *     `aria-pressed` (its node not checkable: TalkBack names a button, not a toggle); a touch
 *     saves the page – the fill climbs on the menu star's spring (`StarGlyph`, one component for
 *     both), the "Saved to Bookmarks" toast comes with its Edit, the star reads "Edit Bookmark"
 *     – and a touch on the toast's Edit opens the editor sheet; a second touch on the filled
 *     star opens the editor again and removes nothing. Then the design record: the star filled
 *     and outlined in light and dark, with the bar at the bottom and at the top.
 *  B. Listen from the selection toolbar reads on (EDGE-11, `readAloud.start` with
 *     `from: 'selection-on'`, the label "Listen" as the lead ruled on #240): a long press on a
 *     sentence in the middle of the article (`user-select: all` on it, so the press takes the
 *     whole sentence) and a finger on Listen start a session whose first sentence is the
 *     selection and whose walk then goes on through the document after it – the player's
 *     position past the selection, the sentence highlight in the page starting after the
 *     selection's end, the engine handed the selection first and the paragraph's next sentence
 *     after it.
 *  C. a page gone while fullscreen (the #244 follow-up): a finger takes a portrait clip
 *     fullscreen on a page that closes its own tab a moment later (`window.close()`, a tab on
 *     its first document); the window's HTML fullscreen ends with the tab and the chrome's
 *     return falls through to its fade at once – the `animate()` of the 120 ms fade within
 *     300 ms of the chrome's fullscreen state clearing, not at the 2.5 s landing timeout that
 *     waited for a page that was never coming back (the timestamps on record).
 *
 * The pages come from a loopback server inside this process ([DemoServer]): the read-aloud
 * demo's article with the sentence marked, and `fullscreen-gone-tab-demo-page.html` with the
 * fullscreen demo's portrait clip. Profile `bar-star-listen-on-demo-state.json`: the two tabs,
 * the Bookmark item on the bar, the gesture and fullscreen hints already shown. The image is the
 * shared default (Google APIs, API 34): the speech engine is there, and with the hint counted as
 * shown nothing needs the `popover` its WebView predates. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class BarStarListenOnDemo : DemoHarness("bar-star-listen-on-demo-state.json", "android", "bar-star-listen-on-demo") {
    override val tag = "BarStarListenOnDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private var sentenceMarked = false
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        val article = readAsset("read-aloud-demo-page.html")
        val marked = article.replace(
            SENTENCE,
            "<span id=\"sentence\" style=\"user-select:all;-webkit-user-select:all\">$SENTENCE</span>"
        )
        sentenceMarked = marked != article
        server = DemoServer(
            PORT,
            mapOf(
                "/article" to ("text/html; charset=utf-8" to marked.toByteArray()),
                "/video" to ("text/html; charset=utf-8" to readAsset("fullscreen-gone-tab-demo-page.html").toByteArray()),
                "/port.webm" to ("video/webm" to readAssetBytes("fullscreen-demo-portrait.webm")),
                "/closing" to ("text/plain; charset=utf-8" to "closing\n".toByteArray())
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures > 0) throw AssertionError("$failures check(s) failed; see bar-star-listen-on-findings.txt")
    }

    override fun beforeLaunch() {
        shell("cmd uimode night no")
        // The system's one-time "Viewing full screen" notice would stand over the fullscreen clip.
        shell("settings put secure immersive_mode_confirmations confirmed")
        SystemClock.sleep(1_000)
    }

    override fun warmUp() {
        findings = File(out, "bar-star-listen-on-findings.txt")
        findings.writeText("Zenium Android bar star, Listen reads on, fullscreen gone-tab checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        finding("the sentence '$SENTENCE' marked in the article for the long press: $sentenceMarked")
        finding("host: speech engines ${host.readAloud.engines()}; available=${host.readAloud.available}")
        awaitLoaded(ARTICLE, "$ORIGIN/article")
        val readerable = poll(15_000) { tab(ARTICLE)?.optBoolean("readerable") == true }
        finding("article: ${tab(ARTICLE)?.optString("url")} readerable=$readerable bookmarked=${bookmarked(ARTICLE)}; bar ${starDom()}")
        chromeJs(FILL_SAMPLER)
        // The menu once off camera: the sheet's layout and the row's compile, before the recording.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(800)
            back()
            awaitSurface(false)
        }
        SystemClock.sleep(1_500)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        barStar()
        listenOn()
        goneTab()
        finding("")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- A. the bar star -------------------------------------------------------------------------

    private fun barStar() {
        finding("\nA. the bar's Bookmark star: a stateful glyph on bookmark.star, no toggle (the menu star's shape)")
        ensureForeground()
        val before = bookmarkCount()
        val rest = starDom()
        val restNode = starNode()
        finding("  at rest: dom $rest; node ${describe(restNode)}; bookmarks $before")
        check(
            "outlined 'Bookmark' on a page that is not bookmarked (label '${rest?.optString("label")}', data-filled ${rest?.optString("filled")}, fill opacity ${rest?.optString("fill")})",
            rest != null && rest.optString("label") == LABEL_STAR && rest.optString("filled") == "false" && rest.optString("fill") == "0"
        )
        check(
            "no aria-pressed on the star, its node not checkable (a button, not a toggle)",
            rest != null && rest.isNull("pressed") && restNode != null && !restNode.isCheckable
        )
        check("TalkBack names it '$LABEL_STAR'", restNode?.let(::nameOf) == LABEL_STAR)
        still("bar-star-01-outlined-light-bottom")
        beat()

        // The touch: the fill sampled per frame from before the finger lands, the toasts on record.
        watchToasts()
        chromeJs("window.__starFillStart()")
        val touched = touchTapLabel(LABEL_STAR)
        val saved = poll(8_000) { bookmarked(ARTICLE) }
        SystemClock.sleep(150)
        still("bar-star-02-filling")
        val toasted = awaitToastSeen(TOAST_SAVED, 8_000)
        // The toast with an action stands five seconds: its Edit is touched first, everything
        // else about the press is read afterwards (the samples and the record keep).
        val editFromToast = toasted && touchChrome(
            ".zen-message-toast .zen-message-button",
            "the editor sheet is up",
            8_000
        ) { editorUp() }
        val samples = fillSamples()
        val opacities = (0 until samples.length()).mapNotNull { i ->
            val s = samples.getJSONArray(i)
            if (s.isNull(1)) null else s.getDouble(1)
        }
        val climbs = opacities.indices.count { it > 0 && opacities[it] > opacities[it - 1] + 0.001 }
        val peak = opacities.maxOrNull() ?: 0.0
        val landing = opacities.indexOfFirst { it >= 0.999 }
        val landingStep = if (landing > 0) opacities[landing] - opacities[landing - 1] else 0.0
        val after = bookmarkCount()
        val filledDom = starDom()
        val filledNode = starNode()
        finding("  after the touch: touched=$touched saved=$saved toast=$toasted; dom $filledDom; node ${describe(filledNode)}; bookmarks $after")
        check("a real touch on the star bookmarked the page (one node more, $before -> $after; the tab bookmarked)", touched && saved && after == before + 1)
        check(
            "the fill climbed on the shared spring over several frames, no cut into the fill (${samples.length()} frames, $climbs climbing, peak ${"%.2f".format(peak)}, landing step ${"%.3f".format(landingStep)}; path ${opacities.joinToString(" ") { "%.2f".format(it) }})",
            climbs >= 2 && peak > 0.8 && landingStep < 0.1
        )
        check("the toast '$TOAST_SAVED' came with its Edit", toasted)
        check(
            "filled '$LABEL_EDIT' once bookmarked (label '${filledDom?.optString("label")}', data-filled ${filledDom?.optString("filled")}, fill opacity ${filledDom?.optString("fill")})",
            filledDom != null && filledDom.optString("label") == LABEL_EDIT && filledDom.optString("filled") == "true" && filledDom.optString("fill") == "1"
        )
        check(
            "still no aria-pressed once filled; TalkBack names it '$LABEL_EDIT'",
            filledDom != null && filledDom.isNull("pressed") && filledNode != null && !filledNode.isCheckable && nameOf(filledNode) == LABEL_EDIT
        )
        check("a touch on the toast's Edit opened the editor sheet", editFromToast)
        if (editFromToast) {
            SystemClock.sleep(1_500)
            check("the editor is the bookmark editor ('$EDITOR_TITLE' on screen)", waitFor(EDITOR_TITLE, 6_000) != null)
            still("bar-star-03-editor-from-toast")
            beat()
            closeEditor()
        }
        // The second touch: the filled star opens the editor and removes nothing.
        val count = bookmarkCount()
        val again = touchTapLabelExpecting(LABEL_EDIT, "the editor sheet is up", 8_000) { editorUp() }
        check("a second touch on the filled star opens the editor", again)
        if (again) {
            SystemClock.sleep(1_500)
            check("the editor is the bookmark editor ('$EDITOR_TITLE' on screen)", waitFor(EDITOR_TITLE, 6_000) != null)
            still("bar-star-04-editor-from-star")
            beat()
        }
        val stillFilled = starDom()
        check(
            "the second touch removed nothing (bookmarks $count -> ${bookmarkCount()}, the tab bookmarked ${bookmarked(ARTICLE)}, the star filled ${stillFilled?.optString("filled")})",
            bookmarkCount() == count && bookmarked(ARTICLE) && stillFilled?.optString("filled") == "true"
        )
        if (again) closeEditor()
        designRecord()
    }

    /** The star filled and outlined in light and dark, the bar at the bottom and at the top (v2 §9.13's words, the design gate's stills). */
    private fun designRecord() {
        finding("\n  design record: the star in light and dark, the bar at the bottom and at the top")
        // Dark, bar at the bottom.
        scheme("dark")
        starStill("filled", "dark", "bottom", "05")
        activate(VIDEO)
        starStill("outlined", "dark", "bottom", "06")
        // Dark, bar at the top.
        barPosition("top")
        starStill("outlined", "dark", "top", "07")
        activate(ARTICLE)
        starStill("filled", "dark", "top", "08")
        // Light, bar at the top.
        scheme("light")
        starStill("filled", "light", "top", "09")
        activate(VIDEO)
        starStill("outlined", "light", "top", "10")
        // Back to the run's shape: light, the bar at the bottom, the article in front.
        barPosition("bottom")
        activate(ARTICLE)
        SystemClock.sleep(1_000)
    }

    private fun starStill(state: String, scheme: String, edge: String, n: String) {
        val dom = starDom()
        val filled = state == "filled"
        check(
            "$scheme, bar $edge: the star ${if (filled) "filled '$LABEL_EDIT'" else "outlined '$LABEL_STAR'"} (label '${dom?.optString("label")}', data-filled ${dom?.optString("filled")}, theme ${dom?.optString("theme")}, edge ${dom?.optString("edge")})",
            dom != null && dom.optString("filled") == filled.toString() && dom.optString("label") == (if (filled) LABEL_EDIT else LABEL_STAR) &&
                dom.optString("theme") == scheme && dom.optString("edge") == edge
        )
        still("bar-star-$n-$state-$scheme-$edge")
        beat()
    }

    private fun scheme(scheme: String) {
        shell("cmd uimode night ${if (scheme == "dark") "yes" else "no"}")
        coreInvoke("settings.update", "{\"colorScheme\":\"$scheme\"}")
        poll(8_000) { starDom()?.optString("theme") == scheme }
        SystemClock.sleep(2_500)
        ensureForeground()
    }

    private fun barPosition(edge: String) {
        coreInvoke("settings.update", "{\"phoneBarPosition\":\"$edge\"}")
        poll(8_000) { starDom()?.optString("edge") == edge }
        SystemClock.sleep(2_000)
    }

    private fun closeEditor() {
        back()
        val gone = poll(6_000) { !editorUp() }
        if (!gone) finding("  the editor did not leave on back (bookmarkEdit still set)")
        SystemClock.sleep(1_200)
    }

    // --- B. Listen reads on -----------------------------------------------------------------------

    private fun listenOn() {
        finding("\nB. $TOOLBAR_ITEM from a selected sentence reads on (readAloud.start from: 'selection-on', EDGE-11)")
        ensureForeground()
        activate(ARTICLE)
        if (!host.readAloud.available) {
            check("a speech engine is on the device (the shared image's Google engine)", false)
            return
        }
        val items = longPress(ARTICLE, "#sentence") { list -> list.any { it.label == TOOLBAR_ITEM || it.label == "More options" } }
        // The selection's range kept in the page before the touch: the mode's finish collapses the
        // document's selection, and the highlight is measured against where the selection was.
        val selected = jsonString(pageJs(ARTICLE, "(function(){var s=getSelection();if(!s.rangeCount)return '';window.__sel=s.getRangeAt(0).cloneRange();return String(s)})()"))
        finding("  long press on the sentence: selection '$selected'; toolbar: ${items?.joinToString(" | ") { it.label } ?: "MISSING"}")
        check("the long press selected the whole sentence (user-select: all on it)", selected.trim() == SENTENCE)
        if (items == null) {
            check("the selection toolbar comes up", false)
            return
        }
        val inBar = items.find { it.label == TOOLBAR_ITEM }
        val logBefore = hostLog().size
        val point = inBar?.let { touchTapPoint(it.node) } ?: touchInOverflow(items, TOOLBAR_ITEM)
        finding("  real touch on $TOOLBAR_ITEM ${point?.let { "at ${it.x.toInt()},${it.y.toInt()}${if (inBar == null) " (behind the overflow)" else ""}" } ?: "NOT POSSIBLE (item missing)"}")
        val first = if (point == null) null else awaitSample(10_000) { it.optString("source") == "selection" }
        finding("  first session sample: $first")
        if (point != null && first == null) touchFault("a touch on the toolbar's $TOOLBAR_ITEM started no session from the selection")
        check("$TOOLBAR_ITEM is on the toolbar and a real touch on it starts a session from the selection", first != null)
        if (first == null) {
            clearSelection()
            return
        }
        // The selection is sentence 0. Reading on means the walk leaves it: the position past
        // it, the page's sentence highlight after the selection's end.
        val passed = awaitSample(30_000) { it.optInt("sentenceIndex", -1) >= 1 && it.optString("status") == "playing" }
        val session = readAloud() ?: passed ?: first
        val position = highlightVersusSelection()
        val handed = hostLog().drop(logBefore).filter { ": FLUSH at " in it || ": ADD at " in it }
            .map { it.substringAfter(" \"").substringBeforeLast('"').trim() }
        finding("  after the selection: session=$session; highlight vs the selection: $position; the engine was handed: ${handed.joinToString(" | ") { "\"${it.take(60)}\"" }}")
        check("the player's position is past the selection (sentenceIndex ${session.optInt("sentenceIndex", -1)} >= 1, the selection being sentence 0, playing)", passed != null)
        check("the sentence highlight in the page starts after the selection's end ('${position.optString("text").take(40)}')", position.optBoolean("afterSelection"))
        check("the document follows the selection: more than the one sentence (${session.optInt("sentenceCount")})", session.optInt("sentenceCount") > 1)
        check("the engine was handed the selection's text first", handed.firstOrNull() == selected.trim())
        check("...and the paragraph's next sentence after it ('$NEXT_SENTENCE_START…')", handed.getOrNull(1)?.startsWith(NEXT_SENTENCE_START) == true)
        check("the session's source is the selection", session.optString("source") == "selection")
        val collapsed = poll(3_000) { jsonString(pageJs(ARTICLE, "String(getSelection().isCollapsed)")) == "true" }
        check("the document's selection is left collapsed (no handles stay up)", collapsed)
        SystemClock.sleep(600)
        still("listen-on-01-reading-past-the-selection")
        beat()
        check(
            "a touch on the player's Close ends the session",
            touchTapLabelExpecting("Close", "the session ends", 8_000) { readAloud() == null }
        )
        if (readAloud() != null) {
            coreInvoke("readAloud.stop")
            poll(5_000) { readAloud() == null }
        }
        clearSelection()
        SystemClock.sleep(1_000)
    }

    /**
     * Where the page's sentence highlight (`zenium-read-sentence`, the core's page script through
     * the CSS Custom Highlight API) stands against the selection the session started from
     * (`window.__sel`): `afterSelection` when its start is past the selection's end.
     */
    private fun highlightVersusSelection(): JSONObject {
        val raw = pageJs(
            ARTICLE,
            "(function(){try{var h=window.CSS&&CSS.highlights&&CSS.highlights.get('zenium-read-sentence');var sel=window.__sel;" +
                "if(!h||!sel)return JSON.stringify({highlight:!!h,selection:!!sel});var ranges=Array.from(h);" +
                "if(!ranges.length)return JSON.stringify({highlight:true,ranges:0});var r=ranges[0];" +
                "var after=sel.comparePoint(r.startContainer,r.startOffset)>0;var rr=document.createRange();" +
                "rr.setStart(r.startContainer,r.startOffset);rr.setEnd(r.endContainer,r.endOffset);" +
                "return JSON.stringify({highlight:true,ranges:ranges.length,afterSelection:after,text:rr.toString().slice(0,80)})}" +
                "catch(e){return JSON.stringify({error:String(e)})}})()"
        )
        return runCatching { JSONObject(jsonString(raw)) }.getOrDefault(JSONObject())
    }

    // --- C. the fullscreen gone tab ------------------------------------------------------------------

    private fun goneTab() {
        finding("\nC. a page gone while fullscreen: the chrome's return falls through to the fade (the #244 follow-up)")
        ensureForeground()
        activate(VIDEO)
        awaitLoaded(VIDEO, "$ORIGIN/video")
        poll(10_000) { title(VIDEO).startsWith("GT|") }
        poll(10_000) { pageJs(VIDEO, "document.getElementById('port').videoWidth") != "0" }
        finding("  the video tab: ${tab(VIDEO)?.optString("url")} title \"${title(VIDEO)}\"; clip ${pageJs(VIDEO, "document.getElementById('port').videoWidth")}x${pageJs(VIDEO, "document.getElementById('port').videoHeight")}")
        check("the tab is on its first document (history.length 1: a script may close it)", field(VIDEO, "hl") == "1")
        check("nothing is fullscreen before the touch", host.fullscreenTab == null && htmlFullscreenTabId() == null)
        installGoneTabSampler()
        // The chrome's clock against the driver's, for the page's close (stamped here, off the
        // server's hit) to be placed on the chrome's own timeline: performance.now() read over one
        // round trip and placed at its middle; half the round trip is the placing's slack.
        val t0 = SystemClock.uptimeMillis()
        val perf = jsonNumber(chromeJs("performance.now()"))
        val t1 = SystemClock.uptimeMillis()
        val chromeAtUptime = (t0 + t1) / 2.0 - perf
        val clockSlack = (t1 - t0) / 2
        val hitsBefore = server.hits("/closing")
        val point = pagePoint(VIDEO, "#fs-close")
        check("the page's button is on screen for a finger", point != null)
        if (point == null) return
        Finger().tap(point.x, point.y)
        val entered = poll(15_000) { host.fullscreenTab?.tabId == VIDEO }
        val enteredAt = SystemClock.uptimeMillis()
        if (!entered) touchFault("a touch on the page's 'Play fullscreen, then close this tab' did not take the video fullscreen")
        check("a finger on the page's button takes the video fullscreen (host fullscreenTab ${host.fullscreenTab?.tabId})", entered)
        // The still first, ahead of every round trip to the chrome (each takes the better part
        // of a second under the fullscreen's software decode on this image, run 35539766163),
        // since the page closes its tab CLOSE_AFTER_MS into the fullscreen. It is the fullscreen
        // surface as the emulator composes it: the image's software decoder gives a black frame
        // whatever the clip is doing (the page's title says what it is doing).
        SystemClock.sleep(1_000)
        still("fullscreen-gone-tab-01-fullscreen")
        check("the chrome's HTML fullscreen names the tab", poll(5_000) { htmlFullscreenTabId() == VIDEO })
        // The page's own word a moment in, read off its title through the core: nothing is asked
        // of the page itself (its `evaluateJavascript` answered late under the fullscreen).
        var word = title(VIDEO)
        poll(2_000) { word = title(VIDEO); word.contains("|fs:1|") }
        finding("  the page a moment into the fullscreen: \"$word\"")
        check("the page saw its fullscreen, its clip playing (fs:1, state:playing in its title)", word.contains("|fs:1|") && word.contains("|state:playing|"))
        // The page closes its tab CLOSE_AFTER_MS into the fullscreen: the moments on the driver's
        // clock. The loop reads nothing over the chrome – a round trip there waits behind the
        // exit's work and stamps everything at the same late tick (run 35539099244) – only the
        // server's hit and the host's layer, both in this process, every 10 ms; the core's word
        // comes from the chrome's own record afterwards.
        var beaconAt = -1L
        var layerGoneAt = -1L
        val deadline = enteredAt + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            val now = SystemClock.uptimeMillis()
            if (beaconAt < 0 && server.hits("/closing") > hitsBefore) beaconAt = now
            if (layerGoneAt < 0 && host.fullscreenTab == null) layerGoneAt = now
            if (beaconAt >= 0 && layerGoneAt >= 0) break
            SystemClock.sleep(10)
        }
        // The fade's 120 ms and whatever the exit still settles.
        SystemClock.sleep(3_000)
        still("fullscreen-gone-tab-02-chrome-back")
        val record = goneRecord()
        val cleared = record.optJSONArray("cleared") ?: JSONArray()
        val fades = (0 until (record.optJSONArray("fades")?.length() ?: 0)).mapNotNull { record.getJSONArray("fades").optJSONObject(it) }
        val landing = record.optJSONArray("landing") ?: JSONArray()
        val clearedAt = if (cleared.length() > 0) cleared.getJSONObject(0).optInt("at") else -1
        val fade = fades.firstOrNull(::isTheReturnFade)
        val fadeAt = fade?.optInt("at") ?: -1
        val tabGoneMs = record.optInt("tabGone", -1)
        val recordT0 = record.optDouble("t0", Double.NaN)
        fun onDriverClock(chromeMs: Int): Long = (chromeAtUptime + recordT0 + chromeMs).toLong()
        val refused = field(VIDEO, "refused")
        finding("  the page's close (its beacon at the server) at +${beaconAt - enteredAt} ms after the fullscreen; the host's layer gone at +${layerGoneAt - enteredAt} (driver clock, 10 ms polls); page title now \"${title(VIDEO)}\"")
        finding("  the chrome's record (ms since its sampler): fullscreen set ${record.optJSONArray("set")}; cleared $cleared; tab gone $tabGoneMs; animate() on the window: ${fades.joinToString(" ") { "${it.optInt("at")}ms:${it.optJSONArray("keyframes")}/${it.opt("options")}" }.ifEmpty { "none" }}")
        finding("  the landing store on the way (ms: settling, reports, placed): ${(0 until landing.length()).joinToString(" ") { val e = landing.getJSONObject(it); "${e.optInt("at")}: ${e.opt("settling")} ${e.optInt("reports")} ${e.optJSONArray("placed")}" }.ifEmpty { "nothing logged" }}")
        finding("  chrome opacity per frame around the return (the frames under 1 with their neighbours): ${frames(record)}")
        check("the page closed its own tab: the tab is gone from the core, the close not refused (refused=$refused)", tabGoneMs >= 0 && refused != "1" && tab(VIDEO) == null)
        check("the host's fullscreen layer went with the tab", layerGoneAt >= 0 && host.fullscreenTab == null)
        check("the window's HTML fullscreen ended with the tab (htmlFullscreenTabId null)", poll(5_000) { htmlFullscreenTabId() == null })
        check("the chrome's fullscreen state cleared on record (at $clearedAt ms)", clearedAt >= 0)
        check("the chrome's return started its 120 ms opacity fade on the window (animate() 0 to 1), once", fade != null && fades.count(::isTheReturnFade) == 1)
        val held = if (fade != null && clearedAt >= 0) fadeAt - clearedAt else -1
        check(
            "the fade started within 300 ms of the chrome's fullscreen state clearing, not at the 2.5 s landing timeout (fade at $fadeAt ms, cleared at $clearedAt ms: held $held ms)",
            fade != null && clearedAt >= 0 && held in 0..300
        )
        if (fade != null && beaconAt >= 0 && clearedAt >= 0) {
            finding(
                "  supplementary, on the driver's clock (the chrome's moments placed on it within ±$clockSlack ms): the page's close -> " +
                    "the host's layer gone +${layerGoneAt - beaconAt} ms -> the chrome's state cleared +${onDriverClock(clearedAt) - beaconAt} ms -> " +
                    "the fade +${onDriverClock(fadeAt) - beaconAt} ms (the thumbnail and the destroy sit between the close and the chrome's state)"
            )
        }
        check("the chrome is fully back (opacity 1)", chromeOpacity() == "1")
        check("the article tab has the screen", activeCoreTab()?.optString("id") == ARTICLE)
        beat()
    }

    /**
     * Installed in the chrome before the fullscreen: every `animate()` the chrome window starts
     * (the return fade's keyframes and timing), every change of the core's fullscreen tab (the
     * browser store), the moment the video tab leaves the state, the landing store's changes, and
     * the window's opacity per frame – all on one clock (`t0`, `performance.now()` at install).
     */
    private fun installGoneTabSampler() {
        chromeJs(
            "(function(){var g=window.__gone={t0:performance.now(),set:[],cleared:[],fades:[],landing:[],frames:[],tabGone:null};" +
                "var ms=function(){return Math.round(performance.now()-g.t0)};" +
                "if(!window.__goneHooked){window.__goneHooked=true;var orig=Element.prototype.animate;" +
                "Element.prototype.animate=function(k,o){if(window.__gone&&this.classList&&this.classList.contains('zen-window'))" +
                "window.__gone.fades.push({at:ms(),keyframes:k,options:o});return orig.apply(this,arguments)}}" +
                "var stores=window.__zenStores||{};var b=stores.browser;var tab=${JSONObject.quote(VIDEO)};" +
                "var last=b&&b.get().state?b.get().state.window.htmlFullscreenTabId:null;" +
                "if(b)b.subscribe(function(){var s=b.get().state;if(!s)return;var fs=s.window.htmlFullscreenTabId;" +
                "if(fs!==last){(fs?g.set:g.cleared).push({at:ms(),tab:fs||last});last=fs}" +
                "if(g.tabGone===null&&!s.tabs[tab])g.tabGone=ms()});" +
                "var l=stores['fullscreen-landing'];if(l)l.subscribe(function(){var s=l.get();" +
                "g.landing.push({at:ms(),settling:s.settling,reports:s.reports,placed:Array.from(s.placed.keys())})});" +
                "(function f(){var w=document.querySelector('.zen-window');g.frames.push(ms()+':'+(w?getComputedStyle(w).opacity:'none'));" +
                "if(g.frames.length<1500)requestAnimationFrame(f)})()})()"
        )
    }

    private fun goneRecord(): JSONObject {
        val raw = chromeJs("JSON.stringify(window.__gone||{})")
        return runCatching { JSONObject(jsonString(raw)) }.getOrDefault(JSONObject())
    }

    /** The chrome's return fade: opacity 0 to 1 over 120 ms (`useFullscreenReturn`; the options may be the bare duration). */
    private fun isTheReturnFade(call: JSONObject): Boolean {
        val duration = call.optJSONObject("options")?.optInt("duration") ?: call.optInt("options")
        val frames = call.optJSONArray("keyframes") ?: return false
        if (frames.length() < 2) return false
        val first = frames.optJSONObject(0)?.optDouble("opacity", -1.0) ?: -1.0
        val last = frames.optJSONObject(frames.length() - 1)?.optDouble("opacity", -1.0) ?: -1.0
        return duration == 120 && first == 0.0 && last == 1.0
    }

    /** The sampled frames where the chrome was not fully opaque, with a neighbour on each side. */
    private fun frames(record: JSONObject): String {
        val all = record.optJSONArray("frames") ?: return "none"
        val samples = (0 until all.length()).map { all.getString(it) }
        val kept = LinkedHashSet<Int>()
        samples.forEachIndexed { i, s ->
            val opacity = s.substringAfter(':').toDoubleOrNull()
            if (opacity != null && opacity < 1.0) {
                kept += maxOf(0, i - 1)
                kept += i
                kept += minOf(samples.size - 1, i + 1)
            }
        }
        val picked = kept.sorted().map { samples[it] }
        val missing = samples.count { it.endsWith(":none") }
        return "${samples.size} frames${if (missing > 0) " ($missing without the window)" else ""}; ${if (picked.isEmpty()) "every frame at 1" else picked.joinToString(" ")}"
    }

    private fun chromeOpacity(): String =
        jsonString(chromeJs("(function(){var w=document.querySelector('.zen-window');return w?getComputedStyle(w).opacity:'none'})()"))

    private fun htmlFullscreenTabId(): String? =
        jsonString(chromeJs("(function(){var s=window.__zenStores.browser.get().state;return s&&s.window.htmlFullscreenTabId||''})()")).ifEmpty { null }

    // --- the bar star in the chrome -----------------------------------------------------------------

    /** The bar's Bookmark button as the chrome's DOM has it: name, `aria-pressed`, the glyph's fill state, the bar's edge, the theme. */
    private fun starDom(): JSONObject? {
        val raw = chromeJs(
            "(function(){var b=document.querySelector('.zen-phone-bar [data-bar-item=\"bookmark\"]');if(!b)return null;" +
                "var g=b.querySelector('.zen-star-glyph');var f=b.querySelector('.zen-star-glyph-fill');var bar=b.closest('.zen-phone-bar');" +
                "return JSON.stringify({label:b.getAttribute('aria-label'),pressed:b.getAttribute('aria-pressed'),disabled:b.getAttribute('aria-disabled')," +
                "filled:g?g.getAttribute('data-filled'):null,fill:f?f.style.opacity:null,edge:bar?bar.getAttribute('data-edge'):null," +
                "theme:document.documentElement.dataset.theme||null})})()"
        )
        return runCatching { JSONObject(jsonString(raw)) }.getOrNull()
    }

    /**
     * The star's accessibility node: the one the WebView's tree names Bookmark or Edit Bookmark
     * (the menu is closed, so the bar's). The name is what TalkBack reads – the WebView carries a
     * button's `aria-label` as the node's text, not its content description (runs 35539099244 and
     * 35539766163: the harness's text-or-description match touched the star while a read of the
     * description alone found nothing), so [nameOf] takes either – and the node an `aria-pressed`
     * would make checkable. The tree does not flag it clickable on this image (the harness's own
     * [clickByLabel] walks up to a clickable ancestor for the same reason), so nothing asks that.
     */
    private fun starNode(): AccessibilityNodeInfo? =
        findNodeWhere { node ->
            val name = nameOf(node)
            name == LABEL_STAR || name == LABEL_EDIT
        }

    /** What TalkBack reads for the node: its text, else its content description. */
    private fun nameOf(node: AccessibilityNodeInfo): String? =
        node.text?.toString()?.takeIf { it.isNotEmpty() } ?: node.contentDescription?.toString()

    private fun describe(node: AccessibilityNodeInfo?): String =
        if (node == null) "MISSING"
        else "text '${node.text}' description '${node.contentDescription}' ${node.className} checkable=${node.isCheckable} checked=${node.isChecked} clickable=${node.isClickable} enabled=${node.isEnabled}"

    private fun editorUp(): Boolean = chromeJs("!!(window.__zenStores.ui.get().bookmarkEdit)") == "true"

    private fun fillSamples(): JSONArray {
        val raw = chromeJs("window.__starFillStop()")
        return runCatching { JSONArray(jsonString(raw)) }.getOrDefault(JSONArray())
    }

    /**
     * A real touch on the chrome element matching `selector`, where its box is on screen (the
     * chrome's DOM rect scaled into the view: the tree trails a toast that stands five seconds),
     * then up to `timeoutMs` for `took`; a touch that did nothing is a touch fault.
     */
    private fun touchChrome(selector: String, effect: String, timeoutMs: Long, took: () -> Boolean): Boolean {
        val point = chromePoint(selector) ?: run {
            finding("  nothing in the chrome matches '$selector' to touch")
            return false
        }
        Finger().tap(point.x, point.y)
        if (poll(timeoutMs, took)) {
            finding("  finger on '$selector' at ${point.x.toInt()},${point.y.toInt()}: $effect")
            return true
        }
        touchFault("a touch on the chrome's '$selector' did not take: not $effect within $timeoutMs ms")
        return false
    }

    /** Where a finger touches the chrome element matching `selector` (screen px, inside [touchable]), or null. */
    private fun chromePoint(selector: String): PointF? {
        val raw = chromeJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;var r=e.getBoundingClientRect();" +
                "if(!r.width||!r.height)return null;return JSON.stringify([r.left,r.top,r.right,r.bottom])})()"
        )
        val json = (JSONTokener(raw).nextValue() as? String)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return null
        var origin: IntArray? = null
        var scale = 0f
        instrumentation.runOnMainSync {
            val view = host.chrome
            origin = IntArray(2).also { view.getLocationOnScreen(it) }
            @Suppress("DEPRECATION")
            scale = view.scale
        }
        val at = origin ?: return null
        if (scale <= 0f) scale = density
        val rect = Rect(
            (at[0] + json.getDouble(0) * scale).toInt(),
            (at[1] + json.getDouble(1) * scale).toInt(),
            (at[0] + json.getDouble(2) * scale).toInt(),
            (at[1] + json.getDouble(3) * scale).toInt()
        )
        return touchPoint(rect)
    }

    // --- the core ----------------------------------------------------------------------------------------

    private fun tab(id: String): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(id)

    private fun bookmarked(id: String): Boolean = tab(id)?.optBoolean("bookmarked") == true

    private fun bookmarkCount(): Int = coreState().optJSONArray("bookmarks")?.length() ?: 0

    private fun title(id: String): String = tab(id)?.optString("title").orEmpty()

    /** The `key:value` field of the gone-tab page's title (`GT|fs:1|...`), or null. */
    private fun field(id: String, key: String): String? =
        title(id).split('|').firstOrNull { it.startsWith("$key:") }?.substringAfter(':')

    private fun activate(id: String) {
        if (activeCoreTab()?.optString("id") == id) return
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(id)}}")
        poll(8_000) { activeCoreTab()?.optString("id") == id }
        SystemClock.sleep(2_500)
    }

    private fun awaitLoaded(id: String, url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = tab(id)
            if (tab != null && tab.optString("url") == url && !tab.optBoolean("loading")) {
                SystemClock.sleep(800)
                return
            }
            SystemClock.sleep(400)
        }
        finding("  $id never finished loading $url: ${tab(id)}")
    }

    private fun readAloud(): JSONObject? = coreState().optJSONObject("readAloud")

    /** The first session sample meeting [condition] within [timeoutMs] (that very sample), or null. */
    private fun awaitSample(timeoutMs: Long, condition: (JSONObject) -> Boolean): JSONObject? {
        var hit: JSONObject? = null
        poll(timeoutMs) {
            hit = readAloud()?.takeIf(condition)
            hit != null
        }
        return hit
    }

    /** The host's log (`ReadAloud.kt`): one line per utterance the engine is handed. */
    private fun hostLog(): List<String> = shell("logcat -d -s $HOST_TAG:*").lines().filter { "speak " in it }

    // --- the selection toolbar (the read-aloud demo's shapes) ------------------------------------------

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

    private fun longPress(tabId: String, selector: String, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        val p = pagePoint(tabId, selector) ?: run {
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
        pagePoint(ARTICLE, "#tail")?.let { Finger().tap(it.x, it.y) }
        SystemClock.sleep(1_000)
    }

    // --- the pages ----------------------------------------------------------------------------------------

    /** Evaluate in a tab's page; the raw JSON-encoded result ("" when it never answered). */
    private fun pageJs(tabId: String, code: String): String {
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

    /** Where the middle of the first element matching `selector` is on screen (device px), or null. */
    private fun pagePoint(tabId: String, selector: String): PointF? {
        val raw = pageJs(
            tabId,
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return JSON.stringify([r.left+r.width/2,r.top+r.height/2])})()"
        )
        val json = (JSONTokener(raw).nextValue() as? String)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return null
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
        return PointF((at[0] + json.getDouble(0) * scale).toFloat(), (at[1] + json.getDouble(1) * scale).toFloat())
    }

    private fun readAssetBytes(name: String): ByteArray =
        instrumentation.context.assets.open(name).use { it.readBytes() }

    // --- the findings ---------------------------------------------------------------------------------------

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    private fun jsonNumber(raw: String): Double = runCatching { (JSONTokener(raw).nextValue() as? Number)?.toDouble() }.getOrNull() ?: Double.NaN

    /** `adb shell` from inside the instrumentation (UiAutomation's shell): the command's output. */
    private fun shell(command: String): String = runCatching {
        val fd = ui.executeShellCommand(command)
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }
    }.getOrElse { "shell failed: $it" }

    private fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(150)
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

    /** Stills named for the store's media: `android-bar-star-*`, `android-listen-on-*`, `android-fullscreen-gone-tab-*`. */
    private fun still(name: String) = shot(name)

    companion object {
        private const val PORT = 18151
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val ARTICLE = "tab_article"
        private const val VIDEO = "tab_video"
        /** A sentence in the middle of the article (its third paragraph's first), wrapped for the long press. */
        private const val SENTENCE = "The lamp itself was simple."
        /** How the paragraph goes on after it: the first sentence the walk reads past the selection. */
        private const val NEXT_SENTENCE_START = "A wick, a reservoir of oil"
        // The star reads by the page's state (v2 §9.13's words): "Bookmark" outlined, "Edit Bookmark" filled.
        private const val LABEL_STAR = "Bookmark"
        private const val LABEL_EDIT = "Edit Bookmark"
        private const val TOAST_SAVED = "Saved to Bookmarks"
        /** The phone's bookmark editor sheet's header (`BookmarkEditSheet`: sentence case). */
        private const val EDITOR_TITLE = "Edit bookmark"
        /** Our selection-toolbar item (`Menus.selectionActions`): the menu's verb, the lead's ruling on #240. */
        private const val TOOLBAR_ITEM = "Listen"
        /** The host's log tag (`ReadAloud.kt`): one line per utterance the engine is handed. */
        private const val HOST_TAG = "ZenReadAloud"

        /**
         * Installed in the chrome once: a frame-by-frame sampler of the bar star's fill layer
         * between `__starFillStart()` and `__starFillStop()` (which answers with the samples as
         * JSON text), each sample `[ms since start, fill opacity, fill transform]`.
         */
        private const val FILL_SAMPLER =
            "(function(){window.__starFill=[];window.__starFillOn=false;" +
                "window.__starFillStart=function(){window.__starFill=[];window.__starFillOn=true;var t0=performance.now();" +
                "var tick=function(){if(!window.__starFillOn)return;var s=document.querySelector('.zen-phone-bar [data-bar-item=\"bookmark\"] .zen-star-glyph-fill');" +
                "window.__starFill.push([Math.round(performance.now()-t0),s?parseFloat(s.style.opacity):null,s?s.style.transform:null]);requestAnimationFrame(tick)};requestAnimationFrame(tick)};" +
                "window.__starFillStop=function(){window.__starFillOn=false;return JSON.stringify(window.__starFill)}})()"
    }
}
