package app.zen.chromium

import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
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
import java.io.FileOutputStream
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
 * So the WebView writes into a pipe of ours that is pumped into a scratch file as fast as it
 * writes, which never waits on the spooler, and the relay then moves the file into the spooler's
 * descriptor on a background thread: without blocking (a full pipe is polled for a while, not
 * waited on for ever), stopping at the spooler's cancellation, and giving up when the spooler
 * has not taken a byte for [IDLE_LIMIT_MS]. The spooler learns of the WebView's `onWriteFinished`
 * as before, but keeps its file under a mutex until its end of the pipe reaches EOF, which is
 * when the relay closes its own copy of the descriptor – so the preview never reads a document
 * that is still arriving.
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
            // No pipe or scratch file to be had: print the way the platform does, stall and all.
            Log.w(TAG, "no plumbing for the print relay; the page writes straight to the spooler")
            delegate.onWrite(pages, destination, cancellationSignal, callback)
            return
        }
        io.execute { relay(plumbing.source, plumbing.file, plumbing.spool, cancellationSignal) }
        val sink = plumbing.sink
        try {
            delegate.onWrite(pages, sink, cancellationSignal, callback)
        } finally {
            // The WebView detaches the descriptor it writes to; one it never took (nothing to
            // print, an exception) is closed here so the pump sees its end of the pipe.
            if (runCatching { sink.fd }.isSuccess) closeQuietly(sink)
        }
    }

    override fun onFinish() {
        finished = true
        delegate.onFinish()
    }

    /** Pump the WebView's pipe into the scratch file, then move the file into the spooler's pipe. */
    private fun relay(source: ParcelFileDescriptor, file: File, spool: ParcelFileDescriptor, signal: CancellationSignal) {
        try {
            val pumped = runCatching { pump(source, file) }.getOrElse { e ->
                Log.w(TAG, "print relay could not take the page: $e")
                false
            }
            val outcome = if (!pumped) Outcome.FAILED else runCatching { forward(file, spool, signal) }.getOrElse { e ->
                Log.w(TAG, "print relay could not hand the page to the spooler: $e")
                Outcome.FAILED
            }
            if (outcome != Outcome.WRITTEN) Log.i(TAG, "print relay ended: $outcome")
        } finally {
            closeQuietly(source)
            closeQuietly(spool)
            file.delete()
        }
    }

    /** Drain the WebView's writes into the scratch file until it closes its end; true on EOF. */
    private fun pump(source: ParcelFileDescriptor, file: File): Boolean {
        FileInputStream(source.fileDescriptor).use { input ->
            FileOutputStream(file).use { output ->
                val buffer = ByteArray(BUFFER_SIZE)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) return true
                    output.write(buffer, 0, n)
                }
            }
        }
    }

    /** Move the scratch file into the spooler's descriptor, without ever blocking on it. */
    private fun forward(file: File, spool: ParcelFileDescriptor, signal: CancellationSignal): Outcome {
        val fd = spool.fileDescriptor
        val flags = Os.fcntlInt(fd, OsConstants.F_GETFL, 0)
        Os.fcntlInt(fd, OsConstants.F_SETFL, flags or OsConstants.O_NONBLOCK)
        val buffer = ByteArray(BUFFER_SIZE)
        FileInputStream(file).use { input ->
            while (true) {
                val n = input.read(buffer)
                if (n < 0) return Outcome.WRITTEN
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

    /** Our copy of the spooler's descriptor, the pipe the WebView writes into, and the scratch file. */
    private class Plumbing(
        val spool: ParcelFileDescriptor,
        val source: ParcelFileDescriptor,
        val sink: ParcelFileDescriptor,
        val file: File
    ) {
        companion object {
            /** Everything or nothing: a failure part-way closes what was opened and yields null. */
            fun open(destination: ParcelFileDescriptor, scratch: () -> File): Plumbing? {
                var spool: ParcelFileDescriptor? = null
                var pipe: Array<ParcelFileDescriptor>? = null
                return try {
                    spool = destination.dup()
                    pipe = ParcelFileDescriptor.createPipe()
                    Plumbing(spool, pipe[0], pipe[1], scratch())
                } catch (e: Exception) {
                    Log.w(TAG, "print relay plumbing: $e")
                    spool?.let(::closeQuietly)
                    pipe?.forEach(::closeQuietly)
                    null
                }
            }
        }
    }

    enum class Outcome { WRITTEN, CANCELLED, FAILED }

    /** What the relay does after a write attempt. */
    enum class Step { CONTINUE, WAIT, CANCEL, GIVE_UP }

    companion object {
        private const val TAG = "ZenPrint"
        private const val BUFFER_SIZE = 64 * 1024

        private fun closeQuietly(fd: ParcelFileDescriptor) {
            runCatching { fd.close() }
        }
        /** How long one wait for room in the spooler's pipe lasts before cancellation is looked at again. */
        const val POLL_STEP_MS = 250
        /** A spooler that has taken nothing for this long has left its preview and will not be back. */
        const val IDLE_LIMIT_MS = 15_000L
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
    }
}
