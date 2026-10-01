package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The Settings tab's card picture and its restore, in two acts around a process death (a driver
 * shares the app's process and cannot outlive `am force-stop`): the user's report that the tab
 * overview shows the Settings landing on the card whatever page the tab is on, that a tap on the
 * card jumps to the right page, and that the overview "loses the state".
 *
 *  - [SettingsTabPreviewDemo], the first act: Settings opened from the app menu, Updates drilled
 *    in (a section), the overview pulled up and the Settings card read – what its picture is
 *    (the host's picture, stamped with the tab's address, or the landing drawing), what the
 *    core's `thumbnail.load` answers for the section's address – then the card tapped with a
 *    real touch (the page it lands on), then Privacy and Security › "See all site data and
 *    permissions" for the drill-in page `zen://settings/privacy/site-data`, the overview and
 *    the card read again, the tap, the overview a second time and the tap again (what the tab
 *    keeps across the round trip: address, section, page, scroll), a back from the page (the
 *    section beneath it), and the tab left on the drill-in page for act two;
 *  - [SettingsTabPreviewRestoreDemo], the second act, after the workflow script force-stopped
 *    the process: the restored session's active tab must be on the drill-in page, its card in
 *    the overview must show the page (the picture read from disk for the address), and a tap
 *    on it must land there; a back goes to the section beneath.
 *
 * Every judgement is a `PASS` or `FAIL` line in `settings-tab-preview-findings.txt` next to the
 * frames; the test fails once the sequence is over when any judgement did. Driven by
 * `.github/scripts/android-settings-tab-preview-demo.sh` through the
 * `android-settings-tab-preview-demo` workflow. See [DemoHarness] for the plumbing.
 */
abstract class SettingsTabPreviewDemoBase(
    stateAsset: String?,
    shotPrefix: String,
    handshakeDir: String,
    keepProfile: Boolean
) : DemoHarness(stateAsset, shotPrefix, handshakeDir, keepProfile = keepProfile) {
    private lateinit var server: DemoServer
    protected val findings = StringBuilder()
    protected val failures = ArrayList<String>()
    private val startedAt = SystemClock.uptimeMillis()

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to DemoServer.page(DEMO_TITLE, "<p>A page of the demo's own: the tab Settings opens next to.</p>"),
                "/other.html" to DemoServer.page("Second tab", "<p>The tab the demo does not visit.</p>")
            )
        ).also { it.start() }
        note("server: ${server.selfCheck()}")
        try {
            runDemo()
        } finally {
            server.close()
            File(out, "settings-tab-preview-findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
    }

    override fun warmUp() {}

    // --- judging ---------------------------------------------------------------------------------

    protected fun note(line: String) {
        Log.i(tag, line)
        findings.append("[${SystemClock.uptimeMillis() - startedAt} ms] ").append(line).append('\n')
    }

    /** A judgement: PASS or FAIL in the findings; a failure fails the run once the sequence is over. */
    protected fun check(name: String, ok: Boolean, detail: String) {
        note("${if (ok) "PASS" else "FAIL"} $name: $detail")
        if (!ok) failures.add(name)
    }

    protected fun finish() {
        if (failures.isNotEmpty()) error("${failures.size} judgement(s) failed: ${failures.joinToString()}")
    }

    /** A screenshot kept for the artifact. */
    protected fun capture(name: String) {
        val bitmap = ui.takeScreenshot() ?: run {
            note("no screenshot for $name")
            return
        }
        shot(name, bitmap)
    }

    // --- the tab ---------------------------------------------------------------------------------

    /** The id of the tab showing the Settings page (one per window), or null. */
    protected fun settingsTabId(): String? {
        val tabs = coreState().getJSONObject("tabs")
        return tabs.keys().asSequence().firstOrNull { tabs.getJSONObject(it).optString("url").startsWith(SETTINGS_URL) }
    }

    protected fun tabState(tabId: String): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(tabId)

    protected fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    protected fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    /** The drill-in page the Settings document shows (`data-page`), "" at a section or the landing, null with no page up. */
    protected fun settingsPage(): String? =
        chromeJsString("(function(){var p=document.querySelector('.zen-settings-phone');return p?String(p.dataset.page||''):null})()")

    /** How many drill-in panes the Settings document has mounted: 0 at the landing, 1 at a section, 2 on a section's page. */
    protected fun drillIns(): Int =
        chromeJsString("String(document.querySelectorAll('.zen-settings-drill-in').length)")?.toIntOrNull() ?: -1

    /** The scroll of the topmost drill-in pane's list, in CSS px (-1 without one). */
    protected fun paneScroll(): Int =
        chromeJsString(
            "(function(){var s=document.querySelectorAll('.zen-settings-drill-in .zen-settings-scroll');" +
                "return s.length?String(Math.round(s[s.length-1].scrollTop)):'-1'})()"
        )?.toIntOrNull() ?: -1

    /** One line on where the tab is: the core's address and back state, the document's section, page and panes. */
    protected fun whereabouts(tabId: String?): String {
        val tab = tabId?.let { tabState(it) }
        return "url ${tab?.optString("url")}, canGoBack ${tab?.optBoolean("canGoBack")}, section '${settingsSection()}', " +
            "page '${settingsPage()}', panes ${drillIns()}, scroll ${paneScroll()}"
    }

    /** Poll until the active tab's address is `url`; true when it is in time. */
    protected fun awaitUrl(url: String, timeoutMs: Long = 8_000): Boolean = awaitTrue(timeoutMs) { activeUrl() == url }

    // --- the overview and the card -----------------------------------------------------------------

    /** The overview by the bar's Tabs button (a real touch), waited for; true once its grid is up. */
    protected fun openOverview(): Boolean {
        val button = tabsButton(6_000) ?: run {
            note("no Tabs button on the bar")
            return false
        }
        Finger().tap(button.exactCenterX(), button.exactCenterY())
        val up = awaitChromeTrue("document.querySelectorAll('.zen-overview-card').length>0", 8_000)
        // The morph's spring and the hero's picture: let the grid come to rest before it is read.
        SystemClock.sleep(3_000)
        return up
    }

    /**
     * What the card of `tabId` shows in its picture, by the document: `img` (the host's picture,
     * with the length of its data URL), `drawing` (the landing drawn small, `SettingsPreview`),
     * or `placeholder`; with the card's accessible name and the first words of what the picture
     * area reads (a drawing's text; nothing for a picture).
     */
    protected fun cardReading(tabId: String): JSONObject? {
        val raw = chromeJs(
            "(function(){var cell=document.querySelector('[data-tab-id=\"$tabId\"]');" +
                "var card=cell?cell.querySelector('.zen-overview-card'):null;if(!card)return null;" +
                "var p=card.querySelector('.zen-overview-card-preview');var img=p?p.querySelector('img'):null;" +
                "var drawing=p?p.querySelector('.zen-settings-preview'):null;" +
                "return JSON.stringify({label:card.getAttribute('aria-label')||''," +
                "kind:img?'img':(drawing?'drawing':'placeholder'),src:img?(img.getAttribute('src')||'').length:0," +
                "text:p?(p.textContent||'').trim().replace(/\\s+/g,' ').slice(0,60):''})})()"
        )
        val text = runCatching { JSONTokener(raw).nextValue() }.getOrNull() as? String ?: return null
        return runCatching { JSONObject(text) }.getOrNull()
    }

    /** What the core answers for the tab's picture at `url` (`thumbnail.load`: the host's file, stamped with the address): its size, or "none". */
    protected fun pictureFor(tabId: String, url: String): String {
        val raw = coreInvoke("thumbnail.load", "{\"tabId\":${JSONObject.quote(tabId)},\"url\":${JSONObject.quote(url)}}")
        val picture = runCatching { JSONObject(raw) }.getOrNull() ?: return "none"
        return "${picture.optInt("width")}x${picture.optInt("height")}, ${picture.optString("data").length} chars"
    }

    /** The picture's file on disk for the tab, with its size; "no file" without one. */
    protected fun pictureFile(tabId: String): String {
        val file = File(File(app.cacheDir, Thumbnails.DIR), "$tabId${Thumbnails.SUFFIX}")
        return if (file.isFile) "${file.name} ${file.length()} B" else "no file"
    }

    /** The card of `tabId` read and judged against the address `url` the tab is on; the reading as a line. */
    protected fun judgeCard(tabId: String, url: String, name: String) {
        val card = cardReading(tabId)
        val picture = pictureFor(tabId, url)
        val detail = "card ${card?.optString("label") ?: "NOT FOUND"} shows ${card?.optString("kind")} (src ${card?.optInt("src")} chars, reads '${card?.optString("text")}'); " +
            "thumbnail.load for $url: $picture; on disk ${pictureFile(tabId)}"
        check(name, card?.optString("kind") == "img" && picture != "none", detail)
    }

    /** A real touch on the card of `tabId`; true once the overview has closed to that tab. */
    protected fun tapCard(tabId: String): Boolean {
        val bounds = domBox("document.querySelector('[data-tab-id=\"$tabId\"] .zen-overview-card')")?.takeIf { !it.isEmpty } ?: run {
            note("no card for $tabId in the grid")
            return false
        }
        Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
        val active = awaitTrue(8_000) { activeTabId() == tabId }
        val closed = awaitChromeTrue("document.querySelectorAll('.zen-overview-card').length===0", 8_000)
        SystemClock.sleep(1_500)
        return active && closed
    }

    protected fun awaitChromeTrue(code: String, timeoutMs: Long): Boolean =
        awaitTrue(timeoutMs) { chromeJsString("String(!!($code))") == "true" }

    /** One back, then up to `timeoutMs` for the active tab to be at `url`. */
    protected fun backTo(url: String, timeoutMs: Long = 8_000): Boolean {
        back()
        val there = awaitUrl(url, timeoutMs)
        SystemClock.sleep(1_200)
        return there
    }

    companion object {
        const val PORT = 18194
        const val DEMO_TITLE = "Settings tab preview demo"
        /** The address the core stores the page under; the pill carries `zenium://`. */
        const val SETTINGS_URL = "zen://settings"
        const val UPDATES_URL = "$SETTINGS_URL/updates"
        const val PRIVACY_URL = "$SETTINGS_URL/privacy"
        const val SITE_DATA_URL = "$PRIVACY_URL/site-data"
        /** The Privacy and Security row that leaves for the drill-in page (siteDataRows.tsx). */
        const val SEE_ALL_ROW = "See all site data and permissions"
    }
}

/** The first act: the card's picture for a section and for a drill-in page, the tap, the round trip, the back. */
@RunWith(AndroidJUnit4::class)
class SettingsTabPreviewDemo : SettingsTabPreviewDemoBase(
    "settings-tab-preview-demo-state.json",
    "settings-tab-preview",
    "settings-tab-preview-demo",
    keepProfile = false
) {
    override val tag = "SettingsTabPreviewDemo"

    override fun demo() {
        val demoTab = activeTabId()
        note("start: active $demoTab ${activeUrl()}")

        // 1. Settings from the menu (a real touch on the menu's row), then Updates: a section over the landing.
        if (!openSettingsLanding(10_000)) {
            check("Settings landing from the menu", false, "the landing never came up (section '${settingsSection()}')")
            finish()
            return
        }
        val tabId = settingsTabId() ?: run {
            check("a Settings tab", false, "no tab on $SETTINGS_URL")
            finish()
            return
        }
        note("Settings tab $tabId opened next to $demoTab")
        if (!openSettingsSection("updates", 10_000)) note("the Updates section never came up (section '${settingsSection()}')")
        awaitUrl(UPDATES_URL)
        SystemClock.sleep(1_000)
        capture("01-updates")
        check("Updates drilled in", activeUrl() == UPDATES_URL && settingsSection() == "updates", whereabouts(tabId))

        // 2. The overview: the Settings card's picture must be of the Updates section.
        if (openOverview()) {
            capture("02-overview-updates-card")
            judgeCard(tabId, UPDATES_URL, "card picture taken for $UPDATES_URL")
            // 3. A real touch on the card: the overview closes to the tab, on the section it was on.
            val landed = tapCard(tabId)
            capture("03-updates-after-tap")
            check("tap on the card lands on Updates", landed && activeUrl() == UPDATES_URL && settingsSection() == "updates", whereabouts(tabId))
        } else {
            check("the overview for the Updates card", false, "the overview never came up")
        }

        // 4. Back to the landing, then Privacy and Security › See all site data: the drill-in page.
        backTo(SETTINGS_URL)
        if (!openSettingsSection("privacy", 10_000)) note("the Privacy section never came up (section '${settingsSection()}')")
        awaitUrl(PRIVACY_URL)
        SystemClock.sleep(800)
        val opened = touchSettingsRowExpecting(SEE_ALL_ROW, "the site-data page is up", 10_000) { activeUrl() == SITE_DATA_URL }
        if (!opened && activeUrl() != SITE_DATA_URL) {
            Log.w(tag, "the row's touch did not open the page; navigating through the core")
            coreInvoke("page.navigate", "{\"tabId\":${JSONObject.quote(tabId)},\"section\":\"privacy\",\"subpage\":\"site-data\"}")
            awaitUrl(SITE_DATA_URL)
        }
        awaitTrue(4_000) { settingsPage() == "site-data" }
        SystemClock.sleep(1_200)
        capture("04-site-data")
        check("Site data page drilled in", activeUrl() == SITE_DATA_URL && settingsPage() == "site-data" && drillIns() == 2, whereabouts(tabId))
        // The page's list scrolled a little, so the round trip's keeping of it can be read.
        chromeJs("(function(){var s=document.querySelectorAll('.zen-settings-drill-in .zen-settings-scroll');if(s.length)s[s.length-1].scrollTop=120})()")
        SystemClock.sleep(600)
        val scrollBefore = paneScroll()
        note("before the overview: ${whereabouts(tabId)}")

        // 5. The overview: the card's picture must be of the site-data page.
        if (openOverview()) {
            capture("05-overview-site-data-card")
            judgeCard(tabId, SITE_DATA_URL, "card picture taken for $SITE_DATA_URL")
            // 6. The tap lands on the page, nothing of it lost.
            val landed = tapCard(tabId)
            capture("06-site-data-after-tap")
            check("tap on the card lands on the site-data page", landed && activeUrl() == SITE_DATA_URL && settingsPage() == "site-data" && drillIns() == 2, whereabouts(tabId))
            note("after the first return: ${whereabouts(tabId)} (scroll before ${scrollBefore})")
        } else {
            check("the overview for the site-data card", false, "the overview never came up")
        }

        // 7. The overview again and the tap again: the round trip keeps the page.
        if (openOverview()) {
            capture("07-overview-again")
            judgeCard(tabId, SITE_DATA_URL, "card picture kept for $SITE_DATA_URL on the second overview")
            val landed = tapCard(tabId)
            capture("08-site-data-after-second-tap")
            val scrollAfter = paneScroll()
            check(
                "return from the overview keeps the site-data page",
                landed && activeUrl() == SITE_DATA_URL && settingsPage() == "site-data" && drillIns() == 2,
                whereabouts(tabId)
            )
            check("return keeps the page's scroll", scrollBefore >= 0 && scrollAfter == scrollBefore, "scroll $scrollBefore -> $scrollAfter CSS px")
        }

        // 8. A back from the page: the section beneath it, then the landing beneath the section.
        val toSection = backTo(PRIVACY_URL)
        capture("09-back-to-privacy")
        check("back from the page returns to the section beneath", toSection && settingsSection() == "privacy" && drillIns() == 1, whereabouts(tabId))
        val toLanding = backTo(SETTINGS_URL)
        check("back from the section returns to the landing", toLanding && settingsSection() == SETTINGS_LANDING && drillIns() == 0, whereabouts(tabId))

        // 9. The tab left on the drill-in page for act two (the session saved with it).
        coreInvoke("page.navigate", "{\"tabId\":${JSONObject.quote(tabId)},\"section\":\"privacy\",\"subpage\":\"site-data\"}")
        awaitUrl(SITE_DATA_URL)
        awaitTrue(4_000) { settingsPage() == "site-data" }
        SystemClock.sleep(3_000)
        note("left for act two: ${whereabouts(tabId)}; picture ${pictureFile(tabId)}, thumbnail.load ${pictureFor(tabId, SITE_DATA_URL)}")
        finish()
    }
}

/** The second act, after `am force-stop`: the restored tab on its page, its card's picture from disk, the tap landing there. */
@RunWith(AndroidJUnit4::class)
class SettingsTabPreviewRestoreDemo : SettingsTabPreviewDemoBase(
    null,
    "settings-tab-preview-restore",
    "settings-tab-preview-restore-demo",
    keepProfile = true
) {
    override val tag = "SettingsTabPreviewRestoreDemo"

    override fun demo() {
        val tabId = settingsTabId()
        note("restored: active ${activeTabId()} ${activeUrl()}; Settings tab $tabId, picture ${tabId?.let { pictureFile(it) }}")
        awaitTrue(8_000) { settingsPage() == "site-data" }
        SystemClock.sleep(1_500)
        capture("01-restored-site-data")
        check(
            "cold restore lands on the site-data page",
            tabId != null && activeTabId() == tabId && activeUrl() == SITE_DATA_URL && settingsPage() == "site-data" && drillIns() == 2,
            whereabouts(tabId)
        )
        if (tabId == null) {
            finish()
            return
        }

        // The overview: the card's picture from disk, stamped with the page's address.
        if (openOverview()) {
            capture("02-restored-overview-card")
            judgeCard(tabId, SITE_DATA_URL, "restored card picture is of $SITE_DATA_URL")
            val landed = tapCard(tabId)
            capture("03-restored-after-tap")
            check("tap on the restored card lands on the site-data page", landed && activeUrl() == SITE_DATA_URL && settingsPage() == "site-data" && drillIns() == 2, whereabouts(tabId))
        } else {
            check("the restored overview", false, "the overview never came up")
        }

        // A back: the section beneath the restored page.
        val toSection = backTo(PRIVACY_URL)
        capture("04-restored-back-to-privacy")
        check("back from the restored page returns to the section beneath", toSection && settingsSection() == "privacy" && drillIns() == 1, whereabouts(tabId))
        finish()
    }
}
