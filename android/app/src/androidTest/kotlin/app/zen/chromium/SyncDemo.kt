package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Process
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
import java.util.Locale

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
 *
 * Frame stats (Bennett's rule of 2026-09-20: performance is a shipping requirement, every driver
 * run records them): each of the PR's sheets is played once as a gesture scene – opened with a
 * finger on its row, left to settle, dismissed with a back – between a `dumpsys gfxinfo
 * <package> reset` and a `framestats` read ([scene]), and the app menu, a sheet main had before
 * this PR, is played the same way first as the baseline. Per scene the total frames, the janky
 * count and share and the 50th / 90th / 99th percentile frame times go to the notes (a table at
 * the end); the raw dumps to `<shotPrefix>-framestats.txt`. Reported, not gated: the harness's
 * gate on janky frames is the Android program's and is adopted when it lands.
 */
@RunWith(AndroidJUnit4::class)
open class SyncDemo(
    stateAsset: String = "sync-demo-state.json",
    /** The stills' and the notes' prefix: the program's capture name (`<prefix>-notes.txt` beside the stills). */
    protected val prefix: String = "services-sync-android-android",
    handshakeDir: String = "sync-demo"
) : DemoHarness(stateAsset, prefix, handshakeDir) {
    override val tag: String = "SyncDemo"
    private lateinit var server: DemoServer
    protected lateinit var notes: File
    protected lateinit var frameDumps: File
    /**
     * The driver's own per-scene table (`scene` below: this PR's reading of `dumpsys gfxinfo`,
     * written into notes.txt), named apart from the harness's `frameScenes` – the record of the
     * scenes measured through `measureFrames` (#268), which this driver moves onto with its next
     * run. Null marks a scene that did not play.
     */
    protected val sceneStats = LinkedHashMap<String, FrameScene?>()
    protected var shots = 0
    protected val startedAt = SystemClock.uptimeMillis()
    /** How many times the second device has written its file (its second round adds a bookmark). */
    protected var peerRounds = 0
    /** The folder's salt, read off this device's file at the first seeding (the other device keeps it). */
    protected var peerSalt: String? = null

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
        notes = File(out, "$prefix-notes.txt")
        notes.writeText("Zenium Android sync demo\n\n")
        frameDumps = File(out, "$prefix-framestats.txt")
        frameDumps.writeText(
            "dumpsys gfxinfo ${app.packageName} framestats, read after each gesture scene (the counters reset before it)\n\n"
        )
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
        // 0. The frame baseline: the app menu, a sheet main had before this PR, opened with a
        //    finger and dismissed with a back, its frames counted the way the PR's sheets' are.
        note("\n0. the frame baseline: the app menu")
        scene(SCENE_MENU) { openAndDismissMenu() }

        // 1. Settings › Sync through the app menu and the landing's category row.
        note("\n1. Settings › Sync")
        openSyncSettings()
        snap("settings-folder-unset")
        note("  ${describeSync()}")

        // 2. The folder: the system picker, a tree granted with a finger.
        note("\n2. the sync folder")
        grantFolder()
        snap("settings-folder-set")

        // 3. Turn on sync: the passphrase sheet – first as a frame scene (opened, dismissed), then
        //    for real.
        note("\n3. the passphrase sheet")
        scene(SCENE_PASSPHRASE) { openAndDismissSheet(TURN_ON_LABEL, "sync-turn-on", PASSPHRASE_TITLE) }
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

        // 7. Turn off sync, this device's data removed from the folder – the sheet first as a
        //    frame scene, then for real.
        note("\n7. Turn off sync")
        scene(SCENE_TURN_OFF) { openAndDismissSheet(TURN_OFF_LABEL, "sync-disconnect", TURN_OFF_TITLE) }
        turnOffSync()
        snap("settings-off")
        note("  tree: ${treeListing()}")

        // 8. The other device writes once more; set up again into the folder with its data: the
        //    merge question (its sheet a frame scene first), and what it wrote in the meantime
        //    landing on the answer.
        note("\n8. the merge question")
        seedPeer()
        grantFolder()
        turnOnSync(firstTime = false)
        snap("settings-merge-pending")
        scene(SCENE_MERGE) { openAndDismissSheet(MERGE_ROW_LABEL, "sync-merge", MERGE_TITLE) }
        answerMerge()
        revealRow(PEER_NAME)
        SystemClock.sleep(600)
        snap("settings-merged")
        note("  ${describeSync()}")
        noteFrameTable()
        note("\ndone in ${(SystemClock.uptimeMillis() - startedAt) / 1000} s")
    }

    // --- 1. the section --------------------------------------------------------------------------

    /**
     * The app menu's Settings row is a sheet's row: a finger once its bounds hold still
     * ([openMenuItem]), and the Settings tab must come up on it – else a [touchFault] and
     * `page.open` is the way on so the recording goes on. The landing's Sync row is a page row: a
     * finger, and the tab must come to the section on it.
     */
    protected fun openSyncSettings() {
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
        // The landing's Sync row is the last of Zen's second run and sits at the chrome's bottom
        // bar on a 720x1600 window: the second run's finger, at the middle of the row's part
        // inside the touchable window, landed on the bar and opened the URL field
        // (35532029145). A page row is touched inside the page's band, above the bar
        // ([touchPageRow]), once the chrome has scrolled it there ([rowBounds]).
        if (rowBounds("Sync", 8_000) == null) {
            note("  no Sync category on the landing")
        } else if (touchPageRow("Sync") == null) {
            touchFault("no finger on the landing's Sync row: no part of it is inside the page's band")
        } else if (!awaitSettled({ activeCoreTab()?.optString("url") == SECTION_URL }, 5_000)) {
            touchFault("a touch on the landing's Sync row did not take: the tab is not at the Sync section within 5000 ms")
            note("  the landing's Sync row did not take the tab to the section")
            recoverUrlField("the landing's Sync row")
        } else {
            note("  the touch on the landing's Sync row took: the tab is at the section")
        }
        if (activeCoreTab()?.optString("url") != SECTION_URL) coreInvoke("page.open", """{"id":"settings","section":"sync"}""")
        if (awaitPage(SECTION_URL, 12_000) == null) error("the tab did not come to the Sync section")
        awaitSurface(up = true, timeoutMs = 6_000)
        if (rowBounds(FOLDER_LABEL, 10_000) == null) {
            // 35681463729: the section painted (the recording shows it, the chrome's document has
            // the row), and the tree read none of its rows for ten seconds. The chrome's own row is
            // the check then – the flow's fingers find their rows through it too ([tapRow]'s second
            // finger) – and what the tree and the document did read goes to the notes, so a repeat
            // says which side trailed.
            val inChrome = chromePoint("[data-row=\"sync-folder\"]")
            note("  the tree read no $FOLDER_LABEL row on the section; the chrome's document: ${describeChromeRow("sync-folder")}")
            dumpNames("the Sync section, on the tree")
            if (inChrome == null) error("no $FOLDER_LABEL row on the section: not on the tree, not in the chrome's document")
        }
        SystemClock.sleep(800)
    }

    /**
     * What the chrome's document says of the row `rowId`: its rectangle (CSS px), the start of
     * its text, and whichever ancestor keeps it from the tree – `inert`, `aria-hidden`, a hidden
     * visibility or display, opacity 0, a content-visibility – with the count of sheets up.
     */
    protected fun describeChromeRow(rowId: String): String =
        chromeJs(
            "(function(){var r=document.querySelector('[data-row=' + ${JSONObject.quote(JSONObject.quote(rowId))} + ']');if(!r)return 'no such row';" +
                "var out=[];var e=r;while(e&&e!==document.documentElement){var cs=getComputedStyle(e);var f=[];" +
                "if(e.hasAttribute('inert'))f.push('inert');if(e.getAttribute('aria-hidden')==='true')f.push('aria-hidden');" +
                "if(cs.visibility!=='visible')f.push('visibility='+cs.visibility);if(cs.display==='none')f.push('display=none');" +
                "if(cs.opacity==='0')f.push('opacity=0');if(cs.contentVisibility&&cs.contentVisibility!=='visible')f.push('content-visibility='+cs.contentVisibility);" +
                "if(f.length)out.push((e.className||e.tagName)+':'+f.join(','));e=e.parentElement}" +
                "var b=r.getBoundingClientRect();return {rect:[Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)]," +
                "text:(r.textContent||'').replace(/\\s+/g,' ').slice(0,48),keeps:out,sheets:document.querySelectorAll('.zen-sheet').length}})()"
        ).ifEmpty { "(the chrome did not answer)" }

    // --- 2. the folder ---------------------------------------------------------------------------

    /**
     * A finger on the folder row brings the system's folder picker up; inside it the folder's
     * row, Use this folder and the permission dialog's Allow are each a finger too, the picker's
     * own controls being the sheet flow's (the rule in [DemoHarness]). The row must then read
     * the folder's name: the host persisted the tree's permission and answered the chrome with
     * its URI, which the setup draft holds.
     */
    protected fun grantFolder() {
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
     * DocumentsUI in tree mode: the folder's row (through the roots drawer and the device's own
     * storage first when the picker opened elsewhere; no row at all when it opened inside the
     * folder, as it does the second time – DocumentsUI keeps the last place each app picked
     * from), then the confirmation button, then the permission dialog's Allow, each a finger
     * ([pickerPress]: the control found afresh right before the touch, up to three fingers for
     * the effect claimed). Two things the first run taught about the bottom button: it is on
     * screen from the start, greyed on the storage root (Android 11 grants no root), so the wait
     * is for it ENABLED and not merely present; and on the emulator it runs under the navigation
     * bar's window, so a finger at the middle of its bounds landed on SystemUI and nothing came
     * of it – the finger now goes to the middle of the part inside [touchable], as the harness's
     * own touches do ([touchPoint]). False when a step's control never came or never took; the
     * caller reports the fault.
     */
    protected fun pickTree(name: String): Boolean {
        if (!awaitPicker(10_000)) {
            note("  no document picker window came up")
            return false
        }
        // A moment for the directory to load: the button reads enabled only once it has.
        if (awaitSettled({ insideFolder(name) }, 4_000)) {
            note("  the picker opened inside '$name' (where the app picked last)")
        } else {
            if (pickerNode(listOf(name), 6_000) == null) {
                note("  the picker did not open on the storage root; through the roots drawer")
                if (!pickerPress(listOf("Show roots"), "the roots drawer is open") { storageRoot() != null }) {
                    note("  no roots drawer")
                    dumpNames("the picker", PICKER_PACKAGES)
                    return false
                }
                SystemClock.sleep(600)
                snap("picker-roots")
                val storage = storageRoot() ?: return false
                val storageName = (storage.text ?: storage.contentDescription)?.toString()?.trim() ?: ""
                if (!pickerPress(listOf(storageName), "the storage root is open") { pickerNode(listOf(name), 0) != null }) {
                    note("  no '$name' folder in the storage root")
                    dumpNames("the storage root", PICKER_PACKAGES)
                    return false
                }
            }
            SystemClock.sleep(500)
            if (!pickerPress(listOf(name), "the folder is open", timeoutMs = 8_000) { insideFolder(name) }) {
                note("  the '$name' row did not open the folder")
                dumpNames("the storage root", PICKER_PACKAGES)
                return false
            }
        }
        // The confirmation ("Use this folder" from Android 11; "Select" before), enabled now that
        // a folder below the root is open.
        if (pickerNode(USE_LABELS, 8_000, role = BUTTON, enabled = true) == null) {
            note("  no enabled Use this folder button inside '$name'")
            dumpNames("the folder", PICKER_PACKAGES)
            return false
        }
        SystemClock.sleep(600)
        snap("picker-folder")
        if (!pickerPress(USE_LABELS, "the permission dialog is up", role = BUTTON, timeoutMs = 6_000) { permissionDialogShowing() }) {
            note("  no permission dialog came up on Use this folder")
            dumpNames("the folder", PICKER_PACKAGES)
            return false
        }
        SystemClock.sleep(600)
        snap("picker-allow")
        if (!pickerPress(ALLOW_LABELS, "the picker is gone", role = BUTTON, timeoutMs = 10_000) { !documentPickerShowing() }) {
            note("  the picker is still up after Allow")
            dumpNames("the permission dialog", PICKER_PACKAGES)
            return false
        }
        note("  the picker closed on Allow")
        return true
    }

    /** Whether the picker is inside `name`: its list's header reads "Files in <name>", or its toolbar's title does, and the bottom button is enabled. */
    protected fun insideFolder(name: String): Boolean {
        if (pickerNode(USE_LABELS, 0, role = BUTTON, enabled = true) == null) return false
        if (pickerNode(listOf("Files in $name"), 0) != null) return true
        return pickerNodes { node -> node.className?.toString()?.endsWith("Toolbar") == true }
            .any { bar -> (0 until bar.childCount).any { bar.getChild(it)?.text?.toString()?.trim() == name } }
    }

    /** The confirmation DocumentsUI raises on Use this folder (Android 11+): its Allow button, enabled. */
    protected fun permissionDialogShowing(): Boolean = pickerNode(ALLOW_LABELS, 0, role = BUTTON, enabled = true) != null

    /** The drawer's row for the device's own storage: by its names, else the row that is no known collection. */
    protected fun storageRoot(): AccessibilityNodeInfo? {
        val deviceName = runCatching { Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        for (label in listOfNotNull(deviceName, Build.MODEL, "Internal storage", "Internal shared storage")) {
            pickerNode(listOf(label), 0)?.let { return it }
        }
        val known = setOf("recent", "images", "videos", "audio", "documents", "downloads", "drive", "bug reports", "show roots")
        return pickerNodes { node ->
            val text = node.text?.toString()?.trim() ?: return@pickerNodes false
            text.isNotEmpty() && text.lowercase() !in known && node.isVisibleToUser && clickableAncestor(node)
        }.firstOrNull { node -> Rect().also(node::getBoundsInScreen).let { it.width() > 0 && it.height() > 0 } }
    }

    protected fun clickableAncestor(node: AccessibilityNodeInfo): Boolean {
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
    protected fun turnOnSync(firstTime: Boolean) {
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
    protected fun fillSecret(index: Int, what: String) {
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

    /**
     * A finger on the `index`th secret field; true once the chrome's focus is in it. The keyboard
     * is a window of its own and takes a touch inside it: when the field sits under it (the
     * second field, once the first brought the keyboard up), one back lowers the keyboard first –
     * the IME consumes that back, the sheet stays (SettingsTouchDemo's rule for its Cancel).
     */
    protected fun focusSecret(index: Int): Boolean {
        var field = secretFields().getOrNull(index) ?: run {
            dumpNames("the passphrase sheet")
            error("no secret field $index in the sheet")
        }
        val inset = imeInset()
        if (inset > 0 && Rect().also(field::getBoundsInScreen).bottom > height - inset) {
            back()
            val down = awaitIme(shown = false, timeoutMs = 6_000)
            note("  the keyboard was over secret field $index: lowered first ($down)")
            SystemClock.sleep(700)
            field = secretFields().getOrNull(index) ?: return false
        }
        if (!touchTap(field)) {
            Log.w(tag, "secret field $index has no bounds on screen to touch")
            return false
        }
        return awaitSettled({ secretFocused(index) }, 4_000)
    }

    /** The sheet's editable fields, top to bottom (the passphrase, then its confirmation). */
    protected fun secretFields(): List<AccessibilityNodeInfo> = nodes { node ->
        node.packageName?.toString() == app.packageName && node.isEditable && node.isVisibleToUser
    }.filter { node -> Rect().also(node::getBoundsInScreen).let { it.width() > 0 && it.height() > 0 } }
        .sortedBy { node -> Rect().also(node::getBoundsInScreen).top }

    protected fun secretFocused(index: Int): Boolean =
        chromeValue("String(document.activeElement && document.activeElement.id === ${JSONObject.quote(SECRET_IDS[index])})") == "true"

    protected fun secretValue(index: Int): String? {
        val raw = chromeJs("(function(){var e=document.getElementById(${JSONObject.quote(SECRET_IDS[index])});return e?e.value:null})()")
        return runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull()
    }

    protected fun clearField(length: Int) {
        pressKey(KeyEvent.KEYCODE_MOVE_END)
        repeat(length) {
            pressKey(KeyEvent.KEYCODE_DEL)
            SystemClock.sleep(40)
        }
    }

    protected fun formBusy(): Boolean =
        chromeValue("String(!!document.querySelector('[data-testid=\"sync-passphrase-form\"][aria-busy=\"true\"]'))") == "true"

    protected fun formState(): String =
        chromeValue(
            "(function(){var f=document.querySelector('[data-testid=\"sync-passphrase-form\"]');if(!f)return 'no form';" +
                "var m=f.querySelector('[role=\"alert\"], .zen-settings-validation');return 'busy='+f.getAttribute('aria-busy')+" +
                "' message='+(m?m.textContent:'none')})()"
        )

    // --- 4. the toggle ---------------------------------------------------------------------------

    protected fun flipOpenTabs() {
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
    protected fun seedPeer() {
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

    protected fun peerRecords(now: Long, round: Int): List<JSONObject> {
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
    protected fun syncNow() {
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

    protected fun peerListed(): Boolean {
        val devices = syncStatus().getJSONArray("devices")
        return (0 until devices.length()).any { devices.getJSONObject(it).optString("name") == PEER_NAME }
    }

    /** The other device in the list with its last-seen time, and its records in the core's state. */
    protected fun assertLanded() {
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
    protected fun showLanded() {
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
    protected fun turnOffSync() {
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

    protected fun wipeChecked(): Boolean =
        chromeValue("String(!!(document.querySelector('[data-testid=\"sync-disconnect-form\"] input[type=checkbox]')||{}).checked)") == "true"

    // --- 8. the merge question -------------------------------------------------------------------

    /**
     * The merge row opens its sheet; inside it a finger on the second radio (it must read
     * checked), a finger back on Merge, a finger on Continue: the merge must be answered and the
     * sync run – the device and its records back in the core's state.
     */
    protected fun answerMerge() {
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
    protected fun pickRadio(label: String, effect: String) {
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

    protected fun radioNode(label: String): AccessibilityNodeInfo? =
        findNodeWhere { n -> n.isCheckable && (n.text?.toString() ?: n.contentDescription?.toString())?.startsWith(label) == true }

    // --- the page's rows -------------------------------------------------------------------------

    /**
     * Press the row reading `label` on the PAGE (never a sheet's) and wait for `settled`. The
     * finger goes in once the row is scrolled into the page's band and its bounds hold still
     * ([touchPageRow]); when the change never comes, a second finger at the row's own rectangle
     * in the chrome (`data-row` is the row's id): the tree trails the screen by seconds on the
     * software-rendered emulator and reports a scrolled row where it was, the stated reason a
     * page row keeps a second touch – a real one, never a click through the tree, and noted when
     * it was needed. A first finger that opened the URL field instead (it landed on the bar) is
     * undone before the second. False when the row is not there or the change never came.
     */
    protected fun tapRow(label: String, rowId: String, timeoutMs: Long = 6_000, settled: () -> Boolean): Boolean {
        if (settled()) return true
        if (rowBounds(label, 8_000) == null) Log.w(tag, "no row reading '$label' in the tree") else {
            SystemClock.sleep(400)
            if (touchPageRow(label) != null && awaitSettled(settled, timeoutMs)) return true
            Log.w(tag, "'$label' did not take at the tree's bounds; tapping the chrome's own rectangle")
            note("  ('$label' did not take at the tree's bounds; a second finger at the chrome's rectangle)")
            recoverUrlField("the '$label' row")
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
     * Settings row is one button whose text runs its label and description together – once the
     * row is inside the page's band ([pageBand]): the part of the window above the chrome's bottom
     * bar, which the page runs under. A row the tree reports inside the window but under the bar
     * is not on screen for a finger (the second run's finger on the landing's Sync row, at
     * 1461–1541 with the bar from ~1460, opened the URL field, 35532029145), so the row is
     * scrolled to the middle of the page first, through the chrome's own scroll
     * ([revealInChrome]; the tree's `ACTION_SHOW_ON_SCREEN` when the chrome has no such row),
     * up to twice; a row taller than the band is taken once its middle is in it. Polls, since the
     * tree trails the screen on the emulator.
     */
    protected fun rowBounds(text: String, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var reveals = 0
        var misses = 0
        do {
            var node = findNode { it == text || it.startsWith(text) }
            if (node == null) {
                // Nothing of that name on the active window's tree: after a few polls, the
                // automation's cache of the tree is flushed (a node it kept from before the page
                // changed answers for the row that replaced it: 35681463729 read the landing's
                // tree for ten seconds over the Sync section painted on screen) and every window
                // on screen is read, in case the focus sits with another.
                if (++misses % 5 == 0) {
                    flushTree()
                    node = findInWindows(app.packageName) { it == text || it.startsWith(text) }
                    if (node != null) Log.i(tag, "'$text' read off another window's tree (or the flushed cache), not the active window's")
                }
            }
            if (node != null) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                val band = pageBand()
                val sized = bounds.width() > 0 && bounds.height() > 0 && bounds.centerX() in 0 until width
                if (sized && bounds.top >= band.top && bounds.bottom <= band.bottom) return bounds
                if (sized && reveals >= 2 && bounds.centerY() in band.top until band.bottom) return bounds
                if (reveals < 2) {
                    reveals++
                    if (!revealInChrome(text)) node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                    SystemClock.sleep(1_000)
                    continue
                }
            }
            SystemClock.sleep(200)
        } while (SystemClock.uptimeMillis() < deadline)
        return null
    }

    protected fun revealRow(text: String): Rect? = rowBounds(text, 6_000)

    /**
     * Scroll the page row whose text starts with `text` to the middle of its list, in the chrome:
     * the first `data-row` row or landing category that is laid out, not inert (the landing stays
     * in the document behind a section) and reads so. True when the chrome had such a row.
     */
    protected fun revealInChrome(text: String): Boolean {
        val raw = chromeJs(
            "(function(){var t=${JSONObject.quote(text)};var all=document.querySelectorAll('[data-row], .zen-settings-category');" +
                "for(var i=0;i<all.length;i++){var e=all[i];if(e.closest('[inert]'))continue;var r=e.getBoundingClientRect();if(!r.width||!r.height)continue;" +
                "var s=(e.textContent||'').replace(/\\s+/g,' ').trim();if(s===t||s.indexOf(t)===0){e.scrollIntoView({block:'center'});return true}}return false})()"
        )
        return raw == "true"
    }

    /**
     * The part of the window a page row can be touched in: the touchable window down to the top
     * of the chrome's bottom bar, read off the chrome ([barTop]). The bar is the chrome's own
     * layer over the page's bottom, and a finger there is the bar's (the URL field opens).
     */
    protected fun pageBand(): Rect = Rect(touchable.left, touchable.top, touchable.right, barTop())

    /** The screen y the chrome's bottom bar begins at; the touchable window's bottom when there is no bar at the bottom edge. */
    protected fun barTop(): Int {
        val raw = chromeJs(
            "(function(){var b=document.querySelector('.zen-phone-bar[data-edge=\"bottom\"]');if(!b)return null;" +
                "var r=b.getBoundingClientRect();return r.height>0?r.top:null})()"
        )
        val top = raw.toDoubleOrNull() ?: return touchable.bottom
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also(host.chrome::getLocationOnScreen) }
        return (origin[1] + top * density).toInt().coerceIn(touchable.top, touchable.bottom)
    }

    /**
     * A real touch on the page row reading `label` (or starting with it): the node found afresh,
     * its bounds once they hold still ([steadyBounds]), the finger at the middle of their part
     * inside the page's band ([pageBand]) – the harness's own [touchTapLabel] aims inside the
     * touchable window, which on the phone runs on under the chrome's bottom bar. Where the
     * finger landed, or null (nothing touched, and a log line) when nothing reads the label in
     * time or no part of the row is inside the band.
     */
    protected fun touchPageRow(label: String): PointF? {
        val node = awaitNode(4_000) { it == label || it.startsWith(label) } ?: run {
            Log.w(tag, "nothing on screen reads '$label'")
            return null
        }
        val bounds = steadyBounds(node) ?: run {
            Log.w(tag, "the '$label' row went away before the touch")
            return null
        }
        val band = pageBand()
        val reach = Rect(bounds)
        if (bounds.isEmpty || !reach.intersect(band)) {
            Log.w(tag, "no part of '$label' at $bounds is inside the page's band $band")
            return null
        }
        val point = PointF(reach.exactCenterX(), reach.exactCenterY())
        Log.i(tag, "touch at ${point.x},${point.y} on '${node.text ?: node.contentDescription}' (bounds $bounds, band $band)")
        Finger().tap(point.x, point.y)
        return point
    }

    /**
     * Undo a finger that opened the URL field instead of pressing `what` (it landed on the
     * chrome's bottom bar): the field closed the harness's way ([closeUrlField]), the outcome in
     * the notes. Nothing when the field is not open.
     */
    protected fun recoverUrlField(what: String) {
        val close = closeUrlField()
        if (close == UrlFieldClose.NOT_OPEN) return
        note("  (the finger meant for $what opened the URL field; ${close.describe()})")
    }

    protected fun rowText(text: String): String? =
        findNode { it.startsWith(text) }?.let { it.text ?: it.contentDescription }?.toString()

    protected fun syncNowRowText(): String = rowText(SYNC_NOW_LABEL) ?: "(no Sync now row)"

    /**
     * Poll `settled` every 250 ms up to `timeoutMs`. Every second of misses the automation's
     * cache of the tree is flushed (API 34), so a condition read off the tree is read afresh
     * rather than off nodes the cache kept from before the page changed (see [rowBounds]).
     */
    protected fun awaitSettled(settled: () -> Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var polls = 0
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled()) return true
            if (++polls % 4 == 0) flushTree()
            SystemClock.sleep(250)
        }
        return settled()
    }

    /** Flush the automation's cache of the accessibility tree (a no-op below API 34). */
    protected fun flushTree() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ui.clearCache()
    }

    protected fun awaitPage(url: String, timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab != null && tab.optString("url") == url) return tab
            SystemClock.sleep(250)
        }
        Log.w(tag, "the active tab did not come to $url")
        return null
    }

    protected fun ensureDemoTab() {
        if (activeCoreTab()?.optString("id") == DEMO_TAB) return
        coreInvoke("tab.activate", """{"tabId":"$DEMO_TAB"}""")
        awaitSettled({ activeCoreTab()?.optString("id") == DEMO_TAB }, 8_000)
        SystemClock.sleep(1_000)
    }

    // --- frame stats -----------------------------------------------------------------------------

    /**
     * One gesture scene's frames as HWUI counts them for the app's process: the `dumpsys gfxinfo`
     * summary since the reset before the scene (every frame the window drew), and the times of
     * the frames its `framestats` ring still held at the read, as a cross-check.
     */
    protected class FrameScene(
        val total: Int,
        val janky: Int,
        val jankyPercent: Double,
        /** Android 12+'s second count, the pre-12 rule (a frame longer than the vsync period). */
        val jankyLegacy: Int?,
        val p50: Int,
        val p90: Int,
        val p99: Int,
        /** FrameCompleted − IntendedVsync in ms for the ring's `Flags == 0` frames (the others are first frames or layout changes, out of the count by Android's own rule). */
        val ringMs: List<Double>,
        val elapsedMs: Long
    )

    /**
     * Frame stats around one gesture scene: the process's HWUI counters reset before it
     * (`dumpsys gfxinfo <package> reset`), the scene played, the counters read after it
     * (`... framestats`) and the summary's total frames, janky count and share and 50th / 90th /
     * 99th percentile frame times kept for the notes and the table at the end ([noteFrameTable]);
     * the raw dump goes to the framestats file. A scene that did not play (its sheet never came or
     * never went) is read all the same but not counted. The stats are the window's – the chrome
     * WebView draws through the app's render thread, so its sheet's frames are these frames.
     */
    protected fun scene(name: String, body: () -> Boolean) {
        val pkg = app.packageName
        shell("dumpsys gfxinfo $pkg reset")
        SystemClock.sleep(400)
        val started = SystemClock.uptimeMillis()
        val played = body()
        // The dismissal's last frames land before the read.
        SystemClock.sleep(700)
        val elapsed = SystemClock.uptimeMillis() - started
        val dump = shell("dumpsys gfxinfo $pkg framestats")
        val stats = parseGfxInfo(dump, elapsed)
        sceneStats[name] = if (played) stats else null
        frameDumps.appendText("=== $name (${if (played) "played" else "NOT played"}, $elapsed ms) ===\n$dump\n\n")
        when {
            stats == null -> note("  frames [$name]: no HWUI summary for $pkg in the dump (${dump.length} chars)")
            played -> note("  frames [$name]: ${describe(stats)}")
            else -> note("  frames [$name]: the scene did not play; ${describe(stats)} – not counted")
        }
    }

    /**
     * The baseline scene: the app menu (the sheet main had before this PR) under a finger on the
     * bar's Menu button, settled, then a back. True when the sheet came and went.
     */
    protected fun openAndDismissMenu(): Boolean {
        if (sheetCount() != 0) closeSheets()
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            note("  the app menu did not open under a finger")
            return false
        }
        SystemClock.sleep(1_200)
        return dismissScene(MENU_HANDLE_LABEL)
    }

    /**
     * One of the PR's sheets as a scene: a finger on its page row (the same finger the flow uses,
     * [tapRow]), the sheet settled, a back (the keyboard lowered first if it came up with the
     * sheet). True when the sheet came and went – from the chrome and from the tree, so the
     * flow's own finger on the row afterwards finds no stale title.
     */
    protected fun openAndDismissSheet(rowLabel: String, rowId: String, title: String): Boolean {
        if (!tapRow(rowLabel, rowId, timeoutMs = 10_000) { findByLabel(title) != null }) {
            note("  the $rowLabel row did not open its sheet for the scene")
            return false
        }
        SystemClock.sleep(1_200)
        if (imeShown()) {
            back()
            awaitIme(shown = false, timeoutMs = 6_000)
            note("  the keyboard came up with the sheet: lowered before the back")
            SystemClock.sleep(400)
        }
        return dismissScene(title)
    }

    /** A back on the scene's sheet; true once no `.zen-sheet` is in the chrome and `label` has left the tree. */
    protected fun dismissScene(label: String): Boolean {
        back()
        val closed = awaitSettled({ sheetCount() == 0 }, 8_000)
        val gone = waitForGone(label, 8_000)
        SystemClock.sleep(600)
        if (closed && gone) return true
        note("  the sheet did not go on a back (chrome closed=$closed, tree gone=$gone)")
        closeSheets()
        waitForGone(label, 8_000)
        return false
    }

    /**
     * The HWUI summary for this process out of a `dumpsys gfxinfo <package> framestats` dump
     * (the block headed `Graphics info for pid <ours>` when the package has more than one), and
     * the frame times out of its PROFILEDATA rings; null without a summary.
     */
    protected fun parseGfxInfo(dump: String, elapsedMs: Long): FrameScene? {
        val blocks = dump.split("** Graphics info for pid ")
        val mine = blocks.drop(1).firstOrNull { it.startsWith("${Process.myPid()} ") }
            ?: blocks.drop(1).firstOrNull { "Total frames rendered:" in it }
            ?: return null
        fun int(pattern: String): Int? =
            Regex(pattern, RegexOption.MULTILINE).find(mine)?.groupValues?.get(1)?.toIntOrNull()
        val total = int("""^Total frames rendered: (\d+)""") ?: return null
        val janky = Regex("""^Janky frames: (\d+) \((\d+(?:\.\d+)?)%\)""", RegexOption.MULTILINE).find(mine)
        return FrameScene(
            total = total,
            janky = janky?.groupValues?.get(1)?.toIntOrNull() ?: 0,
            jankyPercent = janky?.groupValues?.get(2)?.toDoubleOrNull() ?: 0.0,
            jankyLegacy = int("""^Janky frames \(legacy\): (\d+) \("""),
            p50 = int("""^50th percentile: (\d+)ms""") ?: -1,
            p90 = int("""^90th percentile: (\d+)ms""") ?: -1,
            p99 = int("""^99th percentile: (\d+)ms""") ?: -1,
            ringMs = ringFrameTimes(mine),
            elapsedMs = elapsedMs
        )
    }

    /** FrameCompleted − IntendedVsync, in ms, for every `Flags == 0` row of every PROFILEDATA block (the columns found by name: they differ by release). */
    protected fun ringFrameTimes(block: String): List<Double> {
        val times = ArrayList<Double>()
        val lines = block.lines()
        var i = 0
        while (i < lines.size) {
            if (lines[i].trim() != "---PROFILEDATA---") {
                i++
                continue
            }
            val header = lines.getOrNull(i + 1)?.split(',')?.map { it.trim() } ?: break
            val flags = header.indexOf("Flags")
            val vsync = header.indexOf("IntendedVsync")
            val done = header.indexOf("FrameCompleted")
            i += 2
            while (i < lines.size && lines[i].trim() != "---PROFILEDATA---") {
                val cells = lines[i].split(',')
                if (flags >= 0 && vsync >= 0 && done >= 0 && cells.size > maxOf(flags, vsync, done)) {
                    val flag = cells[flags].trim().toLongOrNull()
                    val from = cells[vsync].trim().toLongOrNull()
                    val to = cells[done].trim().toLongOrNull()
                    if (flag == 0L && from != null && to != null && to > from) times.add((to - from) / 1_000_000.0)
                }
                i++
            }
            i++
        }
        return times
    }

    protected fun describe(s: FrameScene): String {
        val ring = if (s.ringMs.isEmpty()) "" else {
            val sorted = s.ringMs.sorted()
            fun at(p: Double) = "%.1f".format(Locale.US, sorted[((sorted.size - 1) * p).toInt()])
            "; ring ${sorted.size} frames p50 ${at(0.5)} p90 ${at(0.9)} p99 ${at(0.99)} ms, ${sorted.count { it > 16.7 }} over 16.7"
        }
        return "${s.total} frames, ${s.janky} janky (${"%.1f".format(Locale.US, s.jankyPercent)} %)" +
            (s.jankyLegacy?.let { ", $it by the pre-12 rule" } ?: "") +
            ", p50 ${s.p50} ms, p90 ${s.p90} ms, p99 ${s.p99} ms, in ${s.elapsedMs} ms$ring"
    }

    /** The scenes as one table at the end of the notes: the app menu is the before, the PR's sheets the after. */
    protected fun noteFrameTable() {
        note(
            "\nframe stats (dumpsys gfxinfo ${app.packageName}: the counters reset before each scene and read after it; a scene is the sheet opened with a finger, settled, dismissed with a back; " +
                "janky is HWUI's count of frames past their deadline; the app menu is the baseline main had before this PR)"
        )
        note("  %-22s %7s %16s %8s %8s %8s".format(Locale.US, "scene", "frames", "janky", "p50", "p90", "p99"))
        for ((name, s) in sceneStats) {
            if (s == null) {
                note("  %-22s %s".format(Locale.US, name, "not played"))
                continue
            }
            note(
                "  %-22s %7d %16s %5d ms %5d ms %5d ms".format(
                    Locale.US, name, s.total, "${s.janky} (${"%.1f".format(Locale.US, s.jankyPercent)} %)", s.p50, s.p90, s.p99
                )
            )
        }
    }

    // --- sheets ----------------------------------------------------------------------------------

    protected fun sheetCount(): Int = chromeValue("String(document.querySelectorAll('.zen-sheet').length)").toIntOrNull() ?: -1

    protected fun awaitNoSheet() {
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline && sheetCount() != 0) SystemClock.sleep(200)
    }

    protected fun closeSheets() {
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

    protected fun documentPickerShowing(): Boolean = pickerNodes { true }.isNotEmpty()

    protected fun awaitPicker(timeoutMs: Long): Boolean = awaitSettled({ documentPickerShowing() }, timeoutMs)

    protected fun awaitPickerGone(timeoutMs: Long): Boolean = awaitSettled({ !documentPickerShowing() }, timeoutMs)

    /** Nodes of the picker's windows (DocumentsUI, the permission dialog it raises). */
    protected fun pickerNodes(predicate: (AccessibilityNodeInfo) -> Boolean): List<AccessibilityNodeInfo> =
        nodes { node -> node.packageName?.toString() in PICKER_PACKAGES && predicate(node) }

    /**
     * A finger on the picker's control reading one of `labels` (of `role` when given, enabled),
     * then up to `timeoutMs` for `took` – the claim of the step, named by `effect`. The control
     * is found afresh right before each touch (a node held across a wait can be stale by the time
     * it is touched), and the finger goes in up to three times when the effect never comes: the
     * first run lost the tree to one finger at the seam of two windows. Each finger and where it
     * landed go to the notes. False when nothing reads the labels in time or no finger took.
     */
    protected fun pickerPress(labels: List<String>, effect: String, role: String? = null, timeoutMs: Long = 5_000, took: () -> Boolean): Boolean {
        for (attempt in 1..3) {
            val node = pickerNode(labels, if (attempt == 1) 8_000 else 3_000, role, enabled = true) ?: run {
                note("  nothing in the picker reads ${labels.joinToString(" / ") { "'$it'" }} (attempt $attempt)")
                return false
            }
            val label = (node.text ?: node.contentDescription ?: node.hintText)?.toString()?.trim()
            val point = pickerTouch(node) ?: run {
                note("  '$label' has no part inside the touchable window (attempt $attempt)")
                return false
            }
            if (awaitSettled(took, timeoutMs)) {
                note("  the finger at ${point.x.toInt()},${point.y.toInt()} on '$label' took: $effect (attempt $attempt)")
                return true
            }
            note("  the finger at ${point.x.toInt()},${point.y.toInt()} on '$label' did not take: not $effect within $timeoutMs ms (attempt $attempt)")
            SystemClock.sleep(500)
        }
        return false
    }

    /**
     * A real touch on the picker's `node`: its bounds once they hold still ([steadyBounds]), the
     * finger at the middle of their part inside [touchable] ([touchPoint]) – DocumentsUI draws
     * under the navigation bar, and its bottom button's middle is in the bar's window on the
     * emulator, where a touch reaches SystemUI and never the picker. Where the finger landed, or
     * null when no part of the node is inside the touchable window.
     */
    protected fun pickerTouch(node: AccessibilityNodeInfo): PointF? {
        val bounds = steadyBounds(node) ?: return null
        val point = touchPoint(bounds) ?: return null
        Log.i(tag, "picker touch at ${point.x},${point.y} on '${node.text ?: node.contentDescription}' (bounds $bounds, touchable $touchable)")
        Finger().tap(point.x, point.y)
        SystemClock.sleep(400)
        return point
    }

    /**
     * The innermost visible node of the picker's windows whose text, description or hint is one
     * of `labels` (case ignored: a Material button reports its displayed, all-caps text, "ALLOW"),
     * of class `role` when given (the class or its simple name: a Material button reports
     * `android.widget.Button`, an AOSP one is one), enabled when `enabled`; polled for up to
     * `timeoutMs` (one look at 0). Null when none is on screen in time.
     */
    protected fun pickerNode(labels: List<String>, timeoutMs: Long, role: String? = null, enabled: Boolean = false): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val found = pickerNodes { node ->
                if (role != null && node.className?.toString()?.let { it == role || it.endsWith(".$role") } != true) return@pickerNodes false
                if (!node.isVisibleToUser || (enabled && !node.isEnabled)) return@pickerNodes false
                listOf(node.text, node.contentDescription, node.hintText).any { value ->
                    val text = value?.toString()?.trim() ?: return@any false
                    labels.any { text.equals(it, ignoreCase = true) }
                }
            }
                .map { node -> node to Rect().also(node::getBoundsInScreen) }
                .filter { (_, bounds) -> bounds.width() > 0 && bounds.height() > 0 }
                .minByOrNull { (_, bounds) -> bounds.width() * bounds.height() }
            if (found != null) return found.first
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(300)
        }
    }

    /** Breadth-first search of every window on screen (the app, the picker, the dialogs). */
    protected fun nodes(predicate: (AccessibilityNodeInfo) -> Boolean): List<AccessibilityNodeInfo> {
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
    protected fun dumpNames(where: String, packages: Set<String> = setOf(app.packageName)) {
        val names = nodes { node -> node.packageName?.toString() in packages }
            .mapNotNull { node ->
                val name = (node.text ?: node.contentDescription ?: node.hintText)?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                "${node.className?.toString()?.substringAfterLast('.')}:$name"
            }.distinct()
        note("  on screen ($where): ${names.take(60).joinToString(" | ")}")
    }

    // --- keys ------------------------------------------------------------------------------------

    /** Type `text` as key events, each stamped as it is injected (a stale stamp is dropped by the dispatcher). */
    protected fun typeText(text: String) {
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

    protected fun pressKey(keyCode: Int) {
        val now = SystemClock.uptimeMillis()
        ui.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0), true)
        ui.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, keyCode, 0), true)
    }

    // --- the chrome's bridge and the core's state ------------------------------------------------

    protected fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    protected fun awaitChrome(code: String, timeoutMs: Long): Boolean =
        awaitSettled({ chromeValue("String(!!($code))") == "true" }, timeoutMs)

    protected fun chromePoint(selector: String): PointF? {
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

    protected val host: Host get() = (activity as MainActivity).host

    protected fun syncStatus(): JSONObject = coreState().getJSONObject("sync")

    protected fun scope(): JSONObject = syncStatus().getJSONObject("scope")

    protected fun describeSync(): String {
        val s = syncStatus()
        return "sync enabled=${s.getBoolean("enabled")} folderName=${s.optString("folderName")} folderLost=${s.optBoolean("folderLost")} " +
            "pendingMerge=${s.optBoolean("pendingMerge")} syncing=${s.optBoolean("syncing")} lastSyncAt=${s.opt("lastSyncAt")} " +
            "lastError=${s.opt("lastError")} devices=${s.optJSONArray("devices")?.length() ?: 0} deviceName='${s.optString("deviceName")}'"
    }

    /** What the tree's `zenium-sync` directory holds, as the shell lists it. */
    protected fun treeListing(): String = shell("ls -l $FOLDER_PATH/${SyncPeer.DIR_NAME} 2>&1").trim().replace('\n', ';')

    /**
     * Run a shell command as adb would. UiAutomation hands the string to `Runtime.exec`, which
     * splits on whitespace and knows nothing of quotes, so the script travels base64-encoded in a
     * single token and `sh` decodes it.
     */
    protected fun shell(script: String): String {
        val encoded = Base64.encodeToString(script.toByteArray(), Base64.NO_WRAP)
        val descriptor = ui.executeShellCommand("sh -c echo\${IFS}$encoded|base64\${IFS}-d|sh")
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.bufferedReader().readText() }
    }

    protected fun snap(name: String) {
        shots++
        shot("${shots.toString().padStart(2, '0')}-$name")
        note("  shot $name")
    }

    protected fun note(line: String) {
        Log.i(tag, line.trim())
        if (::notes.isInitialized) notes.appendText(line + "\n")
    }

    companion object {
        internal const val PORT = 18151
        internal const val DEMO_TAB = "tab_demo"
        internal const val SETTINGS_URL = "zen://settings"
        internal const val SECTION_URL = "zen://settings/sync"
        /** The folder on the device's storage the picker is steered to (`/sdcard` is the shell's view of it). */
        internal const val FOLDER = "ZeniumSync"
        internal const val FOLDER_PATH = "/sdcard/$FOLDER"
        internal const val PASSPHRASE = "orbit-lantern-42"
        internal val SECRET_IDS = listOf("sync-passphrase", "sync-confirm")
        internal const val PEER_ID = "device_worklaptop"
        internal const val PEER_NAME = "Work laptop"
        internal const val PEER_SPACE = "space_worklaptop_research"
        internal const val PEER_SPACE_NAME = "Research"
        internal const val PEER_TAB = "tab_worklaptop_1"
        internal const val PEER_TAB_TITLE = "Sync design notes"
        internal const val PEER_TAB_URL = "https://example.com/sync-design-notes"
        internal const val PEER_BOOKMARK = "bm_worklaptop_1"
        internal const val PEER_BOOKMARK_TITLE = "Zenium on GitHub"
        internal const val PEER_BOOKMARK_URL = "https://github.com/BenItBuhner/Zenium"
        internal const val PEER_BOOKMARK_2 = "bm_worklaptop_2"
        internal const val PEER_BOOKMARK_2_TITLE = "Zenium releases"
        internal const val PEER_BOOKMARK_2_URL = "https://github.com/BenItBuhner/Zenium/releases"
        // The page's words (`SYNC_COPY` in lib/syncSetup.ts).
        internal const val FOLDER_LABEL = "Sync folder"
        internal const val TURN_ON_LABEL = "Turn on sync"
        internal const val PASSPHRASE_TITLE = "Create a passphrase"
        internal const val OPEN_TABS_LABEL = "Open tabs"
        internal const val SYNC_NOW_LABEL = "Sync now"
        internal const val TURN_OFF_LABEL = "Turn off sync"
        internal const val TURN_OFF_TITLE = "Turn off sync?"
        internal const val WIPE_LABEL = "Also remove this device\u2019s data from the folder"
        internal const val TURN_OFF_ACTION = "Turn off"
        internal const val MERGE_ROW_LABEL = "This folder already has synced data"
        internal const val MERGE_TITLE = "Combine with the data in this folder?"
        internal const val MERGE_LABEL = "Merge"
        internal const val REPLACE_LABEL = "Keep only this device\u2019s data"
        internal const val CONTINUE_LABEL = "Continue"
        // The frame scenes' names, as the notes' table and the PR body carry them.
        internal const val SCENE_MENU = "app menu (baseline)"
        internal const val SCENE_PASSPHRASE = "passphrase sheet"
        internal const val SCENE_TURN_OFF = "Turn off sync sheet"
        internal const val SCENE_MERGE = "merge sheet"
        internal val PICKER_PACKAGES = setOf("com.android.documentsui", "com.google.android.documentsui", "com.android.permissioncontroller")
        // DocumentsUI's words and classes: the confirmation reads "Use this folder" from Android 11
        // ("Select" before), greyed on the storage root; the dialog it raises has Allow.
        internal val USE_LABELS = listOf("Use this folder", "Select")
        internal val ALLOW_LABELS = listOf("Allow", "OK")
        internal const val BUTTON = "Button"
        internal val PAGE = """
            <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Sync demo</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:24px;color:#222}h1{font-size:22px}</style></head>
            <body><h1>Sync demo</h1><p>This tab stands in for a page while Settings › Sync is exercised.</p></body></html>
        """.trimIndent()
    }
}
