package app.zen.chromium

import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Drives the EEA's search-engine choice screen on the phone (OMN-26; `PhoneOnboarding.tsx`,
 * `PhoneSearchChoice.tsx` on #514's shared model) from a cleared profile with the device placed
 * in Germany through the tester's override (`debug.zenium.region DE`, `DeviceRegion.kt`), so the
 * `android-search-choice-demo` workflow can record it and say PASS or FAIL per claim:
 *
 *  1. the first run's search step IS the choice screen – the heading, eight radio tiles, nothing
 *     picked, "Set as default" off, no Continue – and "Skip for now" writes no record;
 *  2. the next launch raises the screen on its own over the shell (Chrome's rule: it returns
 *     until answered), the system back is consumed and the screen stays;
 *  3. a REAL injected touch picks a tile that is not the shipped default, Set as default takes
 *     the screen down, the default engine and the device's record (`settings.searchChoice`)
 *     name the pick, live (`app.getState`) and on disk (`zen/state.json`);
 *  4. the launch after that shows no screen and keeps the pick;
 *  5. `searchChoice.askAgain` (what Settings › Search's "Choose your search engine again" runs)
 *     raises it again, and Skip for now leaves the record standing.
 *
 * Every claim is a PASS or FAIL line of `search-choice-findings.txt` beside the stills
 * (`android-w6-13-search-choice-*.png`); a FAIL fails the run once the stills are taken. The
 * override is put back to "no region" when the sequence ends, whatever happened, so a driver
 * after this one on the same boot meets the device as it was.
 *
 * Handshake with the workflow through files under `files/search-choice-demo/`, as in GestureDemo.
 */
@RunWith(AndroidJUnit4::class)
class SearchChoiceDemo : DemoHarness(stateAsset = null, shotPrefix = "android-w6-13-search-choice", handshakeDir = "search-choice-demo") {
    override val tag = "SearchChoiceDemo"

    private lateinit var findings: File
    private var failures = 0

    @Test
    fun record() {
        runDemo()
    }

    /** The device is placed in Germany before the first boot reads its region. */
    override fun beforeLaunch() {
        shellCommand("setprop ${DeviceRegion.OVERRIDE_PROPERTY} $REGION")
        val set = shellCommand("getprop ${DeviceRegion.OVERRIDE_PROPERTY}").trim()
        Log.i(tag, "${DeviceRegion.OVERRIDE_PROPERTY} = '$set'")
    }

    /** Nothing to warm up: the welcome step is the first frame. Just make sure it is there. */
    override fun warmUp() {
        findings = File(out, "search-choice-findings.txt")
        findings.writeText(
            "Zenium Android: the EEA search-engine choice screen on the phone (OMN-26) – API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, region override $REGION\n\n"
        )
        val welcome = waitFor("Get started", 20_000) != null
        if (!welcome) Log.w(tag, "the welcome step never showed")
        claim(welcome, "first run: the welcome step from the cleared profile")
    }

    override fun demo() {
        try {
            sequence()
        } finally {
            shellCommand("setprop ${DeviceRegion.OVERRIDE_PROPERTY} ${DeviceRegion.OVERRIDE_NONE}")
            finding("\n${DeviceRegion.OVERRIDE_PROPERTY} put back to '${DeviceRegion.OVERRIDE_NONE}' (no region)")
        }
        assertEquals("claims that did not hold (see search-choice-findings.txt)", 0, failures)
    }

    private fun sequence() {
        val f = Finger()

        // 1. The tour: welcome, the look, then the search step – the choice screen in the EEA.
        SystemClock.sleep(1_200)
        shot("01-welcome")
        tapLabel(f, "Get started")
        step()
        tapLabel(f, "Continue")
        step()
        val heading = waitFor(TITLE, 8_000) != null
        SystemClock.sleep(800)
        shot("02-tour-choice-step")
        val tiles = tileNodes()
        val names = tiles.map { label(it) }
        claim(heading, "tour: the search step is the choice screen (heading '$TITLE')")
        claim(tiles.size == 8, "tour: eight tiles of the region's list (${tiles.size}: ${names.joinToString()})")
        claim(tiles.none { it.isChecked }, "tour: nothing picked at open")
        claim(findNode(SET)?.isEnabled == false, "tour: Set as default off until a pick")
        claim(findByLabel("Continue") == null, "tour: no Continue on the choice step")
        claim(findByLabel(SKIP) != null, "tour: Skip for now offered")

        // 2. Skip for now, with a real touch: the tour goes on (through the Default step when the
        //    host has a browser role to give) and no record is written.
        val skipped = touchTapLabel(SKIP)
        step()
        if (findByLabel(TITLE) == null && findByLabel("Skip") != null) {
            shot("03-default-step")
            tapLabel(f, "Skip")
        }
        SystemClock.sleep(4_000)
        shot("04-first-session")
        val first = settings()
        val shippedId = first.optString("searchEngineId")
        val shippedName = engineName(shippedId) ?: shippedId
        claim(skipped && findByLabel(TITLE) == null, "tour: Skip for now (a real touch) leaves the step; the screen is down for this session")
        claim(first.isNull("searchChoice"), "skip wrote no record: settings.searchChoice absent, the default still '$shippedId'")

        // 3. The next launch: the screen returns on its own over the shell, back keeps it, a real
        //    touch picks a tile that is not the shipped default, Set as default answers the core.
        launch()
        val returned = waitFor(TITLE, 15_000) != null
        SystemClock.sleep(1_000)
        shot("05-standalone-returns")
        claim(returned, "next launch: the screen returns on its own over the shell (Chrome's rule after a skip)")
        back()
        SystemClock.sleep(1_500)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        claim(findByLabel(TITLE) != null && front == app.packageName, "back on the standalone screen is consumed: the screen stays, the app in front (front: $front)")
        shot("06-standalone-after-back")
        ensureForeground()
        val pick = tileNodes().firstOrNull { label(it) != shippedName && reachable(it) }
        val pickedName = pick?.let { label(it) } ?: "?"
        val touched = pick != null && touchTap(pick)
        SystemClock.sleep(1_000)
        val checked = tileNodes().filter { it.isChecked }.map { label(it) }
        claim(touched && checked == listOf(pickedName), "a real touch picks '$pickedName' (not the shipped '$shippedName'); checked: $checked")
        claim(findNode(SET)?.isEnabled == true, "Set as default live after the pick")
        shot("07-standalone-picked")
        val set = touchTapLabel(SET)
        val gone = waitForGone(TITLE, 10_000)
        SystemClock.sleep(1_500)
        shot("08-after-set")
        claim(set && gone, "Set as default (a real touch) takes the screen down")
        val after = settings()
        val pickedId = engineIdOf(pickedName)
        claim(
            pickedId != null && after.optString("searchEngineId") == pickedId,
            "the default engine is the pick: settings.searchEngineId = '${after.optString("searchEngineId")}' ('$pickedName' is '$pickedId')"
        )
        val record = after.optJSONObject("searchChoice")
        claim(
            record != null && record.optString("engineId") == pickedId && record.optString("region") == REGION && record.optInt("version") == 2,
            "the device's record: settings.searchChoice = $record"
        )
        SystemClock.sleep(2_500)
        val disk = File(app.filesDir, "zen/state.json").takeIf { it.exists() }?.readText().orEmpty()
        val diskRecord = runCatching { JSONObject(disk).getJSONObject("settings").optJSONObject("searchChoice") }.getOrNull()
        claim(diskRecord?.optString("engineId") == pickedId, "zen/state.json on disk carries the record: $diskRecord")

        // 4. Answered: the launch after shows no screen and keeps the pick.
        launch()
        val again = waitFor(TITLE, 6_000) != null
        SystemClock.sleep(1_000)
        shot("09-next-launch")
        claim(!again, "the screen does not return once answered")
        claim(pillNode() != null || findByLabel(NTP_PILL_LABEL) != null, "the browser's own chrome is up (the address pill)")
        claim(settings().optString("searchEngineId") == pickedId, "the pick holds across the launch")

        // 5. Asked again (Settings › Search's row runs this command): the screen returns; Skip for
        //    now leaves the record as it was.
        coreInvoke("searchChoice.askAgain")
        val asked = waitFor(TITLE, 8_000) != null
        SystemClock.sleep(1_000)
        shot("10-ask-again")
        claim(asked, "searchChoice.askAgain (Settings › Search › Choose your search engine again) raises the screen")
        claim(tileNodes().none { it.isChecked }, "asked again: nothing picked at open")
        val skipAgain = touchTapLabel(SKIP)
        claim(skipAgain && waitForGone(TITLE, 8_000), "Skip for now takes the asked-again screen down")
        SystemClock.sleep(1_000)
        val last = settings()
        claim(
            last.optString("searchEngineId") == pickedId && last.optJSONObject("searchChoice")?.optString("engineId") == pickedId,
            "the record and the default stand after the skipped ask"
        )
        shot("11-end")
    }

    /** A step's content slides in on SPRING_GENTLE; let it settle before the next touch. */
    private fun step() = SystemClock.sleep(1_500)

    /** The core's settings, live (`app.getState`). */
    private fun settings(): JSONObject = coreState().getJSONObject("settings")

    /** The tiles: the radio buttons on screen (the list's rows are `role="radio"`, named for their engine). */
    private fun tileNodes(): List<AccessibilityNodeInfo> =
        findNodes { it.isNotEmpty() }.filter { it.isCheckable && it.className?.toString()?.endsWith("RadioButton") == true }

    private fun label(node: AccessibilityNodeInfo): String =
        (node.contentDescription ?: node.text)?.toString().orEmpty()

    /** Whether a finger reaches the node: its bounds inside the touchable band. */
    private fun reachable(node: AccessibilityNodeInfo): Boolean {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        return !bounds.isEmpty && Rect(bounds).intersect(touchable) && bounds.height() > 0
    }

    private fun engines(): List<JSONObject> {
        val list = coreState().optJSONArray("searchEngines") ?: return emptyList()
        return (0 until list.length()).mapNotNull { list.optJSONObject(it) }
    }

    private fun engineName(id: String): String? = engines().firstOrNull { it.optString("id") == id }?.optString("name")

    private fun engineIdOf(name: String): String? = engines().firstOrNull { it.optString("name") == name }?.optString("id")

    private fun claim(ok: Boolean, what: String) {
        if (!ok) failures++
        finding("  ${if (ok) "PASS" else "FAIL"}  $what")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val REGION = "DE"
        /** The screen's heading (`SEARCH_CHOICE_TITLE`, components/overlays/SearchChoice.tsx). */
        private const val TITLE = "Choose your search engine"
        private const val SET = "Set as default"
        private const val SKIP = "Skip for now"
    }
}
