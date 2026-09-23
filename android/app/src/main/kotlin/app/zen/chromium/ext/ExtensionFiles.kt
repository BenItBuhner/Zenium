package app.zen.chromium.ext

import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.SequenceInputStream
import java.security.SecureRandom
import java.util.Vector

/**
 * The on-disk layout of installed extensions, the same one the desktop keeps
 * (`src/core/extensions/installLayout.ts`):
 *
 *     <root>/<id>/<version>/      the files the runtime loads
 *     <root>/<id>/<version>_1/    a second install of the same version (Chrome does this too)
 *     <root>/.staging/<token>/    where a package is written before it becomes visible
 *
 * A package is unpacked into a staging directory and renamed into place in one step, so a crash
 * mid-install leaves a stale staging folder (swept on the next start) but never a half-written
 * extension. Every path written comes from the TypeScript core, which normalised and vetted the
 * archive's names first; the same rules are applied again here ([safeSegments]) and the resolved
 * file is checked to lie inside its directory, so a package cannot write outside its own folder
 * whatever either side missed. Plain Kotlin over `java.io`, so the JVM unit tests cover it.
 */
class ExtensionFiles(val root: File) {
    val staging: File get() = File(root, STAGING_DIR)

    /** `<root>/<id>`; the id must be a Chrome extension id (32 letters a to p). */
    fun installDir(id: String): File {
        if (!isExtensionId(id)) throw IOException("'$id' is not an extension id")
        return File(root, id)
    }

    /**
     * Writes an install through `write(stagingDir)` and moves it to the first free
     * `<root>/<id>/<version>[_n]`, which is returned. The staging directory goes again when
     * writing or the move fails.
     */
    fun install(id: String, version: String, write: (File) -> Unit): File {
        val idDir = installDir(id)
        val stagingDir = File(staging, stagingToken())
        if (!stagingDir.mkdirs()) throw IOException("could not create ${stagingDir.path}")
        try {
            write(stagingDir)
            if (!idDir.isDirectory && !idDir.mkdirs()) throw IOException("could not create ${idDir.path}")
            for (attempt in 1..MAX_RENAME_ATTEMPTS) {
                val target = pickVersionDir(id, version)
                if (stagingDir.renameTo(target)) return target
                // A concurrent install of the same version claimed the directory first: pick again.
                if (!target.exists() || attempt == MAX_RENAME_ATTEMPTS) {
                    throw IOException("could not move the install to ${target.path}")
                }
            }
            throw IOException("could not move the install into place")
        } catch (e: Exception) {
            stagingDir.deleteRecursively()
            throw e
        }
    }

    /** The first free `<root>/<id>/<version>[_n]`, like Chrome's `GetVersionDir`. */
    fun pickVersionDir(id: String, version: String): File {
        val idDir = installDir(id)
        val base = versionDirName(version)
        for (attempt in 0 until MAX_VERSION_DIR_ATTEMPTS) {
            val candidate = File(idDir, if (attempt == 0) base else "${base}_$attempt")
            if (!candidate.exists()) return candidate
        }
        throw IOException("too many installs of $id $version")
    }

    /** Removes every version directory of `id` except `keep`; returns what went. */
    fun prune(id: String, keep: File): List<String> {
        val idDir = installDir(id)
        val keepPath = keep.absolutePath
        val removed = ArrayList<String>()
        for (child in idDir.listFiles() ?: return removed) {
            if (child.absolutePath == keepPath) continue
            child.deleteRecursively()
            removed.add(child.absolutePath)
        }
        return removed
    }

    /** Removes the whole `<root>/<id>` tree (uninstall). */
    fun remove(id: String) {
        installDir(id).deleteRecursively()
    }

    /** Removes the staging folders an interrupted install left behind; returns what went. */
    fun sweepStaging(): List<String> {
        val removed = ArrayList<String>()
        for (child in staging.listFiles() ?: return removed) {
            child.deleteRecursively()
            removed.add(child.absolutePath)
        }
        return removed
    }

    /**
     * Unpacks the package at `packageFile` into a new version directory of `request.id` and
     * returns it. Only the files the core listed are written, each checked against the archive's
     * central directory by [ZipReader]; `request.manifest` replaces the archive's `manifest.json`
     * when set; the sum of the files written may not pass `request.totalSize`.
     */
    fun unpack(packageFile: File, request: UnpackRequest): File = install(request.id, request.version) { dir ->
        ZipReader.open(packageFile, request.zipOffset).use { zip ->
            for (directory in request.directories) {
                val target = resolveInside(dir, directory)
                if (!target.isDirectory && !target.mkdirs()) throw IOException("could not create $directory")
            }
            var written = 0L
            val manifest = request.manifest?.toByteArray(Charsets.UTF_8)
            for (path in request.files) {
                val target = resolveInside(dir, path)
                val parent = target.parentFile
                if (parent != null && !parent.isDirectory && !parent.mkdirs()) throw IOException("could not create the folder of $path")
                if (path == MANIFEST_NAME && manifest != null) {
                    written += manifest.size
                    if (written > request.totalSize) throw IOException("the package is larger than declared")
                    target.writeBytes(manifest)
                    continue
                }
                val entry = zip[request.rootPrefix + path] ?: throw IOException("$path is not in the package")
                if (entry.size > request.totalSize - written) throw IOException("the package is larger than declared")
                FileOutputStream(target).use { out -> zip.copyTo(entry, out) }
                written += entry.size
            }
        }
    }

    /** What `extStore.unpack` asks for (see `extensionStoreIo.ts`). */
    class UnpackRequest(
        val id: String,
        val version: String,
        /** Where the zip starts inside the package file: the CRX3 header length, or 0 for a plain zip. */
        val zipOffset: Long,
        /** The top-level folder wrapping the extension inside the archive (`""` when none). */
        val rootPrefix: String,
        /** Every file to write, relative to the extension root, as the core validated them. */
        val files: List<String>,
        /** Directory entries the archive listed, relative to the extension root. */
        val directories: List<String>,
        /** Replaces the archive's `manifest.json` when set. */
        val manifest: String?,
        /** Cap on the bytes written: the sum of the files' declared sizes. */
        val totalSize: Long
    )

    companion object {
        const val STAGING_DIR = ".staging"
        const val MANIFEST_NAME = "manifest.json"
        private const val MAX_VERSION_DIR_ATTEMPTS = 100
        private const val MAX_RENAME_ATTEMPTS = 3
        private val random = SecureRandom()
        private val VERSION_UNSAFE = Regex("[^0-9A-Za-z._-]")
        private val DRIVE_LETTER = Regex("^[A-Za-z]:")

        fun isExtensionId(id: String): Boolean = id.length == 32 && id.all { it in 'a'..'p' }

        /** A version is safe as a directory name; anything else is escaped, as the desktop does it. */
        fun versionDirName(version: String): String {
            val safe = version.replace(VERSION_UNSAFE, "_")
            return if (safe.isNotEmpty() && safe != "." && safe != "..") safe else "unversioned"
        }

        /**
         * The segments of an archive path, or an [IOException] when it could escape its root or
         * is not a name at all: the rules of the core's `normalizeZipPath` (backslashes are
         * separators; no absolute or drive-letter paths, no `.`, `..` or empty segments, no
         * control characters). One trailing slash (a directory entry) is allowed and dropped.
         */
        fun safeSegments(path: String): List<String> {
            val name = path.replace('\\', '/')
            if (name.isEmpty()) throw IOException("a package entry has an empty name")
            if (name.any { it < ' ' || it == '\u007f' }) throw IOException("a package entry name contains control characters")
            if (name.startsWith("/")) throw IOException("a package entry has an absolute path: $name")
            if (DRIVE_LETTER.containsMatchIn(name)) throw IOException("a package entry has a drive-letter path: $name")
            val segments = name.removeSuffix("/").split('/')
            for (segment in segments) {
                if (segment == "..") throw IOException("a package entry escapes its root: $name")
                if (segment.isEmpty() || segment == ".") throw IOException("a package entry has an empty or \".\" segment: $name")
            }
            return segments
        }

        /** The file `path` names inside `dir`, after [safeSegments] and a check that it is inside. */
        fun resolveInside(dir: File, path: String): File {
            val target = File(dir, safeSegments(path).joinToString(File.separator))
            val inside = dir.canonicalPath + File.separator
            if (!target.canonicalPath.startsWith(inside)) throw IOException("a package entry escapes its root: $path")
            return target
        }

        /**
         * The most bytes of an extension file the bridge will answer as one text
         * (`ext.readFile`). A bridge answer is a Java string quoted into a JavaScript literal and
         * handed to `evaluateJavascript`, three copies of the text in the browser process's heap
         * at once: AdGuard's 21 MB base filter took the process down that way (round 4). Files
         * this size and above reach the runtime through the asset loader instead
         * (`extensionStoreIo.ts` readInstalledFile), which streams them.
         */
        const val BRIDGE_TEXT_LIMIT = 4L * 1024 * 1024

        /**
         * The text of an extension file for a bridge answer, or null when there is no such file
         * or it is too large to answer that way ([BRIDGE_TEXT_LIMIT]).
         */
        fun bridgeText(file: File?): String? {
            if (file == null || !file.isFile) return null
            if (file.length() >= BRIDGE_TEXT_LIMIT) return null
            return runCatching { file.readText() }.getOrNull()
        }

        /**
         * The first [bytes] bytes of a file as text (a multi-byte character cut at the end reads
         * as U+FFFD), or "" when the file cannot be read: what the module bracket looks at to
         * tell a webpack chunk (`ExtensionScripts.isWebpackChunk`) and a module declaring
         * `chrome` itself (`declaresChrome`) without reading the file whole. The buffer is the
         * smaller of [bytes] and the file, read until it is full or the file ends.
         */
        fun head(file: File, bytes: Int): String = runCatching {
            FileInputStream(file).use { stream ->
                val buffer = ByteArray(minOf(bytes.toLong(), file.length()).toInt().coerceAtLeast(0))
                var read = 0
                while (read < buffer.size) {
                    val n = stream.read(buffer, read, buffer.size - read)
                    if (n <= 0) break
                    read += n
                }
                if (read <= 0) "" else String(buffer, 0, read, Charsets.UTF_8)
            }
        }.getOrDefault("")

        /** A served file's body: a stream the WebView drains, and the `Content-Length` it is told. */
        class ServedBody(val stream: InputStream, val length: Long)

        /**
         * The body of a file the runtime serves on the extension's origin, streamed from disk
         * with the optional `open`/`close` brackets around it (the module bracket,
         * `ExtensionScripts.moduleChromeOpen`/`Close`, ASCII on either side of the file's UTF-8).
         * The file is never in the heap whole: a page loads its scripts in parallel and the
         * WebView holds each intercepted body until the renderer drains it, so a wallet whose
         * popup pulls three hundred module chunks, one of 36 MB, put the whole set (and the
         * wrap's two `String` copies of the largest) on the Java heap at once and ran the
         * process out of it. Null when the file cannot be opened.
         */
        fun servedBody(file: File, open: String? = null, close: String? = null): ServedBody? {
            val stream = runCatching { FileInputStream(file) }.getOrNull() ?: return null
            val length = file.length()
            if (open.isNullOrEmpty() && close.isNullOrEmpty()) return ServedBody(stream, length)
            val head = open.orEmpty().toByteArray(Charsets.UTF_8)
            val tail = close.orEmpty().toByteArray(Charsets.UTF_8)
            val parts = Vector<InputStream>(3).apply {
                add(ByteArrayInputStream(head))
                add(stream)
                add(ByteArrayInputStream(tail))
            }
            return ServedBody(SequenceInputStream(parts.elements()), head.size + length + tail.size)
        }

        /**
         * A stylesheet the runtime serves on the extension's origin is at most this long to be
         * localized; a larger one (none seen: Steam Inventory Helper's 514-flag sheet is 60 KB)
         * streams as it is, its placeholders in.
         */
        const val LOCALIZED_CSS_LIMIT = 2L * 1024 * 1024

        private val MESSAGE_PLACEHOLDER = Regex("__MSG_([A-Za-z0-9_@]+)__")

        /**
         * A `text/css` body as Chrome's renderer hands it to the page: every `__MSG_name__` replaced
         * from the extension's substitution map (`ExtensionLocalizationThrottle` in Chromium runs
         * `SharedL10nMap::ReplaceMessages` over every `chrome-extension://` response whose type is
         * `text/css`, whatever asked for it: a `<link>`, an `@import`, a `fetch`). The map is the
         * core's (`ext.configure`'s `served.cssMessages`): the predefined `@@extension_id`,
         * `@@ui_locale` and `@@bidi_*` and the extension's own messages for the UI locale, keys
         * lowercased. A name the map has not stays as written, and the text is returned as it
         * came when it has no placeholder. Steam Inventory Helper's `<link>`-loaded `flag-icon.css`
         * and `manrope.css` name their 517 images and fonts as
         * `chrome-extension://__MSG_@@extension_id__/...` (compat round 9, row 4).
         */
        fun localizeCss(text: String, messages: Map<String, String>): String {
            if (messages.isEmpty() || !text.contains("__MSG_")) return text
            return MESSAGE_PLACEHOLDER.replace(text) { match -> messages[match.groupValues[1].lowercase()] ?: match.value }
        }

        private fun stagingToken(): String {
            val bytes = ByteArray(8).also(random::nextBytes)
            return "${System.currentTimeMillis().toString(36)}-${bytes.joinToString("") { "%02x".format(it) }}"
        }
    }
}
