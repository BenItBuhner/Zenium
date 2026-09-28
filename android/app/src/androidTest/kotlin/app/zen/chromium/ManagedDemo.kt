package app.zen.chromium

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.RestrictionsManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records the app menu's Managed Browser row and the `zen://management` page (TB-13; Chrome for
 * Android 152's "Managed browser" row under `ManagedBrowserUtils.isBrowserManaged()` opening
 * chrome://management) on one boot, every press a real touch, every outcome read off the chrome's
 * DOM or the core's state:
 *
 *  A. The device as found, no managed configuration: the app menu opened by a finger has NO
 *     Managed Browser row and still ends on Change Menu (Chrome shows the row only under a
 *     policy); the core's `managed.status`, read once on that first menu build, is unmanaged.
 *  B. The seam: the shell makes the instrumentation package the device owner (`dpm
 *     set-device-owner`, the test manifest's [ManagedTestAdmin]) and as the owner the package
 *     hands Zenium an app-restrictions bundle through `DevicePolicyManager.setApplicationRestrictions`
 *     – the path an EMM's device policy controller takes, so the app reads it through
 *     `RestrictionsManager` as it would in the field; nothing in the app is overridden. The
 *     owner's calls have to come from the test package's own uid and the driver runs in Zenium's
 *     process (run 36461628148: `SecurityException: Admin ... is not owned by uid`), so they are
 *     made by [ManagedSeedReceiver], a receiver of the test package reached by an ordered
 *     broadcast, whose result comes back to the driver. The running core still says unmanaged
 *     (one read per lifetime), so the app is started again.
 *  C. On the fresh boot the app menu's LAST row is Managed Browser, right under Change Menu with
 *     Chrome's `ic_domain` mark (Lucide Building2) at its trail, and `managed.status` names the
 *     organisation the bundle's `EnterpriseCustomLabel` gives and lists the bundle's keys, sorted.
 *  D. A real touch on the row opens `zen://management` in a NEW tab in front, the page's child
 *     (`openerTabId`): the title "Management", Chrome's subtitle "Your browser is managed by
 *     <org>", the notice that says Zenium reads the configuration and does not yet apply it, and
 *     the keys as static rows under "Settings your administrator set" with their count.
 *  E. The same page and menu on the dark scheme (the design record's pair).
 *  F. The device as it was found: the bundle cleared and the ownership given back (the owner's
 *     own `clearDeviceOwnerApp`, through the same receiver), whatever came before (a `finally`),
 *     so the next driver on the boot meets an unmanaged browser.
 *
 * Findings in `managed-findings.txt` (one `OK` or `FAIL` per claim; a claim that does not hold
 * fails the run at the end). The seeded profile is the tab-group drivers' (`tab-groups-demo-
 * state.json`: Home active, the pages the driver's own loopback server's). Driven by
 * `android-managed-demo.yml` and by the nightly sweep's phone-d shard. See [GroupsDemoBase] and
 * [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class ManagedDemo : GroupsDemoBase("managed", "managed-demo") {
    override val tag = "ManagedDemo"
    override val findingsFile = "managed-findings.txt"
    override val title = "Zenium Android Managed Browser row and zen://management (TB-13)"

    private val dpm: DevicePolicyManager by lazy { app.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager }

    /** The test package's admin: the device owner for the run ([ManagedTestAdmin]). */
    private val admin: ComponentName by lazy { ComponentName(instrumentation.context.packageName, ManagedTestAdmin::class.java.name) }

    /** Whether the test package is the device owner (made so by this run, or found so). */
    private var owner = false

    @Test
    fun record() = recordDemo()

    override fun warmUp() {
        head()
        awaitLoaded(HOME, "$ORIGIN/")
        SystemClock.sleep(1_500)
        // The chrome's CSS px against the screen, read once off the bar's Tabs control.
        calibrate("[aria-label^=\"Tabs (\"]", "Tabs (", prefix = true)
        finding("warm-up done: ${describeSpace()}; restrictions as found ${restrictionKeys()}; device owner ${dpm.isDeviceOwnerApp(admin.packageName)}")
    }

    override fun demo() {
        try {
            still("page")
            unmanaged()
            if (seed()) {
                managedMenu()
                managementPage()
                dark()
            }
        } finally {
            cleanUp()
        }
        still("end")
        tail()
    }

    // --- A. no bundle, no row ----------------------------------------------------------------------

    private fun unmanaged() {
        section("A. The device as found, no managed configuration: no Managed Browser row")
        val rows = openMenuRows("A") ?: return
        check("A: the app menu has no $ROW row and still ends on Change Menu", ROW !in rows && rows.lastOrNull() == "Change Menu", "rows $rows")
        check("A: no managed mark anywhere in the sheet", !inDom("$SHEET_ITEM $MARK"), "")
        finding("  the list's end revealed in the tree at ${reveal("Change Menu")}")
        SystemClock.sleep(600)
        still("menu-unmanaged-light")
        closeMenu()
        val status = status()
        finding("  managed.status after the menu's first build: $status")
        check("A: the core's status is unmanaged – no keys, no name", status.getJSONArray("keys").length() == 0 && status.isNull("by"), "$status")
    }

    // --- B. the seam --------------------------------------------------------------------------------

    /** The bundle handed to the app the EMM way; true when it is in place and the app started again. */
    private fun seed(): Boolean {
        section("B. The seam: the test package made device owner through the shell, the bundle set through DevicePolicyManager as the owner")
        if (!dpm.isDeviceOwnerApp(admin.packageName)) {
            val out = shellCommand("dpm set-device-owner ${admin.flattenToString()}").trim()
            finding("  dpm set-device-owner ${admin.flattenToString()}: ${out.ifEmpty { "(no output)" }}")
        }
        owner = dpm.isDeviceOwnerApp(admin.packageName)
        check("B: the test package is the device owner (a device with no accounts and one user takes dpm set-device-owner after setup)", owner, "isDeviceOwnerApp $owner")
        if (!owner) return false
        val bundle = Bundle().apply {
            putString(ManagedRestrictions.ORG_KEY, ORG)
            putString("HomepageLocation", "https://intranet.nimbus.example/")
            putStringArray("URLBlocklist", arrayOf("social.nimbus.example"))
            putInt("IncognitoModeAvailability", 1)
            putBoolean("BookmarkBarEnabled", false)
        }
        val set = asOwner(ManagedSeedReceiver.ACTION_SEED, bundle)
        finding("  setApplicationRestrictions(${app.packageName}, ${KEYS.size} keys) by the owner's process: $set")
        val keys = restrictionKeys()
        finding("  RestrictionsManager.getApplicationRestrictions() in the app's own process now: $keys")
        check("B: the app's restrictions bundle carries the seeded keys", keys == KEYS, "$keys")
        if (keys != KEYS) return false
        val stale = status()
        check("B: the running core still says unmanaged – one read per lifetime; a change lands on the next start", stale.getJSONArray("keys").length() == 0, "$stale")
        finding("  the app started again: a fresh activity, host and core, which read the bundle on the menu's first build")
        launch()
        awaitLoaded(HOME, "$ORIGIN/")
        SystemClock.sleep(1_500)
        ensureForeground()
        finding("  after the start: ${describeSpace()}")
        return true
    }

    // --- C. the row ---------------------------------------------------------------------------------

    private fun managedMenu() {
        section("C. The Managed Browser row: last of the app menu, under Change Menu, Chrome's business glyph at its trail")
        val rows = openMenuRows("C") ?: return
        check("C: $ROW is the LAST row of the menu, right after Change Menu (Chrome's seat: after Help & feedback, over a divider)", rows.lastOrNull() == ROW && rows.getOrNull(rows.size - 2) == "Change Menu", "rows $rows")
        val marks = jsNumber("document.querySelectorAll('$SHEET_ITEM $MARK').length")
        check("C: the row carries the managed mark (Building2, Chrome's ic_domain) and no other row does", marks == 1.0 && markedRow() == ROW, "marks $marks on '${markedRow()}'")
        val status = status()
        finding("  managed.status after the fresh menu's first build: $status")
        check("C: the status names the organisation ($ORG, the bundle's EnterpriseCustomLabel) and lists the seeded keys, sorted", status.optString("by") == ORG && status.getJSONArray("keys").strings() == KEYS, "$status")
        val revealed = reveal(ROW)
        finding("  $ROW revealed in the tree at $revealed")
        SystemClock.sleep(600)
        still("menu-managed-light")
    }

    // --- D. the page --------------------------------------------------------------------------------

    private fun managementPage() {
        section("D. A real touch on the row opens $MANAGEMENT_URL in a new tab in front, the page's child")
        val before = tabIds()
        var touched = touchTapLabel(ROW)
        if (!touched) {
            finding("  (the tree had no $ROW to touch; the DOM's box instead)")
            touched = touchUntil(ROW, { textRect(SHEET_ITEM, ROW) }, { tabIds().size == before.size + 1 }, waitMs = 6_000)
        }
        val opened = touched && awaitCore(10_000) { st -> newTabIn(st, before)?.let { tabUrl(it, st) == MANAGEMENT_URL } == true }
        val pageTab = newTabIn(coreState(), before)
        val page = pageTab?.let { tab(it) }
        finding("  after the touch: touched $touched; new tab ${pageTab ?: "none"} url ${page?.optString("url")} active ${activeTabId() == pageTab} opener ${page?.optString("openerTabId")}")
        check("D: the touch opens $MANAGEMENT_URL in a NEW tab", opened, "new ${page?.optString("url")}")
        if (pageTab == null) return
        check("D: the page is in front (Chrome's openChromeManagementPage: a new tab in front)", awaitCore { activeTabId(it) == pageTab }, "active ${activeTabId()}")
        check("D: the page is the tab's child (openerTabId = the tab the menu was over; the system back returns to it)", page?.optString("openerTabId") == HOME, "opener ${page?.optString("openerTabId")}")
        check("D: the menu is gone after the touch", awaitJs(MENU_OPEN, false, SHEET_WAIT), "menu ${jsText(MENU_OPEN)}")
        val drawn = awaitDom(PAGE, 8_000) && awaitDom(KEY_ROW, 8_000)
        check("D: the Management page is drawn with its key rows", drawn, "page ${inDom(PAGE)}, rows ${inDom(KEY_ROW)}")
        if (!drawn) return
        val title = textOf(TITLE)
        val subtitle = textOf(SUBTITLE)
        val notice = textOf(NOTICE)
        val group = textOf(GROUP_HEADING)
        val aside = textOf(ASIDE)
        val keys = textsOf(KEY_LABEL)
        finding("  title '$title'; subtitle '$subtitle'; notice '$notice'; group '$group' ($aside); keys $keys")
        check("D: the title is Chrome's IDS_MANAGEMENT, 'Management'", title == "Management", "'$title'")
        check("D: the subtitle names the organisation in Chrome's words (IDS_MANAGEMENT_SUBTITLE_MANAGED_BY)", subtitle == "Your browser is managed by $ORG", "'$subtitle'")
        check("D: the notice says what Zenium does with the configuration – reads and lists it, does not apply it yet", notice.contains("Zenium reads it and lists the settings below; it does not apply them yet."), "'$notice'")
        check("D: the keys are the bundle's, sorted, under '$GROUP' with their count in the aside", keys == KEYS && group == GROUP && aside == KEYS.size.toString(), "keys $keys, group '$group', aside '$aside'")
        check("D: the rows are text, not targets (data-static, no button in them)", inDom("$KEY_ROW[data-static]") && !inDom("$KEY_ROW button"), "")
        SystemClock.sleep(800)
        still("management-page-light")
    }

    // --- E. dark ------------------------------------------------------------------------------------

    private fun dark() {
        section("E. The page and the row on the dark scheme")
        shellCommand("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        val dark = awaitUntil(8_000) { chromeScheme() == "dark" }
        SystemClock.sleep(2_500)
        ensureForeground()
        check("E: the chrome's root carries the dark scheme", dark, "data-theme '${chromeScheme()}'")
        if (!awaitDom(KEY_ROW, 6_000)) finding("  (the page's rows are not in the DOM after the switch)")
        still("management-page-dark")
        val rows = openMenuRows("E")
        if (rows != null) {
            check("E: the row is still last in dark", rows.lastOrNull() == ROW, "rows $rows")
            reveal(ROW)
            SystemClock.sleep(600)
            still("menu-managed-dark")
            closeMenu()
        }
        coreInvoke("settings.update", "{\"colorScheme\":\"light\"}")
        shellCommand("cmd uimode night no")
        SystemClock.sleep(2_000)
        finding("  the scheme put back to light and the device's night mode off for the next driver")
    }

    // --- F. the device as it was found --------------------------------------------------------------

    private fun cleanUp() {
        section("F. The device as it was found: the bundle cleared, the ownership given back")
        if (!owner) {
            finding("  nothing to clear: the test package never became the device owner")
            return
        }
        val released = asOwner(ManagedSeedReceiver.ACTION_RELEASE)
        finding("  the owner's process cleared the restrictions and the device owner: $released; the bundle now ${restrictionKeys()}")
        if (dpm.isDeviceOwnerApp(admin.packageName)) {
            finding("  still the owner; the shell's remove-active-admin instead: ${shellCommand("dpm remove-active-admin ${admin.flattenToString()}").trim().ifEmpty { "(no output)" }}")
        }
        owner = dpm.isDeviceOwnerApp(admin.packageName)
        check("F: the bundle is empty again and the test package is no longer the device owner", restrictionKeys().isEmpty() && !owner, "keys ${restrictionKeys()}, owner $owner")
    }

    /**
     * A device-policy call made as the owner: an explicit ordered broadcast to the test package's
     * [ManagedSeedReceiver] (the system starts that package's own process to deliver it), naming
     * Zenium as the package and carrying `restrictions` when there are any; the receiver's result
     * – its note, or the exception's text – as the line for the findings. "no answer" when the
     * broadcast's result never came within [OWNER_WAIT] ms.
     */
    private fun asOwner(action: String, restrictions: Bundle? = null): String {
        val intent = Intent(action)
            .setComponent(ComponentName(instrumentation.context.packageName, ManagedSeedReceiver::class.java.name))
            .addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
            .putExtra(ManagedSeedReceiver.EXTRA_PACKAGE, app.packageName)
        if (restrictions != null) intent.putExtra(ManagedSeedReceiver.EXTRA_RESTRICTIONS, restrictions)
        val done = CountDownLatch(1)
        var outcome = "no answer within $OWNER_WAIT ms"
        val result = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                outcome = "${if (resultCode == Activity.RESULT_OK) "ok" else "refused"} (${resultData ?: "no detail"})"
                done.countDown()
            }
        }
        instrumentation.context.sendOrderedBroadcast(intent, null, result, Handler(Looper.getMainLooper()), Activity.RESULT_CANCELED, null, null)
        done.await(OWNER_WAIT, TimeUnit.MILLISECONDS)
        return outcome
    }

    // --- the menu -----------------------------------------------------------------------------------

    /** The app menu opened by a real tap and pulled to its height; its text rows, or null when it never opened. */
    private fun openMenuRows(act: String): List<String>? {
        ensureForeground()
        val up = tapMenuButton() && waitFor(MENU_HANDLE_LABEL, 6_000) != null
        check("$act: the app menu comes up as a sheet", up, "menu ${jsText(MENU_OPEN)}")
        if (!up) return null
        SystemClock.sleep(1_000)
        pullMenuUp()
        val rows = textsOf(SHEET_ITEM).filter { it.isNotBlank() }
        finding("  rows as found (${rows.size}): ${rows.joinToString(" · ")}")
        return rows
    }

    private fun closeMenu() {
        back()
        if (!awaitJs(MENU_OPEN, false, SHEET_WAIT)) finding("  (the menu did not leave on back)")
        SystemClock.sleep(600)
    }

    // --- reads --------------------------------------------------------------------------------------

    /** The core's word (`managed.status`): the one lazy read, made on the first ask. */
    private fun status(): JSONObject = JSONObject(coreInvoke("managed.status"))

    /** The text of the sheet row that carries the managed mark; "" when none does. */
    private fun markedRow(): String =
        jsText("(function(){var m=document.querySelector('$SHEET_ITEM $MARK');var r=m&&m.closest('.zen-sheet-item');return r?r.textContent.trim():''})()")

    /** The keys of the app's restrictions bundle as the app itself reads them, sorted. */
    private fun restrictionKeys(): List<String> {
        val manager = app.getSystemService(Context.RESTRICTIONS_SERVICE) as RestrictionsManager
        return manager.applicationRestrictions.keySet().sorted()
    }

    private fun tab(id: String, state: JSONObject = coreState()): JSONObject? = state.getJSONObject("tabs").optJSONObject(id)

    private fun tabIds(state: JSONObject = coreState()): Set<String> = state.getJSONObject("tabs").keys().asSequence().toSet()

    /** The one tab in `state` that `before` did not have; null when none or several. */
    private fun newTabIn(state: JSONObject, before: Set<String>): String? = (tabIds(state) - before).singleOrNull()

    companion object {
        private const val ROW = "Managed Browser"
        private const val ORG = "Nimbus Works"
        private const val GROUP = "Settings your administrator set"
        private const val MANAGEMENT_URL = "zen://management"

        /** The seeded bundle's keys as the status lists them: sorted. */
        private val KEYS = listOf("BookmarkBarEnabled", "EnterpriseCustomLabel", "HomepageLocation", "IncognitoModeAvailability", "URLBlocklist")

        /** How long the owner's process gets to answer an ordered broadcast (its cold start included). */
        private const val OWNER_WAIT = 15_000L

        private const val SHEET_ITEM = ".zen-sheet .zen-sheet-item"
        private const val MARK = "[data-mark=\"managed\"]"
        private const val PAGE = "[data-testid=\"management-page\"]"
        private const val TITLE = "#management-title"
        private const val SUBTITLE = "$PAGE .zen-page-title-desc"
        private const val NOTICE = "[data-testid=\"management-notice\"]"
        private const val GROUP_HEADING = "#zen-management-keys"
        private const val ASIDE = "[data-testid=\"management-keys\"] .zen-page-heading-aside"
        private const val KEY_ROW = "[data-testid=\"management-key\"]"
        private const val KEY_LABEL = "$KEY_ROW .zen-page-row-label"
    }
}
