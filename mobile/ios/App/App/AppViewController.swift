// AppViewController.swift — registers the app's own plugins (AASC-17). Main.storyboard uses this
// class instead of Capacitor's CAPBridgeViewController.
import Capacitor
import UIKit

class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(DeviceVaultPlugin())
        bridge?.registerPluginInstance(ShellBridgePlugin())
    }
}
