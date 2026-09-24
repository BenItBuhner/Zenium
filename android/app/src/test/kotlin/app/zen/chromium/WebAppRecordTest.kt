package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class WebAppRecordTest {
    private fun request(vararg extra: Pair<String, Any?>): JSONObject = json(
        "id" to "https://app.example/app/",
        "url" to "https://app.example/app/",
        "display" to "standalone",
        "scope" to "https://app.example/app/",
        "themeColor" to "#0080ff",
        "backgroundColor" to "#fff",
        *extra
    )

    @Test
    fun aStandaloneInstallBecomesARecord() {
        val record = WebAppRecord.fromRequest(request(), "Example")
        assertNotNull(record)
        record!!
        assertEquals("Example", record.name)
        assertEquals(WebAppRules.Display.STANDALONE, record.display)
        assertEquals("https://app.example/app/", record.scope)
        assertEquals(0xff0080ff.toInt(), record.themeColor)
        assertEquals(0xffffffff.toInt(), record.backgroundColor)
        assertEquals(Shortcuts.shortcutId("https://app.example/app/"), record.shortcutId)
    }

    @Test
    fun coloursTheManifestLeavesOutStayNull() {
        val record = WebAppRecord.fromRequest(request("themeColor" to null, "backgroundColor" to null), "Example")!!
        assertNull(record.themeColor)
        assertNull(record.backgroundColor)
    }

    @Test
    fun aPlainPageShortcutAndABrowserAppAreNoRecord() {
        // No manifest: the core's request carries neither display nor scope.
        assertNull(WebAppRecord.fromRequest(json("id" to "https://page.example/", "url" to "https://page.example/"), "Page"))
        assertNull(WebAppRecord.fromRequest(request("display" to "browser"), "Example"))
        assertNull(WebAppRecord.fromRequest(request("display" to "window-controls-overlay"), "Example"))
        assertNull(WebAppRecord.fromRequest(request("scope" to ""), "Example"))
    }

    @Test
    fun aStartUrlOutsideItsOwnScopeIsNoRecord() {
        assertNull(WebAppRecord.fromRequest(request("url" to "https://app.example/elsewhere/"), "Example"))
    }

    @Test
    fun theRecordRoundTripsThroughItsFile() {
        val record = WebAppRecord.fromRequest(request("display" to "fullscreen", "backgroundColor" to null), "Example")!!
        val back = WebAppRecord.fromJson(JSONObject(record.toJson().toString()))!!
        assertEquals(record.id, back.id)
        assertEquals(record.name, back.name)
        assertEquals(record.startUrl, back.startUrl)
        assertEquals(record.scope, back.scope)
        assertEquals(WebAppRules.Display.FULLSCREEN, back.display)
        assertEquals(record.themeColor, back.themeColor)
        assertNull(back.backgroundColor)
    }

    @Test
    fun aFileOfABrowserAppOrWithoutAScopeReadsAsNone() {
        assertNull(WebAppRecord.fromJson(json("id" to "x", "startUrl" to "https://a.example/", "scope" to "https://a.example/", "display" to "browser")))
        assertNull(WebAppRecord.fromJson(json("id" to "x", "startUrl" to "https://a.example/", "display" to "standalone")))
    }
}
