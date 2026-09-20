package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.junit.runner.RunWith
import java.io.File

/**
 * The `android-text-tools-demo` workflow: the text tools' phone surfaces (CT-07, CT-16 to CT-18,
 * CT-22) under real fingers, on the page controls demo's profile (Wikipedia active, the CERN
 * page and a locked page behind it) with sleeping tabs on at the shortest timeout and Wikipedia
 * on the never-sleep list.
 *
 *  1. Settings > Languages > Spell check: the WebView host has no checker of its own, so the
 *     group states the keyboard's and its one row, Keyboard settings, leads out of the app – a
 *     finger on it, and the system's input-method settings must come to the front.
 *  2. Settings > Accessibility > Page zoom: a finger on Zoom in twice steps the default zoom up
 *     Chrome's ladder (the core's `pageControls.zoom` must follow each), and one on Force enable
 *     zoom flips its switch (`forceZoom` must read true).
 *  3. Settings > Look and Feel > Sites: a finger on Apply dark theme to sites flips its switch
 *     (`darkenSites` must read true), and the page's WebView must then allow algorithmic
 *     darkening (`WebSettingsCompat.isAlgorithmicDarkeningAllowed`).
 *  4. The CERN tab, visited at warm-up and left behind, has meanwhile passed the 30 s timeout
 *     and been put to sleep by the half-minute check (its `discarded` flag); Wikipedia, on the
 *     never-sleep list, has not. The overview is pulled in from the pill and shows the CERN card
 *     faded with the moon and "sleeping" in its label; a finger on the card must wake the tab
 *     (`discarded` false again) and its page load anew.
 *
 * Every control pressed inside a sheet or a panel takes a real finger whose result is asserted
 * (the rule in DemoHarness, the audit after #194); the tree's click only opens the Settings tab
 * and its sections, which are pages, not sheets. What each step found goes to
 * `text-tools-results.json` next to the screenshots.
 */
@RunWith(AndroidJUnit4::class)
class TextToolsUiDemo : PageControlsDemo("pagecontrols-demo-state.json", "services-text-tools-android", "text-tools-demo") {
    override val tag = "TextToolsUiDemo"

    private val results = JSONObject()
    /** When the CERN page was last left, for the sleep's measured delay. */
    private var cernLeftAt = 0L

    /**
     * The page controls profile with the sleeping tabs on at the ladder's shortest step, Wikipedia
     * on the never-sleep list, and the dark theme for sites off (the finger turns it on) with no
     * exceptions (the seed excepts Wikipedia, which is the page whose darkening is read).
     */
    override fun patchState(json: String): String {
        val state = JSONObject(super.patchState(json))
        val settings = state.getJSONObject("settings")
        settings.put("unloadEnabled", true)
        settings.put("unloadTimeoutMinutes", 0.5)
        settings.put("unloadExcludedDomains", JSONArray().put(WIKI_HOST))
        val controls = settings.getJSONObject("pageControls")
        controls.put("darkenSites", false)
        controls.put("darkenSiteExceptions", JSONObject())
        return state.toString()
    }

    override fun warmUp() {
        warmUpChrome()
        awaitPage(WIKI_HOST, 30_000)
        // The CERN page is loaded and left: a hidden, loaded page whose sleep clock runs from here.
        // Forward to it with a fling, back to Wikipedia with the other (the tabs do not wrap).
        val loaded = switchToTab(CERN_HOST)
        if (loaded) {
            SystemClock.sleep(1_000)
            flingRight()
            settle()
            if (!awaitPage(WIKI_HOST, 15_000)) Log.w(tag, "the fling back did not land on Wikipedia")
        }
        cernLeftAt = SystemClock.uptimeMillis()
        results.put("cernLoadedAtWarmUp", loaded)
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        try {
            snap("wikipedia")
            spellcheckSection()
            zoomSection()
            darkThemeForSitesSection()
            sleepingTabSection()
        } finally {
            File(out, "text-tools-results.json").writeText(results.toString(2))
            Log.i(tag, "results: $results")
        }
    }

    // --- 1. Spell check on a WebView host ---------------------------------------------------------

    private fun spellcheckSection() {
        val step = JSONObject()
        if (!openSettings("Languages")) {
            results.put("spellcheck", step.put("opened", false))
            return
        }
        val row = revealRow(KEYBOARD_SETTINGS_ROW)
        step.put("opened", true).put("keyboardRow", row != null)
        step.put("statesKeyboard", findNode { it.contains("spell checker of the keyboard") } != null)
        SystemClock.sleep(800)
        snap("settings-languages-spellcheck")
        // The one control of the group under a finger: the system's own settings must come up.
        val left = touchTapLabelExpecting(
            KEYBOARD_SETTINGS_ROW,
            "the system's input-method settings are in front",
            timeoutMs = 10_000,
            prefix = true
        ) { topPackage() != app.packageName }
        step.put("keyboardSettingsOpened", left).put("frontPackage", topPackage() ?: JSONObject.NULL)
        if (left) {
            SystemClock.sleep(1_500)
            snap("system-keyboard-settings")
        }
        ensureForeground()
        SystemClock.sleep(1_200)
        step.put("backInApp", topPackage() == app.packageName)
        Log.i(tag, "spell check: $step")
        results.put("spellcheck", step)
        ensureChromeClear()
    }

    // --- 2. Page zoom -----------------------------------------------------------------------------

    private fun zoomSection() {
        val step = JSONObject()
        if (!openSettings("Accessibility")) {
            results.put("zoom", step.put("opened", false))
            return
        }
        step.put("opened", revealRow(DEFAULT_ZOOM_ROW) != null)
        SystemClock.sleep(800)
        snap("settings-accessibility-page-zoom")
        val start = coreZoom()
        step.put("zoomBefore", start)
        // Two fingers on Zoom in: the core's default zoom climbs Chrome's ladder each time.
        val first = touchTapLabelExpecting(ZOOM_IN, "the default zoom stepped up from $start") { coreZoom() > start }
        val afterFirst = coreZoom()
        val second = touchTapLabelExpecting(ZOOM_IN, "the default zoom stepped up from $afterFirst") { coreZoom() > afterFirst }
        step.put("zoomInTook", JSONArray().put(first).put(second)).put("zoomAfter", coreZoom())
        SystemClock.sleep(1_000)
        snap("settings-accessibility-page-zoom-stepped")
        // Force enable zoom under a finger: the row is the switch on a phone.
        revealRow(FORCE_ZOOM_ROW)
        SystemClock.sleep(600)
        val forced = touchTapLabelExpecting(FORCE_ZOOM_ROW, "Force enable zoom reads on", prefix = true) {
            pageControls().optBoolean("forceZoom")
        }
        step.put("forceZoomTook", forced).put("forceZoom", pageControls().optBoolean("forceZoom"))
        SystemClock.sleep(1_000)
        snap("settings-accessibility-force-zoom-on")
        Log.i(tag, "zoom: $step")
        results.put("zoom", step)
        ensureChromeClear()
        awaitPage(WIKI_HOST, 20_000)
        SystemClock.sleep(2_000)
        probe("default zoom stepped twice")
        step.put("pageWidth", probeValue("document.documentElement.clientWidth") ?: JSONObject.NULL)
        snap("wikipedia-zoomed")
    }

    // --- 3. Dark theme for sites ------------------------------------------------------------------

    private fun darkThemeForSitesSection() {
        val step = JSONObject()
        step.put("darkeningBefore", darkeningAllowed() ?: JSONObject.NULL)
        if (!openSettings("Look and Feel")) {
            results.put("darkTheme", step.put("opened", false))
            return
        }
        step.put("opened", revealRow(DARK_THEME_ROW) != null)
        SystemClock.sleep(800)
        snap("settings-look-and-feel-sites")
        val flipped = touchTapLabelExpecting(DARK_THEME_ROW, "Apply dark theme to sites reads on", prefix = true) {
            pageControls().optBoolean("darkenSites")
        }
        step.put("switchTook", flipped).put("darkenSites", pageControls().optBoolean("darkenSites"))
        SystemClock.sleep(1_000)
        snap("settings-look-and-feel-dark-theme-on")
        ensureChromeClear()
        awaitPage(WIKI_HOST, 20_000)
        SystemClock.sleep(2_500)
        // The host's word: the page's WebView allows algorithmic darkening now (the chrome is dark).
        step.put("darkeningAfter", darkeningAllowed() ?: JSONObject.NULL)
        step.put("schemeSeen", schemeSeen() ?: JSONObject.NULL)
        Log.i(tag, "dark theme for sites: $step")
        results.put("darkTheme", step)
        snap("wikipedia-darkened")
    }

    // --- 4. A sleeping tab waking -----------------------------------------------------------------

    private fun sleepingTabSection() {
        val step = JSONObject()
        // The timeout is 30 s and the check runs every 30 s: the CERN page, left at warm-up, is
        // asleep by now or within the minute. Wikipedia is on the never-sleep list and stays.
        val deadline = SystemClock.uptimeMillis() + 90_000
        var cern = tabState(CERN_TAB)
        while (SystemClock.uptimeMillis() < deadline && cern?.optBoolean("discarded") != true) {
            SystemClock.sleep(1_000)
            cern = tabState(CERN_TAB)
        }
        val asleep = cern?.optBoolean("discarded") == true
        step.put("cernAsleep", asleep)
            .put("asleepAfterMs", if (asleep) SystemClock.uptimeMillis() - cernLeftAt else JSONObject.NULL)
            .put("savedMb", cern?.opt("sleepSavedMb") ?: JSONObject.NULL)
            .put("wikipediaAwake", tabState(WIKI_TAB)?.optBoolean("discarded") == false)
        Log.i(tag, "sleeping: $step")
        if (!asleep) {
            results.put("sleeping", step)
            return
        }
        // The overview from the pill: the CERN card reads "… – sleeping", faded, with the moon.
        openOverview()
        val card = awaitNode(10_000) { it.endsWith(SLEEPING_SUFFIX) }
        step.put("sleepingCard", card?.let { it.contentDescription ?: it.text }?.toString() ?: JSONObject.NULL)
        SystemClock.sleep(800)
        snap("overview-sleeping-card")
        if (card == null) {
            Log.w(tag, "no sleeping card in the overview")
            results.put("sleeping", step)
            back()
            return
        }
        // A finger on the card: the tab wakes (its page is created again) and comes to the front.
        val touched = touchTap(card)
        val woke = touched && awaitTab(CERN_TAB, 10_000) { !it.optBoolean("discarded") }
        if (touched && !woke) touchFault("a touch on the sleeping card did not wake the CERN tab within 10 s")
        step.put("cardTouched", touched).put("woke", woke)
        val loaded = awaitPage(CERN_HOST, 30_000)
        step.put("pageLoadedAgain", loaded).put("activeTab", activeCoreTab()?.optString("id") ?: JSONObject.NULL)
        SystemClock.sleep(1_500)
        snap("cern-awake")
        Log.i(tag, "woke: $step")
        results.put("sleeping", step)
    }

    // --- readings ---------------------------------------------------------------------------------

    private fun pageControls(): JSONObject = coreState().getJSONObject("settings").getJSONObject("pageControls")

    private fun coreZoom(): Double = pageControls().optDouble("zoom", 1.0)

    private fun tabState(tabId: String): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(tabId)

    private fun awaitTab(tabId: String, timeoutMs: Long, holds: (JSONObject) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            tabState(tabId)?.let { if (holds(it)) return true }
            SystemClock.sleep(250)
        }
        return tabState(tabId)?.let(holds) == true
    }

    private fun topPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

    /** Whether the page's WebView allows algorithmic darkening; null without a page or the feature. */
    private fun darkeningAllowed(): Boolean? {
        val web = pageWebView() ?: return null
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) return null
        var allowed = false
        instrumentation.runOnMainSync { allowed = WebSettingsCompat.isAlgorithmicDarkeningAllowed(web.settings) }
        return allowed
    }

    /** Pull the overview in from the pill and let go, then wait for it to be at rest. */
    private fun openOverview() {
        ensureChromeClear()
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.settleIn(0f, -NUDGE)
        f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 400)
        f.up()
        if (waitFor("Spaces", 8_000) == null) Log.w(tag, "the overview never showed")
        SystemClock.sleep(3_500)
    }

    private companion object {
        const val WIKI_HOST = "en.wikipedia.org"
        const val WIKI_TAB = "tab_wiki"
        const val CERN_TAB = "tab_cern"
        const val KEYBOARD_SETTINGS_ROW = "Keyboard settings"
        const val DARK_THEME_ROW = "Apply dark theme to sites"
        const val ZOOM_IN = "Zoom in"
        /** The overview card's label for a sleeping tab (`OverviewCard`): the title, an en dash, the word. */
        const val SLEEPING_SUFFIX = "– sleeping"
    }
}
