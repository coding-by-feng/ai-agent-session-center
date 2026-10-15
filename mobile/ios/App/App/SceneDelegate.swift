import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// Covers the app while it is in the app switcher (AASC-22, RELEASE row 7).
    private var privacyCover: UIView?
    /// When the app last went to the background, in milliseconds (biometric lock, AASC-21).
    private var pausedAt: Int64 = 0

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = AppViewController()  // registers the app's own plugins (AASC-17)
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // The app switcher snapshots the window after this: never a terminal in it.
    func sceneWillResignActive(_ scene: UIScene) {
        guard privacyCover == nil, let window else { return }
        let cover = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
        cover.frame = window.bounds
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(cover)
        privacyCover = cover
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        privacyCover?.removeFromSuperview()
        privacyCover = nil
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        pausedAt = Int64(Date().timeIntervalSince1970 * 1000)
    }

    // With the lock on and a Mac's page showing, the shell decides whether to ask (LockRules).
    func sceneWillEnterForeground(_ scene: UIScene) {
        guard let bridge = (window?.rootViewController as? CAPBridgeViewController)?.bridge,
              let webView = bridge.webView else { return }
        let target = LockRules.resumeUrl(
            UserDefaults.standard.string(forKey: LockRules.settingsDefaultsKey),
            shell: bridge.config.localURL.absoluteString,
            current: webView.url?.absoluteString,
            pausedAt: pausedAt,
            now: Int64(Date().timeIntervalSince1970 * 1000))
        if let target, let url = URL(string: target) { webView.load(URLRequest(url: url)) }
    }
}
