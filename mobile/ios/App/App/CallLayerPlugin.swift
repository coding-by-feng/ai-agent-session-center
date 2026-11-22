// CallLayerPlugin.swift — the floating call (Nov 22 2026). A voice call runs in the shell's page (the Mac's plain-http
// page gets no microphone), so leaving that page for the Mac's would end the call. Minimize instead lays a second
// WKWebView with the Mac's page over the shell, plus a small draggable bubble; the call keeps running underneath.
//   show({ url, label, state, alert })  load (or show again) the Mac's page at `url` and the bubble → { shown }
//   hide()                              hide both, keeping the page loaded → { url }
//   close()                             drop both → { url }
//   bubble({ label, state, alert })     what the bubble shows: the clock, paused/muted, a dot when the central needs you
//   event `expand` { url }              the bubble was tapped, or the page tried to open the app's own page (a
//                                       reauth, Call AASC): the layer hid itself and the shell shows the call
// The page shares the shell's cookies (the shell sets this call's session cookie first) and user agent, and stays on
// the origin it was opened on: other links open in Safari. It has no Capacitor bridge, so it can't reach a plugin. It
// gets the Live Activity and Download handlers the main page has, never the dictation one (the call holds the mic).
// With the biometric lock on, a return from the background past the relock time hides it (LockRules), so the
// shell's lock decides before the Mac's page shows again. Only the shell page may call this (ShellOnly.swift).
import Capacitor
import UIKit
import WebKit

@objc(CallLayerPlugin)
public class CallLayerPlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate, WKUIDelegate {
    public let identifier = "CallLayerPlugin"
    public let jsName = "CallLayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bubble", returnType: CAPPluginReturnPromise),
    ]

    private var page: WKWebView?
    /// The Mac origin the page was opened on (http://host:port); it never leaves it.
    private var pageOrigin: String?
    private var bubbleView: CallBubbleView?
    private var pausedAt: Int64 = 0
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.pausedAt = Int64(Date().timeIntervalSince1970 * 1000)
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.checkLock()
        })
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    // MARK: - Plugin methods

    @objc func show(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            guard let raw = call.getString("url"), let url = URL(string: raw), url.user == nil, url.password == nil,
                  let origin = ShellRules.originOf(raw), url.scheme == "http", ShellRules.macOrigin(origin) != nil else {
                call.reject("Bad page", "BAD_URL")
                return
            }
            guard let main = self.bridge?.webView else {
                call.reject("The phone couldn't do that.", "FAILED")
                return
            }
            if self.page == nil || self.pageOrigin != origin {
                self.dropPage()
                self.page = self.makePage(over: main)
                self.pageOrigin = origin
                self.page?.load(URLRequest(url: url))
            }
            self.page?.isHidden = false
            let bubble = self.bubbleView ?? self.makeBubble(over: main)
            bubble.isHidden = false
            bubble.update(Self.bubbleState(call))
            main.bringSubviewToFront(bubble)
            call.resolve(["shown": true])
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            self.page?.isHidden = true
            self.bubbleView?.isHidden = true
            call.resolve(["url": self.page?.url?.absoluteString ?? NSNull()])
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            let url = self.page?.url?.absoluteString
            self.dropPage()
            call.resolve(["url": url ?? NSNull()])
        }
    }

    @objc func bubble(_ call: CAPPluginCall) {
        fromShellOnly(call) {
            self.bubbleView?.update(Self.bubbleState(call))
            call.resolve()
        }
    }

    // MARK: - The page

    private func makePage(over main: WKWebView) -> WKWebView {
        let config = WKWebViewConfiguration()
        // The shell's cookie store (this call's session cookie) and its user agent: the Mac's UI sees the phone app
        // exactly as in the main WebView.
        config.websiteDataStore = main.configuration.websiteDataStore
        config.applicationNameForUserAgent = main.configuration.applicationNameForUserAgent
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let page = WKWebView(frame: main.bounds, configuration: config)
        page.customUserAgent = main.customUserAgent
        page.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        page.scrollView.contentInsetAdjustmentBehavior = main.scrollView.contentInsetAdjustmentBehavior
        page.isOpaque = main.isOpaque
        page.backgroundColor = main.backgroundColor
        page.scrollView.backgroundColor = main.scrollView.backgroundColor
        page.allowsBackForwardNavigationGestures = true
        if #available(iOS 16.4, *) { page.isInspectable = main.isInspectable }
        page.navigationDelegate = self
        page.uiDelegate = self
        page.configuration.userContentController.add(LiveActivityBridge(), name: LiveActivityBridge.handlerName)
        if let host = bridge?.viewController {
            page.configuration.userContentController.add(FileSaveBridge(host: host, webView: page), name: FileSaveBridge.handlerName)
        }
        // On the shell WebView itself (CAPBridgeViewController's view), above its content.
        main.addSubview(page)
        return page
    }

    private func dropPage() {
        if let page {
            page.stopLoading()
            page.navigationDelegate = nil
            page.uiDelegate = nil
            page.configuration.userContentController.removeAllScriptMessageHandlers()
            page.removeFromSuperview()
        }
        page = nil
        pageOrigin = nil
        bubbleView?.removeFromSuperview()
        bubbleView = nil
    }

    /// Back to the call: hide the page and the bubble and tell the shell where the page was.
    private func expand() {
        guard let page, !page.isHidden else { return }
        page.isHidden = true
        bubbleView?.isHidden = true
        notifyListeners("expand", data: ["url": page.url?.absoluteString ?? NSNull()])
    }

    /// With the lock on and the relock time passed, the shell must decide before the Mac's page shows again.
    private func checkLock() {
        guard let page, !page.isHidden, let shell = bridge?.config.localURL.absoluteString else { return }
        let settings = UserDefaults.standard.string(forKey: LockRules.settingsDefaultsKey)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if LockRules.resumeUrl(settings, shell: shell, current: page.url?.absoluteString, pausedAt: pausedAt, now: now) != nil {
            expand()
        }
    }

    private func isShell(_ url: URL) -> Bool {
        ShellRules.isShellPage(url.absoluteString, bridge?.config.localURL.absoluteString)
    }

    /// Where a link that isn't on the page's own origin goes: the app's page → back to the call; the web → Safari.
    private func leave(to url: URL) {
        if isShell(url) {
            expand()
        } else if url.scheme == "https" || url.scheme == "http" {
            UIApplication.shared.open(url)
        }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        // Frames inside the page (previews, about:blank) don't move the page.
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
            return
        }
        if ShellRules.originOf(url.absoluteString) == pageOrigin {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        leave(to: url)
    }

    /// target=_blank and window.open: the same origin opens in the page, anything else as a link.
    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if ShellRules.originOf(url.absoluteString) == pageOrigin { webView.load(navigationAction.request) } else { leave(to: url) }
        }
        return nil
    }

    /// iOS dropped the page's process (memory): load it again rather than show a blank page.
    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: - The bubble

    private func makeBubble(over main: WKWebView) -> CallBubbleView {
        let bubble = CallBubbleView()
        bubble.onTap = { [weak self] in self?.expand() }
        main.addSubview(bubble)
        bubble.placeInitially(in: main)
        bubbleView = bubble
        return bubble
    }

    private static func bubbleState(_ call: CAPPluginCall) -> CallBubbleView.State {
        CallBubbleView.State(
            label: CallLayerRules.label(call.getString("label")),
            state: CallLayerRules.state(call.getString("state")),
            alert: call.getBool("alert") ?? false)
    }
}

/// The floating call: a pill with a status dot and the clock. Drag it anywhere inside the safe area; tap to go back
/// to the call.
final class CallBubbleView: UIControl {
    struct State: Equatable {
        let label: String
        let state: CallLayerRules.BubbleState
        let alert: Bool
    }

    var onTap: (() -> Void)?

    private let dot = UIView()
    private let text = UILabel()
    private let badge = UIView()
    private var dragStart: CGPoint = .zero
    private static let height: CGFloat = 48
    private static let margin: CGFloat = 8

    init() {
        super.init(frame: CGRect(x: 0, y: 0, width: 104, height: Self.height))
        backgroundColor = UIColor(red: 0.06, green: 0.09, blue: 0.16, alpha: 0.94)
        layer.cornerRadius = Self.height / 2
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.3
        layer.shadowRadius = 8
        layer.shadowOffset = CGSize(width: 0, height: 3)
        dot.layer.cornerRadius = 5
        dot.isUserInteractionEnabled = false
        text.textColor = .white
        text.font = UIFont.monospacedDigitSystemFont(ofSize: 17, weight: .semibold)
        text.adjustsFontForContentSizeCategory = false
        text.isUserInteractionEnabled = false
        badge.backgroundColor = UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1)
        badge.layer.cornerRadius = 6
        badge.layer.borderWidth = 2
        badge.layer.borderColor = UIColor.white.cgColor
        badge.isHidden = true
        badge.isUserInteractionEnabled = false
        addSubview(dot)
        addSubview(text)
        addSubview(badge)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityHint = "Opens the call."
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
        addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(dragged(_:))))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(_ s: State) {
        text.text = s.label
        switch s.state {
        case .live: dot.backgroundColor = UIColor(red: 0.13, green: 0.77, blue: 0.37, alpha: 1)
        case .paused, .muted: dot.backgroundColor = UIColor(red: 0.98, green: 0.75, blue: 0.14, alpha: 1)
        }
        badge.isHidden = !s.alert
        let what = s.state == .paused ? "paused" : s.state == .muted ? "muted" : s.label
        accessibilityLabel = "Call with AASC, \(what)\(s.alert ? ", needs you" : "")"
        layoutContent()
    }

    private func layoutContent() {
        text.sizeToFit()
        let width = max(88, 16 + 10 + 8 + text.bounds.width + 18)
        let center = self.center
        bounds = CGRect(x: 0, y: 0, width: width, height: Self.height)
        if superview != nil { self.center = center }
        dot.frame = CGRect(x: 16, y: (Self.height - 10) / 2, width: 10, height: 10)
        text.frame = CGRect(x: 34, y: 0, width: text.bounds.width, height: Self.height)
        badge.frame = CGRect(x: width - 10, y: -2, width: 12, height: 12)
        if superview != nil { clamp() }
    }

    /// Right edge, a third of the way down: clear of the Mac page's top bar and its tab bar.
    func placeInitially(in container: UIView) {
        let safe = container.bounds.inset(by: container.safeAreaInsets)
        center = CGPoint(x: safe.maxX - bounds.width / 2 - Self.margin, y: safe.minY + safe.height / 3)
        clamp()
    }

    /// Kept inside the visible screen: not under the notch, the home bar or a screen edge.
    private func clamp() {
        guard let container = superview else { return }
        let safe = container.bounds.inset(by: container.safeAreaInsets).insetBy(dx: Self.margin, dy: Self.margin)
        let halfW = bounds.width / 2, halfH = bounds.height / 2
        center = CGPoint(
            x: min(max(center.x, safe.minX + halfW), max(safe.minX + halfW, safe.maxX - halfW)),
            y: min(max(center.y, safe.minY + halfH), max(safe.minY + halfH, safe.maxY - halfH)))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        clamp()  // rotation, or the safe area changing
    }

    @objc private func tapped() { onTap?() }

    @objc private func dragged(_ pan: UIPanGestureRecognizer) {
        guard let container = superview else { return }
        switch pan.state {
        case .began:
            dragStart = center
        case .changed:
            let moved = pan.translation(in: container)
            center = CGPoint(x: dragStart.x + moved.x, y: dragStart.y + moved.y)
            clamp()
        default:
            clamp()
        }
    }
}
