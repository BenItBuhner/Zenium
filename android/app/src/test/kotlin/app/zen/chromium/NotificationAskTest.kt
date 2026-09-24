package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * NOT-03: Android 13's notification permission is asked ONCE for the whole app – on a site's first
 * grant, before the first download or an extension's first card, whichever comes first – and never
 * a second time; everyone who arrives while the prompt is up shares its answer.
 */
class NotificationAskTest {
    private var asked = false
    private val ask = NotificationAsk(askedBefore = { asked }, markAsked = { asked = true })
    private val answers = ArrayList<String>()

    private fun caller(name: String): (Boolean) -> Unit = { answers += "$name:$it" }

    @Test
    fun withoutAPromptToFaceTheSystemSwitchAnswersAtOnce() {
        assertFalse(ask.arrive(needsPrompt = false, allowed = true, then = caller("web")))
        assertFalse(ask.arrive(needsPrompt = false, allowed = false, then = caller("download")))
        assertEquals(listOf("web:true", "download:false"), answers)
        assertFalse("nothing to remember: no prompt was shown", asked)
    }

    @Test
    fun theFirstCallerShowsThePromptAndItsAnswerReachesEveryoneWhoArrivedMeanwhile() {
        assertTrue(ask.arrive(needsPrompt = true, allowed = false, then = caller("web")))
        assertTrue("the ask is spent the moment the prompt goes up", asked)
        assertFalse("a download arriving under the prompt joins it, no second prompt", ask.arrive(true, false, caller("download")))
        assertFalse(ask.arrive(true, false, caller("extension")))
        assertEquals("nobody is answered before the prompt is", emptyList<String>(), answers)

        ask.settle(true)
        assertEquals(listOf("web:true", "download:true", "extension:true"), answers)
    }

    @Test
    fun aRefusalIsSharedTooAndNobodyAsksASecondTime() {
        ask.arrive(needsPrompt = true, allowed = false, then = caller("download"))
        ask.arrive(needsPrompt = true, allowed = false, then = caller("web"))
        ask.settle(false)
        assertEquals(listOf("download:false", "web:false"), answers)

        assertFalse("the one ask is spent: a later grant gets no prompt", ask.arrive(true, false, caller("web again")))
        assertEquals(listOf("download:false", "web:false", "web again:false"), answers)
    }

    @Test
    fun anInstallThatAskedBeforeNeverAsksAgainEvenInANewProcess() {
        asked = true
        val fresh = NotificationAsk(askedBefore = { asked }, markAsked = { asked = true })
        assertFalse(fresh.arrive(needsPrompt = true, allowed = false, then = caller("web")))
        assertEquals(listOf("web:false"), answers)
    }

    @Test
    fun oncePermissionIsHeldNoAskIsRememberedAgainstTheInstall() {
        assertFalse(ask.arrive(needsPrompt = false, allowed = true, then = caller("web")))
        assertFalse(asked)
        ask.settle(true)
        assertEquals("a settle with nobody waiting is nothing", listOf("web:true"), answers)
    }
}
