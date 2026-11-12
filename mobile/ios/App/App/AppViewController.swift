// AppViewController.swift — registers the app's own plugins (AASC-17) and the message handlers of the Live Activity
// (LiveActivityBridge.swift) and the file view's Download button (FileSaveBridge.swift). SceneDelegate (and Main.storyboard) use this class instead of Capacitor's
// CAPBridgeViewController.
import Capacitor
import UIKit

class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DeviceVaultPlugin())
        bridge?.registerPluginInstance(ShellBridgePlugin())
        bridge?.webView?.configuration.userContentController.add(LiveActivityBridge(), name: LiveActivityBridge.handlerName)
        if let webView = bridge?.webView {
            // The file view's Download button (FileSaveBridge.swift, Nov 7 2026).
            webView.configuration.userContentController.add(FileSaveBridge(host: self, webView: webView), name: FileSaveBridge.handlerName)
        }
        #if DEBUG
        if #available(iOS 16.2, *) { MainActor.assumeIsolated { LiveActivityController.showDemoIfAsked() } }
        #endif
    }
}
