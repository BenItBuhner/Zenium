package app.zen.chromium

import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import android.util.Log
import java.io.File
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.IOException
import java.util.concurrent.Executor

/**
 * Prints a page through the system print service without letting the print spooler stall the
 * WebView renderer.
 *
 * `WebView.createPrintDocumentAdapter` writes the PDF into whatever descriptor `onWrite` is
 * handed – the spooler's end of a pipe – and the renderer's main thread waits on that write:
 * `DidPrintDocument` is a synchronous Mojo call whose reply the WebView's browser side sends only
 * once `SaveDataToFd` has returned. The spooler drains its pipe while its preview wants the
 * pages; once the user backs out of the preview it stops reading (and Android freezes the cached
 * spooler process), the pipe fills, the write never returns – and with it the one renderer
 * process every WebView of the app shares, the chrome's included. The chrome then takes no
 * touch, pages still scroll on the compositor thread, and there is no ANR because the app's main
 * thread is fine (BH-01). The wake watchdog ends the wedged renderer some ten seconds later, at
 * the price of every tab's state.
 *
 * So the WebView is handed a scratch file instead, which takes its write whatever the spooler
 * does, and the relay then moves the file into the spooler's descriptor on a background thread:
 * without blocking (a full pipe is polled for a while, not waited on for ever), stopping at the
 * spooler's cancellation, and giving up when the spooler has not taken a byte for
 * [IDLE_LIMIT_MS].
 *
 * The WebView writes the file from another thread after `onWrite` has returned, and does not
 * close the descriptor it was given (through Chromium 145 `AwPdfExporter` reads the number out
 * of it – "the caller should close the file"): the framework closes the descriptor *it* passed to
 * `onWrite` once the WebView has reported the write finished, failed or cancelled, or when the
 * print session ends. That close is the relay's cue. The page is complete when the framework's
 * descriptor is closed and the file has stopped growing; only then is the WebView's descriptor
 * closed, since closing it any earlier would free a number the renderer still writes to. A
 * session that ended before a byte was written keeps the descriptor for [WRITE_GRACE_MS] in case
 * the write is still to come. A WebView that detaches and closes the descriptor itself (Chromium
 * 152 on) changes nothing: the file is judged the same way.
 *
 * The spooler learns of the WebView's `onWriteFinished` as before, but keeps its file under a
 * mutex until its end of the pipe reaches EOF, which is when the relay closes its own copy of the
 * descriptor – so the preview never reads a document that is still arriving.
 */
class PrintRelay(
    private val delegate: PrintDocumentAdapter,
    private val scratchDir: File,
    private val io: Executor
) : PrintDocumentAdapter() {
    @Volatile
    private var finished = false

    override fun onStart() {
        sweep()
        delegate.onStart()
    }

    override fun onLayout(
        oldAttributes: PrintAttributes?,
        newAttributes: PrintAttributes,
        cancellationSignal: CancellationSignal,
        callback: LayoutResultCallback,
        extras: Bundle?
    ) = delegate.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras)

    override fun onWrite(
        pages: Array<out PageRange>,
        destination: ParcelFileDescriptor,
        cancellationSignal: CancellationSignal,
        callback: WriteResultCallback
    ) {
        val plumbing = Plumbing.open(destination, ::scratchFile)
        if (plumbing == null) {
            // No scratch file to be had: print the way the platform does, stall and all.
            Log.w(TAG, "no plumbing for the print relay; the page writes straight to the spooler")
            delegate.onWrite(pages, destination, cancellationSignal, callback)
            return
        }
        io.execute { relay(plumbing, destination, cancellationSignal) }
        try {
            delegate.onWrite(pages, plumbing.page, cancellationSignal, callback)
        } catch (e: RuntimeException) {
            // The WebView refused the write (one export at a time: a preview the user left may
            // still be preparing) and so never took the descriptor. Nothing will be written, and
            // the framework only hears of it from us.
            Log.w(TAG, "the page refused to print: $e")
            plumbing.refused = true
            callback.onWriteFailed(null)
        }
    }

    override fun onFinish() {
        finished = true
        delegate.onFinish()
    }

    /** Wait for the WebView's write to the scratch file, then move the file into the spooler's pipe. */
    private fun relay(p: Plumbing, destination: ParcelFileDescriptor, signal: CancellationSignal) {
        var outcome = Outcome.FAILED
        try {
            val take = awaitPage(p, destination, signal)
            // The WebView is done with the file (or never wrote it): its descriptor may go.
            closeQuietly(p.page)
            outcome = when {
                take == Take.DELIVER -> forward(p.file, p.spool, signal)
                signal.isCanceled || finished -> Outcome.CANCELLED
                else -> Outcome.FAILED
            }
        } catch (e: Exception) {
            // Leaves `page` open on an error while waiting: a leaked descriptor is nothing next to
            // one the renderer writes into after another file has taken its number.
            Log.w(TAG, "print relay: $e")
        } finally {
            closeQuietly(p.spool)
            p.file.delete()
        }
        if (outcome != Outcome.WRITTEN) Log.i(TAG, "print relay ended: $outcome")
    }

    /**
     * Look at the scratch file every [POLL_STEP_MS] until the WebView has written it, or will not:
     * [takeStep] decides from the framework's descriptor and the file's growth. A write the
     * spooler no longer wants closes the spooler's copy at once, so its pipe reaches EOF.
     */
    private fun awaitPage(p: Plumbing, destination: ParcelFileDescriptor, signal: CancellationSignal): Take {
        var size = 0L
        var closedAt = -1L
        var spoolOpen = true
        while (true) {
            if (p.refused) return Take.DISCARD
            SystemClock.sleep(POLL_STEP_MS.toLong())
            val now = SystemClock.uptimeMillis()
            val destinationClosed = runCatching { destination.fd }.isFailure
            if (destinationClosed && closedAt < 0) closedAt = now
            val wanted = !(signal.isCanceled || finished)
            if (!wanted && spoolOpen) {
                closeQuietly(p.spool)
                spoolOpen = false
            }
            val length = p.file.length()
            val step = takeStep(
                destinationClosed = destinationClosed,
                size = length,
                grew = length != size,
                closedForMs = if (destinationClosed) now - closedAt else 0L,
                wanted = wanted
            )
            size = length
            if (step != Take.WAIT) return step
        }
    }

    /** Move the scratch file into the spooler's descriptor, without ever blocking on it. */
    private fun forward(file: File, spool: ParcelFileDescriptor, signal: CancellationSignal): Outcome {
        val fd = spool.fileDescriptor
        val flags = Os.fcntlInt(fd, OsConstants.F_GETFL, 0)
        Os.fcntlInt(fd, OsConstants.F_SETFL, flags or OsConstants.O_NONBLOCK)
        val buffer = ByteArray(BUFFER_SIZE)
        var total = 0L
        FileInputStream(file).use { input ->
            while (true) {
                val n = input.read(buffer)
                if (n < 0) {
                    Log.i(TAG, "print relay handed $total bytes to the spooler")
                    return Outcome.WRITTEN
                }
                var offset = 0
                var idleMs = 0L
                while (offset < n) {
                    val written = try {
                        Os.write(fd, buffer, offset, n - offset)
                    } catch (e: ErrnoException) {
                        if (e.errno != OsConstants.EAGAIN) throw e
                        0
                    }
                    offset += written
                    total += written
                    when (nextStep(written, signal.isCanceled || finished, idleMs)) {
                        Step.CONTINUE -> idleMs = 0L
                        Step.CANCEL -> return Outcome.CANCELLED
                        Step.GIVE_UP -> return Outcome.FAILED
                        Step.WAIT -> if (!awaitWritable(fd, POLL_STEP_MS)) idleMs += POLL_STEP_MS
                    }
                }
            }
        }
    }

    /** Wait up to `timeoutMs` for room in the pipe; a reader that is gone is an error. */
    private fun awaitWritable(fd: FileDescriptor, timeoutMs: Int): Boolean {
        val pollfd = StructPollfd().apply {
            this.fd = fd
            events = OsConstants.POLLOUT.toShort()
        }
        val ready = try {
            Os.poll(arrayOf(pollfd), timeoutMs)
        } catch (e: ErrnoException) {
            if (e.errno == OsConstants.EINTR) 0 else throw e
        }
        if (ready <= 0) return false
        val revents = pollfd.revents.toInt()
        if (revents and (OsConstants.POLLERR or OsConstants.POLLHUP or OsConstants.POLLNVAL) != 0) {
            throw IOException("the print service closed its end of the pipe")
        }
        return true
    }

    private fun scratchFile(): File {
        scratchDir.mkdirs()
        return File.createTempFile("page-", ".pdf", scratchDir)
    }

    /** Scratch files a print job that died with the process left behind. */
    private fun sweep() {
        val leftovers = scratchDir.listFiles() ?: return
        for (f in leftovers) if (System.currentTimeMillis() - f.lastModified() > SWEEP_AGE_MS) f.delete()
    }

    /** Our copy of the spooler's descriptor, the scratch file, and the descriptor the WebView writes it through. */
    private class Plumbing(
        val spool: ParcelFileDescriptor,
        val page: ParcelFileDescriptor,
        val file: File
    ) {
        /** The WebView threw out of `onWrite` and never took [page]. */
        @Volatile
        var refused = false

        companion object {
            /** Everything or nothing: a failure part-way closes what was opened and yields null. */
            fun open(destination: ParcelFileDescriptor, scratch: () -> File): Plumbing? {
                var spool: ParcelFileDescriptor? = null
                var file: File? = null
                return try {
                    spool = destination.dup()
                    file = scratch()
                    val page = ParcelFileDescriptor.open(
                        file,
                        ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_TRUNCATE
                    )
                    Plumbing(spool, page, file)
                } catch (e: Exception) {
                    Log.w(TAG, "print relay plumbing: $e")
                    spool?.let(::closeQuietly)
                    file?.delete()
                    null
                }
            }
        }
    }

    enum class Outcome { WRITTEN, CANCELLED, FAILED }

    /** What the relay does after a write attempt on the spooler's pipe. */
    enum class Step { CONTINUE, WAIT, CANCEL, GIVE_UP }

    /** What the relay does after a look at the scratch file: wait, hand it on, or drop it. */
    enum class Take { WAIT, DELIVER, DISCARD }

    companion object {
        private const val TAG = "ZenPrint"
        private const val BUFFER_SIZE = 64 * 1024

        private fun closeQuietly(fd: ParcelFileDescriptor) {
            runCatching { fd.close() }
        }
        /** How long one wait lasts – for room in the spooler's pipe, or between looks at the page file. */
        const val POLL_STEP_MS = 250
        /** A spooler that has taken nothing for this long has left its preview and will not be back. */
        const val IDLE_LIMIT_MS = 15_000L
        /**
         * How long the WebView keeps its descriptor after the framework closed its own without a
         * byte written: the session may have ended while the renderer was still laying the page
         * out, and its write is still to come.
         */
        const val WRITE_GRACE_MS = 60_000L
        private const val SWEEP_AGE_MS = 60 * 60 * 1000L

        /**
         * After an attempt that moved `written` bytes (0: the pipe was full): carry on, wait for
         * room, stop because the spooler `cancelled`, or give up after [IDLE_LIMIT_MS] without a
         * byte taken. Cancellation wins over everything; progress resets the idle clock.
         */
        fun nextStep(written: Int, cancelled: Boolean, idleMs: Long): Step = when {
            cancelled -> Step.CANCEL
            written > 0 -> Step.CONTINUE
            idleMs >= IDLE_LIMIT_MS -> Step.GIVE_UP
            else -> Step.WAIT
        }

        /**
         * After a look at the scratch file, `size` bytes long and `grew` since the last look:
         * while the framework still holds the descriptor it passed to `onWrite`
         * (`destinationClosed` false) the WebView has not reported and may yet write, so the relay
         * waits, whatever the file holds. Once the framework has closed it, a file that has stopped
         * growing is the whole page – delivered when the write is still `wanted` (not cancelled,
         * session not finished), dropped otherwise. A file still empty `closedForMs` after that
         * close waits for the renderer's write up to [WRITE_GRACE_MS], then is dropped.
         */
        fun takeStep(destinationClosed: Boolean, size: Long, grew: Boolean, closedForMs: Long, wanted: Boolean): Take = when {
            !destinationClosed -> Take.WAIT
            size > 0 && !grew -> if (wanted) Take.DELIVER else Take.DISCARD
            size == 0L && closedForMs >= WRITE_GRACE_MS -> Take.DISCARD
            else -> Take.WAIT
        }
    }
}
