package app.zen.chromium

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.Executor

/**
 * The PDF viewer's Print (`view.printPdf`, CT-44): the document the viewer shows – the file's
 * bytes as downloaded, or a copy with the form's values written in (`core/pdf.ts`) – handed to
 * the system print flow as the PDF it is, the way Chrome Android's viewer prints. A
 * `PrintManager.print` job whose document adapter writes the bytes into the spooler's
 * descriptor: the platform's own recipe for a PDF that already exists (`PrintDocumentInfo`
 * `CONTENT_TYPE_DOCUMENT`, the page count unknown, all pages written in one go).
 *
 * The job is `{ tabId, name, path | null, data | null }` with exactly one of `path` and `data`
 * ([parse]); anything else answers false. `data` is the document as base64, decoded once and
 * held for this job alone ([Source.Bytes]; dropped in `onFinish`). `path` names a file under
 * the app's own directories – `filesDir` or `cacheDir` ([allowed]) – and nothing else: no file
 * of the device's crosses the bridge into a print job, the public Downloads included (the core
 * hands the bytes for those). The verb answers true once `print()` has returned – the job is
 * the dialog's from then – and not when the pages come out.
 *
 * The write runs on the host's I/O executor (`zen-io`) and reports through the framework's
 * callback on the main thread, where its own adapters report. Unlike the page's print
 * (`PrintRelay`), nothing of the WebView's waits on the spooler here: a spooler that stops
 * reading holds an I/O thread of ours until it closes its pipe, and no renderer.
 */
object PdfPrint {
    private const val TAG = "ZenPdfPrint"
    private const val BUFFER_SIZE = 64 * 1024
    /** The queue's name for a file without one. */
    const val DEFAULT_JOB_NAME = "Document"

    /** The core's job: exactly one of [path] and [data]. */
    class Job(val tabId: String, val name: String, val path: String?, val data: String?)

    /**
     * [args] as a job, or null when they are not one: both or neither of `path` and `data`
     * present (absent and null are the same absence), the present one empty, or no tab. A
     * malformed job is refused, not repaired: what is null up here answers false through the
     * verb, and the chrome says the PDF cannot be printed.
     */
    fun parse(args: JSONObject): Job? {
        val tabId = args.strOrNull("tabId")?.takeIf { it.isNotEmpty() } ?: return null
        val path = args.strOrNull("path")
        val data = args.strOrNull("data")
        if ((path == null) == (data == null)) return null
        if (path?.isEmpty() == true || data?.isEmpty() == true) return null
        return Job(tabId, args.str("name"), path, data)
    }

    /** The job's name in the print queue: the file's without its `.pdf`; [DEFAULT_JOB_NAME] for a file without a name. */
    fun jobName(name: String): String {
        val trimmed = name.trim()
        val stem = if (trimmed.endsWith(".pdf", ignoreCase = true)) trimmed.dropLast(4).trimEnd() else trimmed
        return stem.ifEmpty { DEFAULT_JOB_NAME }
    }

    /**
     * The file [path] names when it is a file under one of [roots] – the app's `filesDir` and
     * `cacheDir` – once links and `..` are resolved; null for any other path: the public
     * Downloads, another app's files, a directory, a link that leads out of the app's own.
     */
    fun allowed(path: String, roots: List<File>): File? {
        val file = File(path)
        if (!file.isAbsolute) return null
        val canonical = runCatching { file.canonicalFile }.getOrNull() ?: return null
        if (!canonical.isFile) return null
        val under = roots.any { root ->
            val base = runCatching { root.canonicalPath }.getOrNull() ?: return@any false
            canonical.path.startsWith(base + File.separator)
        }
        return if (under) canonical else null
    }

    /**
     * Copies [input] to [output] in [BUFFER_SIZE] pieces, asking [cancelled] between them: the
     * bytes written, or -1 when the copy was cancelled part-way (what was written stays where
     * it went; the spooler discards a cancelled write).
     */
    fun copy(input: InputStream, output: OutputStream, cancelled: () -> Boolean): Long {
        val buffer = ByteArray(BUFFER_SIZE)
        var total = 0L
        while (true) {
            if (cancelled()) return -1
            val n = input.read(buffer)
            if (n < 0) {
                output.flush()
                return total
            }
            output.write(buffer, 0, n)
            total += n
        }
    }

    /** Where the job's bytes come from: a file under the app's directories, or the decoded `data`. */
    sealed class Source {
        abstract fun open(): InputStream
        /** The job is over: what was held for it goes. */
        open fun release() {}

        class Path(val file: File) : Source() {
            override fun open(): InputStream = FileInputStream(file)
        }

        class Bytes(private var bytes: ByteArray?) : Source() {
            override fun open(): InputStream = ByteArrayInputStream(bytes ?: throw IllegalStateException("the job's bytes were released"))
            override fun release() {
                bytes = null
            }
        }
    }

    /**
     * The source of [job]'s bytes, or null: `data` that is not base64 or is empty once decoded,
     * a `path` outside [roots] or naming no file.
     */
    fun source(job: Job, roots: List<File>): Source? {
        job.path?.let { path -> return allowed(path, roots)?.let { Source.Path(it) } }
        val data = job.data ?: return null
        val bytes = runCatching { Base64.decode(data, Base64.DEFAULT) }.getOrNull() ?: return null
        return if (bytes.isEmpty()) null else Source.Bytes(bytes)
    }

    /**
     * Hand [job] to the system print dialog from [activity], on the main thread (`PrintManager`
     * starts the print UI from it). True once `print()` has returned; false for a source the
     * verb does not take and for a print service that refused.
     */
    fun print(activity: Activity, job: Job, io: Executor, main: (Runnable) -> Unit): Boolean {
        val source = source(job, listOf(activity.filesDir, activity.cacheDir)) ?: return false
        val name = jobName(job.name)
        return runCatching {
            val manager = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
            manager.print(name, Adapter(name, source, io, main), PrintAttributes.Builder().build())
            true
        }.getOrElse { e ->
            Log.w(TAG, "the print service refused the PDF: $e")
            source.release()
            false
        }
    }

    /**
     * The document as it is: laid out once (the PDF is what it is whatever the attributes) and
     * written whole into the spooler's descriptor off the main thread, stopping at the
     * spooler's cancellation; an I/O error is the write's failure, which reaches the chrome as
     * the dialog's own message. Through a copy of the descriptor of our own, closed when the
     * write is done ([PrintRelay]'s shape): the framework closes the one it passed.
     */
    class Adapter(
        private val jobName: String,
        private val source: Source,
        private val io: Executor,
        private val main: (Runnable) -> Unit
    ) : PrintDocumentAdapter() {
        override fun onLayout(
            oldAttributes: PrintAttributes?,
            newAttributes: PrintAttributes,
            cancellationSignal: CancellationSignal,
            callback: LayoutResultCallback,
            extras: Bundle?
        ) {
            if (cancellationSignal.isCanceled) {
                callback.onLayoutCancelled()
                return
            }
            val info = PrintDocumentInfo.Builder("$jobName.pdf")
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
                .build()
            callback.onLayoutFinished(info, oldAttributes == null || newAttributes != oldAttributes)
        }

        override fun onWrite(
            pages: Array<out PageRange>,
            destination: ParcelFileDescriptor,
            cancellationSignal: CancellationSignal,
            callback: WriteResultCallback
        ) {
            val spool = runCatching { destination.dup() }.getOrElse { e ->
                Log.w(TAG, "no descriptor for the PDF's print: $e")
                callback.onWriteFailed(e.message)
                return
            }
            io.execute {
                val written = runCatching {
                    FileOutputStream(spool.fileDescriptor).use { out ->
                        source.open().use { input -> copy(input, out) { cancellationSignal.isCanceled } }
                    }
                }
                runCatching { spool.close() }
                main(Runnable {
                    val error = written.exceptionOrNull()
                    when {
                        error != null -> {
                            Log.w(TAG, "the PDF's print write failed: $error")
                            callback.onWriteFailed(error.message)
                        }
                        written.getOrThrow() < 0 -> callback.onWriteCancelled()
                        else -> callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
                    }
                })
            }
        }

        override fun onFinish() {
            source.release()
        }
    }
}
