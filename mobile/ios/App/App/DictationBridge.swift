// DictationBridge.swift — the phone app's hold-to-talk mic, app half (Nov 16 2026). The Mac's page is plain http,
// so it has no microphone of its own: it posts `{ id, action }` to `window.webkit.messageHandlers.aascDictation`
// (src/lib/phoneDictation.ts) and this records for it. For a paired Mac's main frame (LiveActivityRules.macName):
//   start   asks for the microphone the first time (answer: `permission`), else records AAC into a temporary
//           .m4a (answer: `recording`), for at most DictationRules.maxSeconds
//   stop    ends the clip and hands it to the page as base64 (answer: `audio`); a hold too short to hold speech
//           is dropped (answer: `cancelled`, short)
//   cancel  drops it (answer: `cancelled`)
// A `start` is taken only just after a finger went down on the screen (TouchWatch, DictationRules.touched): the
// page is plain http, and a script put into it must not be able to turn the microphone on by itself. A clip is
// dropped when the app leaves the screen, when a call or Siri takes the microphone, and when the page reloads.
// Answers go back as an `aasc-dictation` window event, and only while the WebView is still on the page that
// asked. The page sends the clip to its own Mac, which turns it into text. Nothing is kept on the phone: the
// file is removed as soon as it is read, and the whole folder at the next launch.
import AVFoundation
import UIKit
import UIKit.UIGestureRecognizerSubclass
import WebKit

/// Notes when a finger last went down on the WebView, and never takes the touch from the page.
final class TouchWatch: UIGestureRecognizer, UIGestureRecognizerDelegate {
    /// Uptime seconds of the last touch down; nil before the first.
    private(set) var lastDown: TimeInterval?

    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        lastDown = ProcessInfo.processInfo.systemUptime
    }

    // Never recognises: once the fingers are up it fails, which resets it for the next touch.
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { state = .failed }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .failed }

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

@MainActor
final class DictationBridge: NSObject, WKScriptMessageHandler, AVAudioRecorderDelegate {
    static let handlerName = "aascDictation"

    private struct Clip {
        let id: String
        /// The page that asked (scheme://host:port): the clip goes to no other.
        let page: String
        let file: URL
        let recorder: AVAudioRecorder
    }

    private weak var webView: WKWebView?
    private var clip: Clip?
    private var observers: [NSObjectProtocol] = []
    private var loading: NSKeyValueObservation?
    private let touches = TouchWatch()

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
        // Clips left by a recording the app was killed under.
        try? FileManager.default.removeItem(at: Self.root)
        webView.addGestureRecognizer(touches)
        let center = NotificationCenter.default
        // A phone call or Siri taking the microphone drops the clip. The note may arrive on any thread.
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard let raw, AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            Task { @MainActor [weak self] in self?.drop("The recording was interrupted. Try again.") }
        })
        // The app leaving the screen (another app, the lock button) drops it too: it never records unseen.
        observers.append(center.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.drop("The recording was interrupted. Try again.") }
        })
        // A reload or a move to another page leaves no one to hand the clip to: stop recording at once.
        loading = webView.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            guard change.newValue == true else { return }
            Task { @MainActor [weak self] in self?.drop(nil) }
        }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    private static var root: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("AASC-Dictation", isDirectory: true)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        let origin = message.frameInfo.securityOrigin
        let page = "\(origin.protocol)://\(origin.host):\(origin.port)"
        let saved = UserDefaults.standard.string(forKey: LiveActivityRules.macsDefaultsKey)
        guard LiveActivityRules.macName(origin: page, savedMacs: saved) != nil,
              let request = DictationRules.request(message.body) else {
            // Answer a refusal too, or the page's button stays busy.
            if let id = DictationRules.postedId(message.body) {
                report(id, page, "failed", ["message": "This page can't use the microphone."])
            }
            return
        }
        switch request.action {
        case .start: start(request.id, page)
        case .stop: finish(request.id, page, keep: true)
        case .cancel: finish(request.id, page, keep: false)
        }
    }

    // MARK: - Recording

    private func start(_ id: String, _ page: String) {
        // One clip at a time: a new hold drops whatever was still recording.
        if let old = clip { end(old, keep: false, limit: false) }
        // Only a finger on the screen starts the microphone, never the page by itself.
        guard DictationRules.touched(lastDown: touches.lastDown, now: ProcessInfo.processInfo.systemUptime) else {
            report(id, page, "failed", ["message": "Hold the mic with a finger to record."])
            return
        }
        switch Self.permission() {
        case .granted:
            record(id, page)
        case .denied:
            report(id, page, "permission", ["granted": false])
        case .undetermined:
            // The system sheet takes the touch, so nothing is recorded this time: the page says to hold again.
            Self.askPermission { [weak self] granted in
                self?.report(id, page, "permission", ["granted": granted])
            }
        }
    }

    private func record(_ id: String, _ page: String) {
        let file = Self.root.appendingPathComponent(UUID().uuidString + ".m4a")
        do {
            try FileManager.default.createDirectory(at: Self.root, withIntermediateDirectories: true)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            let recorder = try Self.recorder(for: file)
            recorder.delegate = self
            guard recorder.record(forDuration: DictationRules.maxSeconds) else {
                throw NSError(domain: "AASCDictation", code: 1)
            }
            clip = Clip(id: id, page: page, file: file, recorder: recorder)
            report(id, page, "recording")
        } catch {
            try? FileManager.default.removeItem(at: file)
            Self.releaseSession()
            report(id, page, "failed", ["message": "The microphone couldn't start. Try again."])
        }
    }

    /// Speech-sized AAC: 16 kHz mono. An encoder that refuses the bit rate gets its own default.
    private static func recorder(for file: URL) throws -> AVAudioRecorder {
        var settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32_000,
        ]
        if let recorder = try? AVAudioRecorder(url: file, settings: settings), recorder.prepareToRecord() {
            return recorder
        }
        settings[AVEncoderBitRateKey] = nil
        return try AVAudioRecorder(url: file, settings: settings)
    }

    private func finish(_ id: String, _ page: String, keep: Bool) {
        guard let current = clip, current.id == id else {
            // No such recording (it never started, or already ended): say so, the page may be waiting.
            report(id, page, "cancelled")
            return
        }
        end(current, keep: keep, limit: false)
    }

    /// Stop the recorder, answer the page, and leave nothing behind. `limit`: the recorder stopped by itself.
    private func end(_ current: Clip, keep: Bool, limit: Bool) {
        clip = nil
        let seconds = limit ? DictationRules.maxSeconds : current.recorder.currentTime
        current.recorder.delegate = nil
        current.recorder.stop()
        Self.releaseSession()
        defer { try? FileManager.default.removeItem(at: current.file) }
        guard keep else {
            report(current.id, current.page, "cancelled")
            return
        }
        guard DictationRules.longEnough(seconds) else {
            report(current.id, current.page, "cancelled", ["short": true])
            return
        }
        guard let data = try? Data(contentsOf: current.file), DictationRules.fits(data.count) else {
            report(current.id, current.page, "failed", ["message": "The recording couldn't be read. Try again."])
            return
        }
        report(current.id, current.page, "audio",
               ["audio": data.base64EncodedString(), "mime": DictationRules.mime, "ms": Int(seconds * 1000)])
    }

    private static func releaseSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - The recorder ending by itself

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let ended = ObjectIdentifier(recorder)
        Task { @MainActor [weak self] in
            // The two-minute limit: hand over what there is. (A stop of ours cleared the delegate first.)
            guard let self, let current = self.clip, ObjectIdentifier(current.recorder) == ended else { return }
            self.end(current, keep: flag, limit: true)
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let ended = ObjectIdentifier(recorder)
        Task { @MainActor [weak self] in
            guard let self, let current = self.clip, ObjectIdentifier(current.recorder) == ended else { return }
            self.clip = nil
            current.recorder.delegate = nil
            current.recorder.stop()
            Self.releaseSession()
            try? FileManager.default.removeItem(at: current.file)
            self.report(current.id, current.page, "failed", ["message": "The recording failed. Try again."])
        }
    }

    /// Stop recording now and keep nothing. `message`: what to tell the page; nil when it is gone.
    private func drop(_ message: String?) {
        guard let current = clip else { return }
        clip = nil
        current.recorder.delegate = nil
        current.recorder.stop()
        Self.releaseSession()
        try? FileManager.default.removeItem(at: current.file)
        if let message { report(current.id, current.page, "failed", ["message": message]) }
    }

    // MARK: - Microphone permission

    private enum Permission { case granted, denied, undetermined }

    private static func permission() -> Permission {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: return .granted
            case .denied: return .denied
            default: return .undetermined
            }
        }
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return .undetermined
        }
    }

    private static func askPermission(_ done: @escaping @MainActor @Sendable (Bool) -> Void) {
        let answer: @Sendable (Bool) -> Void = { granted in Task { @MainActor in done(granted) } }
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: answer)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(answer)
        }
    }

    // MARK: - Answering the page

    /// Tell the page, but only while the WebView still shows the page that asked.
    private func report(_ id: String, _ page: String, _ state: String, _ fields: [String: Any] = [:]) {
        guard let webView, ShellRules.originOf(webView.url?.absoluteString) == ShellRules.originOf(page),
              let script = DictationRules.outcomeScript(id: id, state: state, fields: fields) else { return }
        webView.evaluateJavaScript(script, completionHandler: nil)
    }
}
