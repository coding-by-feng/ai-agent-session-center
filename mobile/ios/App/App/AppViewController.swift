// AppViewController.swift — registers the app's own plugins (AASC-17; AuthSession, plan 17) and the message handlers of the Live Activity
// (LiveActivityBridge.swift), the file view's Download button (FileSaveBridge.swift) and the hold-to-talk mic (DictationBridge.swift). SceneDelegate (and Main.storyboard) use this class instead of Capacitor's
// CAPBridgeViewController.
import Capacitor
import UIKit

class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DeviceVaultPlugin())
        bridge?.registerPluginInstance(ShellBridgePlugin())
        bridge?.registerPluginInstance(AuthSessionPlugin())  // Google sign-in for the phone (plan 17)
        bridge?.webView?.configuration.userContentController.add(LiveActivityBridge(), name: LiveActivityBridge.handlerName)
        if let webView = bridge?.webView {
            // The file view's Download button (FileSaveBridge.swift, Nov 7 2026).
            webView.configuration.userContentController.add(FileSaveBridge(host: self, webView: webView), name: FileSaveBridge.handlerName)
            // The hold-to-talk mic in Chat and the terminal's compose box (DictationBridge.swift, Nov 16 2026).
            webView.configuration.userContentController.add(DictationBridge(webView: webView), name: DictationBridge.handlerName)
        }
        #if DEBUG
        if #available(iOS 16.2, *) { MainActor.assumeIsolated { LiveActivityController.showDemoIfAsked() } }
        #endif
    }
}
