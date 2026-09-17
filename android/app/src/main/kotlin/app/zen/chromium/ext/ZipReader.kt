package app.zen.chromium.ext

import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Inflater

/**
 * A random-access zip reader over a package file, for unpacking store downloads and sideloaded
 * archives straight from disk into the install directory. The zip may start at an offset inside
 * the file (a CRX3 is a header followed by a zip). Only the central directory is trusted for
 * sizes, methods and CRCs, and every entry written is checked against them, so a package whose
 * data disagrees with its directory is refused rather than half-installed. Deflate and stored
 * entries; no encryption, no zip64 (the TypeScript core, which read the same bytes first, draws
 * the same lines).
 */
class ZipReader(private val file: RandomAccessFile, private val zipOffset: Long) : AutoCloseable {
    class Entry(
        /** The name as the archive spells it, with backslashes turned into slashes. */
        val name: String,
        val method: Int,
        val crc32: Long,
        val compressedSize: Long,
        val size: Long,
        val localHeaderOffset: Long,
        val encrypted: Boolean
    )

    val entries: List<Entry>
    private val byName: Map<String, Entry>

    init {
        require(zipOffset >= 0 && zipOffset <= file.length()) { "zip offset $zipOffset is outside the file" }
        entries = readCentralDirectory()
        byName = HashMap<String, Entry>(entries.size).also { map ->
            for (entry in entries) map.putIfAbsent(entry.name, entry)
        }
    }

    /** An entry by its normalised name (forward slashes), or null. */
    operator fun get(name: String): Entry? = byName[name]

    /**
     * Writes an entry's contents to `out`, inflating deflated entries, and checks that the size
     * and CRC-32 match the central directory. `maxBytes` caps the inflated output as a defence
     * against a directory that lies about its sizes.
     */
    fun copyTo(entry: Entry, out: OutputStream, maxBytes: Long = entry.size) {
        if (entry.encrypted) throw ZipFormatException("${entry.name} is encrypted")
        val dataStart = dataOffset(entry)
        val crc = CRC32()
        var written = 0L
        when (entry.method) {
            METHOD_STORED -> {
                if (entry.compressedSize != entry.size) throw ZipFormatException("${entry.name}: stored entry sizes differ")
                val buffer = ByteArray(BUFFER_SIZE)
                var remaining = entry.compressedSize
                var position = dataStart
                while (remaining > 0) {
                    val n = readAt(position, buffer, minOf(remaining, buffer.size.toLong()).toInt())
                    if (n <= 0) throw ZipFormatException("${entry.name}: archive ends inside the entry")
                    written += n
                    if (written > maxBytes) throw ZipFormatException("${entry.name} is larger than declared")
                    crc.update(buffer, 0, n)
                    out.write(buffer, 0, n)
                    position += n
                    remaining -= n
                }
            }
            METHOD_DEFLATED -> {
                val inflater = Inflater(true)
                try {
                    val input = ByteArray(BUFFER_SIZE)
                    val output = ByteArray(BUFFER_SIZE)
                    var remaining = entry.compressedSize
                    var position = dataStart
                    while (!inflater.finished()) {
                        if (inflater.needsInput()) {
                            if (remaining <= 0) throw ZipFormatException("${entry.name}: deflate stream ends early")
                            val n = readAt(position, input, minOf(remaining, input.size.toLong()).toInt())
                            if (n <= 0) throw ZipFormatException("${entry.name}: archive ends inside the entry")
                            inflater.setInput(input, 0, n)
                            position += n
                            remaining -= n
                        }
                        val n = try {
                            inflater.inflate(output)
                        } catch (e: DataFormatException) {
                            throw ZipFormatException("${entry.name}: ${e.message ?: "corrupt deflate stream"}")
                        }
                        if (n == 0 && inflater.needsDictionary()) throw ZipFormatException("${entry.name} needs a preset dictionary")
                        if (n > 0) {
                            written += n
                            if (written > maxBytes) throw ZipFormatException("${entry.name} is larger than declared")
                            crc.update(output, 0, n)
                            out.write(output, 0, n)
                        }
                    }
                } finally {
                    inflater.end()
                }
            }
            else -> throw ZipFormatException("${entry.name} uses compression method ${entry.method}")
        }
        if (written != entry.size) throw ZipFormatException("${entry.name}: ${written} bytes, ${entry.size} declared")
        if (crc.value != entry.crc32) throw ZipFormatException("${entry.name}: CRC-32 mismatch")
    }

    /** Where the entry's data starts: past its local header, whose name and extra lengths are its own. */
    private fun dataOffset(entry: Entry): Long {
        val header = ByteBuffer.wrap(readExactly(zipOffset + entry.localHeaderOffset, LOCAL_HEADER_LENGTH)).order(ByteOrder.LITTLE_ENDIAN)
        if (header.getInt(0) != SIG_LOCAL_HEADER) throw ZipFormatException("${entry.name}: bad local header")
        val nameLength = header.getShort(26).toInt() and 0xffff
        val extraLength = header.getShort(28).toInt() and 0xffff
        return zipOffset + entry.localHeaderOffset + LOCAL_HEADER_LENGTH + nameLength + extraLength
    }

    private fun readCentralDirectory(): List<Entry> {
        val length = file.length() - zipOffset
        if (length < EOCD_LENGTH) throw ZipFormatException("too short to be a zip")
        // The end-of-central-directory record sits at the end, behind an optional comment.
        val tailLength = minOf(length, (EOCD_LENGTH + MAX_COMMENT_LENGTH).toLong()).toInt()
        val tail = readExactly(zipOffset + length - tailLength, tailLength)
        val tailBuffer = ByteBuffer.wrap(tail).order(ByteOrder.LITTLE_ENDIAN)
        var eocd = -1
        var i = tailLength - EOCD_LENGTH
        while (i >= 0) {
            if (tailBuffer.getInt(i) == SIG_EOCD) {
                val commentLength = tailBuffer.getShort(i + 20).toInt() and 0xffff
                if (i + EOCD_LENGTH + commentLength == tailLength) {
                    eocd = i
                    break
                }
            }
            i--
        }
        if (eocd < 0) throw ZipFormatException("no end-of-central-directory record")
        val count = tailBuffer.getShort(eocd + 10).toInt() and 0xffff
        val directorySize = tailBuffer.getInt(eocd + 12).toLong() and 0xffffffffL
        val directoryOffset = tailBuffer.getInt(eocd + 16).toLong() and 0xffffffffL
        if (count == 0xffff || directorySize == 0xffffffffL || directoryOffset == 0xffffffffL) {
            throw ZipFormatException("zip64 archives are not supported")
        }
        if (directoryOffset + directorySize > length) throw ZipFormatException("central directory is outside the file")
        val directory = ByteBuffer.wrap(readExactly(zipOffset + directoryOffset, directorySize.toInt())).order(ByteOrder.LITTLE_ENDIAN)
        val list = ArrayList<Entry>(count)
        var position = 0
        for (index in 0 until count) {
            if (position + CENTRAL_HEADER_LENGTH > directory.limit()) throw ZipFormatException("central directory is truncated")
            if (directory.getInt(position) != SIG_CENTRAL_HEADER) throw ZipFormatException("bad central directory header")
            val flags = directory.getShort(position + 8).toInt() and 0xffff
            val method = directory.getShort(position + 10).toInt() and 0xffff
            val crc = directory.getInt(position + 16).toLong() and 0xffffffffL
            val compressedSize = directory.getInt(position + 20).toLong() and 0xffffffffL
            val size = directory.getInt(position + 24).toLong() and 0xffffffffL
            val nameLength = directory.getShort(position + 28).toInt() and 0xffff
            val extraLength = directory.getShort(position + 30).toInt() and 0xffff
            val commentLength = directory.getShort(position + 32).toInt() and 0xffff
            val localHeaderOffset = directory.getInt(position + 42).toLong() and 0xffffffffL
            val nameStart = position + CENTRAL_HEADER_LENGTH
            if (nameStart + nameLength > directory.limit()) throw ZipFormatException("central directory is truncated")
            val nameBytes = ByteArray(nameLength)
            directory.position(nameStart)
            directory.get(nameBytes)
            directory.position(0)
            if (compressedSize == 0xffffffffL || size == 0xffffffffL || localHeaderOffset == 0xffffffffL) {
                throw ZipFormatException("zip64 entries are not supported")
            }
            if (localHeaderOffset >= length) throw ZipFormatException("entry $index points outside the file")
            list.add(
                Entry(
                    name = String(nameBytes, Charsets.UTF_8).replace('\\', '/'),
                    method = method,
                    crc32 = crc,
                    compressedSize = compressedSize,
                    size = size,
                    localHeaderOffset = localHeaderOffset,
                    encrypted = flags and FLAG_ENCRYPTED != 0
                )
            )
            position = nameStart + nameLength + extraLength + commentLength
        }
        return list
    }

    private fun readExactly(position: Long, length: Int): ByteArray {
        val bytes = ByteArray(length)
        var done = 0
        while (done < length) {
            val n = readAt(position + done, bytes, length - done, done)
            if (n <= 0) throw ZipFormatException("archive is truncated")
            done += n
        }
        return bytes
    }

    private fun readAt(position: Long, into: ByteArray, length: Int, offset: Int = 0): Int {
        file.seek(position)
        return file.read(into, offset, length)
    }

    override fun close() = file.close()

    /** The archive is not a zip this reader accepts, or an entry's bytes disagree with its directory. */
    class ZipFormatException(message: String) : IOException(message)

    companion object {
        const val METHOD_STORED = 0
        const val METHOD_DEFLATED = 8
        private const val SIG_LOCAL_HEADER = 0x04034b50
        private const val SIG_CENTRAL_HEADER = 0x02014b50
        private const val SIG_EOCD = 0x06054b50
        private const val EOCD_LENGTH = 22
        private const val MAX_COMMENT_LENGTH = 0xffff
        private const val CENTRAL_HEADER_LENGTH = 46
        private const val LOCAL_HEADER_LENGTH = 30
        private const val FLAG_ENCRYPTED = 0x0001
        private const val BUFFER_SIZE = 64 * 1024

        /** Opens a package file and reads its central directory; closing the reader closes the file. */
        fun open(file: File, zipOffset: Long): ZipReader {
            val raf = RandomAccessFile(file, "r")
            try {
                return ZipReader(raf, zipOffset)
            } catch (e: Exception) {
                raf.close()
                throw e
            }
        }

        /**
         * Where the zip begins inside a CRX3 file: the 16-byte header (`Cr24`, version 3, header
         * length) plus the protobuf header it announces. Zero for a plain zip.
         */
        fun crxZipOffset(file: RandomAccessFile): Long {
            if (file.length() < 16) return 0
            val head = ByteBuffer.wrap(ByteArray(16).also { file.seek(0); file.readFully(it) }).order(ByteOrder.LITTLE_ENDIAN)
            if (head.getInt(0) != CRX_MAGIC) return 0
            if (head.getInt(4) != 3) throw ZipFormatException("only CRX3 packages are supported")
            return 16L + (head.getInt(8).toLong() and 0xffffffffL)
        }

        /** `Cr24` as a little-endian int. */
        private const val CRX_MAGIC = 0x34327243
    }
}
