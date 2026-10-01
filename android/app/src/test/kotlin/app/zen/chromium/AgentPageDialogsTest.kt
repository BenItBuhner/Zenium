package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The shapes of an agent's page dialogs (`AgentPageDialogs`, OS-40 part B): the `pageDialog`
 * event the core reads as its `PageDialogRequest`, and the `view.pageDialogAnswer` word it
 * sends back – accept with a prompt's text, dismiss, or `user` for a tab that is not an agent's.
 */
class AgentPageDialogsTest {
    @Test
    fun theEventCarriesTheCoresRequestUnderTheDialogId() {
        val event = AgentPageDialogs.event("pd_1", PageDialogKind.PROMPT, "https://ads.example.net/f", "https://example.com/p", "Name?", "Ada")!!
        assertEquals("pd_1", event.getString("dialogId"))
        assertEquals("prompt", event.getString("kind"))
        assertEquals("Name?", event.getString("message"))
        assertEquals("Ada", event.getString("defaultValue"))
        assertEquals("https://ads.example.net/f", event.getString("frameUrl"))
        assertEquals("https://example.com/p", event.getString("pageUrl"))
    }

    @Test
    fun onlyAPromptCarriesADefault() {
        val confirm = AgentPageDialogs.event("pd_2", PageDialogKind.CONFIRM, "u", "u", "Sure?", "ignored")!!
        assertEquals("confirm", confirm.getString("kind"))
        assertEquals("", confirm.getString("defaultValue"))
        assertEquals("alert", AgentPageDialogs.event("pd_3", PageDialogKind.ALERT, "u", "u", "hi", "ignored")!!.getString("kind"))
    }

    @Test
    fun aBeforeunloadIsNeverRouted() {
        assertNull(AgentPageDialogs.event("pd_4", PageDialogKind.LEAVE, "u", "u", "", ""))
        assertNull(AgentPageDialogs.event("pd_5", PageDialogKind.RELOAD, "u", "u", "", ""))
        assertNull(AgentPageDialogs.kindName(PageDialogKind.LEAVE))
    }

    @Test
    fun theWordUserHandsTheDialogToZeniumsSheet() {
        assertEquals(AgentPageDialogs.Answer.User, AgentPageDialogs.answer(json("user" to true), PageDialogKind.CONFIRM))
        // Whatever else the answer says.
        assertEquals(AgentPageDialogs.Answer.User, AgentPageDialogs.answer(json("user" to true, "accepted" to true), PageDialogKind.PROMPT))
    }

    @Test
    fun anAlertIsAcceptedWhateverTheWord() {
        assertEquals(AgentPageDialogs.Answer.Accept(""), AgentPageDialogs.answer(json("accepted" to false), PageDialogKind.ALERT))
        assertEquals(AgentPageDialogs.Answer.Accept(""), AgentPageDialogs.answer(json(), PageDialogKind.ALERT))
    }

    @Test
    fun aConfirmIsAcceptedOrDismissedAndCarriesNoText() {
        assertEquals(AgentPageDialogs.Answer.Accept(""), AgentPageDialogs.answer(json("accepted" to true, "value" to "ignored"), PageDialogKind.CONFIRM))
        assertEquals(AgentPageDialogs.Answer.Cancel, AgentPageDialogs.answer(json("accepted" to false), PageDialogKind.CONFIRM))
    }

    @Test
    fun aPromptTakesTheAgentsTextOrAnEmptyOne() {
        assertEquals(AgentPageDialogs.Answer.Accept("Grace"), AgentPageDialogs.answer(json("accepted" to true, "value" to "Grace"), PageDialogKind.PROMPT))
        assertEquals(AgentPageDialogs.Answer.Accept(""), AgentPageDialogs.answer(json("accepted" to true), PageDialogKind.PROMPT))
        assertEquals(AgentPageDialogs.Answer.Cancel, AgentPageDialogs.answer(json("accepted" to false, "value" to "x"), PageDialogKind.PROMPT))
    }

    @Test
    fun aMalformedAnswerDismissesTheDialog() {
        assertEquals(AgentPageDialogs.Answer.Cancel, AgentPageDialogs.answer(json(), PageDialogKind.CONFIRM))
        assertEquals(AgentPageDialogs.Answer.Cancel, AgentPageDialogs.answer(json("accepted" to "yes"), PageDialogKind.PROMPT))
        assertFalse(AgentPageDialogs.answer(json(), PageDialogKind.PROMPT) is AgentPageDialogs.Answer.Accept)
    }
}
