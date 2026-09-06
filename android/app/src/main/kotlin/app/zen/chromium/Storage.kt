package app.zen.chromium

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Zen's JSON documents (state, history, downloads, permissions) under `files/zen/`. Writes go to
 * a temp file that is renamed over the target, mirroring the Electron host.
 */
class Storage(context: Context) {
    private val dir = File(context.filesDir, "zen").apply { mkdirs() }
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-storage") }

    /** Every document, read synchronously for the boot payload. */
    fun readAll(): JSONObject {
        val out = JSONObject()
        dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }?.forEach { f ->
            runCatching { out.put(f.name, f.readText()) }
        }
        return out
    }

    fun write(name: String, text: String, done: () -> Unit) {
        executor.execute {
            runCatching { writeAtomic(name, text) }
            done()
        }
    }

    /** Called on the bridge thread when the app is being backgrounded; must finish before returning. */
    fun writeSync(name: String, text: String) {
        runCatching { writeAtomic(name, text) }
    }

    private fun writeAtomic(name: String, text: String) {
        val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val target = File(dir, safe)
        val tmp = File(dir, "$safe.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(target)) {
            target.delete()
            tmp.renameTo(target)
        }
    }
}
