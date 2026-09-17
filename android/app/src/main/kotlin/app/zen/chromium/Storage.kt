package app.zen.chromium

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors

/**
 * Zen's JSON documents (state, history, downloads, permissions) under `files/zen/`. Writes go to
 * a temp file that is renamed over the target, mirroring the Electron host.
 *
 * Names may carry one directory level (`blocking/index.json`): the core's rule sets live in
 * `blocking/` and are read by the Kotlin request engine from the same files. Only the root
 * documents and the blocking index travel in the boot payload; the (megabytes of) filter text
 * stays on disk and is read on demand.
 */
class Storage(context: Context) {
    private val dir = File(context.filesDir, "zen").apply { mkdirs() }
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-storage") }

    /** Every root document plus the blocking index, read synchronously for the boot payload. */
    fun readAll(): JSONObject {
        val out = JSONObject()
        dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }?.forEach { f ->
            runCatching { out.put(f.name, f.readText()) }
        }
        read(BLOCKING_INDEX)?.let { out.put(BLOCKING_INDEX, it) }
        return out
    }

    /** The text of one document, or null when it does not exist. */
    fun read(name: String): String? {
        val file = fileFor(name) ?: return null
        return runCatching { if (file.isFile) file.readText() else null }.getOrNull()
    }

    fun exists(name: String): Boolean = fileFor(name)?.isFile == true

    /** The file a document name resolves to (null for names that escape the storage directory). */
    fun fileFor(name: String): File? {
        val parts = name.split('/').filter { it.isNotEmpty() }
        if (parts.isEmpty() || parts.size > 2) return null
        var file = dir
        for (part in parts) {
            if (part == "." || part == "..") return null
            file = File(file, part.replace(UNSAFE, "_"))
        }
        return file
    }

    fun write(name: String, text: String, done: () -> Unit) {
        executor.execute {
            runCatching { writeAtomic(name, text) }
            notifyChanged(name)
            done()
        }
    }

    /** Called on the bridge thread when the app is being backgrounded; must finish before returning. */
    fun writeSync(name: String, text: String) {
        runCatching { writeAtomic(name, text) }
        notifyChanged(name)
    }

    fun remove(name: String, done: () -> Unit) {
        executor.execute {
            runCatching { fileFor(name)?.delete() }
            notifyChanged(name)
            done()
        }
    }

    /** Run `work` on the storage thread, after every write queued so far has landed. */
    fun execute(work: () -> Unit) {
        executor.execute(work)
    }

    private fun writeAtomic(name: String, text: String) {
        val target = fileFor(name) ?: return
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, "${target.name}.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(target)) {
            target.delete()
            tmp.renameTo(target)
        }
    }

    companion object {
        /** The rule-set index the core keeps (`src/core/blocking/store.ts`). */
        const val BLOCKING_DIR = "blocking"
        const val BLOCKING_INDEX = "$BLOCKING_DIR/index.json"
        private val UNSAFE = Regex("[^A-Za-z0-9._-]")
        private val changeListeners = CopyOnWriteArraySet<(String) -> Unit>()

        /**
         * Hear every write or removal under `files/zen/`, by any instance in the process (the
         * browser window's, a custom tab's, the request engine's own), with the document's name;
         * called on the writing thread.
         */
        fun addChangeListener(listener: (String) -> Unit) {
            changeListeners.add(listener)
        }

        fun removeChangeListener(listener: (String) -> Unit) {
            changeListeners.remove(listener)
        }

        private fun notifyChanged(name: String) {
            for (listener in changeListeners) listener(name)
        }
    }
}
