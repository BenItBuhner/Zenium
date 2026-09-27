package app.zen.chromium

import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The WebDAV sync transport on the phone (ID-32's Android half: `sync.fetch` / `sync.fetchAbort`
 * over OkHttp, `secrets.*` over the Android Keystore), proved against a WebDAV server on the
 * device's own loopback ([DemoWebDavServer]) with a real Keystore between the engine and its app
 * password. The phone's Settings › Sync has no transport choice yet (the transport's UI is
 * services' next PR), so the engine is driven through the core's own commands – `sync.testWebDav`,
 * `sync.setup { transport: 'webdav' }`, `sync.now`, `sync.setWebDavPassword`, `sync.disconnect` –
 * and the Sync section is photographed as it reflects each state. Every claim is a PASS / FAIL
 * line in `sync-webdav-notes.txt`; one FAIL fails the run.
 *
 * What the scenes prove: the probe answers through the bridge (a 207, a 401 for a wrong
 * password, a refused connection); the setup runs PROPFIND, MKCOL and PUT-then-MOVE against the
 * server and puts the device's file in place; a round whose MOVE is answered 412 is run again
 * quietly; a revoked password is `authRefused` with the 401 named and a new one recovers, the
 * password sealed under the Keystore (`zenium-secrets`, a `v1.` text that never contains it); a
 * relaunch reads the password back through `secrets.get` and syncs again without asking; and
 * disconnecting with the wipe removes this device's documents from the server (the directory
 * and the README stay: other devices' data is never this device's to delete) and forgets the
 * secret. The app password never reaches a note or a still.
 */
@RunWith(AndroidJUnit4::class)
class SyncWebDavDemo : DemoHarness("sync-demo-state.json", "sync-webdav", "sync-webdav-demo") {
    override val tag: String = "SyncWebDavDemo"

    private lateinit var server: DemoWebDavServer
    private lateinit var notes: File
    private var shots = 0
    private var checks = 0
    private var failures = 0

    @Test
    fun record() {
        server = DemoWebDavServer(PORT, ROOT, mapOf(USER to PASSWORD)).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun warmUp() {
        notes = File(out, "sync-webdav-notes.txt")
        notes.writeText("Zenium Android WebDAV sync demo (ID-32, the host verbs)\n\n")
        note("device ${Build.MODEL} (API ${Build.VERSION.SDK_INT}), ${width}x$height; WebDAV server ${server.selfCheck()}")
        // The Settings chunk loads on its first open: pay for it off camera.
        val warm = coreInvoke("page.open", """{"id":"settings","section":"sync"}""")
        poll(20_000) { chromeJs("!!document.querySelector('[data-row=\"sync-folder\"]')") == "true" }
        SystemClock.sleep(800)
        coreInvoke("tab.close", """{"tabId":$warm}""")
        SystemClock.sleep(800)
        watchToasts()
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. The section as it starts: sync off, and the engine's word that WebDAV is available here.
        openSection()
        val status = syncStatus()
        check("the engine says WebDAV is available on this phone (fetch and secrets both present)", status.optBoolean("webdavAvailable"))
        check("sync starts off", !status.optBoolean("enabled"))
        still("section-off")

        // 2. The probe: the right password, a wrong one, a server that is not there.
        note("\n2. the probe (sync.testWebDav)")
        val ok = JSONObject(coreInvoke("sync.testWebDav", credentials(PASSWORD)))
        check("the probe with the app password answers ok (PROPFIND Depth 0 → 207 through the bridge)", ok.optBoolean("ok"))
        val wrong = JSONObject(coreInvoke("sync.testWebDav", credentials("not-the-password")))
        check("the probe with a wrong password is refused as auth 401", !wrong.optBoolean("ok") && wrong.optString("kind") == "auth" && wrong.optInt("status") == 401)
        val gone = JSONObject(coreInvoke("sync.testWebDav", credentials(PASSWORD, url = "http://127.0.0.1:${PORT + 1}/dav/")))
        check("the probe against a port nobody listens on is unavailable, status 0", !gone.optBoolean("ok") && gone.optString("kind") == "unavailable" && gone.optInt("status") == 0)
        note("  server log so far: ${describeLog()}")

        // 3. The setup: the engine makes the folder and its directory, writes its file and the README.
        //    scrypt-js derives the key in the WebView (seconds on the emulator) and the first round
        //    runs before the promise settles: the wait is the stall-tolerant one, not coreInvoke's 15 s.
        note("\n3. the setup (sync.setup, transport webdav)")
        val propfindsBefore = server.hits("PROPFIND")
        val requestsBeforeSetup = server.requests().size
        val setupStarted = SystemClock.uptimeMillis()
        coreInvokeUnderStall(
            "sync.setup",
            """{"folder":"","passphrase":"$PASSPHRASE","deviceName":"Pixel (demo)","scope":${syncStatus().getJSONObject("scope")},"transport":"webdav","webdav":${credentials(PASSWORD)}}""",
            baseMs = 150_000,
            maxMs = 180_000
        )
        note("  sync.setup settled after ${SystemClock.uptimeMillis() - setupStarted} ms")
        val on = poll(30_000) { val s = syncStatus(); s.optBoolean("enabled") && !s.isNull("lastSyncAt") && !s.optBoolean("syncing", false) }
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
        openSection()
        still("connected")

        // 4. A round with a failed precondition: the MOVE answered 412 once, the round run again quietly.
        note("\n4. a round whose MOVE is answered 412 (the engine's quiet retry)")
        coreInvoke("bookmark.create", """{"title":"Zenium","url":"https://zenium.app/","type":"url"}""")
        val movesBefore = server.hits("MOVE")
        server.failNext("MOVE", 412)
        coreInvoke("sync.now")
        val settled = poll(30_000) { val s = syncStatus(); !s.optBoolean("syncing", false) && server.hits("MOVE") >= movesBefore + 2 }
        val round = syncStatus()
        check("the round ran the MOVE again after the 412", settled && server.requests().any { it.method == "MOVE" && it.status == 412 })
        check("the round ended without an error shown", round.isNull("lastError") && !round.optBoolean("authRefused"))
        note("  moves ${movesBefore} → ${server.hits("MOVE")}; lastError ${round.opt("lastError")}")

        // 5. The password revoked on the server: authRefused, the 401 named; a new one recovers.
        note("\n5. a revoked app password (authRefused) and the new one")
        server.setPassword(USER, ROTATED)
        coreInvoke("bookmark.create", """{"title":"Docs","url":"https://docs.zenium.app/","type":"url"}""")
        coreInvoke("sync.now")
        val refused = poll(20_000) { syncStatus().optBoolean("authRefused") }
        val refusedStatus = syncStatus()
        check("the round with the old password is authRefused", refused)
        check("the error names the 401 and nothing of the credential", refusedStatus.optString("lastError") == "WebDAV PROPFIND answered 401" && !refusedStatus.toString().contains(PASSWORD))
        openSection()
        still("refused")
        val lastSyncBefore = refusedStatus.optLong("lastSyncAt", 0)
        coreInvokeUnderStall("sync.setWebDavPassword", """{"password":"$ROTATED"}""", baseMs = 60_000, maxMs = 90_000)
        val recovered = poll(30_000) { val s = syncStatus(); !s.optBoolean("authRefused") && s.isNull("lastError") && s.optLong("lastSyncAt", 0) > lastSyncBefore }
        check("the new password recovers: not refused, no error, a round done", recovered)
        val sealed = sealedPassword()
        check("the password is sealed under the Keystore in zenium-secrets (a v1. text that does not contain it)", sealed != null && sealed.startsWith("v1.") && !sealed.contains(ROTATED) && !sealed.contains(PASSWORD))
        note("  sealed text: ${sealed?.let { "${it.length} chars, ${it.count { c -> c == '.' }} dots" } ?: "none"}")
        openSection()
        still("recovered")

        // 6. A relaunch: the password comes back through secrets.get (a fresh host, the Keystore opened
        //    again), the engine connects without asking and a round runs.
        note("\n6. a relaunch reads the password back through the Keystore")
        SystemClock.sleep(3_000)
        val propfindsBeforeRelaunch = server.hits("PROPFIND")
        val requestsBeforeRelaunch = server.requests().size
        relaunch()
        val reconnected = poll(30_000) { val s = syncStatus(); s.optBoolean("enabled") && !s.optBoolean("authRefused") }
        check("after the relaunch sync is on and not refused (the secret was read back)", reconnected)
        val lastSyncBeforeRelaunchRound = syncStatus().optLong("lastSyncAt", 0)
        coreInvoke("sync.now")
        val synced = poll(30_000) { val s = syncStatus(); server.hits("PROPFIND") > propfindsBeforeRelaunch && !s.optBoolean("syncing", false) && s.optLong("lastSyncAt", 0) > lastSyncBeforeRelaunchRound }
        val relaunched = syncStatus()
        val sinceRelaunch = server.requests().drop(requestsBeforeRelaunch)
        check("a round after the relaunch reached the server with the sealed password (no 401 since)", synced && relaunched.isNull("lastError") && sinceRelaunch.isNotEmpty() && sinceRelaunch.none { it.status == 401 })
        note("  requests since the relaunch: ${sinceRelaunch.size}, statuses ${sinceRelaunch.map { it.status }.distinct().sorted()}")
        openSection()
        still("relaunched")

        // 7. Disconnect and wipe: this device's documents go (DELETE), the secret goes (secrets.delete);
        //    the directory and the README stay for the other devices.
        note("\n7. disconnect with wipe")
        val deletesBefore = server.hits("DELETE")
        coreInvoke("sync.disconnect", """{"wipeRemote":true}""")
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
        openSection()
        still("disconnected")

        note("\n$checks checks, $failures failed; server log: ${describeLog()}")
        if (failures > 0) throw AssertionError("$failures of $checks checks failed; see sync-webdav-notes.txt")
    }

    // --- helpers -------------------------------------------------------------------------------------

    private fun credentials(password: String, url: String = server.rootUrl): String =
        JSONObject().put("url", url).put("username", USER).put("password", password).put("folder", FOLDER).toString()

    private fun syncStatus(): JSONObject = coreState().getJSONObject("sync")

    private fun openSection() {
        if (activeCoreTab()?.optString("url") != SECTION_URL) {
            coreInvoke("page.open", """{"id":"settings","section":"sync"}""")
            poll(12_000) { activeCoreTab()?.optString("url") == SECTION_URL }
        }
        SystemClock.sleep(1_200)
    }

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

    private fun still(name: String) {
        shots++
        shot("${shots.toString().padStart(2, '0')}-$name")
        beat()
    }

    companion object {
        private const val PORT = 8767
        private const val ROOT = "/remote.php/dav/files/alice"
        private const val USER = "alice"
        /** The demo's app password – a fixture's, never a real one; it must not appear in a note or a still. */
        private const val PASSWORD = "demo-app-password-1"
        private const val ROTATED = "demo-app-password-2"
        private const val FOLDER = "Zenium"
        private const val DIR = "$ROOT/$FOLDER/zenium-sync"
        private const val PASSPHRASE = "correct horse battery staple"
        private const val SECTION_URL = "zen://settings/sync"
        /** `WEBDAV_SECRET_KEY` in src/core/sync/webdav.ts. */
        private const val SECRET_KEY = "sync.webdav.password"
    }
}
