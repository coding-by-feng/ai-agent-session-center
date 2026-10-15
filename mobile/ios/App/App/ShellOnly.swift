// ShellOnly.swift — the app's plugins answer the bundled shell page and nothing else (AASC-17, plan 08 §2).
// The Swift twin of android/.../ShellOnly.kt: each call checks, on the main thread, that the
// WebView's current page is the shell (capacitor://localhost); anything else is refused.
import Capacitor
import Foundation

extension CAPPlugin {
    func fromShellOnly(_ call: CAPPluginCall, _ work: @escaping () -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let bridge = self?.bridge,
                  ShellRules.isShellPage(bridge.webView?.url?.absoluteString, bridge.config.localURL.absoluteString) else {
                call.reject("Only the AASC app's own page may use this.", "ORIGIN_REFUSED")
                return
            }
            work()
        }
    }
}
