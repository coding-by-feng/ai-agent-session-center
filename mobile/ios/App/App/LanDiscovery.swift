// LanDiscovery.swift — Bonjour browse for `_aasc._tcp` on the phone's Wi-Fi, for the LAN rescan
// (shell lanRescan.ts; the Mac advertises it, server/mobile/lanAdvertiser.ts). The Swift twin of
// android/.../LanDiscovery.kt.
//
// NWBrowser collects the services for the browse window. Each is then resolved to an IPv4 address
// by opening a TCP connection to it (IPv4 only), reading the far end's address, and closing it.
// `localIPv4()` is the phone's own Wi-Fi / Ethernet addresses: the shell sweeps the saved network
// only while the phone is on it.
// Needs NSBonjourServices (_aasc._tcp) and NSLocalNetworkUsageDescription in Info.plist. Nothing
// here is trusted: the shell keeps only private IPv4 on the saved port, and opens an address only
// after the Mac there proves it holds the phone's key.
import Foundation
import Network

enum DiscoveryRules {
    static let serviceType = "_aasc._tcp"
    /// More Macs than anyone has on one network; bounds the resolving.
    static let maxServices = 16
    static let resolveSeconds = 1.5

    /// The shell asks for 2 s; anything odd is pulled into 0.5–5 s.
    static func browseSeconds(_ raw: Int?) -> Double {
        Double(min(max(raw ?? 2_000, 500), 5_000)) / 1_000
    }
}

/// The phone's own IPv4 addresses on `en*` interfaces that are up (Wi-Fi, Ethernet; never cellular).
func localIPv4() -> [String] {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return [] }
    defer { freeifaddrs(head) }
    var out: [String] = []
    for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
        let flags = Int32(entry.pointee.ifa_flags)
        guard let addr = entry.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
              flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0,
              String(cString: entry.pointee.ifa_name).hasPrefix("en") else { continue }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
            out.append(String(cString: host))
        }
    }
    return Array(Set(out))
}

/// One browse. All state lives on `queue`.
final class LanDiscovery: @unchecked Sendable {
    private let queue = DispatchQueue(label: "work.aasc.lan-discovery")
    private var results: [NWEndpoint] = []
    private var found: [[String: Any]] = []
    private var pending = 0
    private var finished = false
    private var connections: [NWConnection] = []
    private var done: (([[String: Any]]) -> Void)?

    /// Calls `done` once, off the main thread, with `[["host": "192.168.1.57", "port": 3333], …]`.
    func browse(seconds: Double, done: @escaping ([[String: Any]]) -> Void) {
        self.done = done
        let browser = NWBrowser(for: .bonjour(type: DiscoveryRules.serviceType, domain: nil), using: .tcp)
        browser.browseResultsChangedHandler = { [self] results, _ in
            self.results = Array(results.map(\.endpoint).prefix(DiscoveryRules.maxServices))
        }
        browser.start(queue: queue)
        queue.asyncAfter(deadline: .now() + seconds) { [self] in
            browser.cancel()
            resolveAll()
        }
    }

    private func resolveAll() {
        pending = results.count
        if pending == 0 {
            finish()
            return
        }
        for endpoint in results {
            let params = NWParameters.tcp
            if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
                ip.version = .v4
            }
            let connection = NWConnection(to: endpoint, using: params)
            connections.append(connection)
            connection.stateUpdateHandler = { [self] state in
                switch state {
                case .ready:
                    if case let .hostPort(host, port)? = connection.currentPath?.remoteEndpoint, case let .ipv4(address) = host {
                        found.append(["host": address.rawValue.map { String($0) }.joined(separator: "."), "port": Int(port.rawValue)])
                    }
                    settle(connection)
                case .failed, .waiting:
                    settle(connection)
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
        queue.asyncAfter(deadline: .now() + DiscoveryRules.resolveSeconds) { [self] in finish() }
    }

    private func settle(_ connection: NWConnection) {
        connection.stateUpdateHandler = nil
        connection.cancel()
        pending -= 1
        if pending <= 0 { finish() }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        connections.forEach {
            $0.stateUpdateHandler = nil
            $0.cancel()
        }
        connections = []
        done?(found)
        done = nil
    }
}
