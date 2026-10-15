package work.aasc.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackRulesTest {
    private val shell = "https://localhost"
    private val mac = "http://192.168.1.20:3333"

    @Test
    fun aMacPageIsAskedTheShellIsNot() {
        assertTrue(BackRules.asksPage(shell, "$mac/?m=/sessions"))
        assertFalse(BackRules.asksPage(shell, "$shell/?reauth=1"))
        assertFalse(BackRules.asksPage(shell, null))
        assertFalse(BackRules.asksPage(shell, "about:blank"))
    }

    @Test
    fun readsThePagesAnswer() {
        // evaluateJavascript hands back the value as JSON.
        assertEquals(BackRules.Answer.LEAVE, BackRules.answer("\"leave\""))
        assertEquals(BackRules.Answer.HANDLED, BackRules.answer("\"handled\""))
        // An older Mac UI (no hook), an error, anything else: Capacitor's own back.
        assertEquals(BackRules.Answer.NONE, BackRules.answer("null"))
        assertEquals(BackRules.Answer.NONE, BackRules.answer("\"none\""))
        assertEquals(BackRules.Answer.NONE, BackRules.answer(null))
        assertEquals(BackRules.Answer.NONE, BackRules.answer("\"leave now\""))
    }
}
