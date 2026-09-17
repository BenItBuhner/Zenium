package app.zen.chromium

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream

/**
 * Where a download's bytes go. Three kinds, one contract: open for writing (from the start or
 * appending to what is there), report the size on disk, finish (make the file visible under its
 * final name), delete. `savePath` is what the core stores and later hands back to `reopen`, so
 * a transfer interrupted by a restart can continue and a quarantined file can be released.
 *
 * - API 29+ default location: a `MediaStore.Downloads` row. While the transfer runs (and while a
 *   flagged file waits for Keep) the row is pending, so no other app sees it; `finish` publishes
 *   it and the system Files and Downloads apps list it.
 * - API 26–28 default location: a file in the public Downloads directory written under
 *   `PARTIAL_SUFFIX`, renamed on finish and registered with `DownloadManager` so the Downloads
 *   app shows it. Needs WRITE_EXTERNAL_STORAGE (granted on first download).
 * - A document the user picked (ask where to save) or created in the folder they chose as the
 *   default location, through the Storage Access Framework.
 */
sealed class DownloadSink {
    abstract val savePath: String
    abstract val displayName: String
    abstract fun open(append: Boolean): OutputStream
    abstract fun size(): Long
    abstract fun exists(): Boolean
    /** Publish the file under its final name; returns where it ended up (path or content URI) and its name. */
    abstract fun finish(mimeType: String, sourceUrl: String, referrer: String): Pair<String, String>
    abstract fun delete()
    /** A URI another app can open (`ACTION_VIEW`). */
    abstract fun shareUri(context: Context): Uri?

    @RequiresApi(Build.VERSION_CODES.Q)
    class MediaStoreSink(private val context: Context, val uri: Uri, override val displayName: String) : DownloadSink() {
        override val savePath: String get() = uri.toString()

        override fun open(append: Boolean): OutputStream =
            context.contentResolver.openOutputStream(uri, if (append) "wa" else "wt")
                ?: throw IOException("could not open the download for writing")

        override fun size(): Long = runCatching {
            context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize }
        }.getOrNull() ?: -1L

        override fun exists(): Boolean = runCatching {
            context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns._ID), null, null, null)?.use { it.moveToFirst() }
        }.getOrNull() == true

        override fun finish(mimeType: String, sourceUrl: String, referrer: String): Pair<String, String> {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.IS_PENDING, 0)
                if (mimeType.isNotEmpty()) put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    if (sourceUrl.startsWith("http")) put(MediaStore.Downloads.DOWNLOAD_URI, sourceUrl)
                    if (referrer.isNotEmpty()) put(MediaStore.Downloads.REFERER_URI, referrer)
                }
            }
            context.contentResolver.update(uri, values, null, null)
            return uri.toString() to (queryDisplayName(context, uri) ?: displayName)
        }

        override fun delete() {
            runCatching { context.contentResolver.delete(uri, null, null) }
        }

        override fun shareUri(context: Context): Uri = uri
    }

    class FileSink(private val context: Context, val partial: File, override val displayName: String) : DownloadSink() {
        override val savePath: String get() = partial.absolutePath

        override fun open(append: Boolean): OutputStream {
            partial.parentFile?.mkdirs()
            return FileOutputStream(partial, append)
        }

        override fun size(): Long = if (partial.exists()) partial.length() else -1L
        override fun exists(): Boolean = partial.exists()

        override fun finish(mimeType: String, sourceUrl: String, referrer: String): Pair<String, String> {
            val dir = partial.parentFile ?: throw IOException("download folder is gone")
            val wanted = partial.name.removeSuffix(DownloadLogic.PARTIAL_SUFFIX)
            val name = DownloadLogic.uniqueName(wanted) { File(dir, it).exists() }
            val target = File(dir, name)
            if (!partial.renameTo(target)) throw IOException("could not rename the download")
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                // Pre-Q the Downloads app lists what DownloadManager knows about; register the file.
                val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                @Suppress("DEPRECATION")
                runCatching {
                    manager.addCompletedDownload(
                        name, "Downloaded with Zenium", true, mimeType.ifEmpty { "application/octet-stream" },
                        target.absolutePath, target.length(), false
                    )
                }
            }
            return target.absolutePath to name
        }

        override fun delete() {
            partial.delete()
        }

        override fun shareUri(context: Context): Uri? = runCatching {
            FileProvider.getUriForFile(context, "${context.packageName}.files", partial)
        }.getOrNull()
    }

    class DocumentSink(private val context: Context, val uri: Uri, override val displayName: String) : DownloadSink() {
        override val savePath: String get() = uri.toString()

        override fun open(append: Boolean): OutputStream {
            val resolver = context.contentResolver
            if (append) {
                // Not every provider supports appending; a fresh write is the honest fallback.
                runCatching { resolver.openOutputStream(uri, "wa") }.getOrNull()?.let { return it }
                throw IOException("provider cannot append")
            }
            return resolver.openOutputStream(uri, "wt")
                ?: resolver.openOutputStream(uri, "w")
                ?: throw IOException("could not open the document for writing")
        }

        override fun size(): Long = runCatching {
            context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize }
        }.getOrNull() ?: -1L

        override fun exists(): Boolean = runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { it.moveToFirst() }
        }.getOrNull() == true

        override fun finish(mimeType: String, sourceUrl: String, referrer: String): Pair<String, String> =
            uri.toString() to (queryDisplayName(context, uri) ?: displayName)

        override fun delete() {
            runCatching { DocumentsContract.deleteDocument(context.contentResolver, uri) }
        }

        override fun shareUri(context: Context): Uri = uri
    }

    companion object {
        /** The default location for a new download. */
        fun createDefault(context: Context, name: String, mimeType: String): DownloadSink {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mimeType.ifEmpty { mimeFor(name) })
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IOException("could not create the download")
                return MediaStoreSink(context, uri, queryDisplayName(context, uri) ?: name)
            }
            val dir = publicDownloads(context)
            val unique = DownloadLogic.uniqueName(name) { File(dir, it).exists() || File(dir, it + DownloadLogic.PARTIAL_SUFFIX).exists() }
            return FileSink(context, File(dir, unique + DownloadLogic.PARTIAL_SUFFIX), unique)
        }

        /** A new document inside the folder the user picked as the default location (a tree URI). */
        fun createInFolder(context: Context, tree: Uri, name: String, mimeType: String): DownloadSink {
            val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
            val uri = DocumentsContract.createDocument(context.contentResolver, parent, mimeType.ifEmpty { mimeFor(name) }, name)
                ?: throw IOException("could not create a file in the chosen folder")
            return DocumentSink(context, uri, queryDisplayName(context, uri) ?: name)
        }

        /** The document the user chose in the save dialog. */
        fun forDocument(context: Context, uri: Uri, name: String): DownloadSink =
            DocumentSink(context, uri, queryDisplayName(context, uri) ?: name)

        /** Back from a persisted `savePath`; null when the file is gone. */
        fun reopen(context: Context, savePath: String, displayName: String): DownloadSink? {
            if (savePath.isEmpty()) return null
            val sink: DownloadSink = when {
                savePath.startsWith("content://media/") && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
                    MediaStoreSink(context, Uri.parse(savePath), displayName)
                savePath.startsWith("content:") -> DocumentSink(context, Uri.parse(savePath), displayName)
                else -> FileSink(context, File(savePath), displayName)
            }
            return if (sink.exists()) sink else null
        }

        fun publicDownloads(context: Context): File {
            val public = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val dir = if (public != null && (public.isDirectory || public.mkdirs())) public
            else context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
            return dir
        }

        fun mimeFor(name: String): String {
            val ext = DownloadLogic.extensionOf(name).lowercase()
            return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        }

        fun extensionFor(mimeType: String): String? =
            MimeTypeMap.getSingleton().getExtensionFromMimeType(DownloadLogic.mimeBase(mimeType))
                ?: DownloadLogic.fallbackExtension(mimeType)

        fun queryDisplayName(context: Context, uri: Uri): String? = runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0)?.takeIf { it.isNotBlank() } else null
            }
        }.getOrNull()

    }
}
