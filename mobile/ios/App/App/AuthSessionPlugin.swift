// AuthSessionPlugin.swift — Google sign-in for the phone (plan 17, security rule 6).
//   start({ url, callbackScheme?, callbackPrefix? })  → { url } on the callback, { cancelled: true } when closed
// An ASWebAuthenticationSession opens the backend's sign-in page (https://api.aasc.work/… only) and returns
// the `work.aasc.mobile://auth/google?…` redirect, which carries a one-use PKCE code useless without the
// verifier the shell holds. The scheme is NOT in Info.plist: the session intercepts it on its own and no
// other app can claim it (plan 08 §5). Not ephemeral, so a Google account already signed in in Safari is
// offered. One session at a time; serves the bundled shell page only (ShellOnly.swift). AuthSessionRules
// decides what may be opened and returned. Registered in AppViewController.
import AuthenticationServices
import Capacitor
import Foundation
import UIKit

@objc(AuthSessionPlugin)
public class AuthSessionPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "AuthSessionPlugin"
    public let jsName = "AuthSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    ]

    /// The open session, held until its completion runs (the system drops an unretained one). Main thread only.
    private var session: ASWebAuthenticationSession?

    @objc func start(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            guard let url = AuthSessionRules.startUrl(call.getString("url")),
                  let scheme = AuthSessionRules.scheme(call.getString("callbackScheme")),
                  let prefix = AuthSessionRules.prefix(call.getString("callbackPrefix")) else {
                call.reject("Bad sign-in address", "BAD_URL")
                return
            }
            guard self.session == nil else {
                call.reject("busy", "BUSY")
                return
            }
            // Holds the plugin until it runs; clearing `session` there breaks the plugin → session → handler loop.
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, error in
                DispatchQueue.main.async {
                    self.session = nil
                    Self.finish(call, callback: callback, error: error, prefix: prefix)
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("The sign-in page couldn't open.", "FAILED")
            }
        }
    }

    /// The callback's URL, a close by the user, or a failure. Never logs the URL: it carries the code.
    private static func finish(_ call: CAPPluginCall, callback: URL?, error: Error?, prefix: String) {
        if let error {
            if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                call.resolve(["cancelled": true])
            } else {
                call.reject("The sign-in page couldn't open.", "FAILED")
            }
            return
        }
        let text = callback?.absoluteString
        guard let text, AuthSessionRules.callbackMatches(text, prefix: prefix) else {
            call.reject("Unexpected sign-in answer", "BAD_CALLBACK")
            return
        }
        call.resolve(["url": text])
    }

    /// The session's sheet sits over the app's own window.
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = bridge?.viewController?.view.window { return window }
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first ?? ASPresentationAnchor()
    }
}
