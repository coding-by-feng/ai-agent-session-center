// FileSaveBridge.swift — the phone file view's Download button, app half (Nov 7 2026). The Mac page posts
// `{ id, url, name }` to `window.webkit.messageHandlers.aascSaveFile` (src/lib/phoneDownload.ts). For a paired
// Mac's main frame (LiveActivityRules.macName) and its own file route (FileSaveRules), WebKit downloads the file
// with the page's own session cookie into a temporary folder, then the share sheet offers Save to Files, Save
// Video, AirDrop… The page hears back through an `aasc-save-file` window event (`shared` once the sheet is up,
// `failed` otherwise, a refused request included). The temporary copy is removed when the sheet closes, when it
// can't be shown, and at the next launch for a sheet the app was killed under.
import UIKit
import WebKit

@MainActor
final class FileSaveBridge: NSObject, WKScriptMessageHandler, WKDownloadDelegate {
    static let handlerName = "aascSaveFile"

    private struct Item {
        let id: String
        let name: String
        var folder: URL?
    }

    private weak var host: UIViewController?
    private weak var webView: WKWebView?
    private var items: [ObjectIdentifier: Item] = [:]

    init(host: UIViewController, webView: WKWebView) {
        self.host = host
        self.webView = webView
        super.init()
        // Copies left by a sheet that never closed (the app was killed while it was open).
        try? FileManager.default.removeItem(at: Self.root)
    }

    private static var root: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("AASC-Downloads", isDirectory: true)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let webView else { return }
        let origin = message.frameInfo.securityOrigin
        let page = "\(origin.protocol)://\(origin.host):\(origin.port)"
        let saved = UserDefaults.standard.string(forKey: LiveActivityRules.macsDefaultsKey)
        guard LiveActivityRules.macName(origin: page, savedMacs: saved) != nil,
              let request = FileSaveRules.request(message.body, page: page) else {
            // Answer a refusal too, or the page's button stays busy.
            if let id = FileSaveRules.postedId(message.body) { report(id, "failed", "This file can't be saved to the phone.") }
            return
        }
        webView.startDownload(using: URLRequest(url: request.url)) { [weak self] download in
            guard let self else { return }
            download.delegate = self
            self.items[ObjectIdentifier(download)] = Item(id: request.id, name: request.name)
        }
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let key = ObjectIdentifier(download)
        guard let item = items[key] else { completionHandler(nil); return }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            items[key] = nil
            completionHandler(nil)
            report(item.id, "failed", "Couldn't download \(item.name) (\(status)).")
            return
        }
        let folder = Self.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            items[key] = nil
            completionHandler(nil)
            report(item.id, "failed", "Couldn't save \(item.name): \(error.localizedDescription)")
            return
        }
        items[key]?.folder = folder
        completionHandler(folder.appendingPathComponent(item.name))
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let item = items.removeValue(forKey: ObjectIdentifier(download)), let folder = item.folder else { return }
        let file = folder.appendingPathComponent(item.name)
        var top: UIViewController? = host
        while let presented = top?.presentedViewController { top = presented }
        // No window to show it in (the app went to the background, or a sheet is closing): nothing is kept.
        guard let top, top.view.window != nil, !top.isBeingDismissed else {
            try? FileManager.default.removeItem(at: folder)
            report(item.id, "failed", "Couldn't show the save sheet for \(item.name). Try again.")
            return
        }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: folder) }
        if let popover = sheet.popoverPresentationController {
            // iPad: a share sheet is a popover and needs an anchor.
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        top.present(sheet, animated: true) { [weak self] in self?.report(item.id, "shared") }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard let item = items.removeValue(forKey: ObjectIdentifier(download)) else { return }
        if let folder = item.folder { try? FileManager.default.removeItem(at: folder) }
        report(item.id, "failed", "Couldn't download \(item.name): \(error.localizedDescription)")
    }

    private func report(_ id: String, _ state: String, _ message: String? = nil) {
        guard let script = FileSaveRules.outcomeScript(id: id, state: state, message: message) else { return }
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }
}
