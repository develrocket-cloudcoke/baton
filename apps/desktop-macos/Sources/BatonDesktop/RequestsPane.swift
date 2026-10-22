import AppKit
import Combine
import SwiftUI
import WebKit

/// 창 컨트롤러가 앱 수명 동안 보관한다. View 재생성 시 웹뷰를 새로 만들거나 다시 읽지 않는다.
final class RequestsWebSession: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let webView: WKWebView
    @Published private(set) var serverURL: URL?
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var isLoading = false
    private weak var model: AppModel?
    private var observations: [NSKeyValueObservation] = []
    private var settingsSubscription: AnyCancellable?
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var destinations: [ObjectIdentifier: URL] = [:]
    /// 로그인 제공자(accounts 등) 주소. 로그인 화면 안의 링크(소셜 로그인·비밀번호 찾기)를 눌러도 창 밖으로 튕기지 않게 한다.
    /// 주소를 고정하지 않고 서버의 /v1/auth/describe 가 알려 주는 authorizeUrl·logoutUrl 의 host 를 쓴다.
    private var authHosts: Set<String> = []

    init(model: AppModel) {
        self.model = model
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // 페이지 안에서도 탐색 상태가 바뀌므로 버튼 조작이 아닌 웹뷰 속성을 관찰한다.
        observations = [
            webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] view, _ in
                self?.canGoBack = view.canGoBack
            },
            webView.observe(\.canGoForward, options: [.initial, .new]) { [weak self] view, _ in
                self?.canGoForward = view.canGoForward
            },
            webView.observe(\.isLoading, options: [.initial, .new]) { [weak self] view, _ in
                self?.isLoading = view.isLoading
            }
        ]
        settingsSubscription = NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshServer() }
        refreshServer()
    }

    func refreshServer() {
        let saved = SettingsStore.shared.savedServerURL
        guard saved != serverURL else { return }
        serverURL = saved
        webView.stopLoading()
        authHosts = []
        if let saved = saved {
            loadAuthHosts(server: saved)
            webView.load(URLRequest(url: saved.appendingPathComponent("requests")))
        } else {
            // 서버 설정을 지운 뒤 이전 서버 화면을 계속 보여 주지 않는다.
            webView.loadHTMLString("", baseURL: nil)
        }
    }

    private func loadAuthHosts(server: URL) {
        let url = server.appendingPathComponent("v1/auth/describe")
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            let hosts = ["authorizeUrl", "logoutUrl"].compactMap { (body[$0] as? String).flatMap(URL.init(string:))?.host?.lowercased() }
            DispatchQueue.main.async {
                guard let self, self.serverURL == server else { return }
                self.authHosts = Set(hosts).subtracting([server.host?.lowercased() ?? ""])
            }
        }.resume()
    }

    /// 창 안에서 열 주소: Baton 서버 또는 로그인 제공자.
    private func staysInApp(_ url: URL) -> Bool {
        isServerURL(url) || authHosts.contains(url.host?.lowercased() ?? "")
    }

    func open(_ url: URL?) {
        refreshServer()
        if let url = url, isServerURL(url) { webView.load(URLRequest(url: url)) }
    }

    func isServerURL(_ url: URL) -> Bool {
        guard let host = serverURL?.host else { return false }
        return url.host?.lowercased() == host.lowercased()
    }

    func openInBrowser() {
        if let url = webView.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, action.navigationType == .linkActivated, !staysInApp(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else if action.shouldPerformDownload {
            decisionHandler(.download)
        } else {
            // 로그인 제공자 주소는 고정하지 않는다. OAuth 리다이렉트·폼·JS 이동은 창 안에서 이어간다.
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.split(separator: ";").first?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "attachment"
        decisionHandler(!response.canShowMIMEType || attachment ? .download : .allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if staysInApp(url) { webView.load(action.request) }
        else { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        retainDownload(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        retainDownload(download)
    }

    private func retainDownload(_ download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let proposed = (suggestedFilename as NSString).lastPathComponent
            let name = proposed.isEmpty || proposed == "." || proposed == ".." ? "download" : proposed
            let extensionName = (name as NSString).pathExtension
            let stem = (name as NSString).deletingPathExtension
            var candidate = directory.appendingPathComponent(name)
            var suffix = 1
            // 진행 중인 내려받기도 예약해 동시에 같은 이름을 받는 경우 덮어쓰지 않는다.
            while FileManager.default.fileExists(atPath: candidate.path) || destinations.values.contains(candidate) {
                let numbered = "\(stem) (\(suffix))" + (extensionName.isEmpty ? "" : ".\(extensionName)")
                candidate = directory.appendingPathComponent(numbered)
                suffix += 1
            }
            destinations[ObjectIdentifier(download)] = candidate
            completionHandler(candidate)
        } catch {
            model?.log("내려받기 저장 위치 준비 실패: \(error.localizedDescription)")
            completionHandler(nil)
            releaseDownload(download)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = destinations[ObjectIdentifier(download)] {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
        releaseDownload(download)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        model?.log("내려받기 실패: \(error.localizedDescription)")
        releaseDownload(download)
    }

    private func releaseDownload(_ download: WKDownload) {
        let key = ObjectIdentifier(download)
        destinations.removeValue(forKey: key)
        downloads.removeValue(forKey: key)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let window = webView.window else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let window = webView.window else { completionHandler(); return }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "확인")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let window = webView.window else { completionHandler(false); return }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "확인")
        alert.addButton(withTitle: "취소")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard let window = webView.window else { completionHandler(nil); return }
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "확인")
        alert.addButton(withTitle: "취소")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        input.stringValue = defaultText ?? ""
        alert.accessoryView = input
        alert.window.initialFirstResponder = input
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        reportNavigationError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        reportNavigationError(error)
    }

    private func reportNavigationError(_ error: Error) {
        // 외부 브라우저 전환·다운로드 전환으로 취소된 탐색은 실패로 기록하지 않는다.
        let failure = error as NSError
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
        model?.log("요청 화면 탐색 실패: \(error.localizedDescription)")
    }
}

private struct RequestsWebView: NSViewRepresentable {
    let session: RequestsWebSession
    func makeNSView(context: Context) -> WKWebView { session.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

struct RequestsPane: View {
    @ObservedObject var session: RequestsWebSession
    var openSettings: () -> Void

    var body: some View {
        if session.serverURL == nil {
            VStack(spacing: 12) {
                Text("먼저 설정에서 서버 주소를 저장하고 페어링하세요")
                Button("설정 열기", action: openSettings)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Button { session.webView.goBack() } label: { Image(systemName: "chevron.left") }
                        .disabled(!session.canGoBack).help("뒤로 (⌘[)")
                    Button { session.webView.goForward() } label: { Image(systemName: "chevron.right") }
                        .disabled(!session.canGoForward).help("앞으로 (⌘])")
                    Button { session.webView.reload() } label: { Image(systemName: "arrow.clockwise") }
                        .help("새로고침 (⌘R)")
                    Button("브라우저에서 열기") { session.openInBrowser() }
                    Spacer()
                    if session.isLoading { ProgressView().controlSize(.small).help("불러오는 중") }
                }
                .controlSize(.small).padding(8)
                Divider()
                RequestsWebView(session: session)
            }
        }
    }
}
