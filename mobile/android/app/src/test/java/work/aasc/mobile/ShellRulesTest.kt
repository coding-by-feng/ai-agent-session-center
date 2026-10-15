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
