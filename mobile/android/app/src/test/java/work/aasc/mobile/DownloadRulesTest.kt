package work.aasc.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DownloadRulesTest {
    private val shell = "https://localhost"
    private val mac = "http://192.168.1.20:3333"
    private val good = "$mac/api/files/stream?root=%2FUsers%2Fk%2Fp&path=v.mp4&download=1"

    @Test
    fun onlyThePagesOwnFileRouteWithTheFlag() {
        assertTrue(DownloadRules.accepts(good, "$mac/?m=/sessions", shell))
        assertFalse(DownloadRules.accepts("$mac/api/files/stream?root=x&path=y", "$mac/", shell))
        assertFalse(DownloadRules.accepts("$mac/api/sessions?download=1", "$mac/", shell))
        assertFalse(DownloadRules.accepts("http://192.168.1.21:3333/api/files/stream?download=1", "$mac/", shell))
        assertFalse(DownloadRules.accepts(good.replace(mac, shell), "$shell/", shell))
        assertFalse(DownloadRules.accepts(good, "$shell/", shell))
        assertFalse(DownloadRules.accepts(null, "$mac/", shell))
    }

    @Test
    fun theNameComesFromTheUtf8FilenameFirst() {
        val header = "attachment; filename=\"__.md\"; filename*=UTF-8''%E7%AC%94%E8%AE%B0%20a%2Bb.md"
        assertEquals("笔记 a+b.md", DownloadRules.fileName(header, "download"))
        assertEquals("v.mp4", DownloadRules.fileName("attachment; filename=\"v.mp4\"", "download"))
        assertEquals("download", DownloadRules.fileName(null, "download"))
        assertEquals("download", DownloadRules.fileName("attachment; filename=\"..\"", "download"))
    }

    @Test
    fun aNameStaysOneFileInDownloads() {
        assertEquals("_.._etc_passwd", DownloadRules.clean("../../etc/passwd"))
        assertEquals("a_b.txt", DownloadRules.clean("a\nb.txt"))
        val long = DownloadRules.clean("x".repeat(300) + ".mp4")!!
        assertEquals(DownloadRules.NAME_MAX_BYTES, long.toByteArray(Charsets.UTF_8).size)
        assertTrue(long.endsWith(".mp4"))
        val cjk = DownloadRules.clean("笔".repeat(100) + ".md")!!
        assertTrue(cjk.toByteArray(Charsets.UTF_8).size <= DownloadRules.NAME_MAX_BYTES)
        assertTrue(cjk.endsWith("笔.md"))
    }
}
