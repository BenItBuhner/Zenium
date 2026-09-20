package app.zen.chromium

import android.graphics.Rect
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records the in-app media controls on the phone (MW-16's UI, over the engine [MediaDemo]
 * records), Chrome Android's media controls being the bar for what they do:
 *
 *  1. a page playing a track -> the Now playing chip in the address pill; a finger on it opens
 *     the media sheet on the sheet chassis: the artwork, the title, the artist and the site, the
 *     seek row and the transport;
 *  2. every control in the sheet under a finger, each asserted on the page: Pause (the page
 *     pauses), Seek forward and Seek backward (ten seconds each way, the browser's default
 *     seeks), Next track and Previous track (the page's own Media Session handlers, the title in
 *     the sheet following), Play, a scrub along the position slider (the page seeks to where the
 *     finger let go), then back closes the sheet; the chip reads Media paused while the page's
 *     own button holds the track;
 *  3. a video: the sheet offers Picture in picture, and a finger on the row puts the window into
 *     the small window (the same `media.pictureInPicture` the engine demo calls by hand);
 *  4. the session from another tab: the chip stands on that tab's pill too, its sheet offers
 *     Switch to tab, and a finger on it brings the playing tab up;
 *  5. Settings > Privacy and Security > Notifications: the row the site-settings builder lists
 *     now that the host enforces the permission (#223, MW-05), its sheet's Default behaviour
 *     row, the picker's Block under a finger – and the page then reads `Notification.permission`
 *     as denied – and Ask put back.
 *
 * Every control pressed inside a sheet is a real injected touch with an assertion on what it did
 * (the rule in [DemoHarness], #198); the page reports through its title as the engine demo's
 * does ([MediaDemoBase]). The stills go out as `services-android-media-android-ui-*`.
 */
@RunWith(AndroidJUnit4::class)
class MediaUiDemo : MediaDemoBase("services-android-media-android-ui") {
    override val tag = "MediaUiDemo"

    @Test
    fun record() = recordWithServer()

    override fun demo() {
        chipStep()
        sheetControlsStep()
        videoStep()
        elsewhereStep()
        settingsStep()
        note("\ndone")
    }

    // --- 1. the chip and the sheet --------------------------------------------------------------

    private fun chipStep() {
        note("\n1. the Now playing chip and the media sheet (MW-16)")
        shot("01-audio-page")
        beat()
        if (findNode { it == CHIP_PLAYING || it == CHIP_PAUSED } != null) touchFault("a media chip stood in the pill before anything played")
        tapPageButton("play", "Play track", "the page reports the track playing", 15_000) { field("state") == "playing" }
        val chip = awaitNode(10_000) { it == CHIP_PLAYING }
        note("  chip: ${if (chip != null) "'$CHIP_PLAYING' at ${bounds(chip)}" else "none in the tree"}; core media state: ${mediaState(TAB)}")
        if (chip == null) {
            touchFault("no Now playing chip came up in the pill for the playing track")
            dumpWindows("pill without the chip")
        }
        SystemClock.sleep(1_000)
        shot("02-chip-playing")
        beat()
        openSheet()
        val title = awaitNode(6_000) { it == "Zenium demo track" }
        val artist = findNode { it.startsWith("The Zenium demo band") }
        note("  sheet: title ${if (title != null) "shown" else "MISSING"}; detail \"${artist?.let(::label) ?: "MISSING"}\"; position slider ${if (chromeRect(SLIDER) != null) "present" else "MISSING"}")
        if (title == null) touchFault("the media sheet did not show the track's title")
        SystemClock.sleep(1_000)
        shot("03-sheet-playing")
        beat()
    }

    // --- 2. the sheet's controls ----------------------------------------------------------------

    private fun sheetControlsStep() {
        note("\n2. the sheet's controls under a finger (MW-16)")
        touchTapLabelExpecting("Pause", "the page pauses", timeoutMs = 8_000) { field("state") == "paused" }
        SystemClock.sleep(1_500)
        note("  paused: ${title()}; the toggle now reads '${if (findNode { it == "Play" } != null) "Play" else "?"}'")
        shot("04-sheet-paused")
        beat()

        val t0 = field("t")?.toIntOrNull() ?: 0
        touchTapLabelExpecting("Seek forward", "the position moves on by ten seconds", timeoutMs = 8_000) {
            (field("t")?.toIntOrNull() ?: 0) >= t0 + 8
        }
        val t1 = field("t")?.toIntOrNull() ?: 0
        note("  Seek forward: t $t0 -> $t1")
        touchTapLabelExpecting("Seek backward", "the position moves back by ten seconds", timeoutMs = 8_000) {
            (field("t")?.toIntOrNull() ?: 0) <= t1 - 8
        }
        note("  Seek backward: t $t1 -> ${field("t")}")

        touchTapLabelExpecting("Next track", "the page's nexttrack handler runs", timeoutMs = 8_000) { field("last") == "nexttrack" }
        val second = awaitNode(6_000) { it == "Zenium demo track 2" }
        note("  Next track: last=${field("last")} track=${field("track")}; the sheet's title ${if (second != null) "reads 'Zenium demo track 2'" else "did not follow"}; session title \"${sessionTitle()}\"")
        if (second == null) touchFault("the sheet's title did not follow the page's new Media Session metadata")
        SystemClock.sleep(1_000)
        shot("05-sheet-next-track")
        beat()
        touchTapLabelExpecting("Previous track", "the page's previoustrack handler runs", timeoutMs = 8_000) { field("last") == "previoustrack" }
        note("  Previous track: last=${field("last")} track=${field("track")}")

        touchTapLabelExpecting("Play", "the page plays again", timeoutMs = 8_000) { field("state") == "playing" }
        SystemClock.sleep(1_500)
        note("  playing again: ${title()}")

        scrub()
        SystemClock.sleep(1_000)
        shot("06-sheet-scrubbed")
        beat()

        // Back takes the sheet down; the chip stays for the session.
        back()
        val down = awaitSurface(false, 8_000)
        note("  back: sheet gone=$down; chip '${findNode { it == CHIP_PLAYING || it == CHIP_PAUSED }?.let(::label) ?: "none"}'")
        if (!down) touchFault("back did not close the media sheet")
        SystemClock.sleep(1_000)

        // The page's own button holds the track: the chip reads Media paused.
        tapPageButton("play", "Pause track", "the page pauses", 10_000) { field("state") == "paused" }
        val paused = awaitNode(8_000) { it == CHIP_PAUSED }
        note("  chip while paused: ${if (paused != null) "'$CHIP_PAUSED'" else "not '$CHIP_PAUSED' (tree: '${findNode { it == CHIP_PLAYING }?.let(::label) ?: "none"}')"}")
        if (paused == null) touchFault("the chip did not read Media paused for the paused track")
        SystemClock.sleep(1_000)
        shot("07-chip-paused")
        beat()
        tapPageButton("play", "Play track", "the page plays", 10_000) { field("state") == "playing" }
        SystemClock.sleep(1_000)
    }

    /**
     * A finger along the position slider: down on its thumb, dragged to the middle of the track,
     * up. The sheet's Radix slider follows the pointer and commits where it let go
     * (`media.action seekto`), so the page's position lands at half the duration. The thumb and
     * the track are placed from the chrome's own document (the first run found no range node
     * for the slider in the WebView's accessibility tree; what the tree has goes to the notes),
     * the finger is as real as every other.
     */
    private fun scrub() {
        val thumb = chromeRect("$SLIDER [role=\"slider\"]")
        val track = chromeRect(SLIDER)
        val rangeNode = findNodeWhere { it.rangeInfo != null }
        note("  slider: thumb $thumb on track $track; the tree's range node: ${rangeNode?.className ?: "none"}${rangeNode?.rangeInfo?.let { " at ${it.current} of ${it.max}" } ?: ""}")
        if (thumb == null || track == null || track.width() <= 0) {
            touchFault("the media sheet's position slider was not in the chrome's document")
            return
        }
        val duration = mediaState(TAB)?.optJSONObject("position")?.optDouble("duration") ?: 0.0
        val before = field("t")?.toIntOrNull() ?: 0
        val x0 = thumb.exactCenterX()
        val y0 = thumb.exactCenterY()
        val target = track.left + track.width() * 0.5f
        Finger().apply {
            down(x0, y0)
            moveBy(target - x0, 0f, 450)
            up()
        }
        val expected = (duration * 0.5).toInt()
        val took = poll(8_000) { (field("t")?.toIntOrNull() ?: 0).let { it in (expected - 6)..(expected + 10) } }
        note("  scrub from ${x0.toInt()},${y0.toInt()} to ${target.toInt()},${y0.toInt()} (half the track, $expected s of $duration): t $before -> ${field("t")} (took: $took)")
        if (!took) touchFault("a scrub to the middle of the position slider did not seek the page there (t $before -> ${field("t")}, expected about $expected)")
    }

    /** Where the first chrome element matching `selector` is on screen (device px), or null. */
    private fun chromeRect(selector: String): Rect? {
        val raw = chromeJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height})})()"
        )
        val json = (JSONTokener(raw).nextValue() as? String)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also(host.chrome::getLocationOnScreen) }
        return Rect(
            (origin[0] + json.getDouble("x") * density).toInt(),
            (origin[1] + json.getDouble("y") * density).toInt(),
            (origin[0] + (json.getDouble("x") + json.getDouble("w")) * density).toInt(),
            (origin[1] + (json.getDouble("y") + json.getDouble("h")) * density).toInt()
        )
    }

    // --- 3. the video's Picture in picture row --------------------------------------------------

    private fun videoStep() {
        note("\n3. video: the sheet's Picture in picture row (MW-08 through MW-16)")
        frontApp()
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/video"}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:video") }
        SystemClock.sleep(1_500)
        tapPageButton("play", "Play video", "the page reports the video playing", 15_000) { field("state") == "playing" }
        SystemClock.sleep(1_500)
        note("  playing: ${title()}; core media state: ${mediaState(TAB)}")
        openSheet()
        val row = awaitNode(6_000) { it.startsWith("Picture in picture") }
        note("  sheet: Picture in picture row ${if (row != null) "at ${bounds(row)}" else "MISSING (capabilities.pictureInPicture=${coreState().getJSONObject("capabilities").optBoolean("pictureInPicture")})"}")
        if (row == null) touchFault("the media sheet offered no Picture in picture row for the playing video")
        SystemClock.sleep(1_000)
        shot("08-sheet-video")
        beat()
        if (row != null) {
            touchTapLabelExpecting("Picture in picture", "the window enters picture-in-picture", timeoutMs = 12_000, prefix = true) { inPip() }
            SystemClock.sleep(3_000)
            val win = appWindowBounds()
            note("  in picture-in-picture: window $win (${ratio(win)}; the clip is ${field("size")}); state=${field("state")}; sheet gone=${!chromeSurfaceUp()}")
            shot("09-pip-from-sheet")
            beat()
            bringToFront()
            note("  expanded back into the app: left pip=${awaitPip(false, 8_000)}")
        }
        frontApp()
        ensureForeground()
        SystemClock.sleep(1_500)
        shot("10-video-back-in-app")
        beat()
        // The clip loops on; the audio track takes the session back for the next steps.
        tapPageButton("play", "Pause video", "the video pauses", 10_000) { field("state") == "paused" }
    }

    // --- 4. the session from another tab --------------------------------------------------------

    private fun elsewhereStep() {
        note("\n4. the session from another tab: the chip on its pill, Switch to tab (MW-16)")
        frontApp()
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/audio"}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:audio") }
        SystemClock.sleep(1_000)
        tapPageButton("play", "Play track", "the page plays", 15_000) { field("state") == "playing" }
        val other = coreInvoke("tab.create", """{"url":"${server.origin}/notify","active":true}""").trim('"')
        val onOther = poll(10_000) { activeCoreTab()?.optString("id") == other }
        waitTitle(other, 15_000) { it.startsWith("NT|") }
        note("  another tab up: $other active=$onOther; the track goes on in $TAB: state=${field("state")} t=${field("t")}")
        val chip = awaitNode(10_000) { it == CHIP_PLAYING }
        note("  chip on the other tab's pill: ${if (chip != null) "'$CHIP_PLAYING' at ${bounds(chip)}" else "MISSING"}")
        if (chip == null) touchFault("the Now playing chip did not stand on another tab's pill")
        SystemClock.sleep(1_000)
        shot("11-chip-other-tab")
        beat()
        openSheet()
        val row = awaitNode(6_000) { it.startsWith("Switch to tab") }
        note("  sheet from the other tab: Switch to tab row ${if (row != null) "at ${bounds(row)}" else "MISSING"}; title ${if (findNode { it.startsWith("Zenium demo track") } != null) "shown" else "MISSING"}")
        if (row == null) touchFault("the media sheet offered no Switch to tab row from another tab")
        SystemClock.sleep(1_000)
        shot("12-sheet-switch-to-tab")
        beat()
        if (row != null) {
            touchTapLabelExpecting("Switch to tab", "the playing tab comes up", timeoutMs = 10_000, prefix = true) {
                activeCoreTab()?.optString("id") == TAB && !chromeSurfaceUp()
            }
            SystemClock.sleep(1_500)
            note("  after Switch to tab: active=${activeCoreTab()?.optString("id")} sheet gone=${!chromeSurfaceUp()}")
        }
        shot("13-back-on-playing-tab")
        beat()
        coreInvoke("tab.close", """{"tabId":"$other","force":true}""")
        SystemClock.sleep(1_500)
    }

    // --- 5. Settings: the Notifications site setting --------------------------------------------

    private fun settingsStep() {
        note("\n5. Settings > Privacy and Security > Notifications (MW-05's row, the site-settings builder)")
        frontApp()
        tapPageButton("play", "Pause track", "the page pauses for the Settings part", 10_000) { field("state") == "paused" }
        val settingsTab = coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
        note("  page.open settings/privacy -> $settingsTab")
        if (waitFor("Safety check", 20_000) == null) {
            note("  the Privacy and Security category never showed")
            touchFault("Settings > Privacy and Security did not open")
            return
        }
        SystemClock.sleep(2_000)
        val row = awaitRow("Notifications", 10_000, show = true)
        note("  Notifications row: ${if (row != null) "\"${rowText("Notifications")}\" at $row" else "MISSING from the section"}")
        if (row == null) {
            touchFault("Settings > Privacy and Security lists no Notifications row on Android")
            dumpWindows("privacy section")
            return
        }
        SystemClock.sleep(1_000)
        shot("14-settings-notifications-row")
        beat()
        if (!touchRowExpecting("Notifications", "the Notifications sheet shows its Default behaviour row", 10_000) { rowNode("Default behaviour") != null }) return
        SystemClock.sleep(1_500)
        note("  Notifications sheet: ${rowText("Default behaviour")}")
        shot("15-settings-notifications-sheet")
        beat()
        if (touchRowExpecting("Default behaviour", "the picker shows the Block option", 8_000) { findByLabel("Block") != null }) {
            SystemClock.sleep(1_500)
            shot("16-settings-notifications-picker")
            beat()
            touchTapLabelExpecting("Block", "the core's default for notifications reads deny", timeoutMs = 8_000) { defaultFor("notifications") == "deny" }
            note("  after Block: default=${defaultFor("notifications")}; row \"${rowText("Default behaviour")}\"")
            SystemClock.sleep(1_500)
            shot("17-settings-notifications-blocked")
            beat()
        }
        // The sheets go the way they came (back, one at a time) before the tab changes: a sheet
        // left standing across a tab switch is not what a user does with one.
        leaveNotificationsSheets()
        coreInvoke("tab.close", """{"tabId":$settingsTab,"force":true}""")
        SystemClock.sleep(1_000)

        // The page's word: a fresh notify page reads `Notification.permission` as denied.
        permissionReads("denied", "Block", "18-notify-page-denied")

        // Ask put back through the same rows: Settings again, the Notifications row, its sheet's
        // Default behaviour, the picker's Ask under a finger; then the page reads default again.
        val again = coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
        if (waitFor("Safety check", 20_000) != null &&
            touchRowExpecting("Notifications", "the Notifications sheet is up again", 10_000) { rowNode("Default behaviour") != null }
        ) {
            SystemClock.sleep(1_500)
            // The Ask option carries its "Default" description, so its node reads "Ask Default"
            // to the tree (Block, with none, reads Block alone): the row shapes find and touch it.
            if (touchRowExpecting("Default behaviour", "the picker shows the Ask option", 8_000) { rowNode("Ask") != null }) {
                touchRowExpecting("Ask", "the core's default for notifications reads ask again", 8_000) { defaultFor("notifications") == "ask" }
                note("  after Ask: default=${defaultFor("notifications")}; row \"${rowText("Default behaviour")}\"")
            }
            SystemClock.sleep(1_000)
            shot("19-settings-notifications-ask-again")
            beat()
            leaveNotificationsSheets()
        }
        if (defaultFor("notifications") != "ask") {
            coreInvoke("permissions.setDefault", """{"permission":"notifications","decision":"ask"}""")
            note("  Ask put back through the core (default=${defaultFor("notifications")})")
        }
        coreInvoke("tab.close", """{"tabId":$again,"force":true}""")
        SystemClock.sleep(1_000)
        permissionReads("default", "Ask", "20-notify-page-default-again")
    }

    /**
     * A fresh notify page on the demo tab reads `Notification.permission` as `expected` under
     * the default `under`. The polyfill's status comes from the browser a moment after the
     * script installs (the page's title, written at once, still says default), so the live value
     * is read, and written into the page's state for the still.
     */
    private fun permissionReads(expected: String, under: String, still: String) {
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/notify?under=${under.lowercase()}"}""")
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        waitTitle(TAB, 15_000) { it.startsWith("NT|") }
        val read = poll(8_000) { pageJs("Notification.permission") == "\"$expected\"" }
        note("  the page under $under: Notification.permission reads ${pageJs("Notification.permission")} (title at load: ${title()})")
        if (!read) touchFault("the page did not read Notification.permission as $expected under the $under default (reads ${pageJs("Notification.permission")})")
        pageJs(
            "document.title = document.title.replace(/permission:[a-z]+/, 'permission:' + Notification.permission);" +
                "document.getElementById('state').textContent = document.title.split('|').join('\\n')"
        )
        SystemClock.sleep(1_000)
        shot(still)
        beat()
    }

    /** Back out of the picker (when up) and the Notifications sheet, waiting for each to be gone. */
    private fun leaveNotificationsSheets() {
        if (findByLabel("Block") != null && rowNode("Ask") != null) {
            backUntil("the picker is gone and the Default behaviour row is back") {
                findByLabel("Block") == null && rowNode("Default behaviour")?.isClickable == true
            }
        }
        if (rowNode("Default behaviour") != null) {
            backUntil("the Notifications sheet is gone and the catalogue's row is back") {
                rowNode("Default behaviour") == null && rowNode("Notifications")?.isClickable == true
            }
        }
    }

    /**
     * One system back on a sheet, then up to `timeoutMs` for `took` – what the tree shows once
     * the sheet has gone – to hold; a second back sent on a sleep would land on a sheet still
     * leaving (the emulator's software renderer paints a dismissal seconds late).
     */
    private fun backUntil(effect: String, timeoutMs: Long = 12_000, took: () -> Boolean): Boolean {
        back()
        if (poll(timeoutMs, took)) {
            SystemClock.sleep(600)
            return true
        }
        note("  after back: not $effect within $timeoutMs ms")
        return false
    }

    /** The core's default for a site setting (`UIState.permissionDefaults`), "" when none is set. */
    private fun defaultFor(permission: String): String =
        coreState().optJSONObject("permissionDefaults")?.optString(permission).orEmpty()

    // --- the sheet ------------------------------------------------------------------------------

    /**
     * A finger on the pill's media chip, then the media sheet up: the host's word (`back.update`
     * names the surface, `chromeSurfaceUp`), since the sheet's header and the chip under its
     * scrim both read Now playing to the tree.
     */
    private fun openSheet() {
        val label = if (field("state") == "playing") CHIP_PLAYING else CHIP_PAUSED
        if (!touchTapLabelExpecting(label, "the media sheet comes up", timeoutMs = 10_000) { chromeSurfaceUp() }) {
            note("  the media sheet did not come up under a finger on '$label'")
            return
        }
        SystemClock.sleep(1_500)
    }

    // --- Settings rows (the site-controls demo's shapes) ----------------------------------------

    /**
     * The row (or control) reading `label`: a Settings row is one button whose text runs its
     * label and description together, a group heading of the same words is a plain node before
     * it, so the clickable node reading the label alone or the label and a space wins.
     */
    private fun rowNode(label: String): AccessibilityNodeInfo? {
        val reads = { node: AccessibilityNodeInfo ->
            val text = (node.text ?: node.contentDescription)?.toString()
            text != null && (text == label || text.startsWith("$label "))
        }
        return findNodeWhere { node -> node.isClickable && reads(node) } ?: findNodeWhere(reads)
    }

    private fun rowText(label: String): String =
        rowNode(label)?.let { (it.text ?: it.contentDescription)?.toString() }.orEmpty()

    private fun awaitRow(label: String, timeoutMs: Long, show: Boolean = false): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val node = rowNode(label)
            if (node != null) {
                if (show) {
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                    SystemClock.sleep(1_500)
                }
                return (rowNode(label) ?: node).let { n -> Rect().also { n.getBoundsInScreen(it) } }
            }
            SystemClock.sleep(200)
        }
        return null
    }

    /** A real touch on the row reading `label` (scrolled onto the screen first), then `took` within `timeoutMs`. */
    private fun touchRowExpecting(label: String, effect: String, timeoutMs: Long, took: () -> Boolean): Boolean {
        awaitRow(label, 8_000, show = true) ?: run {
            note("  no row reads '$label'")
            return false
        }
        val node = rowNode(label) ?: return false
        if (!touchTap(node)) {
            note("  the row '$label' is not inside the touchable window")
            return false
        }
        if (poll(timeoutMs, took)) {
            note("  touch on '$label': $effect")
            return true
        }
        touchFault("a touch on '$label' did not take: not $effect within $timeoutMs ms")
        note("  TOUCH FAULT: '$label' did not $effect")
        return false
    }

    companion object {
        private const val CHIP_PLAYING = "Now playing"
        private const val CHIP_PAUSED = "Media paused"
        /** The sheet's position slider in the chrome's document (`SeekRow`, `data-testid`). */
        private const val SLIDER = "[data-testid=\"media-position\"]"
    }
}
