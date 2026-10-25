// LanDiscovery.kt — Bonjour browse for `_aasc._tcp` on the phone's Wi-Fi, for the LAN rescan
// (shell lanRescan.ts; the Mac advertises it, server/mobile/lanAdvertiser.ts).
//
// NsdManager collects the services for the browse window, then each is resolved to its IPv4
// addresses, one at a time (before API 34 Android runs one resolve at a time, and a resolve that
// timed out can't be stopped there, so later ones may come back empty), within RESOLVE_BUDGET_MS
// in all. `localIpv4` is the phone's own addresses: the shell sweeps the saved network only while
// the phone is on it. Nothing here is trusted: the shell keeps only private IPv4 on the saved port,
// and opens an address only after the Mac there proves it holds the phone's key.
package work.aasc.mobile

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.atomic.AtomicBoolean

internal data class FoundMac(val host: String, val port: Int)

/** The browse's limits, kept pure for the unit tests. */
internal object DiscoveryRules {
    const val SERVICE_TYPE = "_aasc._tcp."
    /** More Macs than anyone has on one network; bounds the resolving. */
    const val MAX_SERVICES = 16
    const val RESOLVE_MS = 1_500L
    /** All resolving together: a crowd of advertised services can't hold the rescan up. */
    const val RESOLVE_BUDGET_MS = 2_500L

    /** The shell asks for 2 s; anything odd is pulled into 0.5–5 s. */
    fun browseMs(raw: Int?): Long = (raw ?: 2_000).coerceIn(500, 5_000).toLong()

    /** Each address once, a real port, no more than a few per service. */
    fun keep(found: List<FoundMac>): List<FoundMac> =
        found.filter { it.host.isNotEmpty() && it.port in 1..65_535 }.distinct().take(MAX_SERVICES * 2)
}

/** The phone's own private IPv4 addresses on interfaces that are up; no permission needed. */
internal fun localIpv4(): List<String> = try {
    NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .flatMap { it.inetAddresses.toList() }
        .filterIsInstance<Inet4Address>()
        .filter { it.isSiteLocalAddress || it.isLinkLocalAddress }
        .mapNotNull { it.hostAddress }
        .distinct()
} catch (e: Exception) {
    emptyList()
}

internal class LanDiscovery(private val context: Context) {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val main = Handler(Looper.getMainLooper())

    /** Calls `done` once, with what was found (empty when the browse can't start). */
    fun browse(timeoutMs: Long, done: (List<FoundMac>) -> Unit) {
        val seen = mutableListOf<NsdServiceInfo>()
        val failed = AtomicBoolean(false)
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onServiceFound(info: NsdServiceInfo) {
                synchronized(seen) { if (seen.size < DiscoveryRules.MAX_SERVICES) seen.add(info) }
            }
            override fun onServiceLost(info: NsdServiceInfo) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                failed.set(true)
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        }
        try {
            nsd.discoverServices(DiscoveryRules.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        } catch (e: Exception) {
            done(emptyList())
            return
        }
        main.postDelayed({
            if (!failed.get()) {
                try {
                    nsd.stopServiceDiscovery(listener)
                } catch (e: Exception) {
                    // already stopped
                }
            }
            val found = synchronized(seen) { seen.toList() }
            resolveAll(found) { done(DiscoveryRules.keep(it)) }
        }, timeoutMs)
    }

    /** On the main thread; `done` once, with what resolved by the end or by RESOLVE_BUDGET_MS. */
    private fun resolveAll(services: List<NsdServiceInfo>, done: (List<FoundMac>) -> Unit) {
        val out = mutableListOf<FoundMac>()
        val finished = AtomicBoolean(false)
        val finish = { if (finished.compareAndSet(false, true)) done(out.toList()) }
        main.postDelayed({ finish() }, DiscoveryRules.RESOLVE_BUDGET_MS)
        fun next(i: Int) {
            if (finished.get()) return
            if (i >= services.size) {
                finish()
                return
            }
            resolveOne(services[i]) { found ->
                out.addAll(found)
                next(i + 1)
            }
        }
        next(0)
    }

    /** One service's IPv4 addresses, on the main thread; empty after RESOLVE_MS or on failure. */
    private fun resolveOne(service: NsdServiceInfo, done: (List<FoundMac>) -> Unit) {
        val answered = AtomicBoolean(false)
        var cleanup: () -> Unit = {}
        val answer = { found: List<FoundMac> ->
            if (answered.compareAndSet(false, true)) {
                main.post {
                    cleanup()
                    done(found)
                }
            }
        }
        main.postDelayed({ answer(emptyList()) }, DiscoveryRules.RESOLVE_MS)
        cleanup = if (Build.VERSION.SDK_INT >= 34) resolveModern(service, answer) else resolveLegacy(service, answer)
    }

    @Suppress("DEPRECATION")
    private fun resolveLegacy(service: NsdServiceInfo, answer: (List<FoundMac>) -> Unit): () -> Unit {
        try {
            nsd.resolveService(service, object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = answer(emptyList())
                override fun onServiceResolved(info: NsdServiceInfo) {
                    val host = info.host
                    answer(if (host is Inet4Address) listOfNotNull(host.hostAddress?.let { FoundMac(it, info.port) }) else emptyList())
                }
            })
        } catch (e: Exception) {
            answer(emptyList())
        }
        return {}
    }

    @RequiresApi(34)
    private fun resolveModern(service: NsdServiceInfo, answer: (List<FoundMac>) -> Unit): () -> Unit {
        val callback = object : NsdManager.ServiceInfoCallback {
            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = answer(emptyList())
            override fun onServiceUpdated(info: NsdServiceInfo) {
                val found = info.hostAddresses.filterIsInstance<Inet4Address>()
                    .mapNotNull { it.hostAddress }
                    .map { FoundMac(it, info.port) }
                if (found.isNotEmpty()) answer(found)
            }
            override fun onServiceLost() = Unit
            override fun onServiceInfoCallbackUnregistered() = Unit
        }
        try {
            nsd.registerServiceInfoCallback(service, ContextCompat.getMainExecutor(context), callback)
        } catch (e: Exception) {
            answer(emptyList())
            return {}
        }
        return {
            try {
                nsd.unregisterServiceInfoCallback(callback)
            } catch (e: Exception) {
                // never registered or already gone
            }
        }
    }
}
