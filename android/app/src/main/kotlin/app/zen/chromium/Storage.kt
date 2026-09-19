package app.zen.chromium

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.Reader
import java.io.Writer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * Zen's JSON documents (state, history, downloads, permissions, the extension registry) under
 * `files/zen/`. Writes go to a temp file that is renamed over the target, mirroring the Electron
 * host.
 *
 * Names may carry one directory level (`blocking/index.json`): the core's rule sets live in
 * `blocking/` and are read by the Kotlin request engine from the same files; the extensions'
 * `chrome.storage` documents live in `ext-storage/`. Only the root documents and the blocking
 * index travel in the boot payload; the (megabytes of) filter text and extension storage stay on
 * disk and are read on demand.
 *
 * Large documents cross the bridge in pieces ([beginWrite] / [writeChunk] / [endWrite] and
 * [beginRead] / [readChunk]): a filter-list extension's storage runs to tens of megabytes, and
 * one bridge call carrying it whole keeps several copies of the text on the Java heap at once
 * (the call's JSON, the tokenizer's buffer, the parsed value) – past the debug heap's limit.
 *
 * The directory is a constructor argument so the JUnit tests can point an instance at a
 * temporary folder; the app passes its `files/zen/`.
 */
class Storage(private val dir: File) {
    constructor(context: Context) : this(File(context.filesDir, "zen"))

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-storage") }

    private class PendingWrite(val name: String, val tmp: File, val writer: Writer)

    /** Writes and reads in pieces that have begun and not ended, by token; each is used from one thread. */
    private val pendingWrites = ConcurrentHashMap<Long, PendingWrite>()
    private val pendingReads = ConcurrentHashMap<Long, Reader>()
    private val tokens = AtomicLong()

    init {
        dir.mkdirs()
        moveLegacyExtensionStorage()
    }

    /**
     * Extension storage documents used to be root documents (`ext-storage-<id>.json`), which put
     * them in every boot payload; they live in `ext-storage/` now. A rename that fails leaves the
     * legacy file where the boot payload still finds it.
     */
    private fun moveLegacyExtensionStorage() {
        val legacy = dir.listFiles { f -> f.isFile && f.name.startsWith(LEGACY_EXT_STORAGE_PREFIX) && f.name.endsWith(".json") } ?: return
        for (file in legacy) {
            val target = File(File(dir, EXT_STORAGE_DIR), file.name.removePrefix(LEGACY_EXT_STORAGE_PREFIX))
            if (target.isFile) file.delete()
            else {
                target.parentFile?.mkdirs()
                file.renameTo(target)
            }
        }
    }

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

    /** The documents under one directory level (`safebrowsing`), as names (`safebrowsing/urlhaus.json`). */
    fun list(dir: String): List<String> {
        val folder = fileFor(dir) ?: return emptyList()
        if (folder == this.dir || !folder.isDirectory) return emptyList()
        return folder.listFiles { f -> f.isFile && !f.name.endsWith(".tmp") }?.map { "${folder.name}/${it.name}" } ?: emptyList()
    }

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

    // --- documents in pieces -------------------------------------------------------------------

    /**
     * Begin writing `name` in pieces: a temp file of its own beside the target (two writes of one
     * document may overlap – an asynchronous one still landing when the app is backgrounded and
     * the synchronous last-chance write starts). The token names the write to [writeChunk],
     * [endWrite] and [abortWrite]; null for a name that escapes the directory or a file that
     * cannot be opened. Runs on the caller's thread.
     */
    fun beginWrite(name: String): Long? {
        val target = fileFor(name) ?: return null
        target.parentFile?.mkdirs()
        val token = tokens.incrementAndGet()
        val tmp = File(target.parentFile, "${target.name}.$token.tmp")
        val writer = runCatching { tmp.bufferedWriter() }.getOrNull() ?: return null
        pendingWrites[token] = PendingWrite(name, tmp, writer)
        return token
    }

    /** Append `text` to the write `token`; false when there is no such write or the write failed (it is then aborted). */
    fun writeChunk(token: Long, text: String): Boolean {
        val pending = pendingWrites[token] ?: return false
        if (runCatching { pending.writer.write(text) }.isSuccess) return true
        abortWrite(token)
        return false
    }

    /** Finish the write `token`: the temp file becomes the document. False when it was not pending or did not land. */
    fun endWrite(token: Long): Boolean {
        val pending = pendingWrites.remove(token) ?: return false
        val target = fileFor(pending.name)
        val landed = runCatching {
            pending.writer.close()
            target != null && replace(pending.tmp, target)
        }.getOrDefault(false)
        if (!landed) pending.tmp.delete()
        notifyChanged(pending.name)
        return landed
    }

    /** Drop the write `token` and its temp file; the document stays as it was. */
    fun abortWrite(token: Long) {
        val pending = pendingWrites.remove(token) ?: return
        runCatching { pending.writer.close() }
        pending.tmp.delete()
    }

    /** Begin reading `name` in pieces ([readChunk]); null when it does not exist. Runs on the caller's thread. */
    fun beginRead(name: String): Long? {
        val file = fileFor(name) ?: return null
        if (!file.isFile) return null
        val reader = runCatching { file.bufferedReader() }.getOrNull() ?: return null
        val token = tokens.incrementAndGet()
        pendingReads[token] = reader
        return token
    }

    /**
     * The next up to `maxChars` characters of the read `token` (at least one), or null once it is
     * exhausted or failed – the reader is closed then. A surrogate pair may straddle two pieces;
     * they concatenate back into the document.
     */
    fun readChunk(token: Long, maxChars: Int): String? {
        val reader = pendingReads[token] ?: return null
        val buffer = CharArray(maxChars.coerceIn(1, MAX_CHUNK_CHARS))
        var filled = 0
        while (filled < buffer.size) {
            val n = runCatching { reader.read(buffer, filled, buffer.size - filled) }.getOrDefault(-1)
            if (n < 0) break
            filled += n
        }
        if (filled == 0) {
            endRead(token)
            return null
        }
        return String(buffer, 0, filled)
    }

    /** Close the read `token` before its end. */
    fun endRead(token: Long) {
        pendingReads.remove(token)?.let { runCatching { it.close() } }
    }

    /** For the tests: whether a write or read in pieces is still open. */
    fun hasPending(token: Long): Boolean = pendingWrites.containsKey(token) || pendingReads.containsKey(token)

    private fun writeAtomic(name: String, text: String) {
        val target = fileFor(name) ?: return
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, "${target.name}.tmp")
        tmp.writeText(text)
        replace(tmp, target)
    }

    private fun replace(tmp: File, target: File): Boolean {
        if (tmp.renameTo(target)) return true
        target.delete()
        return tmp.renameTo(target)
    }

    companion object {
        /** The rule-set index the core keeps (`src/core/blocking/store.ts`). */
        const val BLOCKING_DIR = "blocking"
        const val BLOCKING_INDEX = "$BLOCKING_DIR/index.json"
        /** The extensions' `chrome.storage` documents, `<id>.json` each (`src/android/extensionRuntime.ts`). */
        const val EXT_STORAGE_DIR = "ext-storage"
        private const val LEGACY_EXT_STORAGE_PREFIX = "ext-storage-"
        /** The most characters one [readChunk] hands out (the bridge's chunk is 1 Mi; this bounds a caller's request). */
        const val MAX_CHUNK_CHARS = 4 shl 20
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
