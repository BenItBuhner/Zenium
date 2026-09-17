package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ByteBudgetLruTest {
    /** Values are their own size, in bytes. */
    private fun lru(budget: Long) = ByteBudgetLru<Long>(budget) { it }

    @Test
    fun evictsTheLeastRecentlyUsedOnceOverBudget() {
        val cache = lru(100)
        cache.put("a", 40)
        cache.put("b", 40)
        cache.put("c", 40) // 120 > 100: "a" goes
        assertNull(cache.get("a"))
        assertNotNull(cache.get("b"))
        assertNotNull(cache.get("c"))
        assertEquals(80, cache.bytes)
    }

    @Test
    fun aLookupCountsAsAUse() {
        val cache = lru(100)
        cache.put("a", 40)
        cache.put("b", 40)
        cache.get("a")
        cache.put("c", 40) // "b" is now the least recently used
        assertNotNull(cache.get("a"))
        assertNull(cache.get("b"))
    }

    @Test
    fun replacingAKeyAccountsForBothSizes() {
        val cache = lru(100)
        cache.put("a", 30)
        cache.put("a", 50)
        assertEquals(50, cache.bytes)
        assertEquals(1, cache.size)
    }

    @Test
    fun anOversizedNewcomerIsKeptAlone() {
        val cache = lru(100)
        cache.put("a", 40)
        cache.put("big", 400)
        assertNull(cache.get("a"))
        assertEquals(400L, cache.get("big"))
        assertEquals(1, cache.size)
    }

    @Test
    fun removeIfAndClearKeepTheByteCountHonest() {
        val cache = lru(1000)
        cache.put("t1#0", 10)
        cache.put("t1#1", 20)
        cache.put("t2#0", 30)
        cache.removeIf { it < 25 }
        assertEquals(30, cache.bytes)
        assertEquals(1, cache.size)
        cache.clear()
        assertEquals(0, cache.bytes)
        assertEquals(0, cache.size)
    }
}
