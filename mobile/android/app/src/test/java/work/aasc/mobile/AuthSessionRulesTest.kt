package work.aasc.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Mirrors the AuthSessionRules cases in ios/RulesTests/main.swift (plan 17, security rule 6).
class AuthSessionRulesTest {
    @Test
    fun opensOnlyTheBackendsHttpsPages() {
        val start = "https://api.aasc.work/v1/auth/google/start?return=x&challenge=abc"
        assertEquals(start, AuthSessionRules.startUrl(start))
        assertNull(AuthSessionRules.startUrl("https://API.aasc.work/v1/x"))
        assertNull(AuthSessionRules.startUrl("http://api.aasc.work/v1/x"))
        assertNull(AuthSessionRules.startUrl("https://aasc.work/v1/x"))
        assertNull(AuthSessionRules.startUrl("https://api.aasc.work.evil.example/v1/x"))
        assertNull(AuthSessionRules.startUrl("https://api.aasc.work@evil.example/v1/x"))
        assertNull(AuthSessionRules.startUrl("https://user@api.aasc.work/v1/x"))
        assertNull(AuthSessionRules.startUrl("https://api.aasc.work:8443/v1/x"))
        assertNull(AuthSessionRules.startUrl("https://api.aasc.work"))
        assertNull(AuthSessionRules.startUrl("https://api.aasc.work/a b"))
        assertNull(AuthSessionRules.startUrl("https://api.aasc.work/" + "a".repeat(5000)))
        assertNull(AuthSessionRules.startUrl(null))
        assertNull(AuthSessionRules.startUrl(""))
        assertNull(AuthSessionRules.startUrl("javascript:alert(1)"))
    }

    @Test
    fun callbackPrefixStaysUnderTheAppLink() {
        assertEquals("https://aasc.work/auth/google", AuthSessionRules.prefix(null))
        assertEquals("https://aasc.work/auth/google?", AuthSessionRules.prefix("https://aasc.work/auth/google?"))
        assertNull(AuthSessionRules.prefix("https://aasc.work/"))
        assertNull(AuthSessionRules.prefix("work.aasc.mobile://auth/google"))
        assertNull(AuthSessionRules.prefix("https://aasc.work/auth/googlex"))
        assertNull(AuthSessionRules.prefix("https://aasc.work/pair"))
    }

    @Test
    fun acceptsOnlyCallbacksUnderThePrefix() {
        val prefix = AuthSessionRules.DEFAULT_CALLBACK_PREFIX
        assertTrue(AuthSessionRules.callbackMatches("https://aasc.work/auth/google?code=abc&state=x", prefix))
        assertTrue(AuthSessionRules.callbackMatches("https://aasc.work/auth/google", prefix))
        assertTrue(AuthSessionRules.callbackMatches("https://aasc.work/auth/google#x", prefix))
        assertFalse(AuthSessionRules.callbackMatches("https://aasc.work/auth/googlex?code=a", prefix))
        assertFalse(AuthSessionRules.callbackMatches("https://aasc.work/pair?code=a", prefix))
        assertFalse(AuthSessionRules.callbackMatches("HTTPS://aasc.work/auth/google?code=a", prefix))
        assertFalse(AuthSessionRules.callbackMatches(null, prefix))
        assertTrue(AuthSessionRules.callbackMatches("https://aasc.work/auth/google?code=a", "https://aasc.work/auth/google?"))
    }
}
