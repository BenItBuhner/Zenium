package app.zen.chromium

import android.content.Context
import android.graphics.PointF
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyCharacterMap
import android.view.KeyEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.roundToInt

/**
 * The WebDAV sync transport on the phone (ID-32's Android half: `sync.fetch` / `sync.fetchAbort`
 * over OkHttp, `secrets.*` over the Android Keystore), proved against a WebDAV server on the
 * device's own loopback ([DemoWebDavServer]) with a real Keystore between the engine and its app
 * password – and, since #628 gave Settings › Sync its transport choice, driven THROUGH THE PAGE
 * the way a person drives it: the section from the app menu, the Sync through picker, the server
 * form's one-field sheets typed under a finger, Test connection, Turn on sync's passphrase
 * sheet, Sync now, the App password row after a refusal, Turn off sync's prompt. Every finger is
 * a real touch ([DemoHarness.Finger]) whose effect is read back from the chrome's document or
 * the core's state; a touch that does not take is a [touchFault] (the run fails) and the scene
 * goes on another way so the recording covers the rest. The core's own commands remain for what
 * the page has no control for (the probe's three answers, `bookmark.create`) and as the ways on.
 *
 * Every scene is a still in the light scheme and one in the dark
 * (`sync-webdav-NN-<scene>-{light,dark}.png`): the section with its Sync through row, the
 * picker, the form filled (the app password as dots, the address's plain-http warning), Test
 * connection answered, connected ("Server and device"), the sign-in refused (the status row and
 * its way out over the App password row – and, asserted on the document, neither the engine's
 * method name nor its status code anywhere on the page), recovered with the new password,
 * relaunched (the password read back through the Keystore), disconnected.
 *
 * What the checks prove besides: the probe answers through the bridge (a 207, a 401 for a wrong
 * password, a refused connection); the setup runs PROPFIND, MKCOL and PUT-then-MOVE against the
 * server and puts the device's file in place; a round whose MOVE is answered 412 is run again
 * quietly; a revoked password is `authRefused` (the engine's line names the 401 at the status
 * level, the page never does) and a new one typed into the App password row recovers, the
 * password sealed under the Keystore (`zenium-secrets`, a `v1.` text that never contains it); a
 * relaunch reads the password back through `secrets.get` and syncs again without asking; and
 * Turn off sync with the wipe removes this device's documents from the server (the directory and
 * the README stay: other devices' data is never this device's to delete) and forgets the secret.
 * Every claim is a PASS / FAIL line in `sync-webdav-notes.txt`; one FAIL fails the run. The app
 * passwords never reach a note or a still (a note says how many characters a field holds, never
 * which).
 */
@RunWith(AndroidJUnit4::class)
class SyncWebDavDemo : DemoHarness("sync-demo-state.json", "sync-webdav", "sync-webdav-demo") {
    override val tag: String = "SyncWebDavDemo"

    private lateinit var server: DemoWebDavServer
    private lateinit var page: DemoServer
    private lateinit var notes: File
    private var scenes = 0
    private var checks = 0
    private var failures = 0

    @Test
    fun record() {
        server = DemoWebDavServer(PORT, ROOT, mapOf(USER to PASSWORD)).also { it.start() }
        // The seeded profile's one tab (`sync-demo-state.json`): a page of its own, so the menu
        // the section is opened from stands over a page rather than an error.
        page = DemoServer(PAGE_PORT, mapOf("/" to DemoServer.page("Sync demo", "<p>Settings › Sync is opened from here.</p>"))).also { it.start() }
        try {
            runDemo()
        } finally {
            page.close()
            server.close()
        }
    }

    override fun warmUp() {
        notes = File(out, "sync-webdav-notes.txt")
        notes.writeText("Zenium Android WebDAV sync demo (ID-32, the host verbs; Settings › Sync under a finger)\n\n")
        note("device ${Build.MODEL} (API ${Build.VERSION.SDK_INT}), ${width}x$height; WebDAV server ${server.selfCheck()}; page ${page.selfCheck()}")
        // The Settings chunk loads on its first open: pay for it off camera.
        val warm = coreInvoke("page.open", """{"id":"settings","section":"sync"}""")
        poll(20_000) { rowListed("sync-transport") || rowListed("sync-folder") }
        SystemClock.sleep(800)
        coreInvoke("tab.close", """{"tabId":$warm}""")
        SystemClock.sleep(800)
        val close = closeUrlField()
        if (!close.ok) note("warm-up: ${close.describe()}")
        watchToasts()
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. Settings › Sync from the app menu: sync off, and the Sync through row – the engine's
        //    word that WebDAV is available here (fetch and secrets both present) drawn as the page.
        note("1. Settings › Sync, from the app menu")
        openSection()
        val status = syncStatus()
        check("the engine says WebDAV is available on this phone (fetch and secrets both present)", status.optBoolean("webdavAvailable"))
        check("sync starts off", !status.optBoolean("enabled"))
        check("the page opens on the setup with the Sync through row", groupHeading("sync-setup") == "Set up sync" && rowListed("sync-transport") && settingsRowListed(TRANSPORT_LABEL))
        check("Sync through reads the folder while nothing is chosen", settingsRowValue(TRANSPORT_LABEL) == TRANSPORT_FOLDER)
        check("the setup's paragraph names a WebDAV server beside the folder", pageWords().contains("WebDAV server such as Nextcloud"))
        scene("sync-through")

        // 2. The probe through the bridge, off camera: the core's command, since the page's Test
        //    connection row answers one question at a time and the other two answers are the
        //    bridge's to prove.
        note("\n2. the probe (sync.testWebDav), off camera")
        val ok = JSONObject(coreInvoke("sync.testWebDav", credentials(PASSWORD)))
        check("the probe with the app password answers ok (PROPFIND Depth 0 → 207 through the bridge)", ok.optBoolean("ok"))
        val wrong = JSONObject(coreInvoke("sync.testWebDav", credentials("not-the-password")))
        check("the probe with a wrong password is refused as auth 401", !wrong.optBoolean("ok") && wrong.optString("kind") == "auth" && wrong.optInt("status") == 401)
        val gone = JSONObject(coreInvoke("sync.testWebDav", credentials(PASSWORD, url = "http://127.0.0.1:${PORT + 1}/dav/")))
        check("the probe against a port nobody listens on is unavailable, status 0", !gone.optBoolean("ok") && gone.optString("kind") == "unavailable" && gone.optInt("status") == 0)
        note("  server log so far: ${describeLog()}")

        // 3. Sync through: a finger on the row opens the §9.13 picker; a finger on A WebDAV server
        //    closes it on the server form.
        note("\n3. Sync through: the picker")
        val pickerUp = touchSettingsRowExpecting(TRANSPORT_LABEL, "the Sync through picker is up", 8_000) { sheetPresented(TRANSPORT_LABEL) }
        if (!pickerUp && !sheetPresented(TRANSPORT_LABEL)) {
            note("  the picker did not come up under a finger; the row's click is the way on")
            clickSettingsRow(TRANSPORT_LABEL)
            awaitSheet(TRANSPORT_LABEL, 8_000)
        }
        awaitSheetAtRest(6_000)
        check("the picker lists both transports, the folder marked", radioChecked(TRANSPORT_FOLDER) == true && radioChecked(TRANSPORT_WEBDAV) == false)
        scene("transport-picker")
        val picked = touchSettingsRowExpecting(TRANSPORT_WEBDAV, "the picker closed on the server form", 8_000) { !sheetPresented(TRANSPORT_LABEL) && rowListed("sync-webdav-url") }
        if (!picked && !rowListed("sync-webdav-url")) {
            note("  the option did not take under a finger; the row's click is the way on")
            clickSettingsRow(TRANSPORT_WEBDAV)
            poll(8_000) { !sheetPresented(TRANSPORT_LABEL) && rowListed("sync-webdav-url") }
        }
        awaitTrue(1_500) { settingsAtRest() }
        SystemClock.sleep(800)
        check(
            "Sync through reads the server and the form's rows stand under it",
            settingsRowValue(TRANSPORT_LABEL) == TRANSPORT_WEBDAV && FORM_ROWS.all { rowListed(it) } && !rowListed("sync-folder")
        )
        check("Turn on sync is laid out at 40 %, not pressable, until the details are in", rowDisabled("sync-turn-on") == true)

        // 4. The form: each field its one-field sheet (§9.12), typed under a finger and saved
        //    with one; the row reads what was typed – the app password as dots.
        note("\n4. the server form, field by field")
        fillField(SERVER_LABEL, "sync-webdav-url", server.rootUrl)
        check("Server address reads the address typed", settingsRowValue(SERVER_LABEL) == server.rootUrl)
        check("the plain-http warning stands under the address (taken, not refused)", rowText("sync-webdav-url")?.contains(HTTP_WARNING) == true)
        fillField(USERNAME_LABEL, "sync-webdav-username", USER)
        check("Username reads the account", settingsRowValue(USERNAME_LABEL) == USER)
        fillField(PASSWORD_LABEL, "sync-webdav-password", PASSWORD, secret = true)
        check("App password reads dots, and its text reaches nothing on the page", settingsRowValue(PASSWORD_LABEL) == PASSWORD_SET && !pageWords().contains(PASSWORD))
        fillField(FOLDER_LABEL, "sync-webdav-folder", FOLDER)
        check("Folder reads the folder typed", settingsRowValue(FOLDER_LABEL) == FOLDER)
        check("Turn on sync is pressable with the details in", rowDisabled("sync-turn-on") == false)
        check("Test connection waits with its hint", settingsRowValue(TEST_LABEL) == TEST_HINT)
        scene("server-form")

        // 5. Test connection: a finger on the row, the answer in the row's own line (§9.33: the
        //    sentence, never the method or the status).
        note("\n5. Test connection")
        val propfindsBeforeTest = server.hits("PROPFIND")
        val tested = touchSettingsRowExpecting(TEST_LABEL, "the row reads Connected.", 20_000) { settingsRowValue(TEST_LABEL) == CONNECTED }
        if (!tested && settingsRowValue(TEST_LABEL) != CONNECTED) {
            note("  Test connection did not take under a finger; the row's click is the way on")
            clickSettingsRow(TEST_LABEL)
            poll(20_000) { settingsRowValue(TEST_LABEL) == CONNECTED }
        }
        check("Test connection answers Connected. – one PROPFIND through the bridge", settingsRowValue(TEST_LABEL) == CONNECTED && server.hits("PROPFIND") > propfindsBeforeTest)
        check("the answer names neither the method nor the status", pageWords().let { !it.contains("PROPFIND") && !it.contains("207") })
        scene("test-connection")

        // 6. Turn on sync: the passphrase sheet under a finger; the engine makes the folder and its
        //    directory, writes its file and the README. scrypt-js derives the key in the WebView
        //    (seconds on the emulator) and the first round runs before the sheet closes.
        note("\n6. Turn on sync")
        val propfindsBefore = server.hits("PROPFIND")
        val requestsBeforeSetup = server.requests().size
        val on = turnOn()
        val after = syncStatus()
        check("sync is on after the setup and the first round is done", on)
        check("the status names the WebDAV transport and the folder", after.optString("transport") == "webdav" && after.optString("folderName") == FOLDER)
        check("the status carries neither an error nor a refused sign-in", after.isNull("lastError") && !after.optBoolean("authRefused"))
        check("the server has the folder and its zenium-sync directory (MKCOL)", server.hasCollection("$ROOT/$FOLDER") && server.hasCollection(DIR))
        val files = server.files(DIR) ?: emptyMap()
        val deviceFiles = files.keys.filter { it.endsWith(".zensync") }
        check("one device file (<deviceId>.zensync) and the README are in the directory, no temp file left", deviceFiles.size == 1 && files.containsKey("README.txt") && files.keys.none { it.contains(".tmp-") })
        check("the writes went PUT then MOVE", server.hits("PUT") >= 2 && server.hits("MOVE") >= 2)
        check("the listing went PROPFIND", server.hits("PROPFIND") > propfindsBefore)
        check("no request was answered 401 with the right password", server.requests().drop(requestsBeforeSetup).none { it.status == 401 })
        check("the status never carries the app password", !after.toString().contains(PASSWORD))
        note("  directory: ${files.keys.sorted()}; server log: ${describeLog()}")
        awaitTrue(1_500) { settingsAtRest() }
        SystemClock.sleep(800)
        check("the connected page: Server and device, the account on the host, the folder", groupHeading("sync-where") == WHERE_SERVER && settingsRowValue(SERVER_IN_USE_LABEL) == "$USER on 127.0.0.1:$PORT" && settingsRowValue(FOLDER_LABEL) == "$FOLDER/")
        check("Sync now reads when it last synced", settingsRowValue(SYNC_NOW_LABEL)?.startsWith("Last synced") == true && rowTone("sync-now") == null)
        check("the connected page shows nothing of the app password", !pageWords().contains(PASSWORD))
        scene("connected")

        // 7. A round with a failed precondition: the MOVE answered 412 once, the round run again quietly.
        note("\n7. a round whose MOVE is answered 412 (the engine's quiet retry)")
        coreInvoke("bookmark.create", """{"title":"Zenium","url":"https://zenium.app/","type":"url"}""")
        val movesBefore = server.hits("MOVE")
        server.failNext("MOVE", 412)
        syncNow("the round ran (two MOVEs, the second after the 412)", 30_000) { s -> !s.optBoolean("syncing", false) && server.hits("MOVE") >= movesBefore + 2 }
        val round = syncStatus()
        check("the round ran the MOVE again after the 412", server.hits("MOVE") >= movesBefore + 2 && server.requests().any { it.method == "MOVE" && it.status == 412 })
        check("the round ended without an error shown", round.isNull("lastError") && !round.optBoolean("authRefused") && rowTone("sync-now") == null)
        note("  moves $movesBefore → ${server.hits("MOVE")}; lastError ${round.opt("lastError")}")

        // 8. The password revoked on the server: authRefused. The page says it in its own words –
        //    the status row and its way out over the App password row – and the engine's line
        //    (its method and status code) reaches nothing on the page.
        note("\n8. a revoked app password (authRefused)")
        server.setPassword(USER, ROTATED)
        coreInvoke("bookmark.create", """{"title":"Docs","url":"https://docs.zenium.app/","type":"url"}""")
        syncNow("the sign-in is refused", 20_000) { s -> s.optBoolean("authRefused") }
        val refusedStatus = syncStatus()
        check("the round with the old password is authRefused", refusedStatus.optBoolean("authRefused"))
        check("the status carries the engine's line, and nothing of the credential", refusedStatus.optString("lastError") == RAW_ENGINE_LINE && !refusedStatus.toString().contains(PASSWORD))
        awaitTrue(1_500) { settingsAtRest() }
        SystemClock.sleep(800)
        val refusedRow = rowText("sync-auth-refused")
        check(
            "the status row says the refusal and its way out in the page's words, in the danger ink",
            refusedRow != null && refusedRow.contains(AUTH_REFUSED) && refusedRow.contains(AUTH_REFUSED_HINT) && rowTone("sync-auth-refused") == "danger" && firstRowOf("sync-status") == "sync-auth-refused"
        )
        check(
            "the App password row stands first under Server and device, with its line",
            firstRowOf("sync-where") == "sync-webdav-password" && rowText("sync-webdav-password")?.contains(PASSWORD_AGAIN_HINT) == true && groupHeading("sync-where") == WHERE_SERVER
        )
        check("Sync now is not pressable while the sign-in is refused, and carries no line of its own", rowDisabled("sync-now") == true && rowTone("sync-now") == null)
        val words = pageWords()
        check(
            "neither PROPFIND nor 401 reaches the page: not in its text, its labels, its markup",
            !words.contains("PROPFIND") && !STATUS_CODE_401.containsMatchIn(words) && chromeJs("document.body.innerHTML.indexOf('PROPFIND')<0") == "true"
        )
        check("the app passwords reach nothing on the page", !words.contains(PASSWORD) && !words.contains(ROTATED))
        scene("refused")

        // 9. The new password, typed into the App password row: the sheet is §9.30's busy form
        //    while the engine keeps it and runs a round, then closes; the status row goes.
        note("\n9. the new app password, through the App password row")
        val lastSyncBefore = refusedStatus.optLong("lastSyncAt", 0)
        fillField(PASSWORD_LABEL, "sync-webdav-password", ROTATED, secret = true, saveTimeoutMs = 90_000)
        val recovered = poll(60_000) { val s = syncStatus(); !s.optBoolean("authRefused") && s.isNull("lastError") && s.optLong("lastSyncAt", 0) > lastSyncBefore }
        check("the new password recovers: not refused, no error, a round done", recovered)
        val sealed = sealedPassword()
        check("the password is sealed under the Keystore in zenium-secrets (a v1. text that does not contain it)", sealed != null && sealed.startsWith("v1.") && !sealed.contains(ROTATED) && !sealed.contains(PASSWORD))
        note("  sealed text: ${sealed?.let { "${it.length} chars, ${it.count { c -> c == '.' }} dots" } ?: "none"}")
        awaitTrue(1_500) { settingsAtRest() }
        SystemClock.sleep(800)
        check("the status row and the App password row are gone from the page", !rowListed("sync-auth-refused") && !rowListed("sync-webdav-password") && firstRowOf("sync-where") == "sync-server")
        check("Sync now reads when it last synced again", settingsRowValue(SYNC_NOW_LABEL)?.startsWith("Last synced") == true && rowDisabled("sync-now") == false)
        check("the new password reaches nothing on the page", !pageWords().contains(ROTATED))
        scene("recovered")

        // 10. A relaunch: the password comes back through secrets.get (a fresh host, the Keystore
        //     opened again), the engine connects without asking and a round runs.
        note("\n10. a relaunch reads the password back through the Keystore")
        SystemClock.sleep(3_000)
        val propfindsBeforeRelaunch = server.hits("PROPFIND")
        val requestsBeforeRelaunch = server.requests().size
        relaunch()
        val reconnected = poll(30_000) { val s = syncStatus(); s.optBoolean("enabled") && !s.optBoolean("authRefused") }
        check("after the relaunch sync is on and not refused (the secret was read back)", reconnected)
        if (!poll(10_000) { settingsSectionIs("sync") }) {
            note("  the relaunch did not come back on the section; opened again")
            openSection()
        } else {
            note("  the relaunch came back on Settings › Sync")
        }
        awaitTrue(1_500) { settingsAtRest() }
        SystemClock.sleep(800)
        val lastSyncBeforeRelaunchRound = syncStatus().optLong("lastSyncAt", 0)
        syncNow("a round ran after the relaunch", 30_000) { s -> server.hits("PROPFIND") > propfindsBeforeRelaunch && !s.optBoolean("syncing", false) && s.optLong("lastSyncAt", 0) > lastSyncBeforeRelaunchRound }
        val relaunched = syncStatus()
        val sinceRelaunch = server.requests().drop(requestsBeforeRelaunch)
        check("a round after the relaunch reached the server with the sealed password (no 401 since)", relaunched.optLong("lastSyncAt", 0) > lastSyncBeforeRelaunchRound && relaunched.isNull("lastError") && sinceRelaunch.isNotEmpty() && sinceRelaunch.none { it.status == 401 })
        check("the relaunched page is the connected one, no status row", groupHeading("sync-where") == WHERE_SERVER && !rowListed("sync-auth-refused") && settingsRowValue(SERVER_IN_USE_LABEL) == "$USER on 127.0.0.1:$PORT")
        note("  requests since the relaunch: ${sinceRelaunch.size}, statuses ${sinceRelaunch.map { it.status }.distinct().sorted()}")
        scene("relaunched")

        // 11. Turn off sync with the wipe (§9.23: the checkbox row submitted with the destructive
        //     action): this device's documents go (DELETE), the secret goes (secrets.delete); the
        //     directory and the README stay for the other devices.
        note("\n11. Turn off sync, with the wipe")
        val deletesBefore = server.hits("DELETE")
        turnOff()
        val off = poll(30_000) {
            val remaining = server.files(DIR) ?: emptyMap()
            !syncStatus().optBoolean("enabled") && server.hits("DELETE") > deletesBefore && remaining.keys.none { it.endsWith(".zensync") || it.endsWith(".zenpage") }
        }
        val remaining = server.files(DIR) ?: emptyMap()
        check("sync is off and this device's documents are gone from the server (DELETE)", off)
        check("the directory and the README stay for the other devices", server.hasCollection(DIR) && remaining.containsKey("README.txt"))
        val forgotten = poll(10_000) { sealedPassword() == null }
        check("the sealed password is gone from zenium-secrets", forgotten)
        note("  directory after the wipe: ${remaining.keys.sorted()}")
        awaitTrue(1_500) { settingsAtRest() }
        SystemClock.sleep(800)
        check("the page is back on the setup with the Sync through row", groupHeading("sync-setup") == "Set up sync" && rowListed("sync-transport") && !rowListed("sync-disconnect"))
        check("the setup shows nothing of the app passwords", pageWords().let { !it.contains(PASSWORD) && !it.contains(ROTATED) })
        scene("disconnected")

        note("\n$checks checks, $failures failed; $scenes scenes, ${scenes * 2} stills; server log: ${describeLog()}")
        if (failures > 0) throw AssertionError("$failures of $checks checks failed; see sync-webdav-notes.txt")
    }

    // --- the section -----------------------------------------------------------------------------

    /**
     * Settings › Sync the way a person reaches it: the app menu's Settings row and the landing's
     * Sync row under a finger ([openSettingsSection]; the fault is on record when a touch did
     * not take), `page.open` as the way on when the fingers' way never came up.
     */
    private fun openSection() {
        ensureForeground()
        val how = when {
            settingsSectionIs("sync") -> "already up"
            openSettingsSection("sync", 10_000) -> "the app menu's Settings row and the landing's Sync row under a finger"
            else -> {
                coreInvoke("page.open", """{"id":"settings","section":"sync"}""")
                poll(12_000) { settingsSectionIs("sync") }
                "page.open (the fingers' way did not come up)"
            }
        }
        awaitTrue(1_500) { settingsAtRest() }
        SystemClock.sleep(1_000)
        note("  Settings › Sync: $how")
    }

    // --- the sheets ------------------------------------------------------------------------------

    /**
     * A field row's one-field sheet (§9.12): a finger on the row opens it, a finger on the field
     * focuses it (the keyboard lowered first when it stands over the field: the IME takes that
     * back, the sheet stays), `text` typed as key events and read back from the field, the
     * keyboard lowered, and a finger on Save, which must close the sheet within `saveTimeoutMs`
     * (the App password row's Save runs a round first: §9.30's busy form). A secret's text is
     * never noted, only its length. True once the sheet is gone.
     */
    private fun fillField(label: String, rowId: String, text: String, secret: Boolean = false, saveTimeoutMs: Long = 15_000): Boolean {
        val id = "settings-field-$rowId"
        val up = touchSettingsRowExpecting(label, "the $label sheet is up", 8_000) { sheetPresented(label) }
        if (!up && !sheetPresented(label)) {
            note("  the $label row did not open its sheet under a finger; the row's click is the way on")
            clickSettingsRow(label)
            if (!awaitSheet(label, 8_000)) {
                note("  no $label sheet came up")
                return false
            }
        }
        awaitSheetAtRest(6_000)
        typeInto(id, text, "the $label field", secret)
        lowerKeyboard()
        val saved = touchSheetButton("Save", "the $label sheet closed", saveTimeoutMs) { !sheetPresented(label) }
        if (!saved && sheetPresented(label)) {
            note("  Save did not take under a finger; Enter in the field is the way on")
            focusField(id)
            pressKey(KeyEvent.KEYCODE_ENTER)
            awaitSheetGone(label, saveTimeoutMs)
        }
        SystemClock.sleep(800)
        return !sheetPresented(label)
    }

    /**
     * Turn on sync: a finger on the row opens the passphrase sheet; the passphrase typed into
     * both fields under a finger each; the keyboard lowered; a finger on the sheet's Turn on
     * sync, which must leave the form busy or sync on. Then the engine: scrypt-js takes its
     * seconds on the emulator, so the wait for `enabled` and the first round is generous. True
     * once sync is on and the first round is done.
     */
    private fun turnOn(): Boolean {
        val up = touchSettingsRowExpecting(TURN_ON_LABEL, "the passphrase sheet is up", 10_000) { sheetPresented(PASSPHRASE_TITLE) }
        if (!up && !sheetPresented(PASSPHRASE_TITLE)) {
            note("  Turn on sync did not open its sheet under a finger; the row's click is the way on")
            clickSettingsRow(TURN_ON_LABEL)
            awaitSheet(PASSPHRASE_TITLE, 8_000)
        }
        awaitSheetAtRest(6_000)
        typeInto("sync-passphrase", PASSPHRASE, "the passphrase field", secret = true)
        typeInto("sync-confirm", PASSPHRASE, "the confirmation field", secret = true)
        lowerKeyboard()
        val touched = SystemClock.uptimeMillis()
        val took = touchSheetButton(TURN_ON_LABEL, "the form is busy or sync is on", 8_000) { formBusy() || syncStatus().optBoolean("enabled") }
        if (!took && !formBusy() && !syncStatus().optBoolean("enabled")) {
            note("  the sheet's Turn on sync did not take under a finger; Enter in the field is the way on")
            focusField("sync-confirm")
            pressKey(KeyEvent.KEYCODE_ENTER)
        }
        val on = poll(150_000) { val s = syncStatus(); s.optBoolean("enabled") && !s.isNull("lastSyncAt") && !s.optBoolean("syncing", false) }
        note("  sync ${if (on) "on, the first round done," else "NOT on"} ${SystemClock.uptimeMillis() - touched} ms after the touch; form ${formState()}")
        awaitSheetGone(PASSPHRASE_TITLE, 10_000)
        SystemClock.sleep(1_000)
        return on
    }

    /**
     * Sync now under a finger, `settled` its claim on the status (named by `effect`); `sync.now`
     * through the core is the way on when the row did not take the touch.
     */
    private fun syncNow(effect: String, timeoutMs: Long, settled: (JSONObject) -> Boolean) {
        val took = touchSettingsRowExpecting(SYNC_NOW_LABEL, effect, timeoutMs) { settled(syncStatus()) }
        if (!took && !settled(syncStatus())) {
            note("  Sync now did not take under a finger; sync.now through the core is the way on")
            coreInvoke("sync.now")
            poll(timeoutMs) { settled(syncStatus()) }
        }
    }

    /**
     * Turn off sync: a finger on the row opens the prompt, a finger on the wipe's checkbox row
     * checks it, a finger on Turn off must leave sync off; `sync.disconnect` is the way on.
     */
    private fun turnOff() {
        val up = touchSettingsRowExpecting(TURN_OFF_LABEL, "the Turn off sync? prompt is up", 10_000) { sheetPresented(TURN_OFF_TITLE) }
        if (!up && !sheetPresented(TURN_OFF_TITLE)) {
            note("  Turn off sync did not open its prompt under a finger; the row's click is the way on")
            clickSettingsRow(TURN_OFF_LABEL)
            awaitSheet(TURN_OFF_TITLE, 8_000)
        }
        awaitSheetAtRest(6_000)
        val box = chromePointOf("document.querySelector('$SHEET .zen-v2-check-row')")
        if (box != null && touchable.contains(box.x.roundToInt(), box.y.roundToInt())) {
            Finger().tap(box.x, box.y)
            if (!awaitTrue(4_000) { wipeChecked() }) touchFault("a touch on the wipe's checkbox row did not check it")
        } else {
            touchTapLabelExpecting(WIPE_LABEL, "the wipe is checked", 4_000, prefix = true) { wipeChecked() }
        }
        if (!wipeChecked()) {
            note("  the wipe's box did not take a finger; checked through the document as the way on")
            chromeJs("(function(){var b=document.querySelector('$SHEET input.zen-v2-checkbox');if(b&&!b.checked)b.click();return !!b})()")
            poll(2_000) { wipeChecked() }
        }
        check("the wipe's checkbox row is checked before Turn off", wipeChecked())
        SystemClock.sleep(600)
        val off = touchSheetButton(TURN_OFF_ACTION, "sync is off", 15_000) { !syncStatus().optBoolean("enabled") }
        if (!off && syncStatus().optBoolean("enabled")) {
            note("  Turn off did not take under a finger; sync.disconnect through the core is the way on")
            coreInvoke("sync.disconnect", """{"wipeRemote":true}""")
        }
        awaitSheetGone(TURN_OFF_TITLE, 10_000)
    }

    /**
     * A finger on the presented sheet's action button reading `text` (Cancel, Save, Turn on sync,
     * Turn off: `.zen-settings-sheet-actions`, blocks.tsx), where the document has it; then up to
     * `timeoutMs` for `took` – the step's claim, named by `effect`. The tree's node when the
     * document has no such button. A touch that went in and never took is a [touchFault].
     */
    private fun touchSheetButton(text: String, effect: String, timeoutMs: Long, took: () -> Boolean): Boolean {
        val point = chromePointOf(
            "Array.prototype.find.call(document.querySelectorAll('$SHEET .zen-settings-sheet-actions button')," +
                "function(b){return (b.textContent||'').trim()===${JSONObject.quote(text)}})"
        )
        if (point == null || !touchable.contains(point.x.roundToInt(), point.y.roundToInt())) {
            note("  no '$text' button in the sheet's document within the touchable window (${point ?: "none"}); the tree's node instead")
            return touchTapLabelExpecting(text, effect, timeoutMs, took = took)
        }
        Log.i(tag, "touch at ${point.x},${point.y} on the sheet's '$text'")
        Finger().tap(point.x, point.y)
        if (awaitTrue(timeoutMs, took)) {
            Log.i(tag, "the touch on the sheet's '$text' took: $effect")
            return true
        }
        touchFault("a touch on the sheet's '$text' did not take: not $effect within $timeoutMs ms")
        return false
    }

    /**
     * The sheet's spring has landed: the chassis holds `--zen-recede` at 1 once a sheet rests
     * (§11.1), and a finger landing on a moving sheet catches it instead of tapping.
     */
    private fun awaitSheetAtRest(timeoutMs: Long): Boolean {
        val rested = poll(timeoutMs) {
            chromeJs(
                "document.querySelectorAll('.zen-sheet').length===1&&" +
                    "Number(document.documentElement.style.getPropertyValue('--zen-recede'))>=0.99"
            ) == "true"
        }
        SystemClock.sleep(800)
        return rested
    }

    // --- the keyboard ----------------------------------------------------------------------------

    /**
     * `text` typed into the field `id`: focused under a finger ([focusField]; a touch that does
     * not focus it is a [touchFault]), the keys injected and the field read back, up to four
     * rounds, then set through the document as the way on. A secret's length is noted, never
     * its text. True once the field holds `text`.
     */
    private fun typeInto(id: String, text: String, what: String, secret: Boolean): Boolean {
        if (!focusField(id)) touchFault("a touch on $what did not focus it")
        var typed = 0
        for (attempt in 1..4) {
            if (!fieldFocused(id)) focusField(id)
            typeText(text.substring(typed))
            SystemClock.sleep(600)
            val value = fieldValue(id)
            if (value == text) {
                note("  $what holds its ${text.length} characters (attempt $attempt)")
                return true
            }
            if (value != null && value.isNotEmpty() && text.startsWith(value)) {
                typed = value.length
                note("  $typed of ${text.length} keys landed in $what (attempt $attempt)")
            } else {
                note("  $what holds ${value?.length ?: "no"} characters, not a start of the text (attempt $attempt)")
                clearField(value?.length ?: 0)
                typed = 0
            }
        }
        note("  $what never took the keys${if (secret) "" else " for '$text'"}; set through the document as the way on")
        return setFieldValue(id, text)
    }

    /**
     * A finger on the field `id`; true once the chrome's focus is in it. The keyboard is a
     * window of its own and takes a touch inside it: when the field sits under it, one back
     * lowers the keyboard first – the IME consumes that back, the sheet stays
     * (SettingsTouchDemo's rule for its Cancel).
     */
    private fun focusField(id: String): Boolean {
        for (attempt in 1..4) {
            if (fieldFocused(id)) return true
            val point = chromePointOf("document.getElementById(${JSONObject.quote(id)})") ?: return false
            val inset = imeInset()
            if (inset > 0 && point.y > height - inset) {
                back()
                val down = awaitIme(shown = false, timeoutMs = 6_000)
                note("  the keyboard was over the field: lowered first (${if (down) "down" else "still up"})")
                SystemClock.sleep(700)
                continue
            }
            if (!touchable.contains(point.x.roundToInt(), point.y.roundToInt())) {
                Log.w(tag, "the field '$id' at $point is outside the touchable window $touchable")
                return false
            }
            Finger().tap(point.x, point.y)
            if (awaitTrue(4_000) { fieldFocused(id) }) {
                awaitIme(shown = true, timeoutMs = 4_000)
                SystemClock.sleep(500)
                return true
            }
            SystemClock.sleep(500)
        }
        return fieldFocused(id)
    }

    private fun lowerKeyboard() {
        if (!imeShown()) return
        back()
        val down = awaitIme(shown = false, timeoutMs = 6_000)
        note("  the keyboard lowered before the sheet's action (${if (down) "down" else "still up"})")
        SystemClock.sleep(800)
    }

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

    private fun clearField(length: Int) {
        pressKey(KeyEvent.KEYCODE_MOVE_END)
        repeat(length) {
            pressKey(KeyEvent.KEYCODE_DEL)
            SystemClock.sleep(40)
        }
    }

    // --- the chrome's document -------------------------------------------------------------------

    private fun fieldFocused(id: String): Boolean =
        chromeJs("!!document.activeElement&&document.activeElement.id===${JSONObject.quote(id)}") == "true"

    private fun fieldValue(id: String): String? =
        chromeJsString("(function(){var e=document.getElementById(${JSONObject.quote(id)});return e?e.value:null})()")

    /** The way on when the keys never landed: the value set through the native setter and React told through an input event. */
    private fun setFieldValue(id: String, text: String): Boolean =
        chromeJs(
            "(function(){var e=document.getElementById(${JSONObject.quote(id)});if(!e)return false;" +
                "var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(e,${JSONObject.quote(text)});" +
                "e.dispatchEvent(new Event('input',{bubbles:true}));return e.value===${JSONObject.quote(text)}})()"
        ) == "true"

    private fun formBusy(): Boolean =
        chromeJs("!!document.querySelector('[data-testid=\"sync-passphrase-form\"][aria-busy=\"true\"]')") == "true"

    private fun formState(): String =
        chromeJsString(
            "(function(){var f=document.querySelector('[data-testid=\"sync-passphrase-form\"]');if(!f)return 'no form';" +
                "var m=f.querySelector('[role=\"alert\"], .zen-settings-validation');return 'busy='+f.getAttribute('aria-busy')+" +
                "' message='+(m?m.textContent:'none')})()"
        ) ?: "(no answer)"

    private fun wipeChecked(): Boolean =
        chromeJs("!!(function(){var b=document.querySelector('[data-testid=\"sync-disconnect-form\"] input.zen-v2-checkbox');return b&&b.checked})()") == "true"

    /** Whether the picker's option reading `label` is checked (`aria-checked` on its radio row); null when there is none. */
    private fun radioChecked(label: String): Boolean? =
        chromeJsString(
            "(function(){var b=Array.prototype.find.call(document.querySelectorAll('$SHEET [role=\"radio\"]'),function(e){" +
                "var l=e.querySelector('.zen-settings-label');return l&&(l.textContent||'').trim()===${JSONObject.quote(label)}});" +
                "return b?String(b.getAttribute('aria-checked')==='true'):null})()"
        )?.toBooleanStrictOrNull()

    private fun rowSelector(rowId: String): String = JSONObject.quote("[data-row=\"$rowId\"]")

    private fun rowListed(rowId: String): Boolean =
        chromeJs("!!document.querySelector(${rowSelector(rowId)})") == "true"

    private fun rowText(rowId: String): String? =
        chromeJsString("(function(){var r=document.querySelector(${rowSelector(rowId)});return r?(r.textContent||''):null})()")

    private fun rowTone(rowId: String): String? =
        chromeJsString("(function(){var r=document.querySelector(${rowSelector(rowId)});return r?r.getAttribute('data-tone'):null})()")

    /** Whether the row is laid out but not pressable (`aria-disabled`, §10.4); null when the document has no such row. */
    private fun rowDisabled(rowId: String): Boolean? =
        chromeJsString("(function(){var r=document.querySelector(${rowSelector(rowId)});return r?String(r.getAttribute('aria-disabled')==='true'||r.disabled===true):null})()")
            ?.toBooleanStrictOrNull()

    private fun groupSelector(groupId: String): String = JSONObject.quote("[data-group=\"$groupId\"]")

    private fun groupHeading(groupId: String): String? =
        chromeJsString(
            "(function(){var g=document.querySelector(${groupSelector(groupId)});if(!g)return null;var h=g.querySelector('.zen-settings-heading');" +
                "if(!h)return '';var c=h.firstChild;return (c&&c.nodeType===3?c.nodeValue:(h.textContent||'')).trim()})()"
        )

    private fun firstRowOf(groupId: String): String? =
        chromeJsString("(function(){var g=document.querySelector(${groupSelector(groupId)});var r=g&&g.querySelector('[data-row]');return r?r.getAttribute('data-row'):null})()")

    /**
     * Every word the Settings page could show or read out: the page's text, and the `aria-label`,
     * `title`, `placeholder`, `alt` and `value` of every element under it. What the refused scene
     * is checked against: neither the engine's method nor its status code, nor an app password.
     */
    private fun pageWords(): String =
        chromeJsString(
            "(function(){var root=document.querySelector('.zen-settings-phone')||document.body;var parts=[root.textContent||''];" +
                "var els=root.querySelectorAll('*');var attrs=['aria-label','title','placeholder','alt','value'];" +
                "for(var i=0;i<els.length;i++){for(var j=0;j<attrs.length;j++){var v=els[i].getAttribute(attrs[j]);if(v)parts.push(v)}}" +
                "return parts.join('\\n')})()"
        ) ?: ""

    /**
     * Where the element `elementJs` evaluates to is on screen: scrolled into view if it is not,
     * its box's middle in CSS px scaled into the chrome view's place on screen. Null when the
     * document has no such element.
     */
    private fun chromePointOf(elementJs: String): PointF? {
        val raw = chromeJs(
            "(function(){var e=($elementJs);if(!e)return null;e.scrollIntoView({block:'nearest',behavior:'instant'});" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also((activity as MainActivity).host.chrome::getLocationOnScreen) }
        SystemClock.sleep(400)
        return PointF(origin[0] + point.getDouble(0).toFloat() * density, origin[1] + point.getDouble(1).toFloat() * density)
    }

    // --- the stills ------------------------------------------------------------------------------

    /** The scene as a still in the light scheme and one in the dark, the page left in the light. */
    private fun scene(name: String) {
        scenes++
        val n = scenes.toString().padStart(2, '0')
        theme(LIGHT)
        shot("$n-$name-light")
        beat()
        theme(DARK)
        shot("$n-$name-dark")
        beat()
        theme(LIGHT)
        note("  stills $n-$name-light, $n-$name-dark")
    }

    /** Switch the chrome's colour scheme through the core and wait for the root to carry it. */
    private fun theme(scheme: String): Boolean {
        if (themeAttribute() == scheme) return true
        coreInvoke("settings.update", JSONObject().put("colorScheme", scheme).toString())
        val took = poll(8_000) { themeAttribute() == scheme }
        // The 240 ms theme blend (§11), the page's repaint on the software GPU, then a frame.
        SystemClock.sleep(1_500)
        if (!took) note("  (the scheme did not flip to $scheme: theme attribute '${themeAttribute()}')")
        return took
    }

    private fun themeAttribute(): String? = chromeJsString("document.documentElement.getAttribute('data-theme')")

    // --- the core, the server, the Keystore ------------------------------------------------------

    private fun credentials(password: String, url: String = server.rootUrl): String =
        JSONObject().put("url", url).put("username", USER).put("password", password).put("folder", FOLDER).toString()

    private fun syncStatus(): JSONObject = coreState().getJSONObject("sync")

    /** The sealed app password as `Secrets.kt` keeps it, or null when there is none; never its plain text. */
    private fun sealedPassword(): String? =
        app.getSharedPreferences(Secrets.PREFERENCES_FILE, Context.MODE_PRIVATE).getString(SECRET_KEY, null)

    /**
     * The activity finished and started again ([StatusBarDemo]'s way): the old host is torn down
     * with its lazily built `Secrets`, and the new core's `connect()` asks a fresh one.
     */
    private fun relaunch() {
        val old = activity
        instrumentation.runOnMainSync { old.finish() }
        poll(10_000) { old.isDestroyed }
        SystemClock.sleep(1_500)
        launch()
        ensureForeground()
        poll(20_000) { chromeJs("typeof window.zen") == "\"object\"" }
        SystemClock.sleep(1_500)
    }

    private fun poll(timeoutMs: Long, holds: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (runCatching { holds() }.getOrDefault(false)) return true
            SystemClock.sleep(250)
        }
        return runCatching { holds() }.getOrDefault(false)
    }

    private fun describeLog(): String =
        server.requests().groupBy { it.method }.entries.sortedBy { it.key }
            .joinToString(", ") { (method, requests) -> "$method ×${requests.size} (${requests.map { it.status }.distinct().sorted().joinToString("/")})" }

    private fun check(claim: String, holds: Boolean) {
        checks++
        if (!holds) failures++
        note("  ${if (holds) "PASS" else "FAIL"}: $claim")
    }

    private fun note(text: String) {
        notes.appendText("$text\n")
        Log.i(tag, text)
    }

    companion object {
        private const val PORT = 8767
        /** The seeded profile's tab (`sync-demo-state.json`: `http://127.0.0.1:18151/`). */
        private const val PAGE_PORT = 18151
        /** The DAV root: the address the form takes is `http://127.0.0.1:8767/dav/`. */
        private const val ROOT = "/dav"
        private const val USER = "alice"
        /** The demo's app password – a fixture's, never a real one; it must not appear in a note or a still. */
        private const val PASSWORD = "demo-app-password-1"
        private const val ROTATED = "demo-app-password-2"
        private const val FOLDER = "Zenium"
        private const val DIR = "$ROOT/$FOLDER/zenium-sync"
        private const val PASSPHRASE = "correct horse battery staple"
        /** `WEBDAV_SECRET_KEY` in src/core/sync/webdav.ts. */
        private const val SECRET_KEY = "sync.webdav.password"
        /** The engine's own line for the refused round (engine.ts): kept in the status, never on the page. */
        private const val RAW_ENGINE_LINE = "WebDAV PROPFIND answered 401"
        private const val LIGHT = "light"
        private const val DARK = "dark"
        /** The presented sheet's dialog, as the chassis names it (`BottomSheet.tsx`). */
        private const val SHEET = "[data-sheet-layer] [role=\"dialog\"]"
        private val STATUS_CODE_401 = Regex("(?<!\\d)401(?!\\d)")

        // The page's words (`SYNC_COPY`, lib/syncSetup.ts).
        private const val TRANSPORT_LABEL = "Sync through"
        private const val TRANSPORT_FOLDER = "A folder on this device"
        private const val TRANSPORT_WEBDAV = "A WebDAV server"
        private const val SERVER_LABEL = "Server address"
        private const val HTTP_WARNING = "Over http:// the app password is sent unprotected."
        private const val USERNAME_LABEL = "Username"
        private const val PASSWORD_LABEL = "App password"
        private const val PASSWORD_SET = "••••••••"
        private const val PASSWORD_AGAIN_HINT = "The one the server takes now; the old one is forgotten."
        private const val FOLDER_LABEL = "Folder"
        private const val TEST_LABEL = "Test connection"
        private const val TEST_HINT = "Reaches the server with these details; nothing is written yet."
        private const val CONNECTED = "Connected."
        private const val TURN_ON_LABEL = "Turn on sync"
        private const val PASSPHRASE_TITLE = "Create a passphrase"
        private const val SYNC_NOW_LABEL = "Sync now"
        private const val WHERE_SERVER = "Server and device"
        private const val SERVER_IN_USE_LABEL = "WebDAV server"
        private const val AUTH_REFUSED = "The server refused the sign-in"
        private const val AUTH_REFUSED_HINT = "Enter a new app password to keep syncing."
        private const val TURN_OFF_LABEL = "Turn off sync"
        private const val TURN_OFF_TITLE = "Turn off sync?"
        private const val WIPE_LABEL = "Also remove this device’s data from the folder"
        private const val TURN_OFF_ACTION = "Turn off"
        private val FORM_ROWS = listOf("sync-webdav-url", "sync-webdav-username", "sync-webdav-password", "sync-webdav-folder", "sync-webdav-test")
    }
}
