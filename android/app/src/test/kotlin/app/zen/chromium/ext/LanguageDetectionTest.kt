package app.zen.chromium.ext

import app.zen.chromium.ext.LanguageDetection.Hypothesis
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** `ext.i18n.detectLanguage`: the classifier's hypotheses in Chrome's `i18n.detectLanguage` shape. */
class LanguageDetectionTest {
    @Test
    fun ranksTheClassifierGuessesAsBareCodesWithPercentages() {
        val out = LanguageDetection.toChrome(
            listOf(
                Hypothesis("en-US", 0.06f),
                Hypothesis("de-DE", 0.92f),
                Hypothesis("und", 0.02f),
                Hypothesis("nl", 0.0f),
                Hypothesis("fr", 0.004f),
                Hypothesis("da", 0.001f)
            )
        )
        assertTrue(out.getBoolean("isReliable"))
        val languages = out.getJSONArray("languages")
        assertEquals(3, languages.length())
        assertEquals("de", languages.getJSONObject(0).getString("language"))
        assertEquals(92, languages.getJSONObject(0).getInt("percentage"))
        assertEquals("en", languages.getJSONObject(1).getString("language"))
        assertEquals(6, languages.getJSONObject(1).getInt("percentage"))
        assertEquals("fr", languages.getJSONObject(2).getString("language"))
        assertEquals(0, languages.getJSONObject(2).getInt("percentage"))
    }

    @Test
    fun aGuessBelowTheThresholdIsNotReliableAndNothingIsAnEmptyList() {
        val unsure = LanguageDetection.toChrome(listOf(Hypothesis("es", 0.55f), Hypothesis("pt", 0.45f)))
        assertFalse(unsure.getBoolean("isReliable"))
        assertEquals(2, unsure.getJSONArray("languages").length())
        assertEquals("es", unsure.getJSONArray("languages").getJSONObject(0).getString("language"))

        val none = LanguageDetection.NONE
        assertFalse(none.getBoolean("isReliable"))
        assertEquals(0, none.getJSONArray("languages").length())

        val onlyUnknown = LanguageDetection.toChrome(listOf(Hypothesis("und", 1f), Hypothesis("", 0.9f)))
        assertFalse(onlyUnknown.getBoolean("isReliable"))
        assertEquals(0, onlyUnknown.getJSONArray("languages").length())
    }

    @Test
    fun reducesATagToItsLanguage() {
        assertEquals("en", LanguageDetection.languageOf("en-US"))
        assertEquals("zh", LanguageDetection.languageOf("zh_Hant_TW"))
        assertEquals("ast", LanguageDetection.languageOf(" AST "))
        assertEquals("und", LanguageDetection.languageOf(""))
        assertEquals("und", LanguageDetection.languageOf("x-klingon"))
        assertEquals("und", LanguageDetection.languageOf("1234"))
    }

    @Test
    fun theSampleIsTheTrimmedLeadingPart() {
        assertEquals("", LanguageDetection.sampleOf("  \n\t "))
        assertEquals("Hallo Welt", LanguageDetection.sampleOf("  Hallo Welt  "))
        val long = "a".repeat(LanguageDetection.SAMPLE_CHARS + 500)
        assertEquals(LanguageDetection.SAMPLE_CHARS, LanguageDetection.sampleOf(long).length)
    }
}
