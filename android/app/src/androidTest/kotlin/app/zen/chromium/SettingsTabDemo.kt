package app.zen.chromium

import android.content.ClipboardManager
import android.content.Context
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.content.Intent
import android.util.Base64
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
 * Records Settings as a tab of the phone chrome (PR #134, v2 §10.1 to §10.5) for the
 * `android-settings-tab-demo` workflow, and writes what it measured to
 * `android-settings-tab-findings.txt` next to the frames (one `PASS` or `FAIL` per check; the
 * test itself only fails when the driver could not run):
 *
 *  1. Settings from the app menu opens a tab of its own next to the tab that asked, with its
 *     card in the tab overview;
 *  2. Look and Feel drills in over the landing; Colour scheme through the picker sheet flips the
 *     theme live;
 *  3. the predictive back gesture slides the drill-in out with the finger;
 *  4. away and back, the menu's Settings reuses the one tab (§10.1: one per window);
 *  5. back at the landing returns to the tab that opened it and closes the page tab
 *     (`rootBackAction`'s opener rule);
 *  6. `am start -a android.intent.action.VIEW -d zenium://settings/privacy`, as adb or another
 *     app sends it, opens the section with the landing beneath it;
 *  7. a web page's own link to `zenium://settings/privacy` is refused (only the user opens the
 *     browser's pages, never a document);
 *  8. Find in Settings "site" lists rows across categories;
 *  9. a container's editor sheet and its delete confirmation stack, the lower sheet receding;
 * 10. the pill edits `zenium://settings/look`, the user-facing alias of the page's address;
 * 11. About: a hold on the version block copies the version report (SET-54), the Open by
 *     default row reads the host's link-handling state and leaves for the system's screen
 *     (DEF-06), What's new opens as a page tab of its own and a back returns to About;
 * 12. Legal: Privacy notice and Terms open as page tabs, each back returning to About (SET-55);
 * 13. Security's Notification settings row leaves for the system's screen for this app (SET-26);
 * 14. the link menu on the demo page: its header with the link's text over its address, a tap
 *     expanding the address, a hold copying it (PUI-18); the `tel:` link's Call, Send Message
 *     and Add to Contacts, the `mailto:` link's Send Email (PUI-22).
 *
 * The pages come from a loopback server inside this process ([DemoServer]); the profile
 * (`settings-tab-demo-state.json`) holds the demo page (active) and a second tab. Gesture
 * navigation is switched on before the app starts, since the back gesture is part of what is
 * recorded. Settings rows are whole buttons whose accessible text runs label and value together
 * ("Colour scheme Light"), so rows are found by the label as a prefix. See [DemoHarness] for the
 * plumbing.
 */
@RunWith(AndroidJUnit4::class)
class SettingsTabDemo : DemoHarness("settings-tab-demo-state.json", "android-settings-tab", "settings-tab-demo") {
    override val tag = "SettingsTabDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to DemoServer.page(
                    DEMO_TITLE,
                    "<p>A page of the demo's own. Its link below names one of the browser's pages, " +
                        "which a web page may not open.</p>" +
                        "<p id=\"link\"><a href=\"zenium://settings/privacy\" " +
                        "onclick=\"document.getElementById('note').textContent='Link tapped: zenium://settings/privacy'\">" +
                        "Open Privacy and Security in Settings</a></p>" +
                        "<p id=\"note\" style=\"color:#7a2e2e\"></p>" +
                        // Three links for the link menu's header and its tel: / mailto: items (step 16):
                        // a page of this site, a number and an address, each with text of its own so
                        // the header shows the text over what the link holds.
                        "<p id=\"links\" style=\"line-height:2.6\">Also here: <a id=\"site\" href=\"$ORIGIN/other.html\">The second page</a>, " +
                        "<a id=\"call\" href=\"tel:$DEMO_NUMBER\">Call the demo</a> or " +
                        "<a id=\"mail\" href=\"mailto:$DEMO_EMAIL\">Write to the demo</a>.</p>"
                ),
                "/other.html" to DemoServer.page("Second tab", "<p>The tab the demo does not visit.</p>")
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    /** Gesture navigation and the predictive animations: the back gesture is what the recording is for. */
    override fun beforeLaunch() {
        shell("cmd overlay disable com.android.internal.systemui.navbar.threebutton")
        shell("cmd overlay enable com.android.internal.systemui.navbar.gestural")
        shell("settings put global enable_back_animation 1")
        // SystemUI re-inflates its bar; the insets the chrome measures at launch are the new ones.
        SystemClock.sleep(3_500)
    }

    override fun warmUp() {
        findings = File(out, "android-settings-tab-findings.txt")
        findings.writeText("Zenium Android Settings tab demo (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        // The Settings page is a chunk of its own that loads on its first open: pay for it off
        // camera, then put the profile back as seeded (the warm tab closed, the demo page active).
        val warm = coreInvoke("page.open", "{\"id\":\"settings\",\"section\":null}")
        // The field's name is its hint in the accessibility tree (an empty text field has no text
        // and no content description there), so the chrome's own DOM says when the page is up.
        val painted = awaitChrome("!!document.querySelector('$SEARCH_FIELD')", 12_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", "{\"tabId\":$warm}")
        SystemClock.sleep(800)
        ensureActive(DEMO_TAB)
        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(600)
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
        }
        SystemClock.sleep(1_500)
        finding("warm-up: Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera; ${describeActive()}")
    }

    override fun demo() {
        val before = tabCount()
        val demoTab = activeTabId()

        // 1. Settings from the app menu: a page tab of its own, next to the tab that asked.
        step("Settings from the app menu") {
            if (!openMenuItem("Settings")) {
                finding("  the menu had no Settings item")
                closeSurfaces()
                return@step
            }
            val tab = awaitPage(SETTINGS_URL, 10_000)
            SystemClock.sleep(1_500)
            shot("01-landing")
            val opener = tab?.optString("openerTabId").orEmpty()
            finding(
                "  active ${tab?.optString("id")} ${tab?.optString("url")}, opener '$opener', tabs ${tabCount()} (were $before) " +
                    verdict(tab?.optString("url") == SETTINGS_URL && opener == demoTab && tabCount() == before + 1)
            )
        }

        // 2. Its card in the tab overview, with the page's glyph and title.
        step("The Settings tab's card in the overview") {
            val button = waitForText("Tabs (", 5_000) ?: run {
                finding("  no tab-count button on the bar")
                return@step
            }
            Finger().tap(button.exactCenterX(), button.exactCenterY())
            SystemClock.sleep(2_200)
            val cards = chromeValue(
                "(function(){var c=document.querySelectorAll('.zen-overview-card');var s=document.querySelectorAll" +
                    "('.zen-overview-card[aria-label=\"Settings\"]');return c.length+'/'+s.length})()"
            )
            val overview = chromeSurfaceUp()
            shot("02-overview-card")
            finding("  overview up: $overview; cards (all/Settings): $cards ${verdict(overview && cards.endsWith("/1"))}")
            back()
            awaitSurface(up = false, timeoutMs = 6_000)
            SystemClock.sleep(1_000)
        }

        // 3. Look and Feel: a section over the landing, and the chrome holds the back for it.
        step("Look and Feel drills in") {
            if (!tapText("Look and Feel")) return@step
            val up = awaitSurface(up = true, timeoutMs = 6_000)
            SystemClock.sleep(1_500)
            shot("03-look-and-feel")
            val tab = activeCoreTab()
            finding(
                "  url ${tab?.optString("url")}, canGoBack ${tab?.optBoolean("canGoBack")}, chrome surface $up " +
                    verdict(tab?.optString("url") == "$SETTINGS_URL/look" && tab?.optBoolean("canGoBack") == true && up)
            )
        }

        // 4. Colour scheme through the picker sheet: the theme flips live, no reload.
        step("Colour scheme through the picker sheet") {
            val was = colorScheme()
            if (!tapText("Colour scheme")) return@step
            if (waitForText("Dark", 6_000, exact = true) == null) {
                finding("  the picker sheet never showed its Dark option")
                return@step
            }
            SystemClock.sleep(1_000)
            shot("04-picker-sheet")
            // The picker sheet's injected touch (the rule in DemoHarness): the option under a
            // finger, and the core's scheme must flip on it – a finding, and a fault of the run.
            val touched = tapText("Dark", exact = true)
            SystemClock.sleep(1_800)
            val now = colorScheme()
            shot("05-dark-scheme")
            finding("  colorScheme $was -> $now ${verdict(was == "light" && now == "dark")}")
            if (touched && now != "dark") touchFault("the touch on the Colour scheme picker's Dark left colorScheme '$now'")
        }

        // 5. The predictive back gesture slides the drill-in out with the finger.
        step("Predictive back on the drill-in") {
            if (!chromeSurfaceUp()) {
                finding("  no section over the landing to slide out")
                return@step
            }
            // With the finger held, the pane is where the finger put it: BackDismissal's inline
            // transform, a positive share of its width.
            var held = ""
            edgeSwipe(0.34f * width, hold = 700) {
                held = chromeValue("(document.querySelector('.zen-settings-drill-in')||{style:{}}).style.transform||''")
                shot("06-predictive-back")
            }
            val displaced = Regex("translate3d\\(([0-9.]+)%").find(held)?.groupValues?.get(1)?.toDoubleOrNull()?.let { it > 5 } == true
            commitSwipe()
            val gone = awaitSurface(up = false, timeoutMs = 8_000)
            SystemClock.sleep(1_200)
            val tab = activeCoreTab()
            finding(
                "  held: pane transform '$held' ${verdict(displaced)}; drill-in gone: surface down $gone, url ${tab?.optString("url")}, canGoBack ${tab?.optBoolean("canGoBack")} " +
                    verdict(gone && tab?.optString("url") == SETTINGS_URL && tab?.optBoolean("canGoBack") == false)
            )
        }

        // 6. Away to the tab next door and back through the menu: the one Settings tab is reused.
        step("Reopening Settings from the menu reuses the tab") {
            val settingsId = activeTabId()
            flingRight()
            val away = awaitActive(demoTab, 8_000)
            // The fling is not what this step measures: when it misses, the core switches, so the
            // menu's reuse is still shown.
            if (!away) ensureActive(demoTab)
            SystemClock.sleep(1_000)
            if (!openMenuItem("Settings")) {
                finding("  the menu had no Settings item")
                closeSurfaces()
                return@step
            }
            val reused = awaitActive(settingsId, 8_000)
            SystemClock.sleep(1_500)
            shot("07-reused-tab")
            finding(
                "  fling to $demoTab: ${if (away) "yes" else "NO"}; menu > Settings: active ${activeTabId()} (was $settingsId), tabs ${tabCount()} " +
                    verdict(away && reused && tabCount() == before + 1)
            )
        }

        // 7. Back at the landing: rootBackAction's opener rule closes the page tab to the tab that opened it.
        step("Back at the landing returns to the opener") {
            val settingsId = activeTabId()
            edgeSwipe(0.36f * width, hold = 300)
            commitSwipe()
            val returned = awaitActive(demoTab, 8_000)
            SystemClock.sleep(1_500)
            // Had the chrome not claimed the root back, the system's back-to-home would have run:
            // the app comes back for the rest of the recording, and the finding says so.
            if (!appInFront()) {
                finding("  the back LEFT THE APP (the launcher is in front): bringing it back")
                recoverApp()
            }
            shot("08-back-to-opener")
            val closed = coreState().getJSONObject("tabs").optJSONObject(settingsId) == null
            finding(
                "  active ${activeTabId()}, Settings tab $settingsId ${if (closed) "closed" else "STILL OPEN"}, tabs ${tabCount()} (were $before) " +
                    verdict(returned && closed && tabCount() == before)
            )
        }

        // 8. A deep link as adb or another app sends it: the section, the landing beneath it.
        step("Deep link zenium://settings/privacy") {
            shell("am start -a android.intent.action.VIEW -d zenium://settings/privacy")
            val tab = awaitPage("$SETTINGS_URL/privacy", 12_000)
            val up = awaitSurface(up = true, timeoutMs = 6_000)
            SystemClock.sleep(1_500)
            shot("09-deep-link-privacy")
            finding(
                "  active ${tab?.optString("id")} ${tab?.optString("url")}, canGoBack ${tab?.optBoolean("canGoBack")} (the landing beneath), " +
                    "fromIntent ${tab?.optBoolean("fromIntent")}, chrome surface $up, tabs ${tabCount()} " +
                    verdict(tab?.optString("url") == "$SETTINGS_URL/privacy" && tab?.optBoolean("canGoBack") == true && tab?.optBoolean("fromIntent") == true)
            )
            // Back to the landing, so the tab is found there when the menu reuses it.
            edgeSwipe(0.36f * width, hold = 300)
            commitSwipe()
            awaitSurface(up = false, timeoutMs = 8_000)
            SystemClock.sleep(800)
        }

        // 9. A web page's link to the page is refused: nothing opens, the tab stays where it is.
        step("A web page's link to zenium://settings/privacy is refused") {
            if (!switchTo(demoTab, DEMO_TITLE)) {
                finding("  could not return to the demo page")
                return@step
            }
            val tabsBefore = tabCount()
            val settingsBefore = pageTabIds()
            tapPage("#link a")
            SystemClock.sleep(2_200)
            shot("10-refused-link")
            val note = jsonString(tabJs("document.getElementById('note').textContent"))
            finding(
                "  page says '$note'; active ${activeTabId()} ${activeUrl()}, tabs ${tabCount()} (were $tabsBefore), Settings tabs $settingsBefore -> ${pageTabIds()} " +
                    verdict(activeTabId() == demoTab && activeUrl() == "$ORIGIN/" && tabCount() == tabsBefore && pageTabIds() == settingsBefore)
            )
        }

        // 10. Find in Settings: rows from more than one category, each under its caption.
        step("Find in Settings") {
            if (!openMenuItem("Settings")) {
                finding("  the menu had no Settings item")
                closeSurfaces()
                return@step
            }
            awaitPage(SETTINGS_URL, 10_000, anySection = true)
            // The reused tab comes up where it was; a section over the landing goes first.
            if (chromeSurfaceUp()) {
                back()
                awaitSurface(up = false, timeoutMs = 6_000)
            }
            SystemClock.sleep(800)
            // The field is found in the chrome's DOM: an empty text field carries its name as the
            // accessibility node's hint, which no label lookup reads.
            if (!awaitChrome("!!document.querySelector('$SEARCH_FIELD')", 6_000)) {
                finding("  no Find in Settings field on the landing")
                return@step
            }
            val field = chromePoint(SEARCH_FIELD) ?: run {
                finding("  the Find in Settings field has no place on screen")
                return@step
            }
            Finger().tap(field.x, field.y)
            val keyboard = awaitIme(shown = true, timeoutMs = 6_000)
            shell("input text site")
            SystemClock.sleep(1_500)
            var query = chromeValue("(document.querySelector('$SEARCH_FIELD')||{}).value||''")
            if (query != "site") {
                Log.w(tag, "input text left the field at '$query'; typing through the chrome")
                chromeJs(
                    "(function(){var i=document.querySelector('$SEARCH_FIELD');if(!i)return;" +
                        "var s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;" +
                        "s.call(i,'site');i.dispatchEvent(new Event('input',{bubbles:true}))})()"
                )
                SystemClock.sleep(1_200)
                query = chromeValue("(document.querySelector('$SEARCH_FIELD')||{}).value||''")
            }
            val hits = chromeValue(
                "(function(){var c=Array.from(document.querySelectorAll('.zen-settings-results .zen-settings-caption'))" +
                    ".map(function(e){return e.textContent.split('\\u203a')[0].trim()});" +
                    "var u=c.filter(function(x,i){return c.indexOf(x)===i});return c.length+' rows in '+u.length+' categories: '+u.join(', ')})()"
            )
            // The keyboard down, so the frame shows the rows it covered.
            if (imeShown()) {
                back()
                awaitIme(shown = false, timeoutMs = 4_000)
            }
            SystemClock.sleep(1_000)
            shot("11-search-hits")
            val categories = Regex("in (\\d+) categories").find(hits)?.groupValues?.get(1)?.toIntOrNull() ?: 0
            finding("  keyboard ${if (keyboard) "up" else "NOT UP"} on tap; query '$query'; $hits ${verdict(query == "site" && categories >= 2)}")
            if (tapText("Clear search", exact = true, timeoutMs = 4_000)) SystemClock.sleep(1_000)
            if (imeShown()) {
                back()
                awaitIme(shown = false, timeoutMs = 4_000)
            }
        }

        // 11. A container's editor sheet and, over it, its delete confirmation: depth two, the lower sheet receding.
        step("Container editor and its confirmation, stacked") {
            if (!tapText("Containers", exact = true)) return@step
            awaitSurface(up = true, timeoutMs = 6_000)
            SystemClock.sleep(1_200)
            if (!tapText("Work", exact = true)) return@step
            if (waitForText("Delete container", 6_000) == null) {
                finding("  the container sheet never showed Delete container")
                return@step
            }
            SystemClock.sleep(1_000)
            shot("12-container-sheet")
            tapText("Delete container")
            if (waitForText("Cancel", 6_000, exact = true) == null) {
                finding("  the confirmation never came up")
                return@step
            }
            // The chassis stack (lib/motion/recede.ts, §9.24 / §11.2): the upper sheet's progress
            // is written onto the lower sheet itself (`--zen-layer-recede`, scale .97, inert,
            // data-recessed) and, on the same progress, takes over the scrim – the lower sheet's
            // fades out as the upper's fades in, so one scrim is lit over page and lower sheet.
            // The upper sheet's spring is waited out (64 ms a frame at most, long frames here).
            // `data-recessed` is a bare toggle since #168 (`toggleAttribute`, no value): its
            // presence is the reading, not a 'true'.
            awaitChrome("(function(){var s=document.querySelectorAll('.zen-sheet');return s.length===2&&+s[0].style.getPropertyValue('--zen-layer-recede')>0.9})()", 8_000)
            SystemClock.sleep(600)
            val stackJson = chromeValue(
                "(function(){var s=Array.from(document.querySelectorAll('.zen-sheet'));var l=s[0];" +
                    "var scrims=Array.from(document.querySelectorAll('.zen-sheet-scrim')).map(function(e){return Math.round(+getComputedStyle(e).opacity*100)/100});" +
                    "return JSON.stringify({sheets:s.length,recede:l?l.style.getPropertyValue('--zen-layer-recede').trim():''," +
                    "recessed:!!(l&&l.hasAttribute('data-recessed')&&l.inert),scrims:scrims,lit:scrims.filter(function(o){return o>0.05}).length})})()"
            )
            val stack = runCatching { JSONObject(stackJson) }.getOrNull()
            val sheets = stack?.optInt("sheets", -1) ?: sheetCount()
            val recede = stack?.optString("recede", "") ?: ""
            val recessed = stack?.optBoolean("recessed", false) ?: false
            val lit = stack?.optInt("lit", -1) ?: -1
            shot("13-stacked-sheet")
            finding(
                "  sheets up: $sheets; the lower sheet's --zen-layer-recede '$recede', recessed and inert $recessed; " +
                    "scrims lit ${if (lit >= 0) lit else "?"} of ${stack?.optJSONArray("scrims")?.length() ?: "?"} (opacities ${stack?.optJSONArray("scrims") ?: "?"}) " +
                    verdict(sheets == 2 && recede.toDoubleOrNull()?.let { it > 0.9 } == true && recessed && lit == 1)
            )
            // The confirmation's Cancel, tapped where the chrome draws it (the top sheet's first
            // footer button): its accessibility node still carried the bounds of the sheet's
            // slide-in, so a tap by label went under the button (see chromePointOf).
            val cancel = chromePointOf(TOP_SHEET_CANCEL)
            if (cancel != null) Finger().tap(cancel.x, cancel.y) else tapText("Cancel", exact = true)
            // A dismissed sheet stays mounted until its spring has carried it out, and the spring
            // advances at most 64 ms per frame (lib/motion/spring.ts): under the emulator's software
            // GPU a frame is long, so the close takes seconds and is waited for, never slept over.
            val cancelled = awaitSheets(1, 8_000)
            finding("  Cancel${if (cancel == null) " (by label)" else ""}: sheets up ${sheetCount()} ${verdict(cancelled)}")
            // The item sheet by a back, then the section by the gesture: each dismissal settles first.
            back()
            if (!awaitSheets(0, 8_000) && sheetCount() > 0) {
                // A sheet still mounted past its time: one more back – a back only ever goes to a
                // sheet or the section here, never to the landing.
                back()
                awaitSheets(0, 8_000)
            }
            SystemClock.sleep(500)
            // The section by the gesture, only while it is up: at the landing of this tab (fromIntent)
            // the gesture would hand the user to the sender and leave the app.
            if (chromeSurfaceUp()) {
                edgeSwipe(0.36f * width, hold = 300)
                commitSwipe()
                awaitSurface(up = false, timeoutMs = 8_000)
            }
            SystemClock.sleep(800)
        }

        // 12. The pill, editing: the page's user-facing alias, section and all.
        step("The pill edits zenium://settings/look") {
            // From the landing: whatever the last step left up (a sheet, its section) goes first.
            if (chromeSurfaceUp()) {
                closeSurfaces()
                awaitSurface(up = false, timeoutMs = 6_000)
                SystemClock.sleep(800)
            }
            if (!tapText("Look and Feel")) return@step
            awaitSurface(up = true, timeoutMs = 6_000)
            SystemClock.sleep(1_200)
            val pillNow = findByLabelPrefix(PILL_LABEL) ?: pill
            Finger().tap(pillNow.exactCenterX(), pillNow.exactCenterY())
            // The phone's editor field carries no aria-label (its placeholder names it); it is the
            // one `urlbar-input` in the chrome. Its value arrives with the editor's first render.
            val editing = awaitChrome("((document.querySelector('$URLBAR_FIELD')||{}).value||'')!==''", 6_000)
            SystemClock.sleep(1_200)
            val text = chromeValue("(document.querySelector('$URLBAR_FIELD')||{}).value||''")
            val focused = chromeValue("String(document.activeElement===document.querySelector('$URLBAR_FIELD'))") == "true"
            shot("14-pill-editing")
            finding("  editor ${if (editing) "up" else "NOT UP"}, field focused $focused; pill text '$text' ${verdict(text == "zenium://settings/look")}")
            // The keyboard, then the editor, by the shared close (DemoHarness.closeUrlField): a
            // back only against the chrome's own word that the editor is up, never one that looks
            // for the pill. This tab came from the deep link (fromIntent), so a back at its landing
            // would hand the user to the sender and leave the app; the close names a page it moved.
            val close = closeUrlField()
            finding("  editor closed by back, the tab kept ${verdict(close.ok)} (${close.describe()})")
            SystemClock.sleep(1_500)
        }

        // 13. About: the version block copies its report on a hold; Open by default reads the
        // host's link state and leaves for the system's screen; What's new is a page tab of its own.
        step("About: the version copies on a hold, Open by default, What's new") {
            if (!openSection("About", "about")) return@step
            SystemClock.sleep(1_200)
            shot("15-about")
            // The block carries the hold (rows.tsx, `data-copies`): the finger lands on it where
            // the chrome draws it, as the sheet steps do.
            val block = chromePointOf("document.querySelector('[data-row=\"version\"][data-copies]')")
            if (block == null) {
                finding("  no version block carries the hold")
            } else {
                val before = clipboardText()
                watchToasts()
                Finger().apply {
                    press(block.x, block.y)
                    up()
                }
                val copied = awaitClipboardPrefix("Zenium ", 6_000)
                val text = clipboardText()
                // Android 13+ shows the system's clipboard chip in the toast's place
                // (`copyConfirmation`): the chrome's toast is only looked for before it.
                val word = when {
                    Build.VERSION.SDK_INT >= 33 -> "the system's chip stands for the toast"
                    awaitToastSeen("Version copied", 4_000) -> "toast 'Version copied' seen"
                    else -> "toast 'Version copied' NOT seen"
                }
                SystemClock.sleep(800)
                shot("16-version-copied")
                finding("  hold on the version block at ${block.x.toInt()},${block.y.toInt()}: clipboard '$before' -> '$text'; $word ${verdict(copied)}")
                // The hold's release is swallowed (no row action fires): the section stays up.
                finding("  section still up after the hold ${verdict(chromeSurfaceUp() && activeUrl() == "$SETTINGS_URL/about")}")
                // The system's clipboard chip is a window of its own, and while it shows the
                // accessibility tree read is its (run 35939865448: every label read after the
                // hold found nothing): the rest of the step works off the chrome's own document,
                // and the chip is waited out before anything is pressed.
                finding("  the clipboard chip: ${awaitClipboardChip()}")
            }
            // Open by default (DEF-06): the row reads the host's state; its tap leaves for the
            // system's screen, and the app is brought back for the rest of the recording.
            val openByText = rowText("open-by-default")
            val known = openByText.contains("is set to open") || openByText.contains("is set not to open") || openByText.contains("Choose which links")
            finding("  Open by default row reads '$openByText' ${verdict(openByText.isNotEmpty() && known)}")
            if (openByText.isNotEmpty() && tapRow("open-by-default")) {
                val left = awaitLeftApp(8_000)
                SystemClock.sleep(1_200)
                shot("17-open-by-default-system")
                finding("  its tap left for the system's screen (${ui.rootInActiveWindow?.packageName}) ${verdict(left)}")
                recoverApp()
                awaitPage("$SETTINGS_URL/about", 8_000)
                SystemClock.sleep(800)
            }
            // What's new: a page tab of its own, opened from the row; a back returns to About.
            val tabsBefore = tabCount()
            val aboutId = activeTabId()
            if (!tapRow("whats-new")) return@step
            val page = awaitPage(WHATS_NEW_URL, 10_000)
            SystemClock.sleep(1_500)
            val body = chromeValue(
                "(function(){if(document.querySelector('[data-testid=\"whats-new-notes\"]'))return 'notes';" +
                    "var e=document.querySelector('[data-testid=\"whats-new-empty\"]');return e?'empty: '+e.textContent.trim():'nothing'})()"
            )
            shot("18-whats-new")
            finding(
                "  active ${page?.optString("id")} ${page?.optString("url")}, opener '${page?.optString("openerTabId")}', tabs ${tabCount()} (were $tabsBefore); the page shows $body " +
                    verdict(page?.optString("url") == WHATS_NEW_URL && page?.optString("openerTabId") == aboutId && tabCount() == tabsBefore + 1 && body != "nothing")
            )
            back()
            val returned = awaitPage("$SETTINGS_URL/about", 8_000)
            SystemClock.sleep(1_000)
            finding("  back: active ${returned?.optString("url")}, tabs ${tabCount()} ${verdict(returned?.optString("url") == "$SETTINGS_URL/about" && tabCount() == tabsBefore)}")
        }

        // 14. Legal: the Privacy notice and the Terms, each a page tab, each back returning to About.
        step("Legal: Privacy notice and Terms") {
            if (activeUrl() != "$SETTINGS_URL/about" && !openSection("About", "about")) return@step
            val tabsBefore = tabCount()
            for ((rowId, url, shotName) in listOf(
                Triple("privacy-notice", PRIVACY_URL, "19-privacy-notice"),
                Triple("terms", TERMS_URL, "20-terms")
            )) {
                val label = if (rowId == "terms") "Terms" else "Privacy notice"
                if (!tapRow(rowId)) continue
                val page = awaitPage(url, 10_000)
                SystemClock.sleep(1_500)
                val prose = chromeValue("String(document.querySelectorAll('.zen-page-prose p, .zen-page-prose li').length)").toIntOrNull() ?: 0
                shot(shotName)
                finding("  $label: active ${page?.optString("url")}, $prose paragraphs and items of prose ${verdict(page?.optString("url") == url && prose > 0)}")
                back()
                val returned = awaitPage("$SETTINGS_URL/about", 8_000)
                SystemClock.sleep(800)
                finding("  back to About ${verdict(returned?.optString("url") == "$SETTINGS_URL/about" && tabCount() == tabsBefore)}")
            }
        }

        // 15. Security's Notification settings row: the system's screen for this app's notifications.
        step("Security: the Notification settings row") {
            if (!openSection("Security", "security")) return@step
            awaitChrome("!!document.querySelector('[data-row=\"notification-settings\"]')", 8_000)
            val row = rowPoint("notification-settings")
            SystemClock.sleep(800)
            shot("21-notification-settings-row")
            if (row == null) {
                finding("  no Notification settings row in Security")
                return@step
            }
            finding("  the row reads '${rowText("notification-settings")}'")
            Finger().tap(row.x, row.y)
            val left = awaitLeftApp(8_000)
            SystemClock.sleep(1_200)
            shot("22-notification-settings-system")
            finding("  the tap left for the system's screen (${ui.rootInActiveWindow?.packageName}) ${verdict(left)}")
            recoverApp()
            awaitPage(SETTINGS_URL, 8_000, anySection = true)
            SystemClock.sleep(800)
        }

        // 16. The link menu on the demo page: the header (PUI-18), then the tel: and mailto: items (PUI-22).
        step("The link menu's header, and the tel: and mailto: items") {
            if (chromeSurfaceUp()) closeSurfaces()
            if (!switchTo(demoTab, DEMO_TITLE)) {
                finding("  could not return to the demo page")
                return@step
            }
            // A page link with text: the text over the address, the site's favicon or the globe.
            if (holdPageLink("#site") == null) return@step
            val header = readLinkHeader()
            SystemClock.sleep(600)
            shot("23-link-header")
            finding("  header on the page link: $header ${verdict(header == "The second page | $ORIGIN/other.html")}")
            val headerPoint = chromePointOf("document.querySelector('.zen-menu-link-header')")
            if (headerPoint != null) {
                Finger().tap(headerPoint.x, headerPoint.y)
                val expanded = awaitChrome("!!document.querySelector('.zen-menu-link-header[aria-expanded=\"true\"]')", 4_000)
                SystemClock.sleep(600)
                shot("24-link-header-expanded")
                finding("  a tap expands the address ${verdict(expanded)}")
                val before = clipboardText()
                Finger().apply {
                    press(headerPoint.x, headerPoint.y)
                    up()
                }
                val copied = awaitClipboard("$ORIGIN/other.html", 6_000)
                finding("  a hold copies it: clipboard '$before' -> '${clipboardText()}' ${verdict(copied)}")
                // The menu stands after the hold (the release's click is swallowed).
                finding("  the menu still up after the hold ${verdict(chromeSurfaceUp())}")
            }
            // The copy's chip waited out before the back: while it shows, the emulator's
            // software GPU is its and the sheet's spring crawls (run 35941798860: 8 s from the
            // back to `back.update`, and closeSurfaces' second back meanwhile landed on the page's
            // root – the demo tab left for a new one, nothing for the next holds to match).
            finding("  the clipboard chip: ${awaitClipboardChip()}")
            finding("  the menu closed by one back ${verdict(closeMenuSheet())}")
            SystemClock.sleep(800)
            // tel: – the number bare under the link's text, and the three items for it.
            if (holdPageLink("#call") != null) {
                val telHeader = readLinkHeader()
                val labels = menuItemLabels()
                val items = listOf("Call", "Send Message", "Add to Contacts", "Copy Phone Number").map { it to (it in labels) }
                SystemClock.sleep(600)
                shot("25-tel-menu")
                finding(
                    "  tel: header $telHeader; items ${items.joinToString { "${it.first} ${if (it.second) "yes" else "NO"}" }} " +
                        verdict(telHeader == "Call the demo | $DEMO_NUMBER" && items.all { it.second })
                )
                closeMenuSheet()
                SystemClock.sleep(800)
            }
            // mailto: – the address bare, Send Email.
            if (holdPageLink("#mail") != null) {
                val mailHeader = readLinkHeader()
                val labels = menuItemLabels()
                val items = listOf("Send Email", "Copy Email Address").map { it to (it in labels) }
                SystemClock.sleep(600)
                shot("26-mailto-menu")
                finding(
                    "  mailto: header $mailHeader; items ${items.joinToString { "${it.first} ${if (it.second) "yes" else "NO"}" }} " +
                        verdict(mailHeader == "Write to the demo | $DEMO_EMAIL" && items.all { it.second })
                )
                closeMenuSheet()
            }
            SystemClock.sleep(800)
        }

        finding("\nend: ${describeActive()}")
    }

    // --- the small rows' helpers (steps 13 to 16) ------------------------------------------------

    /**
     * The Settings section `label` over the landing: from wherever the last step left the tab
     * (a section, a sheet, another tab), by a finger on the landing's row – the core's own open
     * when the row is not found, so the step still runs. True once the tab shows the section.
     */
    private fun openSection(label: String, id: String): Boolean {
        val url = "$SETTINGS_URL/$id"
        if (activeUrl() == url) return true
        if (!activeUrl().startsWith(SETTINGS_URL)) {
            coreInvoke("page.open", "{\"id\":\"settings\",\"section\":null}")
            awaitPage(SETTINGS_URL, 10_000, anySection = true)
            SystemClock.sleep(800)
        }
        if (chromeSurfaceUp()) {
            closeSurfaces()
            awaitSurface(up = false, timeoutMs = 6_000)
            SystemClock.sleep(800)
        }
        if (!tapText(label)) {
            Log.w(tag, "no landing row reads $label; opening the section through the core")
            coreInvoke("page.open", "{\"id\":\"settings\",\"section\":${JSONObject.quote(id)}}")
        }
        val there = awaitPage(url, 8_000)?.optString("url") == url
        awaitSurface(up = true, timeoutMs = 6_000)
        if (!there) finding("  the tab did not come to $url (${describeActive()})")
        return there
    }

    /** A hold on the page's link `selector` until its menu sheet is up; the point held, or null (and a finding). */
    private fun holdPageLink(selector: String): PointF? {
        val p = pagePoint(selector) ?: run {
            finding("  nothing matches $selector on the page")
            return null
        }
        // Two holds before giving up: the first after a sheet has left (run 35939865448's
        // #call) landed while the page was not yet the pointer's again.
        repeat(2) { attempt ->
            Finger().apply {
                press(p.x, p.y)
                up()
            }
            if (awaitChrome("!!document.querySelector('.zen-menu-link-header')", 6_000)) {
                if (attempt > 0) finding("  the hold on $selector raised the menu at the second hold")
                SystemClock.sleep(600)
                return p
            }
            Log.w(tag, "no link menu after hold ${attempt + 1} on $selector at ${p.x.toInt()},${p.y.toInt()}")
            SystemClock.sleep(1_000)
        }
        finding("  the hold on $selector at ${p.x.toInt()},${p.y.toInt()} raised no link menu (two holds)")
        return null
    }

    /**
     * True once the app's own window is the active one again (`rootInActiveWindow`), with how
     * long it took: the system's clipboard chip (Android 13+) is a window of its own that takes
     * the focus for a while after a copy, and the accessibility tree read meanwhile is its.
     */
    private fun awaitAppWindow(timeoutMs: Long): String {
        val start = SystemClock.uptimeMillis()
        val deadline = start + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (ui.rootInActiveWindow?.packageName?.toString() == app.packageName) {
                return "after ${SystemClock.uptimeMillis() - start} ms PASS"
            }
            SystemClock.sleep(250)
        }
        return "NOT within $timeoutMs ms (active window ${ui.rootInActiveWindow?.packageName}) FAIL"
    }

    /**
     * After a copy on Android 13+: the system's clipboard chip comes up as a window of its own a
     * moment after the copy, holds the active window for as long as it shows (about six seconds;
     * every accessibility read meanwhile is its) and, on the emulator's software GPU, starves the
     * app's frames – a sheet's spring crawls under it. Wait for it to have come (up to 2.5 s) and
     * gone, so that what follows lands on an app drawing at its own pace; a word on what happened.
     */
    private fun awaitClipboardChip(): String {
        if (Build.VERSION.SDK_INT < 33) return "none below 33"
        val start = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() - start < 2_500 && appInFront()) SystemClock.sleep(100)
        if (appInFront()) return "no window of its own within 2.5 s"
        val came = SystemClock.uptimeMillis() - start
        return "took the window after $came ms, the app's back ${awaitAppWindow(15_000)}"
    }

    /**
     * One back on the menu sheet, then wait for the sheet to have gone – its spring carried out
     * (`.zen-sheet` unmounted) and the host told (`back.update`) – before anything else; never a
     * second back while it is still mounted, which would land on the page beneath. False when it
     * is still there after the wait.
     */
    private fun closeMenuSheet(): Boolean {
        if (!chromeSurfaceUp() && sheetCount() == 0) return true
        back()
        val gone = awaitSheets(0, 20_000)
        val told = awaitSurface(up = false, timeoutMs = 10_000)
        SystemClock.sleep(500)
        return gone && told
    }

    /** The text of the settings row `id` as the chrome draws it (`data-row`); empty when the page has none. */
    private fun rowText(id: String): String =
        chromeValue("(function(){var e=document.querySelector('[data-row=\"$id\"]');return e?e.textContent.trim():null})()")

    /** The middle of the settings row `id` on screen, scrolled into view first; null when the page has none. */
    private fun rowPoint(id: String): PointF? {
        val element = "document.querySelector('[data-row=\"$id\"]')"
        if (chromeValue("String(!!$element)") != "true") return null
        chromeJs("$element.scrollIntoView({block:'center'})")
        SystemClock.sleep(500)
        return chromePointOf(element)
    }

    /** A finger on the middle of the settings row `id`; false (and a finding) when the page has none. */
    private fun tapRow(id: String): Boolean {
        val p = rowPoint(id) ?: run {
            finding("  no row '$id' on the page")
            return false
        }
        Finger().tap(p.x, p.y)
        return true
    }

    /** The labels of the menu sheet's items, in order, as the chrome draws them. */
    private fun menuItemLabels(): List<String> {
        val raw = chromeJs(
            "Array.from(document.querySelectorAll('.zen-v2-menu-item')).map(function(e){return e.textContent.trim()})"
        )
        val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
        return List(array.length()) { array.optString(it) }
    }

    /** The link menu's header as "title | address", read from the chrome. */
    private fun readLinkHeader(): String = chromeValue(
        "(function(){var h=document.querySelector('.zen-menu-link-header');if(!h)return 'no header';" +
            "return ((h.querySelector('.zen-menu-link-title')||{}).textContent||'').trim()+' | '+((h.querySelector('.zen-menu-link-url')||{}).textContent||'').trim()})()"
    )

    /** Poll until another app's window is in front (a system screen the row opened); false when the browser stays. */
    private fun awaitLeftApp(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (!appInFront()) return true
            SystemClock.sleep(250)
        }
        return !appInFront()
    }

    /** The clipboard's text as the app (in the foreground, so allowed to read it) sees it. */
    private fun clipboardText(): String {
        var text = ""
        instrumentation.runOnMainSync {
            val manager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            text = runCatching {
                manager.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(app)?.toString()
            }.getOrNull().orEmpty()
        }
        return text
    }

    private fun awaitClipboard(text: String, timeoutMs: Long): Boolean = awaitClipboardWhere(timeoutMs) { it == text }

    private fun awaitClipboardPrefix(prefix: String, timeoutMs: Long): Boolean = awaitClipboardWhere(timeoutMs) { it.startsWith(prefix) }

    private fun awaitClipboardWhere(timeoutMs: Long, accept: (String) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (accept(clipboardText())) return true
            SystemClock.sleep(250)
        }
        return accept(clipboardText())
    }

    // --- steps -----------------------------------------------------------------------------------

    /** Run one step of the sequence; a failure inside it is a finding, not the end of the recording. */
    private fun step(name: String, block: () -> Unit) {
        finding("\n$name")
        try {
            block()
        } catch (e: Throwable) {
            Log.w(tag, "$name failed", e)
            finding("  FAIL: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    // --- rows and labels -------------------------------------------------------------------------

    /**
     * The bounds of the first node whose accessible text reads `text` – exactly, or (`exact`
     * false) as a prefix: a Settings row is one button whose text runs its label, value and
     * description together. Polls, since the tree trails the screen on the emulator. A node the
     * list holds below the fold is scrolled into view first (its bounds read empty, or fall
     * outside the window, until it is).
     */
    private fun waitForText(text: String, timeoutMs: Long, exact: Boolean = false): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var revealed = false
        while (SystemClock.uptimeMillis() < deadline) {
            val node = findNode { it == text || (!exact && it.startsWith(text)) }
            if (node != null) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                val onScreen = bounds.width() > 0 && bounds.height() > 0 &&
                    bounds.centerY() in 0 until height && bounds.centerX() in 0 until width
                if (onScreen) return bounds
                if (!revealed) {
                    revealed = true
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                    SystemClock.sleep(1_000)
                    continue
                }
            }
            SystemClock.sleep(200)
        }
        return null
    }

    /** A finger on the middle of the node reading `text`; false (and a finding) when none shows. */
    private fun tapText(text: String, exact: Boolean = false, timeoutMs: Long = 8_000): Boolean {
        val target = waitForText(text, timeoutMs, exact) ?: run {
            finding("  nothing on screen reads '$text'")
            return false
        }
        Finger().tap(target.exactCenterX(), target.exactCenterY())
        return true
    }

    // --- the back gesture ------------------------------------------------------------------------

    private var finger: Finger? = null

    /**
     * A thumb from the left screen edge: down in the gesture inset, out to `dx`, then held there
     * (with `during` run while holding – a frame). The gesture stays down; follow with
     * [commitSwipe].
     */
    private fun edgeSwipe(dx: Float, hold: Long, during: () -> Unit = {}) {
        ensureForeground()
        val f = Finger()
        f.down(EDGE_X, height * 0.6f)
        f.moveBy(dx, 0f, 650)
        f.hold(hold)
        during()
        finger = f
    }

    /** Let go where it is: the system commits the gesture. */
    private fun commitSwipe() {
        val f = finger ?: return
        finger = null
        f.up()
    }

    /** The browser's own window is the one in front (not the launcher, not a system dialog). */
    private fun appInFront(): Boolean = ui.rootInActiveWindow?.packageName?.toString() == app.packageName

    /** Bring the browser's task back in front of the launcher; the activity is singleTask, so nothing restarts. */
    private fun recoverApp() {
        val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (!appInFront() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        SystemClock.sleep(1_500)
    }

    /** Back out of whatever chrome surface is up, a few at most, each given time to go. */
    private fun closeSurfaces() {
        repeat(3) {
            if (!chromeSurfaceUp()) return
            back()
            awaitSurface(up = false, timeoutMs = 5_000)
            SystemClock.sleep(500)
        }
    }

    // --- tabs ------------------------------------------------------------------------------------

    /** To `tabId` through the overview's card labelled `title`; the core's own activate when the card is not found. */
    private fun switchTo(tabId: String, title: String): Boolean {
        if (activeTabId() == tabId) return true
        val button = waitForText("Tabs (", 5_000)
        if (button != null) {
            Finger().tap(button.exactCenterX(), button.exactCenterY())
            SystemClock.sleep(2_000)
            val card = waitForText(title, 5_000, exact = true)
            if (card != null) {
                Finger().tap(card.exactCenterX(), card.exactCenterY())
                if (awaitActive(tabId, 8_000)) {
                    awaitSurface(up = false, timeoutMs = 6_000)
                    SystemClock.sleep(1_500)
                    return true
                }
            }
            Log.w(tag, "no card for $title in the overview; activating through the core")
            closeSurfaces()
        }
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        val ok = awaitActive(tabId, 8_000)
        SystemClock.sleep(1_500)
        return ok
    }

    private fun ensureActive(tabId: String) {
        if (activeTabId() == tabId) return
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        awaitActive(tabId, 8_000)
        SystemClock.sleep(1_000)
    }

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun tabCount(): Int = coreState().getJSONObject("tabs").length()

    private fun colorScheme(): String = coreState().getJSONObject("settings").optString("colorScheme")

    /** The ids of the tabs showing the Settings page, in the core's order. */
    private fun pageTabIds(): List<String> {
        val tabs = coreState().getJSONObject("tabs")
        return tabs.keys().asSequence().filter { tabs.getJSONObject(it).optString("url").startsWith(SETTINGS_URL) }.sorted().toList()
    }

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${tabCount()} tabs" }

    /** Poll until `tabId` is the active tab; false when it does not become so in time. */
    private fun awaitActive(tabId: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeTabId() == tabId) return true
            SystemClock.sleep(250)
        }
        Log.w(tag, "$tabId did not become the active tab")
        return activeTabId() == tabId
    }

    /**
     * Poll until the active tab shows `url` (or, with `anySection`, that page at any section);
     * that tab, or the active tab then when it does not come in time.
     */
    private fun awaitPage(url: String, timeoutMs: Long, anySection: Boolean = false): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            val at = tab?.optString("url").orEmpty()
            if (tab != null && (at == url || (anySection && at.startsWith(url)))) return tab
            SystemClock.sleep(250)
        }
        Log.w(tag, "the active tab did not come to $url")
        return activeCoreTab()
    }

    // --- the chrome and the page -----------------------------------------------------------------

    /** Evaluate in the chrome; the value as text ("" when it never answered). */
    private fun chromeValue(code: String): String = jsonString(chromeJs(code))

    /** Poll the chrome until the expression `code` is true; false when it is not in time. */
    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    /** How many sheets the chrome has mounted (a closing one counts until its spring has carried it out). */
    private fun sheetCount(): Int = chromeValue("String(document.querySelectorAll('.zen-sheet').length)").toIntOrNull() ?: -1

    /** Poll until the chrome has `count` sheets mounted; false when it does not in time. */
    private fun awaitSheets(count: Int, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (sheetCount() == count) return true
            SystemClock.sleep(200)
        }
        return sheetCount() == count
    }

    /** Where the middle of the first chrome element matching `selector` is on screen, or null. */
    private fun chromePoint(selector: String): PointF? =
        chromePointOf("document.querySelector(${JSONObject.quote(selector)})")

    /**
     * Where the middle of the chrome element the expression `elementJs` evaluates to is on
     * screen, or null when there is none. The frame's own rectangle, read the moment before the
     * finger lands: the accessibility tree's bounds trail a sheet's motion by seconds on the
     * emulator's software GPU (run 35397351416 tapped a confirm's Cancel 75 px under the button,
     * where its node still said the sliding sheet had it – in the gesture-navigation zone, which
     * swallowed the tap).
     */
    private fun chromePointOf(elementJs: String): PointF? {
        val raw = chromeJs(
            "(function(){var e=($elementJs);if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { host.chrome.let { v -> IntArray(2).also(v::getLocationOnScreen) } }
        return PointF(
            origin[0] + point.getDouble(0).toFloat() * density,
            origin[1] + point.getDouble(1).toFloat() * density
        )
    }

    private fun jsonString(raw: String): String =
        runCatching { JSONTokener(raw).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    /** Evaluate in the page on screen; the JSON text of the value ("" when nothing answered). */
    private fun tabJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = shownTabView()
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(
            origin[0] + point.getDouble(0).toFloat() * density,
            origin[1] + point.getDouble(1).toFloat() * density
        )
    }

    private fun tapPage(selector: String) {
        val p = pagePoint(selector) ?: run {
            finding("  nothing matches $selector on the page")
            return
        }
        Finger().tap(p.x, p.y)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

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

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18134
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val DEMO_TAB = "tab_demo"
        private const val DEMO_TITLE = "Settings tab demo"
        /** The address the core stores the page under; the pill and the deep link carry `zenium://`. */
        private const val SETTINGS_URL = "zen://settings"
        /** The page tabs About and Legal open (SET-54, SET-55), by the addresses the core stores them under. */
        private const val WHATS_NEW_URL = "zen://whats-new"
        private const val PRIVACY_URL = "zen://privacy-notice"
        private const val TERMS_URL = "zen://terms"
        /** The demo page's `tel:` and `mailto:` links (step 16): what their headers show bare. */
        private const val DEMO_NUMBER = "+15550100"
        private const val DEMO_EMAIL = "hello@zenium.example"
        /** The landing's Find in Settings field, in the chrome's DOM. */
        private const val SEARCH_FIELD = ".zen-settings-search-field"
        private const val URLBAR_FIELD = "input[data-testid=\"urlbar-input\"]"
        /** The top sheet's first footer button: a prompt sheet's Cancel (blocks.tsx, SheetActions). */
        private const val TOP_SHEET_CANCEL =
            "(function(){var s=document.querySelectorAll('.zen-sheet');" +
                "return s.length?s[s.length-1].querySelector('.zen-settings-sheet-actions .zen-v2-button'):null})()"
        /** Inside the system's back-gesture inset on any density. */
        private const val EDGE_X = 2f
    }
}
