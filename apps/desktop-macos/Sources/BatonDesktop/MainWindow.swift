import AppKit
import SwiftUI

/// 창의 사이드바 항목 (CLO-107). 팝오버의 "설정 열기"·"기록 열기" 가 이 값을 지정해 창을 연다.
enum MainPane: String, Hashable, CaseIterable {
    case requests
    case settings
    case activity

    var title: String {
        switch self {
        case .requests: return "요청"
        case .settings: return "설정"
        case .activity: return "활동 기록"
        }
    }
    var symbol: String {
        switch self {
        case .requests: return "tray.full"
        case .settings: return "gearshape"
        case .activity: return "list.bullet.rectangle"
        }
    }
}

/// 설정·활동 기록 창 (CLO-107).
///
/// 상단바 앱은 그대로 두고(`LSUIElement=true`), 자주 쓰지 않지만 화면을 많이 먹는 일만 이 창으로 덜어낸다.
/// 팝오버는 다른 곳을 클릭하면 닫히므로 로그를 읽으면서 다른 창을 함께 볼 수 없었다 — 그 문제를 푸는 것이 이 창의 존재 이유다.
///
/// Dock 아이콘은 **창이 열려 있는 동안에만** 보인다. 열 때 `.regular`, 닫을 때 `.accessory` 로 되돌린다.
final class MainWindowController: NSObject, NSWindowDelegate {
    static let frameAutosaveName = "BatonMainWindow"

    private let model: AppModel
    private let actionsProvider: () -> ShellActions
    private var window: NSWindow?
    // SwiftUI 항목 전환과 창 닫힘에도 웹뷰·로그인·스크롤을 유지한다.
    lazy var requests = RequestsWebSession(model: model)

    init(model: AppModel, actions: @escaping () -> ShellActions) {
        self.model = model
        self.actionsProvider = actions
    }

    var isVisible: Bool { window?.isVisible == true }

    /// 창을 열고 지정한 사이드바 항목을 고른다. 이미 열려 있으면 항목만 바꾸고 앞으로 가져온다.
    func show(pane: MainPane = .requests, url: URL? = nil) {
        model.windowPane = pane
        if pane == .requests { requests.open(url) }
        let window = ensureWindow()
        // `.accessory → .regular` 전환은 앱의 활성화 상태를 다시 계산하게 만든다. 전환 **뒤에** activate 하고,
        // 다음 런루프에서 한 번 더 앞으로 올려야 창이 다른 앱 뒤로 내려가지 않는다(실측).
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
            model.log("창 열림 → Dock 아이콘 표시 (.regular)")
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        DispatchQueue.main.async { [weak self] in
            NSApp.activate(ignoringOtherApps: true)
            self?.window?.makeKeyAndOrderFront(nil)
        }
    }

    func close() {
        window?.performClose(nil)
    }

    private func ensureWindow() -> NSWindow {
        if let w = window { return w }
        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        w.title = "Baton"
        // 최소 크기는 사용자가 드래그로 줄일 때 걸린다. contentMinSize 도 함께 정해 둔다
        // (접근성 도구의 `set size` 는 setFrame 과 같아 이 제한을 우회한다 — 사용자 경로가 아니다).
        w.minSize = NSSize(width: 720, height: 460)
        w.contentMinSize = NSSize(width: 720, height: 430)
        // 창을 닫아도 해제하지 않는다. 다시 열 때 같은 인스턴스를 쓰고 크기·위치가 유지된다.
        w.isReleasedWhenClosed = false
        w.delegate = self
        // NSHostingController 는 기본적으로 SwiftUI 의 fitting size 를 창에 밀어 넣는다. NavigationSplitView 는
        // 그 값이 화면 폭만큼 커서 창이 1512pt 로 열렸다(실측). `sizingOptions = []` 로 크기 전파를 끄고
        // 창 크기는 아래 setContentSize 와 minSize 로 직접 정한다.
        let host = NSHostingController(rootView: MainWindowView(model: model, actions: actionsProvider(), requests: requests))
        host.sizingOptions = []
        w.contentViewController = host
        w.setContentSize(NSSize(width: 1100, height: 760))
        // 지난번 크기·위치가 있으면 복원하고, 없으면 화면 가운데에 놓는다.
        if !w.setFrameUsingName(MainWindowController.frameAutosaveName) { w.center() }
        w.setFrameAutosaveName(MainWindowController.frameAutosaveName)
        window = w
        return w
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        // 닫히는 도중에 policy 를 바꾸면 Dock 아이콘이 남거나 앱이 활성 상태로 굳는다 → 다음 런루프로 미룬다.
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.window?.isVisible != true else { return }
            NSApp.setActivationPolicy(.accessory)
            self.model.log("창 닫힘 → Dock 아이콘 숨김 (.accessory)")
        }
    }
}

// MARK: - 창 본문

struct MainWindowView: View {
    @ObservedObject var model: AppModel
    var actions: ShellActions
    var requests: RequestsWebSession

    var body: some View {
        NavigationSplitView {
            List(selection: $model.windowPane) {
                ForEach(MainPane.allCases, id: \.self) { pane in
                    Label(pane.title, systemImage: pane.symbol).tag(pane)
                }
            }
            .navigationSplitViewColumnWidth(min: 150, ideal: 170, max: 220)
            .safeAreaInset(edge: .bottom) { sidebarFooter }
        } detail: {
            switch model.windowPane {
            case .requests: RequestsPane(session: requests, openSettings: { actions.openWindow(.settings) })
            case .settings: SettingsPane(model: model, actions: actions)
            case .activity: ActivityPane(model: model, actions: actions)
            }
        }
        .tint(BrandColor.blue)
        .navigationTitle("Baton")
        .navigationSubtitle(model.windowPane.title)
    }

    /// 사이드바 아래에 연결 상태를 고정해 둔다. 창만 열어 둔 채로도 상태를 볼 수 있다.
    var sidebarFooter: some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider()
            HStack(spacing: 6) {
                Circle().fill(StatusPalette.color(model)).frame(width: 8, height: 8)
                Text(StatusPalette.text(model)).font(.caption)
                Spacer()
            }
            Text(model.hasToken ? "이 Mac의 작업 연결" : "설정에서 계정을 연결하세요")
                .font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary)
        }
        .padding(.horizontal, 12).padding(.bottom, 10)
    }
}

/// 연결 상태 뱃지 색·문구. 팝오버와 창이 같은 규칙을 쓴다.
enum StatusPalette {
    static func color(_ model: AppModel) -> Color {
        switch model.connectionState {
        case "connected": return .green
        case "running": return BrandColor.blue
        case "connecting": return .orange
        default: return model.daemonState.hasPrefix("backoff") || model.daemonState.hasPrefix("failed") ? .red : .gray
        }
    }

    static func text(_ model: AppModel) -> String {
        if model.daemonState.hasPrefix("failed") { return "연결 프로그램 확인 필요" }
        if model.daemonState.hasPrefix("backoff") { return "연결 프로그램 다시 시작 중" }
        if model.daemonState == "stopped" { return "연결 프로그램 꺼짐" }
        if model.daemonState.hasPrefix("starting") { return "연결 준비 중" }
        switch model.connectionState {
        case "connected": return "작업 받을 준비가 됐습니다"
        case "running": return "작업 실행 중"
        case "connecting": return "서버에 연결하는 중"
        default: return model.hasToken ? "연결 상태 확인 필요" : "계정 연결이 필요합니다"
        }
    }
}
