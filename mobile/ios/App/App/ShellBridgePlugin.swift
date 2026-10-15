// ShellBridgePlugin.swift — the shell's other native needs on iOS (AASC-17):
//   setSessionCookie / clearSessionCookie  the Mac's session cookie, HttpOnly, in the WebView's store
//   allowOrigins                           which paired-Mac http origins the WebView may load
//   scanQr                                 the pairing QR with VisionKit's live scanner (QrScanSession.swift)
//   pushConfigured                         false until APNs is set up (Apple Developer Program, AASC-19)
//   biometricStatus / authenticate / bootId  the biometric lock's native half (AASC-21, biometricLock.ts decides)
// The share extension and widget come with their iOS halves later. Serves the bundled
// shell page only (ShellOnly.swift).
import Capacitor
import Foundation
import LocalAuthentication
import WebKit

@objc(ShellBridgePlugin)
public class ShellBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShellBridgePlugin"
    public let jsName = "ShellBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSessionCookie", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSessionCookie", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "allowOrigins", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanQr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushConfigured", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bootId", returnType: CAPPluginReturnPromise),
    ]

    /// The http origins of the paired Macs, as the shell last listed them. Main thread only.
    private var allowed: Set<String> = []

    private func cookie(origin: String, value: String, maxAge: Int) -> HTTPCookie? {
        guard let url = URL(string: origin), let host = url.host else { return nil }
        // Same attributes as the Mac's own Set-Cookie (mobileRouter.ts), no Secure: plain http.
        return HTTPCookie(properties: [
            .domain: host,
            .path: "/",
            .name: "auth_token",
            .value: value,
            .maximumAge: String(maxAge),
            .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict.rawValue,
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ])
    }

    private func store(_ call: CAPPluginCall, _ cookie: HTTPCookie?) {
        guard let cookie, let cookies = bridge?.webView?.configuration.websiteDataStore.httpCookieStore else {
            call.reject("The cookie wasn't stored", "FAILED")
            return
        }
        cookies.setCookie(cookie) { call.resolve() }
    }

    @objc func setSessionCookie(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            let origin = ShellRules.macOrigin(call.getString("origin"))
            let token = call.getString("token")
            let maxAge = call.getInt("maxAgeSeconds") ?? 0
            guard let origin, ShellRules.isSessionToken(token), let token, (1...ShellRules.cookieMaxAgeMax).contains(maxAge) else {
                call.reject("Bad session cookie", "BAD_COOKIE")
                return
            }
            self.store(call, self.cookie(origin: origin, value: token, maxAge: maxAge))
        }
    }

    @objc func clearSessionCookie(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            guard let origin = ShellRules.macOrigin(call.getString("origin")), let host = URL(string: origin)?.host,
                  let cookies = self.bridge?.webView?.configuration.websiteDataStore.httpCookieStore else {
                call.reject("Bad origin", "BAD_COOKIE")
                return
            }
            cookies.getAllCookies { all in
                let mine = all.filter { $0.name == "auth_token" && $0.domain == host }
                let group = DispatchGroup()
                for c in mine {
                    group.enter()
                    cookies.delete(c) { group.leave() }
                }
                group.notify(queue: .main) { call.resolve() }
            }
        }
    }

    @objc func allowOrigins(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            let raw = call.getArray("origins", String.self) ?? []
            let origins = raw.map { ShellRules.macOrigin($0) }
            if origins.contains(where: { $0 == nil }) {
                call.reject("Bad origin", "BAD_ORIGIN")
                return
            }
            self.allowed = Set(origins.compactMap { $0 })
            call.resolve()
        }
    }

    /// The pairing QR (iOS 16+, a phone with the scanner). The shell parses the text like a pasted link.
    @objc func scanQr(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            guard #available(iOS 16.0, *) else {
                call.reject("The scanner isn't available on this phone.", "SCANNER_UNAVAILABLE")
                return
            }
            // fromShellOnly runs this on the main queue.
            MainActor.assumeIsolated { QrScanSession.start(from: self.bridge?.viewController, call: call) }
        }
    }

    /// Push stays off until the app is built with the APNs entitlement (Apple Developer Program).
    /// Then this returns true and the shell registers as on Android (README "Turning push on").
    @objc func pushConfigured(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            call.resolve(["configured": Bundle.main.object(forInfoDictionaryKey: "AASCPushConfigured") as? Bool == true])
        }
    }

    /// Face ID / Touch ID, or the passcode: what the lock may ask for.
    @objc func biometricStatus(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            var error: NSError?
            call.resolve(["available": LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)])
        }
    }

    @objc func authenticate(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            let reason = PromptRules.title(call.getString("reason"))
            LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
                // Cancelled, locked out or no biometrics: the app stays locked. The reason is a code, never user data.
                call.resolve(ok ? ["ok": true] : ["ok": false, "code": (error as NSError?)?.code ?? -1])
            }
        }
    }

    /// Changes on every restart (biometricLock.ts locks after one): the kernel's boot time.
    @objc func bootId(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            var boot = timeval()
            var size = MemoryLayout<timeval>.stride
            var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
            let ok = sysctl(&mib, 2, &boot, &size, nil, 0) == 0 && boot.tv_sec > 0
            call.resolve(ok ? ["bootId": String(boot.tv_sec)] : ["bootId": NSNull()])
        }
    }

    /// Capacitor asks every plugin before it decides where a navigation goes. A paired Mac's http
    /// origin stays in the WebView (false); anything else gets Capacitor's default: the app's own
    /// origin and *.aasc.work stay, everything else opens in Safari.
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url, url.scheme == "http",
              let origin = ShellRules.originOf(url.absoluteString), allowed.contains(origin) else { return nil }
        return false
    }
}
