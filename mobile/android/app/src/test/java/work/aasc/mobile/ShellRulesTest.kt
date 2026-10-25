package work.aasc.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellRulesTest {
    private val shell = "https://localhost"

    @Test
    fun onlyTheBundledShellPageIsTheShell() {
        assertTrue(ShellRules.isShellPage("https://localhost/", shell))
        assertTrue(ShellRules.isShellPage("https://localhost/?reauth=1&back=%2Fqueue", shell))
        assertFalse(ShellRules.isShellPage("http://100.101.102.103:3333/", shell))
        assertFalse(ShellRules.isShellPage("http://localhost/", shell))
        assertFalse(ShellRules.isShellPage("https://localhost:8443/", shell))
        assertFalse(ShellRules.isShellPage("https://localhost.evil.example/", shell))
        assertFalse(ShellRules.isShellPage("https://mac-kason.aasc.work/", shell))
        assertFalse(ShellRules.isShellPage(null, shell))
        assertFalse(ShellRules.isShellPage("about:blank", shell))
    }

    @Test
    fun acceptsOnlyPairedStyleMacOrigins() {
        assertEquals("http://100.101.102.103:3333", ShellRules.macOrigin("http://100.101.102.103:3333"))
        assertEquals("http://192.168.1.20:3333", ShellRules.macOrigin("http://192.168.1.20:3333/"))
        assertNull(ShellRules.macOrigin("http://8.8.8.8:3333"))
        assertNull(ShellRules.macOrigin("https://100.101.102.103:3333"))
        assertNull(ShellRules.macOrigin("http://100.101.102.103"))
        assertNull(ShellRules.macOrigin("http://100.200.1.1:3333"))
        assertNull(ShellRules.macOrigin("http://user@192.168.1.20:3333"))
        assertNull(ShellRules.macOrigin("http://192.168.1.20:3333/api"))
        assertNull(ShellRules.macOrigin("http://192.168.1.20:3333/?x=1"))
        assertNull(ShellRules.macOrigin("http://example.com:3333"))
        assertNull(ShellRules.macOrigin(null))
    }

    // A leading-zero octet is octal to the WebView's URL parser (010.1.1.1 is dialled as 8.1.1.1), so the
    // rule is canonical dotted decimal only (= shell/src/pairingLink.ts).
    @Test
    fun macOriginRefusesLeadingZeroOctets() {
        for (raw in listOf("http://010.1.1.1:3333", "http://100.064.001.001:3333", "http://192.168.001.010:3333",
                           "http://10.0.0.08:3333", "http://00.0.0.0:3333"))
            assertNull(raw, ShellRules.macOrigin(raw))
    }

    @Test
    fun pairableHostsAreCanonical() {
        for (h in listOf("010.1.1.1", "100.064.001.001", "100.64.01.1", "100.64.1.256", "100.64.1"))
            assertFalse(h, ShellRules.isPairableHost(h))
        for (h in listOf("10.0.0.1", "172.16.0.1", "192.168.7.231", "169.254.1.1", "100.64.0.0", "100.127.255.255", "100.101.102.103"))
            assertTrue(h, ShellRules.isPairableHost(h))
    }

    // Char.isDigit() and String.toInt() take any Unicode decimal digit (fullwidth, Arabic-Indic), which is not a
    // dotted quad the WebView dials as written: ASCII digits only.
    @Test
    fun pairableHostsAreAsciiDigitsOnly() {
        for (h in listOf("\uFF11\uFF10.0.0.1", "10.0.0.\uFF11", "\u0661\u0660.0.0.1", "192.168.\u0661.\u0662"))
            assertFalse(h, ShellRules.isPairableHost(h))
    }

    @Test
    fun originsCompareWithDefaultPortsWrittenOut() {
        assertEquals("http://192.168.1.20:3333", ShellRules.originOf("http://192.168.1.20:3333/queue?x=1"))
        assertEquals("https://aasc.work:443", ShellRules.originOf("https://AASC.work/pair"))
        assertNull(ShellRules.originOf("javascript:alert(1)"))
    }

    @Test
    fun sessionTokensCantCarryCookieAttributes() {
        assertTrue(ShellRules.isSessionToken("abc.DEF_123-~+/="))
        assertFalse(ShellRules.isSessionToken("abc; Domain=evil.example"))
        assertFalse(ShellRules.isSessionToken("abc def"))
        assertFalse(ShellRules.isSessionToken(""))
        assertFalse(ShellRules.isSessionToken(null))
    }

    @Test
    fun vaultKeysAreSimpleNames() {
        assertTrue(ShellRules.isVaultKey("mac.6f1c2a10-0000-4000-8000-000000000001"))
        assertFalse(ShellRules.isVaultKey("../x"))
        assertFalse(ShellRules.isVaultKey(""))
        assertFalse(ShellRules.isVaultKey("a".repeat(129)))
    }
}
