package app.zen.chromium

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.Reader
import java.io.Writer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicLong

/**
 * Zen's JSON documents (state, history, downloads, permissions, the extension registry) under
 * `files/zen/`. Writes go to a temp file that is renamed over the target, mirroring the Electron
 * host.
 *
 * Names may carry one directory level (`blocking/index.json`), two for the rule sets' documents
 * alone (`blocking/sets/<name>.json`): the core's rule sets live in `blocking/` and are read by
 * the Kotlin request engine from the same files, the Safe Browsing feed documents live in
 * `safebrowsing/`, and the extensions' `chrome.storage` documents in `ext-storage/`. What the
 * core reads at boot ([bootDocuments]) travels inline in the boot payload while small, and is
 * fetched through the chrome WebView's document handler (`BootHandoff.kt`) once it is not; the
 * Safe Browsing feed documents (megabytes once the feeds were refreshed) are not read at boot
 * at all – the core brings them in through the same handler once it is up ([isServedDocument])
 * – and the filter text and extension storage stay on disk and are read on demand.
 *
 * Large documents cross the bridge in pieces ([beginWrite] / [writeChunk] / [endWrite], and
 * [readOrBegin] / [readChunk]): a filter-list extension's storage runs to tens of megabytes, and
 * one bridge call carrying it whole keeps several copies of the text on the Java heap at once
 * (the call's JSON, the tokenizer's buffer, the parsed value) – past the debug heap's limit.
 *
 * An instance lives as long as its host: the browser window's `Host` [close]s its own when the
 * Activity is destroyed, and nothing is written through it after that – not from the storage
 * thread (stopped), not from a caller's thread (refused). A `Host` also holds the profile's
 * [Lease] while it is the latest: two browser hosts share the process for a moment when the
 * Activity is relaunched or recreated, and the core running in the old one may still have a
 * write in it when the new one's core has read the profile; every [publish] checks, under the
 * lease's lock, that its host is the latest before the rename, so a write from a superseded host
 * is refused (the temp file deleted, the caller told) and the profile the new core read is the
 * profile it has. Instances without a lease (the request engine's, a custom tab's) publish
 * unconditionally.
 *
 * The directory is a constructor argument so the JUnit tests can point an instance at a
 * temporary folder; the app passes its `files/zen/`. `log` hears the refusals (`ZenStorage`).
 */
class Storage(private val dir: File, private val lease: Lease? = null, private val log: (String) -> Unit = {}) {
    constructor(context: Context, lease: Lease? = null, log: (String) -> Unit = {}) : this(File(context.filesDir, "zen"), lease, log)

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-storage") }

    /** This instance's claim on [lease] ([Lease.claim]); 0 without one. */
    private val holder: Long = lease?.claim() ?: 0L

    /** Set by [close]: the host this instance served is destroyed; every write is refused from then on. */
    @Volatile private var closed = false

    /**
     * Held around every rename of [publish] and around [close]'s setting of [closed]: a close
     * waits for a rename under way and no rename begins after it, so once `close()` has returned
     * nothing this instance was asked to write reaches the profile.
     */
    private val publishLock = Any()

    private class PendingWrite(val name: String, val tmp: File, val writer: Writer, val backup: Boolean)

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

    /**
     * The documents the core reads at boot, split by size (`BootDocuments`): `files` holds the
     * text of every one of `inlineLimit` bytes or less, by name, as the boot payload always
     * carried them; `deferred` lists the larger ones – a session grown big, an extension's
     * rule-set document – with their size and version tag ([etag]), for the chrome to fetch
     * through the document handler instead of receiving them JSON-quoted inside the payload.
     * The Safe Browsing feed documents are not among them (see [bootFiles]).
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
     * The root documents, then the blocking index and its set documents, in the order the
     * payload lists them: the root first, by name, then the folder. Not the Safe Browsing feed
     * documents under `safebrowsing/`: the core reads those after it has started (its service
     * keeps their metadata and the refresh schedule; the tables themselves are this side's,
     * `privacy/SafeBrowsing.kt`), through the document handler, so that a profile whose feeds
     * were refreshed – megabytes of prefixes – boots as fast as a fresh one.
     */
    private fun bootFiles(): List<Pair<String, File>> {
        val out = ArrayList<Pair<String, File>>()
        dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }?.sortedBy { it.name }?.forEach { out.add(it.name to it) }
        fileFor(BLOCKING_INDEX)?.takeIf { it.isFile }?.let { out.add(BLOCKING_INDEX to it) }
        for (name in list(BLOCKING_SETS_DIR).sorted()) {
            if (!name.endsWith(".json")) continue
            fileFor(name)?.takeIf { it.isFile }?.let { out.add(name to it) }
        }
        return out
    }

    /**
     * Whether the document handler serves a name: every document [bootFiles] can list – a root
     * `*.json` document, the blocking index, a rule set's document under `blocking/sets/` – and
     * the Safe Browsing feed documents, which the core fetches after boot rather than reading
     * through the bridge. Not the filter text under `blocking/`, not a backup, not a temp file:
     * those the chrome reads through the bridge when it needs them, as before.
     */
    fun isServedDocument(name: String): Boolean {
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
        if (closed) return done(refused(name, CLOSED))
        try {
            executor.execute {
                val failure = runCatching { writeAtomic(name, text, backup) }.exceptionOrNull()
                if (failure == null) notifyChanged(name)
                done(failure)
            }
        } catch (_: RejectedExecutionException) {
            done(refused(name, CLOSED))
        }
    }

    /**
     * Called on the bridge thread when the app is being backgrounded; must finish before
     * returning. Throws when the document could not be replaced (the file is as it was), and
     * when the write is refused – the host is [close]d, or a newer host holds the profile.
     */
    fun writeSync(name: String, text: String, backup: Boolean = false) {
        if (closed) throw refused(name, CLOSED)
        writeAtomic(name, text, backup)
        notifyChanged(name)
    }

    /**
     * The host this instance served is destroyed: stop the storage thread (a write queued and
     * not begun never runs) and refuse every write from here on – one that had begun on the
     * thread is refused at its rename ([publish]), and a caller's own thread is told at once. A
     * rename under way when the close comes finishes first (the [publishLock]): what has landed
     * when this returns is all that ever will. A write in pieces still open is dropped with its
     * temp file. Reads are unaffected. Idempotent.
     *
     * Why nothing may land after this: the profile the next host's core boots from is the one
     * `pause` flushed before the Activity went; a document this host still had in it – the
     * debounced write of a state the teardown itself made – would land over that boot's read.
     */
    fun close() {
        if (closed) return
        synchronized(publishLock) { closed = true }
        executor.shutdownNow()
        val open = pendingWrites.keys.toList()
        for (token in open) abortWrite(token)
        log("closed: writes from this host are refused from here${if (open.isEmpty()) "" else " (${open.size} in pieces dropped)"}")
    }

    /** Whether [close] has been called (for the host's diagnostics and the tests). */
    val isClosed: Boolean get() = closed

    private fun refused(name: String, why: String): RefusedWrite {
        log("refused $name: $why")
        return RefusedWrite(name, why)
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

    /** Delete a document on the storage thread; `done` hears the refusal, if any (a [close]d instance removes nothing). */
    fun remove(name: String, done: (Throwable?) -> Unit) {
        if (closed) return done(refused(name, CLOSED))
        try {
            executor.execute {
                val failure = if (closed) refused(name, CLOSED) else runCatching { fileFor(name)?.delete() }.exceptionOrNull()
                if (failure == null) notifyChanged(name)
                done(failure)
            }
        } catch (_: RejectedExecutionException) {
            done(refused(name, CLOSED))
        }
    }

    /**
     * Run `work` on the storage thread, after every write queued so far has landed. Nothing runs
     * once the instance is [close]d: a caller waiting on an answer is one whose host is gone.
     */
    fun execute(work: () -> Unit) {
        if (closed) return
        try {
            executor.execute(work)
        } catch (_: RejectedExecutionException) {
            // Closed between the check and the hand-over: the same as closed before it.
        }
    }

    // --- documents in pieces -------------------------------------------------------------------

    /**
     * Begin writing `name` in pieces: a temp file of its own beside the target (two writes of one
     * document may overlap – an asynchronous one still landing when the app is backgrounded and
     * the synchronous last-chance write starts). The token names the write to [writeChunk],
     * [endWrite] and [abortWrite]; null for a name that escapes the directory or a file that
     * cannot be opened. With `backup` the document that was there is kept as `<name>.bak` when
     * the write ends, as [write] keeps it. Runs on the caller's thread.
     */
    fun beginWrite(name: String, backup: Boolean = false): Long? {
        if (closed) {
            refused(name, CLOSED)
            return null
        }
        val target = fileFor(name) ?: return null
        target.parentFile?.mkdirs()
        val token = tokens.incrementAndGet()
        val tmp = File(target.parentFile, "${target.name}.$token.tmp")
        val writer = runCatching { tmp.bufferedWriter() }.getOrNull() ?: return null
        pendingWrites[token] = PendingWrite(name, tmp, writer, backup)
        return token
    }

    /** Append `text` to the write `token`; false when there is no such write or the write failed (it is then aborted). */
    fun writeChunk(token: Long, text: String): Boolean {
        val pending = pendingWrites[token] ?: return false
        if (runCatching { pending.writer.write(text) }.isSuccess) return true
        abortWrite(token)
        return false
    }

    /**
     * Finish the write `token`: the temp file becomes the document, as a whole write's does
     * ([publish]: the version tag moves on, the backup is kept when asked). False when it was not
     * pending or did not land; the document is then as it was.
     */
    fun endWrite(token: Long): Boolean {
        val pending = pendingWrites.remove(token) ?: return false
        val landed = runCatching {
            pending.writer.close()
            val target = fileFor(pending.name) ?: throw IOException("not a document name: ${pending.name}")
            publish(pending.tmp, target, pending.name, pending.backup)
        }.isSuccess
        if (landed) notifyChanged(pending.name) else pending.tmp.delete()
        return landed
    }

    /** Drop the write `token` and its temp file; the document stays as it was. */
    fun abortWrite(token: Long) {
        val pending = pendingWrites.remove(token) ?: return
        runCatching { pending.writer.close() }
        pending.tmp.delete()
    }

    /**
     * A document as the bridge's `storage.read` answers it: the text, whole, when the file is at
     * most `inlineLimit` bytes; `{ token }` for a bigger one, to be read in pieces ([readChunk]
     * until null) so that one piece is on the Java heap at a time – the text whole, JSON-quoted
     * into the bridge's answer, is two copies of it. Null when the document does not exist.
     * Runs on the caller's thread.
     */
    fun readOrBegin(name: String, inlineLimit: Long): Any? {
        val file = fileFor(name)?.takeIf { it.isFile } ?: return null
        if (file.length() <= inlineLimit) return runCatching { file.readText() }.getOrNull()
        val token = beginRead(name) ?: return null
        return JSONObject().put("token", token)
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

    /**
     * The text goes to a temp file that is renamed over the target ([publish]), so a crash
     * mid-write never leaves a torn document. Throws when the document could not be replaced.
     */
    private fun writeAtomic(name: String, text: String, backup: Boolean) {
        val target = fileFor(name) ?: throw IOException("not a document name: $name")
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, "${target.name}.tmp")
        tmp.writeText(text)
        publish(tmp, target, name, backup)
    }

    /**
     * The temp file becomes the document `name`. With `backup` the document that was there is
     * renamed to `<name>.bak` first (two renames, no copying, as the Electron host does): the
     * previous version survives a write that the document itself does not, and the core reads the
     * backup when the document is gone or unreadable (`JsonStore`, `backup: true`). Throws when
     * the document could not be replaced (the temp file is deleted; the document is as it was).
     *
     * The new file's version tag ([etag]) differs from the old one's: bytes of the same size
     * landing within the modification time's millisecond (a filesystem's clock is coarser than
     * that) get a modification time one millisecond past the old file's, on the temp file, so
     * the rename publishes bytes and tag together.
     *
     * Refused – the temp file deleted, a [RefusedWrite] thrown – when the instance was [close]d
     * while the text was being written, or when another host has claimed the [lease] since this
     * one did: the check and the rename run under the lease's lock, which [Lease.claim] takes
     * too, so a write either lands before a new host exists (and before its core reads) or not
     * at all.
     */
    private fun publish(tmp: File, target: File, name: String, backup: Boolean) {
        val before = target.takeIf { it.isFile }?.let { it.length() to it.lastModified() }
        if (before != null && tmp.length() == before.first && tmp.lastModified() <= before.second) {
            tmp.setLastModified(before.second + 1)
        }
        val rename: () -> Unit = {
            if (backup && target.isFile) target.renameTo(File(target.parentFile, "${target.name}.bak"))
            if (!tmp.renameTo(target)) {
                target.delete()
                if (!tmp.renameTo(target)) {
                    tmp.delete()
                    throw IOException("could not replace $name")
                }
            }
        }
        var refusal: String? = null
        // The closed check and the rename are one step under the publish lock (see `close`); with
        // a lease, that step is under the lease's lock too, so a claim and a rename never straddle.
        val attempt: () -> Unit = {
            synchronized(publishLock) {
                if (closed) refusal = CLOSED else rename()
            }
        }
        if (lease == null) attempt() else if (!lease.whileHeld(holder, attempt)) refusal = SUPERSEDED
        refusal?.let {
            tmp.delete()
            throw refused(name, it)
        }
    }

    /**
     * A write this instance would not make: its host is destroyed ([close]), or a newer host
     * holds the profile's [Lease]. The document is as it was.
     */
    class RefusedWrite(name: String, why: String) : IOException("$name not written: $why")

    /**
     * Who may write a profile: the latest holder. The browser `Host` claims it as it is built –
     * before the core it hosts reads a document – so a host that has been relaunched or
     * recreated under it is superseded from that moment, and every rename of its [publish] is
     * refused. A claim and a publish exclude each other (the lock), so no write straddles the
     * hand-over. In-process by design: the two hosts of a relaunch share the process, and a
     * process that died writes nothing.
     */
    class Lease {
        private val latest = AtomicLong()
        private val lock = Any()

        /** Become the latest holder; the number names the holder to [whileHeld]. */
        fun claim(): Long = synchronized(lock) { latest.incrementAndGet() }

        /** Whether `holder` is still the latest claim. */
        fun holds(holder: Long): Boolean = latest.get() == holder

        /** Run `publish` with the lease held by `holder`, or not at all: false when `holder` has been superseded. */
        fun whileHeld(holder: Long, publish: () -> Unit): Boolean = synchronized(lock) {
            if (latest.get() != holder) return@synchronized false
            publish()
            true
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
        /** The extensions' `chrome.storage` documents, `<id>.json` each (`src/android/extensionRuntime.ts`). */
        const val EXT_STORAGE_DIR = "ext-storage"
        private const val LEGACY_EXT_STORAGE_PREFIX = "ext-storage-"
        /**
         * A document up to this many bytes is answered whole by the bridge's `storage.read`; a
         * bigger one is read in pieces (`CHUNK_CHARS` in `src/android/storeIo.ts`, the same 1 Mi).
         */
        const val INLINE_READ_BYTES = 1L shl 20
        /** The most characters one [readChunk] hands out (the bridge's chunk is 1 Mi; this bounds a caller's request). */
        const val MAX_CHUNK_CHARS = 4 shl 20
        private val UNSAFE = Regex("[^A-Za-z0-9._-]")
        private val changeListeners = CopyOnWriteArraySet<(String) -> Unit>()
        /** The one profile's lease, claimed by every browser `Host` of the process as it is built. */
        val hostLease = Lease()
        /** Why a write was refused, as [RefusedWrite]'s message and the log say it. */
        const val CLOSED = "the host is destroyed"
        const val SUPERSEDED = "a newer host holds the profile"

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
