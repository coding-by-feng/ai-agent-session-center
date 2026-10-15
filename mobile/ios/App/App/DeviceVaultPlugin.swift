// DeviceVaultPlugin.swift — the shell's secrets in the Keychain (AASC-17, plan 08 §2).
// One generic-password item per entry: service work.aasc.mobile.vault, account = the entry name,
// readable only while the phone is unlocked and never synced or restored to another device
// (…WhenUnlockedThisDeviceOnly). Serves the bundled shell page only (ShellOnly.swift).
import Capacitor
import Foundation
import Security

@objc(DeviceVaultPlugin)
public class DeviceVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceVaultPlugin"
    public let jsName = "DeviceVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    private static let service = "work.aasc.mobile.vault"

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Self.service,
         kSecAttrAccount as String: key]
    }

    @objc func get(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            guard let key = call.getString("key"), ShellRules.isVaultKey(key) else {
                call.reject("Bad vault key", "BAD_KEY")
                return
            }
            var q = self.query(key)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            let status = SecItemCopyMatching(q as CFDictionary, &item)
            if status == errSecItemNotFound {
                call.resolve([:])
            } else if status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) {
                call.resolve(["value": value])
            } else {
                call.reject("The phone couldn't do that.", "FAILED")
            }
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            guard let key = call.getString("key"), ShellRules.isVaultKey(key) else {
                call.reject("Bad vault key", "BAD_KEY")
                return
            }
            guard let value = call.getString("value"), value.utf8.count <= ShellRules.vaultValueMax else {
                call.reject("Bad vault value", "BAD_VALUE")
                return
            }
            SecItemDelete(self.query(key) as CFDictionary)
            var q = self.query(key)
            q[kSecValueData as String] = Data(value.utf8)
            q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let status = SecItemAdd(q as CFDictionary, nil)
            if status == errSecSuccess { call.resolve() } else { call.reject("The phone couldn't do that.", "FAILED") }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            guard let key = call.getString("key"), ShellRules.isVaultKey(key) else {
                call.reject("Bad vault key", "BAD_KEY")
                return
            }
            let status = SecItemDelete(self.query(key) as CFDictionary)
            if status == errSecSuccess || status == errSecItemNotFound { call.resolve() } else { call.reject("The phone couldn't do that.", "FAILED") }
        }
    }
}
