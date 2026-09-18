package app.zen.chromium.ext

import androidx.core.app.NotificationCompat
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** The pure half of the shade: image resolution as Chrome does it, channel and card naming, priorities. */
class ExtensionNotificationsTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val id = "abcdefghijklmnopabcdefghijklmnop"
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

    @Test
    fun `a data URL decodes base64 or percent-encoded bytes`() {
        val base64 = java.util.Base64.getEncoder().encodeToString(png)
        assertArrayEquals(png, ExtensionNotifications.imageBytes(null, "data:image/png;base64,$base64"))
        assertArrayEquals("hi there".toByteArray(), ExtensionNotifications.imageBytes(null, "data:text/plain,hi%20there"))
        assertNull(ExtensionNotifications.imageBytes(null, "data:image/png;base64"))
    }

    @Test
    fun `a path resolves inside the extension's directory, in any of Chrome's spellings`() {
        val dir = folder.newFolder("ext")
        File(dir, "icons").mkdirs()
        File(dir, "icons/48.png").writeBytes(png)
        assertArrayEquals(png, ExtensionNotifications.imageBytes(dir, "icons/48.png"))
        assertArrayEquals(png, ExtensionNotifications.imageBytes(dir, "/icons/48.png"))
        assertArrayEquals(png, ExtensionNotifications.imageBytes(dir, "chrome-extension://$id/icons/48.png"))
        assertNull(ExtensionNotifications.imageBytes(dir, "icons/missing.png"))
        assertNull(ExtensionNotifications.imageBytes(dir, "icons"))
        assertNull(ExtensionNotifications.imageBytes(null, "icons/48.png"))
    }

    @Test
    fun `a path that escapes the directory and a remote URL are nothing`() {
        val dir = folder.newFolder("ext2")
        val outside = File(folder.root, "secret.png")
        outside.writeBytes(png)
        assertNull(ExtensionNotifications.imageBytes(dir, "../secret.png"))
        assertNull(ExtensionNotifications.imageBytes(dir, "/../secret.png"))
        assertNull(ExtensionNotifications.imageBytes(dir, "https://example.com/48.png"))
        assertNull(ExtensionNotifications.imageBytes(dir, "file:///etc/passwd"))
    }

    @Test
    fun `subsampling brings a large image near the ceiling and leaves a small one alone`() {
        assertEquals(1, ExtensionNotifications.sampleSize(200, 200, 256))
        assertEquals(1, ExtensionNotifications.sampleSize(512, 512, 256))
        assertEquals(2, ExtensionNotifications.sampleSize(1024, 300, 256))
        assertEquals(4, ExtensionNotifications.sampleSize(2000, 100, 256))
        assertEquals(8, ExtensionNotifications.sampleSize(4000, 100, 256))
        assertEquals(1, ExtensionNotifications.sampleSize(0, 0, 256))
    }

    @Test
    fun `channel and tag names carry the extension and the card`() {
        assertEquals("zenium.ext.$id", ExtensionNotifications.channelId(id))
        assertEquals("zenium.ext/$id/n1", ExtensionNotifications.tag(id, "n1"))
        assertNotEquals(ExtensionNotifications.tag(id, "n1"), ExtensionNotifications.tag("ponmlkjihgfedcbaponmlkjihgfedcba", "n1"))
    }

    @Test
    fun `Chrome's priorities map onto the compat ones`() {
        assertEquals(NotificationCompat.PRIORITY_MAX, ExtensionNotifications.priority(2))
        assertEquals(NotificationCompat.PRIORITY_HIGH, ExtensionNotifications.priority(1))
        assertEquals(NotificationCompat.PRIORITY_DEFAULT, ExtensionNotifications.priority(0))
        assertEquals(NotificationCompat.PRIORITY_LOW, ExtensionNotifications.priority(-1))
        assertEquals(NotificationCompat.PRIORITY_MIN, ExtensionNotifications.priority(-2))
        assertEquals(NotificationCompat.PRIORITY_MAX, ExtensionNotifications.priority(7))
    }
}
