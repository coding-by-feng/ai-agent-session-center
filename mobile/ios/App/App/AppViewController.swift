// AppViewController.swift — registers the app's own plugins (AASC-17) and the Live Activity's message handler
// (LiveActivityBridge.swift). SceneDelegate (and Main.storyboard) use this class instead of Capacitor's
// CAPBridgeViewController.
import Capacitor
import UIKit

class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DeviceVaultPlugin())
        bridge?.registerPluginInstance(ShellBridgePlugin())
        bridge?.webView?.configuration.userContentController.add(LiveActivityBridge(), name: LiveActivityBridge.handlerName)
        #if DEBUG
        if #available(iOS 16.2, *) { MainActor.assumeIsolated { LiveActivityController.showDemoIfAsked() } }
        #endif
    }
}
