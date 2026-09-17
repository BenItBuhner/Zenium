package app.zen.chromium

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Zen's JSON documents (state, history, downloads, permissions) under `files/zen/`. Writes go to
 * a temp file that is renamed over the target, mirroring the Electron host.
 */
class Storage(private val dir: File) {
    constructor(context: Context) : this(File(context.filesDir, "zen"))

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-storage") }

    init {
        dir.mkdirs()
    }

    /** Every document, read synchronously for the boot payload. */
    fun readAll(): JSONObject {
        val out = JSONObject()
        dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }?.forEach { f ->
            read(f.name)?.let { out.put(f.name, it) }
        }
        return out
    }

    /** One document's text, or null when there is none (or it cannot be read). */
    fun read(name: String): String? = runCatching { File(dir, safeName(name)).takeIf { it.isFile }?.readText() }.getOrNull()

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

    private fun safeName(name: String): String = name.replace(Regex("[^A-Za-z0-9._-]"), "_")

    private fun writeAtomic(name: String, text: String) {
        val safe = safeName(name)
        val target = File(dir, safe)
        val tmp = File(dir, "$safe.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(target)) {
            target.delete()
            tmp.renameTo(target)
        }
    }
}
