package app.zen.chromium

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors

/**
 * Zen's JSON documents (state, history, downloads, permissions, the extension registry) under
 * `files/zen/`. Writes go to a temp file that is renamed over the target, mirroring the Electron
 * host.
 *
 * Names may carry one directory level (`blocking/index.json`), two for the rule sets' documents
 * alone (`blocking/sets/<name>.json`): the core's rule sets live in `blocking/` and are read by
 * the Kotlin request engine from the same files, and the Safe Browsing feed documents live in
 * `safebrowsing/`. What the core reads at boot ([bootDocuments]) travels inline in the boot
 * payload while small, and is fetched through the chrome WebView's document handler
 * (`BootHandoff.kt`) once it is not; the (megabytes of) filter text stays on disk and is read
 * on demand.
 *
 * The directory is a constructor argument so the JUnit tests can point an instance at a
 * temporary folder; the app passes its `files/zen/`.
 */
class Storage(private val dir: File) {
    constructor(context: Context) : this(File(context.filesDir, "zen"))

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-storage") }

    init {
        dir.mkdirs()
    }

    /**
     * The documents the core reads at boot, split by size (`BootDocuments`): `files` holds the
     * text of every one of `inlineLimit` bytes or less, by name, as the boot payload always
     * carried them; `deferred` lists the larger ones – a Safe Browsing feed's prefix table, a
     * rule index grown big – with their size and version tag ([etag]), for the chrome to fetch
     * through the document handler instead of receiving them JSON-quoted inside the payload.
     */
    fun bootDocuments(inlineLimit: Long): BootDocuments {
        val files = JSONObject()
        val deferred = JSONArray()
        for ((name, file) in bootFiles()) {
            val length = file.length()
            if (length <= inlineLimit) {
                runCatching { files.put(name, file.readText()) }
            } else {
                deferred.put(JSONObject().put("name", name).put("bytes", length).put("etag", etagOf(file, length)))
            }
        }
        return BootDocuments(files, deferred)
    }

    /** Every boot document read synchronously, whatever its size (the pre-handoff payload). */
    fun readAll(): JSONObject = bootDocuments(Long.MAX_VALUE).files

    /**
     * The root documents, the blocking index and its set documents, and the Safe Browsing feed
     * documents, in the order the payload lists them: the root first, by name, then the folders.
     */
    private fun bootFiles(): List<Pair<String, File>> {
        val out = ArrayList<Pair<String, File>>()
        dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }?.sortedBy { it.name }?.forEach { out.add(it.name to it) }
        fileFor(BLOCKING_INDEX)?.takeIf { it.isFile }?.let { out.add(BLOCKING_INDEX to it) }
        for (folder in listOf(BLOCKING_SETS_DIR, SAFE_BROWSING_DIR)) {
            for (name in list(folder).sorted()) {
                if (!name.endsWith(".json")) continue
                fileFor(name)?.takeIf { it.isFile }?.let { out.add(name to it) }
            }
        }
        return out
    }

    /**
     * Whether a name is one [bootFiles] can list – a root `*.json` document, the blocking index,
     * a rule set's document under `blocking/sets/`, a Safe Browsing feed document – and so one
     * the document handler serves. Not the filter text under `blocking/`, not a backup, not a
     * temp file: those the chrome reads through the bridge when it needs them, as before.
     */
    fun isBootDocument(name: String): Boolean {
        val parts = name.split('/').filter { it.isNotEmpty() }
        return when (parts.size) {
            1 -> isJsonName(parts[0])
            2 -> parts[0] == SAFE_BROWSING_DIR && isJsonName(parts[1]) || parts == BLOCKING_INDEX.split('/')
            3 -> parts[0] == BLOCKING_DIR && parts[1] == BLOCKING_SETS && isJsonName(parts[2])
            else -> false
        }
    }

    private fun isJsonName(name: String): Boolean = name.endsWith(".json") && name != ".json"

    /**
     * The version tag of a document: its size and its modification time. Every write changes it
     * (writes replace the file whole, see [writeAtomic], which moves a rewrite of the same size
     * within the same millisecond one millisecond on), and it is a property of the file, not of
     * the process: what the chrome compares with the boot manifest, what the Safe Browsing host
     * keeps its parsed tables by and names the documents its snapshot was built from with, so a
     * snapshot written by one process is recognised by the next. Null when the document does
     * not exist.
     */
    fun etag(name: String): String? {
        val file = fileFor(name)?.takeIf { it.isFile } ?: return null
        return etagOf(file, file.length())
    }

    private fun etagOf(file: File, length: Long): String =
        "${java.lang.Long.toHexString(length)}-${java.lang.Long.toHexString(file.lastModified())}"

    /**
     * A boot document opened for streaming (the document handler), or null when it does not
     * exist. The stream is opened first and the length taken from it, so the `Content-Length`
     * describes the bytes that are streamed even if a write renames a new file over the name in
     * between; the tag is one stat after that.
     */
    fun open(name: String): OpenDocument? {
        val file = fileFor(name)?.takeIf { it.isFile } ?: return null
        val stream = runCatching { FileInputStream(file) }.getOrNull() ?: return null
        val length = runCatching { stream.channel.size() }.getOrElse { stream.close(); return null }
        return OpenDocument(etagOf(file, length), length, stream)
    }

    /** The text of one document, or null when it does not exist. */
    fun read(name: String): String? {
        val file = fileFor(name) ?: return null
        return runCatching { if (file.isFile) file.readText() else null }.getOrNull()
    }

    fun exists(name: String): Boolean = fileFor(name)?.isFile == true

    /** The documents under a directory (`safebrowsing`, `blocking/sets`), as names (`safebrowsing/urlhaus.json`). */
    fun list(dir: String): List<String> {
        val folder = fileFor(dir) ?: return emptyList()
        if (folder == this.dir || !folder.isDirectory) return emptyList()
        val prefix = dir.split('/').filter { it.isNotEmpty() }.joinToString("/")
        return folder.listFiles { f -> f.isFile && !f.name.endsWith(".tmp") }?.map { "$prefix/${it.name}" } ?: emptyList()
    }

    /**
     * The file a document name resolves to: null for names that escape the storage directory
     * and for a second directory level anywhere but under `blocking/sets/`.
     */
    fun fileFor(name: String): File? {
        val parts = name.split('/').filter { it.isNotEmpty() }
        if (parts.isEmpty() || parts.size > 3) return null
        if (parts.size == 3 && (parts[0] != BLOCKING_DIR || parts[1] != BLOCKING_SETS)) return null
        var file = dir
        for (part in parts) {
            if (part == "." || part == "..") return null
            file = File(file, part.replace(UNSAFE, "_"))
        }
        return file
    }

    /**
     * Replace a document on the storage thread; `done` hears the failure, if any, so the chrome
     * can reject the write instead of remembering it as made. With `backup`, the document that
     * was there is kept as `<name>.bak` (see [writeAtomic]).
     */
    fun write(name: String, text: String, backup: Boolean = false, done: (Throwable?) -> Unit) {
        executor.execute {
            val failure = runCatching { writeAtomic(name, text, backup) }.exceptionOrNull()
            if (failure == null) notifyChanged(name)
            done(failure)
        }
    }

    /**
     * Called on the bridge thread when the app is being backgrounded; must finish before
     * returning. Throws when the document could not be replaced (the file is as it was).
     */
    fun writeSync(name: String, text: String, backup: Boolean = false) {
        writeAtomic(name, text, backup)
        notifyChanged(name)
    }

    /**
     * The bytes of a file the host keeps beside the documents (the Safe Browsing snapshot,
     * `safebrowsing/tables.bin`), or null when there is none.
     */
    fun readBytes(name: String): ByteArray? {
        val file = fileFor(name) ?: return null
        return runCatching { if (file.isFile) file.readBytes() else null }.getOrNull()
    }

    /**
     * Write such a file whole, on the caller's thread: a temp file renamed over the target like
     * the documents, but with no change notification – a cache the Kotlin side owns is nobody's
     * document. True when the bytes landed.
     */
    fun writeBytes(name: String, bytes: ByteArray): Boolean {
        val target = fileFor(name) ?: return false
        return runCatching {
            target.parentFile?.mkdirs()
            val tmp = File(target.parentFile, "${target.name}.tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(target)) {
                target.delete()
                tmp.renameTo(target)
            }
            target.isFile
        }.getOrDefault(false)
    }

    /** Delete such a file at once, silently; true when nothing is left under the name. */
    fun deleteBytes(name: String): Boolean {
        val file = fileFor(name) ?: return false
        return runCatching { !file.exists() || file.delete() }.getOrDefault(false)
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

    /**
     * The text goes to a temp file that is renamed over the target, so a crash mid-write never
     * leaves a torn document. With `backup` the document that was there is renamed to
     * `<name>.bak` first (two renames, no copying, as the Electron host does): the previous
     * version survives a write that the document itself does not, and the core reads the backup
     * when the document is gone or unreadable (`JsonStore`, `backup: true`). Throws when the
     * document could not be replaced.
     *
     * The new file's version tag ([etag]) differs from the old one's: bytes of the same size
     * landing within the modification time's millisecond (a filesystem's clock is coarser than
     * that) get a modification time one millisecond past the old file's, on the temp file, so
     * the rename publishes bytes and tag together.
     */
    private fun writeAtomic(name: String, text: String, backup: Boolean) {
        val target = fileFor(name) ?: throw IOException("not a document name: $name")
        target.parentFile?.mkdirs()
        val before = target.takeIf { it.isFile }?.let { it.length() to it.lastModified() }
        val tmp = File(target.parentFile, "${target.name}.tmp")
        tmp.writeText(text)
        if (before != null && tmp.length() == before.first && tmp.lastModified() <= before.second) {
            tmp.setLastModified(before.second + 1)
        }
        if (backup && target.isFile) target.renameTo(File(target.parentFile, "${target.name}.bak"))
        if (!tmp.renameTo(target)) {
            target.delete()
            if (!tmp.renameTo(target)) {
                tmp.delete()
                throw IOException("could not replace $name")
            }
        }
    }

    /** What [bootDocuments] hands the boot payload: the inlined texts and the deferred documents' manifest. */
    class BootDocuments(val files: JSONObject, val deferred: JSONArray)

    /** One document as [open] hands it to the document handler; the caller closes `stream`. */
    class OpenDocument(val etag: String, val length: Long, val stream: InputStream)

    companion object {
        /** The rule-set index the core keeps (`src/core/blocking/store.ts`). */
        const val BLOCKING_DIR = "blocking"
        const val BLOCKING_INDEX = "$BLOCKING_DIR/index.json"
        private const val BLOCKING_SETS = "sets"
        /** The rule sets' documents (`SETS_DIR` in `store.ts`): one `<name>.json` of structured rules per set. */
        const val BLOCKING_SETS_DIR = "$BLOCKING_DIR/$BLOCKING_SETS"
        /** The Safe Browsing feed documents (`SAFE_BROWSING_DIR` in `src/core/safebrowsing/service.ts`). */
        const val SAFE_BROWSING_DIR = "safebrowsing"
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
