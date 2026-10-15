// QrScanSession.swift — the pairing QR on iOS (AASC-17): VisionKit's live scanner, QR codes only.
// The Swift side of ShellBridge.scanQr; Android uses Google's code scanner. The app only receives the
// decoded text, which the shell parses like a pasted link (parsePairingLink), so nothing is trusted here.
// One scan at a time; Cancel, a swipe down or a failure resolves with no value.
import AVFoundation
import Capacitor
import UIKit
import VisionKit

@available(iOS 16.0, *)
@MainActor
final class QrScanSession: NSObject, DataScannerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    /// A QR far longer than any pairing link is not one (and is never handed to the page).
    private static let maxPayload = 4096
    private static var current: QrScanSession?

    private let call: CAPPluginCall
    private weak var scanner: DataScannerViewController?
    private weak var sheet: UINavigationController?
    private var finished = false

    private init(call: CAPPluginCall) {
        self.call = call
    }

    /// Main thread. Asks for the camera the first time (NSCameraUsageDescription), then shows the scanner.
    static func start(from host: UIViewController?, call: CAPPluginCall) {
        guard current == nil else {
            call.reject("A scan is already open.", "SCANNER_BUSY")
            return
        }
        guard let host, DataScannerViewController.isSupported else {
            call.reject("The scanner isn't available on this phone.", "SCANNER_UNAVAILABLE")
            return
        }
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async {
                guard granted, DataScannerViewController.isAvailable else {
                    call.reject("AASC can't use the camera. Allow it in Settings, or paste the link.", "CAMERA_DENIED")
                    return
                }
                present(from: host, call: call)
            }
        }
    }

    private static func present(from host: UIViewController, call: CAPPluginCall) {
        let session = QrScanSession(call: call)
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true)
        scanner.delegate = session
        scanner.title = "Scan the pairing QR"
        scanner.navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .cancel, primaryAction: UIAction { [weak session] _ in session?.finish(nil) })
        let sheet = UINavigationController(rootViewController: scanner)
        sheet.presentationController?.delegate = session
        session.scanner = scanner
        session.sheet = sheet
        current = session
        host.present(sheet, animated: true) {
            do {
                try scanner.startScanning()
            } catch {
                session.finish(nil)
            }
        }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        for item in addedItems {
            if case .barcode(let code) = item, let value = code.payloadStringValue, value.count <= Self.maxPayload {
                finish(value)
                return
            }
        }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
        finish(nil)
    }

    /// Swiped down: the same as Cancel.
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish(nil)
    }

    private func finish(_ value: String?) {
        guard !finished else { return }
        finished = true
        scanner?.stopScanning()
        if let sheet, sheet.presentingViewController != nil {
            sheet.dismiss(animated: true)
        }
        call.resolve(value.map { ["value": $0] } ?? [:])
        Self.current = nil
    }
}
