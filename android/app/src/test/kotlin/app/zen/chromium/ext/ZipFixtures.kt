package app.zen.chromium.ext

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Archives for the store tests: built with the JDK's writer, so the reader is tested against another implementation. */
object ZipFixtures {
    class Member(val name: String, val bytes: ByteArray, val stored: Boolean = false)

    fun zip(vararg members: Member): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            for (member in members) {
                val entry = ZipEntry(member.name)
                if (member.stored) {
                    entry.method = ZipEntry.STORED
                    entry.size = member.bytes.size.toLong()
                    entry.compressedSize = member.bytes.size.toLong()
                    entry.crc = CRC32().also { it.update(member.bytes) }.value
                }
                zip.putNextEntry(entry)
                zip.write(member.bytes)
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    /** A CRX3 shell around a zip: `Cr24`, version 3, the header length, `headerBytes` of opaque header, then the zip. */
    fun crx(zip: ByteArray, headerBytes: Int): ByteArray {
        val head = ByteBuffer.allocate(16 + headerBytes).order(ByteOrder.LITTLE_ENDIAN)
        head.put("Cr24".toByteArray(Charsets.US_ASCII))
        head.putInt(3)
        head.putInt(headerBytes)
        // Filler so a reader that ignored the offset would find no zip at 16.
        for (i in 0 until headerBytes) head.put((i and 0xff).toByte())
        return head.array() + zip
    }

    /** Sets the encryption bit in the general-purpose flags of every central directory header. */
    fun markEncrypted(zip: ByteArray): ByteArray {
        val out = zip.copyOf()
        var i = 0
        while (i + 4 <= out.size) {
            if (out[i] == 0x50.toByte() && out[i + 1] == 0x4b.toByte() && out[i + 2] == 0x01.toByte() && out[i + 3] == 0x02.toByte()) {
                out[i + 8] = (out[i + 8].toInt() or 0x01).toByte()
            }
            i++
        }
        return out
    }

    fun tempDir(prefix: String): File = File.createTempFile(prefix, "").also { it.delete(); it.mkdirs() }

    fun write(dir: File, name: String, bytes: ByteArray): File = File(dir, name).also { it.writeBytes(bytes) }
}
