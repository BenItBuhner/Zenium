package app.zen.chromium

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test

class BrowsingDataTest {
    @Test
    fun plansTheOneShotDeleteWhenCookiesAndStorageGoTogether() {
        assertEquals(
            listOf(BrowsingData.Step.ALL_SITE_DATA, BrowsingData.Step.CACHE),
            BrowsingData.plan(setOf("cookies", "storage", "cache"), oneShotDelete = true)
        )
        assertEquals(listOf(BrowsingData.Step.ALL_SITE_DATA), BrowsingData.plan(setOf("storage", "cookies"), oneShotDelete = true))
    }

    @Test
    fun fallsBackToTheSeparateCallsWithoutItOrForOneKind() {
        assertEquals(
            listOf(BrowsingData.Step.COOKIES, BrowsingData.Step.STORAGE, BrowsingData.Step.CACHE),
            BrowsingData.plan(setOf("cookies", "storage", "cache"), oneShotDelete = false)
        )
        assertEquals(listOf(BrowsingData.Step.COOKIES), BrowsingData.plan(setOf("cookies"), oneShotDelete = true))
        assertEquals(listOf(BrowsingData.Step.STORAGE), BrowsingData.plan(setOf("storage"), oneShotDelete = true))
        assertEquals(listOf(BrowsingData.Step.CACHE), BrowsingData.plan(setOf("cache"), oneShotDelete = true))
        assertEquals(emptyList<BrowsingData.Step>(), BrowsingData.plan(setOf("history"), oneShotDelete = true))
        assertEquals(emptyList<BrowsingData.Step>(), BrowsingData.plan(emptySet(), oneShotDelete = false))
    }

    @Test
    fun countsSitesNotOriginsAndSkipsWhatIsNotAnOrigin() {
        val origins = listOf(
            "https://mail.google.com",
            "https://www.google.com:443",
            "http://google.com",
            "https://news.bbc.co.uk",
            "https://bbc.co.uk",
            "https://192.168.0.1:8080",
            "file://",
            "garbage"
        )
        assertEquals(3, BrowsingData.siteCount(origins))
        assertEquals(0, BrowsingData.siteCount(emptyList()))
    }

    @Test
    fun readsStringArraysAndDropsBlanks() {
        assertEquals(listOf("default", "work"), BrowsingData.strings(JSONArray().put("default").put("").put("work")))
        assertEquals(emptyList<String>(), BrowsingData.strings(JSONArray()))
    }
}
