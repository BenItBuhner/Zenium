package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Records Settings › Sync on the phone (ID-08's UI, `pages/settings/sync.tsx`) end to end
 * against the real engine and a real document tree: the Sync category from the app menu's
 * Settings, the sync folder granted through the system's folder picker (a `ZeniumSync` folder
 * the shell made on the device's storage, chosen in DocumentsUI with a finger: the folder, Use
 * this folder, Allow), the passphrase sheet (fingers on both secret fields, the passphrase typed
 * as key events, a finger on Turn on sync; the form busy while scrypt-js derives the key in the
 * WebView), the connected page with its status line, a toggle flipped (Open tabs, so the other
 * device's tab is wanted), a SECOND DEVICE's file seeded into the tree by the driver itself
 * ([SyncPeer]: the folder's salt read off this device's file, the same passphrase, a Space with
 * a tab and a bookmark under the shared key), Sync now with a finger and the records landing –
 * the device in the list with its last-seen time, the Space, its tab, the bookmark in the
 * core's state – then Turn off sync with the wipe-remote checkbox row (this device's file gone
 * from the tree, the other's kept), and – the other device having written once more in the
 * meantime, a second bookmark – the folder chosen and the passphrase set up once more so the
 * folder's existing data raises the merge question: its sheet's radios and Continue with a
 * finger, the new bookmark landing with the rest.
 *
 * The rule in [DemoHarness] (#194's audit, #198): every control pressed inside a sheet – the
 * app menu's Settings row, the picker's folder row and its two buttons, the passphrase form's
 * fields and its button, the checkbox row and Turn off, the merge sheet's radios and Continue –
 * is a real injected touch whose effect is asserted against the core's state or the window that
 * came up; a touch that did not take is a [touchFault] the run fails on at its end. The rows on
 * the page (the category, the folder row, Turn on sync, the toggle, Sync now, Turn off sync) are
 * touched too ([tapRow]), with a second finger at the row's rectangle in the chrome when the
 * tree's bounds trailed a scroll. Findings go to `<shotPrefix>-notes.txt` beside the stills.
 */
@RunWith(AndroidJUnit4::class)
class SyncDemo : DemoHarness("sync-demo-state.json", "services-sync-android-android", "sync-demo") {
    override val tag = "SyncDemo"
    private lateinit var server: DemoServer
    private lateinit var notes: File
    private var shots = 0
    private val startedAt = SystemClock.uptimeMillis()
    /** How many times the second device has written its file (its second round adds a bookmark). */
    private var peerRounds = 0
    /** The folder's salt, read off this device's file at the first seeding (the other device keeps it). */
    private var peerSalt: String? = null

    @Test
    fun record() {
        server = DemoServer(PORT, mapOf("/" to ("text/html; charset=utf-8" to PAGE.toByteArray()))).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun beforeLaunch() {
        // The folder the picker is steered to, made by the shell: the app has no leave to write
        // the device's storage itself, and a fresh one each run so the tree starts empty.
        shell("rm -rf $FOLDER_PATH; mkdir -p $FOLDER_PATH")
    }

    override fun warmUp() {
        notes = File(out, "services-sync-android-android-notes.txt")
        notes.writeText("Zenium Android sync demo\n\n")
        note("device ${Build.MODEL} (${Build.VERSION.SDK_INT}); demo server ${server.selfCheck()}")
        note("folder $FOLDER_PATH: ${shell("ls -ld $FOLDER_PATH").trim()}")
        // The Settings page is a chunk of its own that loads on its first open: pay for it off
        // camera, then put the profile back as seeded.
        val warm = coreInvoke("page.open", """{"id":"settings","section":"sync"}""")
        val painted = awaitChrome("document.querySelector('[data-row=\"sync-folder\"]')", 20_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", """{"tabId":$warm}""")
        SystemClock.sleep(800)
        ensureDemoTab()
        note("warm-up: the Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera")
        val close = closeUrlField()
        if (!close.ok) note("warm-up: ${close.describe()}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. Settings › Sync through the app menu and the landing's category row.
        note("\n1. Settings › Sync")
        openSyncSettings()
        snap("settings-folder-unset")
        note("  ${describeSync()}")

        // 2. The folder: the system picker, a tree granted with a finger.
        note("\n2. the sync folder")
        grantFolder()
        snap("settings-folder-set")

        // 3. Turn on sync: the passphrase sheet.
        note("\n3. the passphrase sheet")
        turnOnSync(firstTime = true)
        snap("settings-connected")
        note("  ${describeSync()}")
        note("  tree: ${treeListing()}")

        // 4. What you sync: Open tabs on, so the other device's tab is wanted.
        note("\n4. a toggle")
        flipOpenTabs()
        snap("toggle-open-tabs")

        // 5. The second device writes its file into the tree.
        note("\n5. the second device")
        seedPeer()

        // 6. Sync now: its records land, the device appears.
        note("\n6. Sync now")
        syncNow()
        revealRow(PEER_NAME)
        SystemClock.sleep(600)
        snap("settings-devices")
        showLanded()

        // 7. Turn off sync, this device's data removed from the folder.
        note("\n7. Turn off sync")
        turnOffSync()
        snap("settings-off")
        note("  tree: ${treeListing()}")

        // 8. The other device writes once more; set up again into the folder with its data: the
        //    merge question, and what it wrote in the meantime landing on the answer.
        note("\n8. the merge question")
        seedPeer()
        grantFolder()
        turnOnSync(firstTime = false)
        snap("settings-merge-pending")
        answerMerge()
        revealRow(PEER_NAME)
        SystemClock.sleep(600)
        snap("settings-merged")
        note("  ${describeSync()}")
        note("\ndone in ${(SystemClock.uptimeMillis() - startedAt) / 1000} s")
    }

    // --- 1. the section --------------------------------------------------------------------------

    /**
     * The app menu's Settings row is a sheet's row: a finger once its bounds hold still
     * ([openMenuItem]), and the Settings tab must come up on it – else a [touchFault] and
     * `page.open` is the way on so the recording goes on. The landing's Sync row is a page row: a
     * finger, and the tab must come to the section on it.
     */
    private fun openSyncSettings() {
        ensureForeground()
        if (!openMenuItem("Settings")) {
            touchFault("no Settings row in the app menu to touch")
            closeSheets()
            coreInvoke("page.open", """{"id":"settings"}""")
        } else if (awaitPage(SETTINGS_URL, 12_000) == null) {
            touchFault("the touch on the app menu's Settings row did not open the Settings tab")
            closeSheets()
            coreInvoke("page.open", """{"id":"settings"}""")
        } else {
            note("  the touch on the menu's Settings row took: the Settings tab is up")
        }
        if (awaitPage(SETTINGS_URL, 12_000) == null) error("Settings did not come up")
        SystemClock.sleep(1_200)
        if (rowBounds("Sync", 8_000) == null) {
            note("  no Sync category on the landing")
        } else if (!touchTapLabelExpecting("Sync", "the tab is at the Sync section", prefix = true) {
                activeCoreTab()?.optString("url") == SECTION_URL
            }
        ) {
            note("  the landing's Sync row did not take the tab to the section")
        } else {
            note("  the touch on the landing's Sync row took: the tab is at the section")
        }
        if (activeCoreTab()?.optString("url") != SECTION_URL) coreInvoke("page.open", """{"id":"settings","section":"sync"}""")
        if (awaitPage(SECTION_URL, 12_000) == null) error("the tab did not come to the Sync section")
        awaitSurface(up = true, timeoutMs = 6_000)
        if (rowBounds(FOLDER_LABEL, 10_000) == null) error("no $FOLDER_LABEL row on the section")
        SystemClock.sleep(800)
    }

    // --- 2. the folder ---------------------------------------------------------------------------

    /**
     * A finger on the folder row brings the system's folder picker up; inside it the folder's
     * row, Use this folder and the permission dialog's Allow are each a finger too, the picker's
     * own controls being the sheet flow's (the rule in [DemoHarness]). The row must then read
     * the folder's name: the host persisted the tree's permission and answered the chrome with
     * its URI, which the setup draft holds.
     */
    private fun grantFolder() {
        if (!tapRow(FOLDER_LABEL, "sync-folder", timeoutMs = 12_000) { documentPickerShowing() }) {
            error("the folder row did not bring the system picker up")
        }
        SystemClock.sleep(1_500)
        snap("picker-open")
        if (!pickTree(FOLDER)) {
            touchFault("the system picker did not grant $FOLDER under a finger")
            dumpNames("the picker")
            back()
            error("no tree granted")
        }
        if (!awaitSettled({ rowReads(FOLDER_LABEL, FOLDER) }, 12_000)) {
            note("  the folder row does not read '$FOLDER': ${rowText(FOLDER_LABEL)}")
            touchFault("the granted tree did not reach the folder row")
        } else {
            note("  the folder row reads: ${rowText(FOLDER_LABEL)}")
        }
        val grants = shell("dumpsys activity uri-grants 2>/dev/null | grep -i zenium | head -n 5").trim()
        if (grants.isNotEmpty()) note("  persisted grants: $grants")
    }

    /**
     * DocumentsUI in tree mode: the folder's row (opening the roots drawer and the device's own
     * storage first when the picker opened elsewhere), then the confirmation button and the
     * permission dialog's Allow, each a finger where the node's bounds are. False when a step's
     * control never came; the caller reports the fault.
     */
    private fun pickTree(name: String): Boolean {
        if (!awaitPicker(10_000)) {
            note("  no document picker window came up")
            return false
        }
        var row = waitForNode(name, 6_000)
        if (row == null) {
            note("  the picker did not open on the storage root; through the roots drawer")
            val roots = findLabelled("Show roots") ?: findLabelled("Show roots", role = "android.widget.ImageButton") ?: run {
                note("  no Show roots button")
                return false
            }
            tapRect(roots)
            SystemClock.sleep(1_200)
            snap("picker-roots")
            val storage = storageRoot() ?: run {
                note("  no storage root in the drawer")
                dumpNames("the roots drawer", PICKER_PACKAGES)
                return false
            }
            tapRect(storage)
            row = waitForNode(name, 8_000) ?: run {
                note("  no '$name' folder in the storage root")
                dumpNames("the storage root", PICKER_PACKAGES)
                return false
            }
        }
        SystemClock.sleep(500)
        tapRect(row)
        // Inside the folder: the confirmation ("Use this folder" from Android 11; "Select" before).
        val use = waitForAny(listOf("Use this folder", "Select"), 8_000, role = "android.widget.Button") ?: run {
            note("  no Use this folder button")
            dumpNames("the folder", PICKER_PACKAGES)
            return false
        }
        SystemClock.sleep(600)
        snap("picker-folder")
        tapRect(use)
        val allow = waitForAny(listOf("Allow", "OK"), 8_000) ?: run {
            note("  no Allow in the permission dialog")
            dumpNames("the permission dialog", PICKER_PACKAGES)
            return false
        }
        snap("picker-allow")
        tapRect(allow)
        val gone = awaitPickerGone(10_000)
        note("  the picker ${if (gone) "closed on Allow" else "is still up"}")
        return gone
    }

    /** The drawer's row for the device's own storage: by its names, else the row that is no known collection. */
    private fun storageRoot(): Rect? {
        val deviceName = runCatching { Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        for (label in listOfNotNull(deviceName, Build.MODEL, "Internal storage", "Internal shared storage")) {
            findLabelled(label)?.let { return it }
        }
        val known = setOf("recent", "images", "videos", "audio", "documents", "downloads", "drive", "bug reports", "show roots")
        return pickerNodes { node ->
            val text = node.text?.toString()?.trim() ?: return@pickerNodes false
            text.isNotEmpty() && text.lowercase() !in known && node.isVisibleToUser && clickableAncestor(node)
        }.map { Rect().also(it::getBoundsInScreen) }.firstOrNull { it.width() > 0 && it.height() > 0 }
    }

    private fun clickableAncestor(node: AccessibilityNodeInfo): Boolean {
        var n: AccessibilityNodeInfo? = node
        while (n != null) {
            if (n.isClickable) return true
            n = n.parent
        }
        return false
    }

    // --- 3. the passphrase sheet -----------------------------------------------------------------

    /**
     * A finger on Turn on sync opens the passphrase sheet; inside it a finger on each secret
     * field (the focus must land: the sheet's injected touch, asserted), the passphrase typed as
     * key events and read back from the field, the keyboard put down, and a finger on the sheet's
     * Turn on sync, which must leave the form busy or sync on. Then the engine: scrypt-js in the
     * WebView takes its seconds on the emulator, so the wait for `enabled` is generous.
     */
    private fun turnOnSync(firstTime: Boolean) {
        if (!tapRow(TURN_ON_LABEL, "sync-turn-on", timeoutMs = 10_000) { findByLabel(PASSPHRASE_TITLE) != null }) {
            error("the Turn on sync row did not open the passphrase sheet")
        }
        SystemClock.sleep(1_000)
        if (firstTime) snap("setup-sheet")
        fillSecret(0, "the passphrase field")
        fillSecret(1, "the confirmation field")
        if (firstTime) snap("setup-sheet-filled")
        if (imeShown()) {
            back()
            awaitIme(shown = false, timeoutMs = 6_000)
            SystemClock.sleep(800)
        }
        val before = syncStatus()
        val took = touchTapLabelExpecting(TURN_ON_LABEL, "the form is busy or sync is on", timeoutMs = 8_000) {
            formBusy() || syncStatus().getBoolean("enabled")
        }
        if (firstTime && formBusy()) snap("setup-busy")
        if (!took) {
            note("  submitting the form through its field so the demo goes on")
            focusSecret(0)
            pressKey(KeyEvent.KEYCODE_ENTER)
        }
        val started = SystemClock.uptimeMillis()
        if (!awaitSettled({ syncStatus().getBoolean("enabled") }, 120_000)) {
            note("  sync did not turn on: ${describeSync()}; form: ${formState()}")
            error("sync did not turn on")
        }
        note("  sync on ${SystemClock.uptimeMillis() - started} ms after the touch (was enabled=${before.getBoolean("enabled")})")
        awaitNoSheet()
        if (firstTime) {
            if (!awaitSettled({ !syncStatus().isNull("lastSyncAt") }, 30_000)) note("  the first sync did not finish: ${describeSync()}")
            else note("  first sync done: ${syncNowRowText()}")
        } else {
            if (!awaitSettled({ syncStatus().getBoolean("pendingMerge") }, 10_000)) note("  no merge question raised: ${describeSync()}")
            else note("  the folder's data raised the merge question: ${rowText(MERGE_ROW_LABEL)}")
        }
        SystemClock.sleep(800)
    }

    /** A finger on the `index`th secret field of the sheet (top to bottom), then the passphrase typed into it. */
    private fun fillSecret(index: Int, what: String) {
        var typed = 0
        for (attempt in 1..4) {
            if (!secretFocused(index)) {
                val took = focusSecret(index)
                if (attempt == 1 && !took) touchFault("the touch on $what did not focus it")
            }
            typeText(PASSPHRASE.substring(typed))
            SystemClock.sleep(600)
            val value = secretValue(index)
            if (value == PASSPHRASE) {
                note("  $what holds the passphrase (attempt $attempt)")
                return
            }
            if (value != null && value.isNotEmpty() && PASSPHRASE.startsWith(value)) {
                typed = value.length
                note("  $typed of ${PASSPHRASE.length} keys landed in $what (attempt $attempt)")
            } else {
                note("  $what holds ${value?.length ?: "no"} characters, not a start of the passphrase (attempt $attempt)")
                clearField(value?.length ?: 0)
                typed = 0
            }
        }
        error("$what never took the passphrase")
    }

    /** A finger on the `index`th secret field; true once the chrome's focus is in it. */
    private fun focusSecret(index: Int): Boolean {
        val field = secretFields().getOrNull(index) ?: run {
            dumpNames("the passphrase sheet")
            error("no secret field $index in the sheet")
        }
        if (!touchTap(field)) {
            Log.w(tag, "secret field $index has no bounds on screen to touch")
            return false
        }
        return awaitSettled({ secretFocused(index) }, 4_000)
    }

    /** The sheet's editable fields, top to bottom (the passphrase, then its confirmation). */
    private fun secretFields(): List<AccessibilityNodeInfo> = nodes { node ->
        node.packageName?.toString() == app.packageName && node.isEditable && node.isVisibleToUser
    }.filter { node -> Rect().also(node::getBoundsInScreen).let { it.width() > 0 && it.height() > 0 } }
        .sortedBy { node -> Rect().also(node::getBoundsInScreen).top }

    private fun secretFocused(index: Int): Boolean =
        chromeValue("String(document.activeElement && document.activeElement.id === ${JSONObject.quote(SECRET_IDS[index])})") == "true"

    private fun secretValue(index: Int): String? {
        val raw = chromeJs("(function(){var e=document.getElementById(${JSONObject.quote(SECRET_IDS[index])});return e?e.value:null})()")
        return runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull()
    }

    private fun clearField(length: Int) {
        pressKey(KeyEvent.KEYCODE_MOVE_END)
        repeat(length) {
            pressKey(KeyEvent.KEYCODE_DEL)
            SystemClock.sleep(40)
        }
    }

    private fun formBusy(): Boolean =
        chromeValue("String(!!document.querySelector('[data-testid=\"sync-passphrase-form\"][aria-busy=\"true\"]'))") == "true"

    private fun formState(): String =
        chromeValue(
            "(function(){var f=document.querySelector('[data-testid=\"sync-passphrase-form\"]');if(!f)return 'no form';" +
                "var m=f.querySelector('[role=\"alert\"], .zen-settings-validation');return 'busy='+f.getAttribute('aria-busy')+" +
                "' message='+(m?m.textContent:'none')})()"
        )

    // --- 4. the toggle ---------------------------------------------------------------------------

    private fun flipOpenTabs() {
        val was = scope().getBoolean("openTabs")
        if (!tapRow(OPEN_TABS_LABEL, "sync-scope:openTabs") { scope().getBoolean("openTabs") != was }) {
            touchFault("the Open tabs switch row did not flip under a finger")
            coreInvoke("sync.setScope", """{"openTabs":${!was}}""")
        }
        awaitSettled({ scope().getBoolean("openTabs") != was }, 5_000)
        note("  Open tabs: $was -> ${scope().getBoolean("openTabs")}; row reads: ${rowText(OPEN_TABS_LABEL)}")
        SystemClock.sleep(600)
    }

    // --- 5. the second device --------------------------------------------------------------------

    /**
     * Another Zenium's file, written into the tree by the shell as its sync client would upload
     * it: the folder's salt read off this device's own file (kept for the rounds after this
     * device's file is gone), the key derived from the same passphrase ([SyncPeer.deriveKey],
     * seconds on the device), a Space with one tab and its order record, a bookmark – and from the
     * second round a second bookmark, so a later sync has something new to bring.
     */
    private fun seedPeer() {
        peerRounds++
        val dir = "$FOLDER_PATH/${SyncPeer.DIR_NAME}"
        val salt = peerSalt ?: run {
            val mine = SyncPeer.deviceFileName(syncStatus().getString("deviceId"))
            val mineText = shell("cat $dir/$mine")
            runCatching { SyncPeer.saltOf(mineText) }.getOrElse {
                note("  this device's file could not be read: ${mineText.take(120)}")
                error("no salt to derive the second device's key from")
            }.also { peerSalt = it }
        }
        val started = SystemClock.uptimeMillis()
        val key = SyncPeer.deriveKey(PASSPHRASE, salt)
        note("  key derived on the device in ${SystemClock.uptimeMillis() - started} ms from the folder's salt $salt")
        val now = System.currentTimeMillis()
        val records = peerRecords(now, round = peerRounds)
        val text = SyncPeer.deviceFile(PEER_ID, PEER_NAME, now, SyncPeer.encrypt(key, salt, SyncPeer.payload(records)))
        val encoded = Base64.encodeToString(text.toByteArray(), Base64.NO_WRAP)
        val target = "$dir/${SyncPeer.deviceFileName(PEER_ID)}"
        shell("mkdir -p $dir; echo $encoded | base64 -d > $target")
        val back = shell("cat $target")
        if (back != text) {
            note("  the tree did not keep the second device's file as written (${back.length} of ${text.length} bytes)")
            error("the second device's file did not land")
        }
        note("  '$PEER_NAME' wrote ${records.size} records (${records.joinToString { it.getString("type") }}) as ${SyncPeer.deviceFileName(PEER_ID)} (round $peerRounds)")
        note("  tree: ${treeListing()}")
    }

    private fun peerRecords(now: Long, round: Int): List<JSONObject> {
        val records = ArrayList<JSONObject>()
        records += SyncPeer.record(
            PEER_SPACE, "space", now,
            JSONObject().put("name", PEER_SPACE_NAME).put("icon", "\uD83D\uDD2D").put("containerId", "default")
                .put("theme", JSONObject.NULL).put("pinnedCollapsed", false)
        )
        records += SyncPeer.record(
            PEER_BOOKMARK, "bookmark", now,
            JSONObject().put("parentId", "2").put("index", 0).put("type", "url").put("title", PEER_BOOKMARK_TITLE)
                .put("url", PEER_BOOKMARK_URL).put("dateAdded", now)
        )
        records += SyncPeer.record(
            PEER_TAB, "tab", now,
            JSONObject().put("url", PEER_TAB_URL).put("pinnedUrl", JSONObject.NULL).put("title", PEER_TAB_TITLE)
                .put("customTitle", JSONObject.NULL).put("customIcon", JSONObject.NULL).put("favicon", JSONObject.NULL)
                .put("pinned", false).put("essential", false).put("spaceId", PEER_SPACE).put("folderId", JSONObject.NULL)
                .put("containerId", "default").put("muted", false)
        )
        records += SyncPeer.record(
            "order:tabs:$PEER_SPACE", "order", now,
            JSONObject().put("pinned", JSONArray()).put("regular", JSONArray().put(PEER_TAB))
        )
        if (round >= 2) {
            records += SyncPeer.record(
                PEER_BOOKMARK_2, "bookmark", now,
                JSONObject().put("parentId", "2").put("index", 1).put("type", "url").put("title", PEER_BOOKMARK_2_TITLE)
                    .put("url", PEER_BOOKMARK_2_URL).put("dateAdded", now)
            )
        }
        return records
    }

    // --- 6. Sync now -----------------------------------------------------------------------------

    /**
     * A finger on Sync now; the sync it starts must land the other device's records. The engine
     * also polls the folder every 30 s while the app is in front, so whether the device was
     * already in the list before the finger is noted: the touch is asserted on a sync of its
     * own (`lastSyncAt` moving), the landing on the state after it.
     */
    private fun syncNow() {
        val before = syncStatus().optLong("lastSyncAt", 0)
        note("  before the touch: '$PEER_NAME' ${if (peerListed()) "already listed by the 30 s poll" else "not yet in the list"}")
        if (!tapRow(SYNC_NOW_LABEL, "sync-now") { syncStatus().getBoolean("syncing") || syncStatus().optLong("lastSyncAt", 0) > before }) {
            touchFault("the Sync now row did not start a sync under a finger")
            coreInvoke("sync.now")
        }
        if (!awaitSettled({ syncStatus().optLong("lastSyncAt", 0) > before }, 30_000)) note("  the sync did not finish: ${describeSync()}")
        SystemClock.sleep(600)
        assertLanded()
    }

    private fun peerListed(): Boolean {
        val devices = syncStatus().getJSONArray("devices")
        return (0 until devices.length()).any { devices.getJSONObject(it).optString("name") == PEER_NAME }
    }

    /** The other device in the list with its last-seen time, and its records in the core's state. */
    private fun assertLanded() {
        val state = coreState()
        val sync = state.getJSONObject("sync")
        val devices = sync.getJSONArray("devices")
        val peer = (0 until devices.length()).map(devices::getJSONObject).firstOrNull { it.optString("name") == PEER_NAME }
        if (peer == null) {
            note("  '$PEER_NAME' is NOT in the device list: ${describeSync()}")
            error("the second device did not appear")
        }
        note("  device list: ${(0 until devices.length()).map { devices.getJSONObject(it).optString("name") }}; " +
            "'$PEER_NAME' last seen ${System.currentTimeMillis() - peer.getLong("lastSeen")} ms ago")
        val bookmarks = state.getJSONArray("bookmarks").let { b -> (0 until b.length()).map(b::getJSONObject) }
        val bookmark = bookmarks.firstOrNull { it.optString("id") == PEER_BOOKMARK }
        val second = bookmarks.firstOrNull { it.optString("id") == PEER_BOOKMARK_2 }
        val spaces = state.getJSONArray("spaces")
        val space = (0 until spaces.length()).map(spaces::getJSONObject).firstOrNull { it.optString("id") == PEER_SPACE }
        val tab = state.getJSONObject("tabs").optJSONObject(PEER_TAB)
        note("  bookmark: ${bookmark?.optString("title") ?: "MISSING"}; second bookmark: ${second?.optString("title") ?: "none"}; " +
            "space: ${space?.optString("name") ?: "MISSING"} (${space?.optJSONArray("tabIds")?.length() ?: 0} tabs); " +
            "tab: ${tab?.optString("title") ?: "MISSING"} discarded=${tab?.optBoolean("discarded")}")
        if (bookmark == null || space == null) error("the second device's records did not land")
        if (peerRounds >= 2 && second == null) error("what the second device wrote in the meantime did not land on the merge")
        if (rowBounds(PEER_NAME, 8_000) == null) {
            touchFault("'$PEER_NAME' is in the core's device list but not on the page")
        } else {
            note("  the page lists: ${rowText(PEER_NAME)}")
        }
    }

    /** The Space the other device sent, brought to the front so the recording shows its tab in the strip. */
    private fun showLanded() {
        val space = coreState().getJSONArray("spaces").let { s -> (0 until s.length()).map(s::getJSONObject) }
            .firstOrNull { it.optString("id") == PEER_SPACE } ?: return
        if (space.optJSONArray("tabIds")?.length() == 0) return
        coreInvoke("space.activate", """{"spaceId":"$PEER_SPACE"}""")
        val came = awaitSettled({ coreState().optString("activeSpaceId") == PEER_SPACE }, 8_000)
        SystemClock.sleep(2_500)
        note("  the '$PEER_SPACE_NAME' Space ${if (came) "is active: ${activeCoreTab()?.optString("title")}" else "did not come to the front"}")
        snap("landed-space")
        // Back to Settings › Sync for the rest: the Settings tab lives in the first Space.
        coreInvoke("page.open", """{"id":"settings","section":"sync"}""")
        awaitPage(SECTION_URL, 12_000)
        SystemClock.sleep(1_200)
    }

    // --- 7. Turn off sync ------------------------------------------------------------------------

    /**
     * The disconnect sheet: a finger on the §9.23 checkbox row (it must read checked), a finger
     * on Turn off (sync must be off), then the tree: this device's file gone, the other's kept.
     */
    private fun turnOffSync() {
        val mine = SyncPeer.deviceFileName(syncStatus().getString("deviceId"))
        if (!tapRow(TURN_OFF_LABEL, "sync-disconnect", timeoutMs = 10_000) { findByLabel(TURN_OFF_TITLE) != null }) {
            error("the Turn off sync row did not open its sheet")
        }
        SystemClock.sleep(1_000)
        snap("disconnect-sheet")
        if (!touchTapLabelExpecting(WIPE_LABEL, "the checkbox row reads checked", prefix = true) { wipeChecked() }) {
            note("  ticking the checkbox through the chrome so the demo goes on")
            chromeJs("(function(){var c=document.querySelector('[data-testid=\"sync-disconnect-form\"] input[type=checkbox]');if(c&&!c.checked)c.click()})()")
            awaitSettled({ wipeChecked() }, 3_000)
        }
        SystemClock.sleep(600)
        snap("disconnect-sheet-wipe")
        if (!touchTapLabelExpecting(TURN_OFF_ACTION, "sync is off") { !syncStatus().getBoolean("enabled") }) {
            note("  turning sync off through the core so the demo goes on")
            coreInvoke("sync.disconnect", """{"wipeRemote":true}""")
            awaitSettled({ !syncStatus().getBoolean("enabled") }, 5_000)
        }
        awaitNoSheet()
        val gone = awaitSettled({ !treeListing().contains(mine) }, 10_000)
        val kept = treeListing().contains(SyncPeer.deviceFileName(PEER_ID))
        note("  this device's file $mine ${if (gone) "is gone from" else "is STILL in"} the tree; '$PEER_NAME''s ${if (kept) "kept" else "GONE"}")
        if (!gone || !kept) touchFault("the wipe did not leave the tree as the checkbox said")
        awaitSettled({ rowBounds(FOLDER_LABEL, 2_000) != null }, 8_000)
        note("  ${describeSync()}; folder row: ${rowText(FOLDER_LABEL)}")
        SystemClock.sleep(600)
    }

    private fun wipeChecked(): Boolean =
        chromeValue("String(!!(document.querySelector('[data-testid=\"sync-disconnect-form\"] input[type=checkbox]')||{}).checked)") == "true"

    // --- 8. the merge question -------------------------------------------------------------------

    /**
     * The merge row opens its sheet; inside it a finger on the second radio (it must read
     * checked), a finger back on Merge, a finger on Continue: the merge must be answered and the
     * sync run – the device and its records back in the core's state.
     */
    private fun answerMerge() {
        if (!tapRow(MERGE_ROW_LABEL, "sync-merge", timeoutMs = 10_000) { findByLabel(MERGE_TITLE) != null }) {
            error("the merge row did not open its sheet")
        }
        SystemClock.sleep(1_000)
        snap("merge-sheet")
        pickRadio(REPLACE_LABEL, "the Keep only this device's data option reads checked")
        SystemClock.sleep(600)
        snap("merge-sheet-replace")
        pickRadio(MERGE_LABEL, "the Merge option reads checked")
        val before = syncStatus().optLong("lastSyncAt", 0)
        if (!touchTapLabelExpecting(CONTINUE_LABEL, "the merge is answered") { !syncStatus().getBoolean("pendingMerge") }) {
            note("  answering the merge through the core so the demo goes on")
            coreInvoke("sync.confirmMerge", """{"merge":true}""")
        }
        awaitNoSheet()
        if (!awaitSettled({ syncStatus().optLong("lastSyncAt", 0) > before }, 60_000)) note("  the sync after the merge did not finish: ${describeSync()}")
        SystemClock.sleep(600)
        assertLanded()
    }

    /** A finger on the radio reading `label`; it must read checked (`aria-checked`) afterwards. */
    private fun pickRadio(label: String, effect: String) {
        val node = radioNode(label) ?: run {
            dumpNames("the merge sheet")
            touchFault("no radio reading '$label' in the merge sheet")
            return
        }
        if (!touchTap(node)) {
            touchFault("the radio '$label' has no bounds on screen to touch")
            return
        }
        if (awaitSettled({ radioNode(label)?.isChecked == true }, 5_000)) note("  the touch on '$label' took: $effect")
        else touchFault("the touch on the radio '$label' did not take: not $effect")
    }

    private fun radioNode(label: String): AccessibilityNodeInfo? =
        findNodeWhere { n -> n.isCheckable && (n.text?.toString() ?: n.contentDescription?.toString())?.startsWith(label) == true }

    // --- the page's rows -------------------------------------------------------------------------

    /**
     * Press the row reading `label` on the PAGE (never a sheet's) and wait for `settled`. The
     * finger goes in once the row is scrolled into view and its bounds hold still, inside the
     * touchable window ([touchTapLabel]); when the change never comes, a second finger at the
     * row's own rectangle in the chrome (`data-row` is the row's id): the tree trails the screen
     * by seconds on the software-rendered emulator and reports a scrolled row where it was, the
     * stated reason a page row keeps a second touch – a real one, never a click through the tree,
     * and noted when it was needed. False when the row is not there or the change never came.
     */
    private fun tapRow(label: String, rowId: String, timeoutMs: Long = 6_000, settled: () -> Boolean): Boolean {
        if (settled()) return true
        if (rowBounds(label, 8_000) == null) Log.w(tag, "no row reading '$label' in the tree") else {
            SystemClock.sleep(400)
            if (touchTapLabel(label, prefix = true) && awaitSettled(settled, timeoutMs)) return true
            Log.w(tag, "'$label' did not take at the tree's bounds; tapping the chrome's own rectangle")
            note("  ('$label' did not take at the tree's bounds; a second finger at the chrome's rectangle)")
        }
        val point = chromePoint("[data-row=${JSONObject.quote(rowId)}]") ?: run {
            Log.w(tag, "no row $rowId in the chrome")
            return false
        }
        Finger().tap(point.x, point.y)
        return awaitSettled(settled, timeoutMs)
    }

    /**
     * The bounds of the first node whose accessible text reads `text` – exactly or as a prefix: a
     * Settings row is one button whose text runs its label and description together. Polls,
     * since the tree trails the screen on the emulator; a node the list holds below the fold is
     * scrolled into view first.
     */
    private fun rowBounds(text: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var revealed = false
        do {
            val node = findNode { it == text || it.startsWith(text) }
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
        } while (SystemClock.uptimeMillis() < deadline)
        return null
    }

    private fun revealRow(text: String): Rect? = rowBounds(text, 6_000)

    private fun rowText(text: String): String? =
        findNode { it.startsWith(text) }?.let { it.text ?: it.contentDescription }?.toString()

    private fun syncNowRowText(): String = rowText(SYNC_NOW_LABEL) ?: "(no Sync now row)"

    private fun awaitSettled(settled: () -> Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled()) return true
            SystemClock.sleep(250)
        }
        return settled()
    }

    private fun awaitPage(url: String, timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab != null && tab.optString("url") == url) return tab
            SystemClock.sleep(250)
        }
        Log.w(tag, "the active tab did not come to $url")
        return null
    }

    private fun ensureDemoTab() {
        if (activeCoreTab()?.optString("id") == DEMO_TAB) return
        coreInvoke("tab.activate", """{"tabId":"$DEMO_TAB"}""")
        awaitSettled({ activeCoreTab()?.optString("id") == DEMO_TAB }, 8_000)
        SystemClock.sleep(1_000)
    }

    // --- sheets ----------------------------------------------------------------------------------

    private fun sheetCount(): Int = chromeValue("String(document.querySelectorAll('.zen-sheet').length)").toIntOrNull() ?: -1

    private fun awaitNoSheet() {
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline && sheetCount() != 0) SystemClock.sleep(200)
    }

    private fun closeSheets() {
        var count = sheetCount()
        repeat(3) {
            if (count <= 0) return
            back()
            val deadline = SystemClock.uptimeMillis() + 6_000
            while (SystemClock.uptimeMillis() < deadline && sheetCount() >= count) SystemClock.sleep(200)
            count = sheetCount()
        }
    }

    // --- the system picker -----------------------------------------------------------------------

    private fun documentPickerShowing(): Boolean = pickerNodes { true }.isNotEmpty()

    private fun awaitPicker(timeoutMs: Long): Boolean = awaitSettled({ documentPickerShowing() }, timeoutMs)

    private fun awaitPickerGone(timeoutMs: Long): Boolean = awaitSettled({ !documentPickerShowing() }, timeoutMs)

    /** Nodes of the picker's windows (DocumentsUI, the permission dialog it raises). */
    private fun pickerNodes(predicate: (AccessibilityNodeInfo) -> Boolean): List<AccessibilityNodeInfo> =
        nodes { node -> node.packageName?.toString() in PICKER_PACKAGES && predicate(node) }

    private fun tapRect(rect: Rect) {
        Finger().tap(rect.exactCenterX(), rect.exactCenterY())
        SystemClock.sleep(700)
    }

    private fun waitForNode(label: String, timeoutMs: Long, role: String? = null): Rect? = waitForAny(listOf(label), timeoutMs, role)

    private fun waitForAny(labels: List<String>, timeoutMs: Long, role: String? = null): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            for (label in labels) findLabelled(label, role)?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(300)
        }
    }

    /**
     * Bounds of the innermost visible node whose text, description or hint is `label`. Case is
     * ignored: a Material button reports its displayed, all-caps text ("ALLOW") to accessibility.
     */
    private fun findLabelled(label: String, role: String? = null): Rect? = nodes { node ->
        if (role != null && node.className?.toString() != role) return@nodes false
        if (!node.isVisibleToUser) return@nodes false
        listOf(node.text, node.contentDescription, node.hintText).any {
            it?.toString()?.trim().equals(label, ignoreCase = true)
        }
    }
        .map { Rect().also(it::getBoundsInScreen) }
        .filter { it.width() > 0 && it.height() > 0 }
        .minByOrNull { it.width() * it.height() }

    /** Breadth-first search of every window on screen (the app, the picker, the dialogs). */
    private fun nodes(predicate: (AccessibilityNodeInfo) -> Boolean): List<AccessibilityNodeInfo> {
        val roots = ArrayList<AccessibilityNodeInfo>()
        for (window in ui.windows) window.root?.let(roots::add)
        if (roots.isEmpty()) ui.rootInActiveWindow?.let(roots::add)
        val found = ArrayList<AccessibilityNodeInfo>()
        val queue = ArrayDeque(roots)
        var visited = 0
        while (queue.isNotEmpty() && visited < 12_000) {
            val node = queue.removeFirst()
            visited++
            if (predicate(node)) found += node
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found
    }

    /** Every named node on screen (in `packages`) into the notes, for a step that found nothing. */
    private fun dumpNames(where: String, packages: Set<String> = setOf(app.packageName)) {
        val names = nodes { node -> node.packageName?.toString() in packages }
            .mapNotNull { node ->
                val name = (node.text ?: node.contentDescription ?: node.hintText)?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                "${node.className?.toString()?.substringAfterLast('.')}:$name"
            }.distinct()
        note("  on screen ($where): ${names.take(60).joinToString(" | ")}")
    }

    // --- keys ------------------------------------------------------------------------------------

    /** Type `text` as key events, each stamped as it is injected (a stale stamp is dropped by the dispatcher). */
    private fun typeText(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (ch in text) {
            val events = map.getEvents(charArrayOf(ch)) ?: continue
            for (event in events) {
                val now = SystemClock.uptimeMillis()
                if (!ui.injectInputEvent(KeyEvent.changeTimeRepeat(event, now, 0), true)) note("  a key was not injected")
                SystemClock.sleep(40)
            }
        }
    }

    private fun pressKey(keyCode: Int) {
        val now = SystemClock.uptimeMillis()
        ui.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0), true)
        ui.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, keyCode, 0), true)
    }

    // --- the chrome's bridge and the core's state ------------------------------------------------

    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun awaitChrome(code: String, timeoutMs: Long): Boolean =
        awaitSettled({ chromeValue("String(!!($code))") == "true" }, timeoutMs)

    private fun chromePoint(selector: String): PointF? {
        val raw = chromeJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also(host.chrome::getLocationOnScreen) }
        SystemClock.sleep(400)
        return PointF(origin[0] + point.getDouble(0).toFloat() * density, origin[1] + point.getDouble(1).toFloat() * density)
    }

    private val host: Host get() = (activity as MainActivity).host

    private fun syncStatus(): JSONObject = coreState().getJSONObject("sync")

    private fun scope(): JSONObject = syncStatus().getJSONObject("scope")

    private fun describeSync(): String {
        val s = syncStatus()
        return "sync enabled=${s.getBoolean("enabled")} folderName=${s.optString("folderName")} folderLost=${s.optBoolean("folderLost")} " +
            "pendingMerge=${s.optBoolean("pendingMerge")} syncing=${s.optBoolean("syncing")} lastSyncAt=${s.opt("lastSyncAt")} " +
            "lastError=${s.opt("lastError")} devices=${s.optJSONArray("devices")?.length() ?: 0} deviceName='${s.optString("deviceName")}'"
    }

    /** What the tree's `zenium-sync` directory holds, as the shell lists it. */
    private fun treeListing(): String = shell("ls -l $FOLDER_PATH/${SyncPeer.DIR_NAME} 2>&1").trim().replace('\n', ';')

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

    private fun snap(name: String) {
        shots++
        shot("${shots.toString().padStart(2, '0')}-$name")
        note("  shot $name")
    }

    private fun note(line: String) {
        Log.i(tag, line.trim())
        if (::notes.isInitialized) notes.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18151
        private const val DEMO_TAB = "tab_demo"
        private const val SETTINGS_URL = "zen://settings"
        private const val SECTION_URL = "zen://settings/sync"
        /** The folder on the device's storage the picker is steered to (`/sdcard` is the shell's view of it). */
        private const val FOLDER = "ZeniumSync"
        private const val FOLDER_PATH = "/sdcard/$FOLDER"
        private const val PASSPHRASE = "orbit-lantern-42"
        private val SECRET_IDS = listOf("sync-passphrase", "sync-confirm")
        private const val PEER_ID = "device_worklaptop"
        private const val PEER_NAME = "Work laptop"
        private const val PEER_SPACE = "space_worklaptop_research"
        private const val PEER_SPACE_NAME = "Research"
        private const val PEER_TAB = "tab_worklaptop_1"
        private const val PEER_TAB_TITLE = "Sync design notes"
        private const val PEER_TAB_URL = "https://example.com/sync-design-notes"
        private const val PEER_BOOKMARK = "bm_worklaptop_1"
        private const val PEER_BOOKMARK_TITLE = "Zenium on GitHub"
        private const val PEER_BOOKMARK_URL = "https://github.com/BenItBuhner/Zenium"
        private const val PEER_BOOKMARK_2 = "bm_worklaptop_2"
        private const val PEER_BOOKMARK_2_TITLE = "Zenium releases"
        private const val PEER_BOOKMARK_2_URL = "https://github.com/BenItBuhner/Zenium/releases"
        // The page's words (`SYNC_COPY` in lib/syncSetup.ts).
        private const val FOLDER_LABEL = "Sync folder"
        private const val TURN_ON_LABEL = "Turn on sync"
        private const val PASSPHRASE_TITLE = "Create a passphrase"
        private const val OPEN_TABS_LABEL = "Open tabs"
        private const val SYNC_NOW_LABEL = "Sync now"
        private const val TURN_OFF_LABEL = "Turn off sync"
        private const val TURN_OFF_TITLE = "Turn off sync?"
        private const val WIPE_LABEL = "Also remove this device\u2019s data from the folder"
        private const val TURN_OFF_ACTION = "Turn off"
        private const val MERGE_ROW_LABEL = "This folder already has synced data"
        private const val MERGE_TITLE = "Combine with the data in this folder?"
        private const val MERGE_LABEL = "Merge"
        private const val REPLACE_LABEL = "Keep only this device\u2019s data"
        private const val CONTINUE_LABEL = "Continue"
        private val PICKER_PACKAGES = setOf("com.android.documentsui", "com.google.android.documentsui", "com.android.permissioncontroller")
        private val PAGE = """
            <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Sync demo</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:24px;color:#222}h1{font-size:22px}</style></head>
            <body><h1>Sync demo</h1><p>This tab stands in for a page while Settings › Sync is exercised.</p></body></html>
        """.trimIndent()
    }
}
