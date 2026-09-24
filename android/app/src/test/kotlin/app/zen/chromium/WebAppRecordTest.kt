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
    fun aStartUrlTheWebViewWouldCommitWithABarInItsQueryInstalls() {
        // `java.net.URI` read this start URL as no URL and the install fell back to a plain tab.
        val record = WebAppRecord.fromRequest(request("url" to "https://app.example/app/?view=a|b"), "Example")
        assertNotNull(record)
        assertEquals("https://app.example/app/?view=a|b", record!!.startUrl)
    }

    /** [WebAppRecord.fromIntent] over a map standing in for the intent's extras (`Intent` is a stub on the JVM). */
    private fun fromExtras(extras: Map<String, Any>): WebAppRecord? =
        WebAppRecord.fromExtras(string = { extras[it] as? String }, int = { extras[it] as? Int })

    @Test
    fun theRecordRoundTripsThroughItsIntentExtras() {
        val record = WebAppRecord.fromRequest(request("display" to "fullscreen", "backgroundColor" to null), "Example")!!
        val extras = record.extras()
        assertEquals(
            setOf(WebAppRecord.EXTRA_ID, WebAppRecord.EXTRA_NAME, WebAppRecord.EXTRA_START_URL, WebAppRecord.EXTRA_SCOPE, WebAppRecord.EXTRA_DISPLAY, WebAppRecord.EXTRA_THEME_COLOR),
            extras.keys
        )
        assertEquals("fullscreen", extras[WebAppRecord.EXTRA_DISPLAY])
        assertEquals(0xff0080ff.toInt(), extras[WebAppRecord.EXTRA_THEME_COLOR])
        val back = fromExtras(extras)!!
        assertEquals(record.id, back.id)
        assertEquals("Example", back.name)
        assertEquals(record.startUrl, back.startUrl)
        assertEquals(record.scope, back.scope)
        assertEquals(WebAppRules.Display.FULLSCREEN, back.display)
        assertEquals(record.themeColor, back.themeColor)
        assertNull(back.backgroundColor)
    }

    @Test
    fun anIntentWithoutARecordOrOfABrowserAppReadsAsNone() {
        val record = WebAppRecord.fromRequest(request(), "Example")!!
        // A tile pinned before the record existed carries the page URL alone.
        assertNull(fromExtras(emptyMap()))
        assertNull(fromExtras(record.extras() - WebAppRecord.EXTRA_SCOPE))
        assertNull(fromExtras(record.extras() - WebAppRecord.EXTRA_START_URL))
        assertNull(fromExtras(record.extras() + (WebAppRecord.EXTRA_DISPLAY to "browser")))
        assertNull(fromExtras(record.extras() + (WebAppRecord.EXTRA_ID to "")))
        assertNull(WebAppRecord.fromIntent(null))
        // A name the extras lost falls back to the start URL: the window has a task label either way.
        assertEquals(record.startUrl, fromExtras(record.extras() + (WebAppRecord.EXTRA_NAME to " "))!!.name)
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
