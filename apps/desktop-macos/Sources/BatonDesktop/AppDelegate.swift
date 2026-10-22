import AppKit
import Combine
import SwiftUI
import WebKit
import BatonIPC

final class AppDelegate: NSObject, NSApplicationDelegate, DaemonSupervisorDelegate {
    let model = AppModel()
    let supervisor = DaemonSupervisor()
    /// 토큰 읽기·쓰기 전담 (main thread 밖). CLO-9 ①
    let tokens = TokenService()
    lazy var inbox = InboxStore(model: model, tokens: tokens)
    // UNUserNotificationCenter.current() 를 NSApplication 이 launch 를 시작하기 전(main.swift 의 AppDelegate() 생성 시점)에
    // 호출하면 이후 requestAuthorization 이 "Notifications are not allowed for this application" 으로 실패한다(실측).
    // 그래서 lazy 로 두고 applicationWillFinishLaunching 에서 처음 만든다.
    lazy var notifications = NotificationManager()   // init 에서 UNUserNotificationCenter.delegate 설정
    var statusItem: NSStatusItem!
    /// 상단바 아이콘을 누르면 뜨는 창(연결 상태·실행 중 작업·최근 알림). MenuBarPanel 참조
    private var popover: MenuBarPanel!
    /// 설정·활동 기록 창 (CLO-107). 열려 있는 동안에만 Dock 아이콘이 보인다.
    lazy var mainWindow = MainWindowController(model: model, actions: { [unowned self] in self.actions })
    /// 첫 실행(토큰 없음) 안내를 한 번만 띄우기 위한 표시. 나중에 pairing 을 풀어도 다시 뜨지 않는다.
    private var didOfferFirstRunSetup = false
    /// 상단바 아이콘을 상태(연결됨·연결 안 됨·실행 중)에 맞춰 바꾸기 위한 구독
    private var iconSubscription: AnyCancellable?
    private var iconState: MenuBarIcon.State?

    func applicationWillFinishLaunching(_ notification: Notification) {
        _ = notifications
    }

    /// 표준 편집 메뉴를 만든다.
    ///
    /// LSUIElement 앱이라 메뉴 막대에 보이지는 않지만, **⌘V·⌘C·⌘X·⌘A 는 mainMenu 의
    /// key equivalent 로 전달된다.** 메뉴가 없으면 responder chain 까지 가지 못해서
    /// 입력칸에 붙여넣기가 통째로 안 먹는다 (pairing 코드를 손으로 쳐야 했다).
    private func installMainMenu() {
        guard NSApp.mainMenu == nil else { return }
        let main = NSMenu()

        // 앱 메뉴: ⌘Q 도 여기에 걸려 있어야 한다
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Baton 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "편집")
        edit.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "다시 실행", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "오려두기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "복사하기", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "모두 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let navigationItem = NSMenuItem()
        let navigation = NSMenu(title: "요청")
        for (title, action, key) in [
            ("뒤로", #selector(requestsBack(_:)), "["),
            ("앞으로", #selector(requestsForward(_:)), "]"),
            ("새로고침", #selector(requestsReload(_:)), "r")
        ] {
            let item = navigation.addItem(withTitle: title, action: action, keyEquivalent: key)
            item.target = self
            item.keyEquivalentModifierMask = [.command]
        }
        navigationItem.submenu = navigation
        main.addItem(navigationItem)
        NSApp.mainMenu = main
    }

    // 다른 항목의 입력 중에는 웹 탐색 단축키가 숨은 페이지를 바꾸지 않는다.
    @objc private func requestsBack(_ sender: Any?) {
        if mainWindow.isVisible && model.windowPane == .requests { mainWindow.requests.webView.goBack() }
    }
    @objc private func requestsForward(_ sender: Any?) {
        if mainWindow.isVisible && model.windowPane == .requests { mainWindow.requests.webView.goForward() }
    }
    @objc private func requestsReload(_ sender: Any?) {
        if mainWindow.isVisible && model.windowPane == .requests { mainWindow.requests.webView.reload() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if MoveToApplications.interceptLaunch() { return }
        EjectInstallerVolumes.run { [weak self] line in self?.model.log(line) }
        installMainMenu()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let b = statusItem.button {
            b.target = self; b.action = #selector(togglePopover(_:))
        }
        updateStatusIcon()
        // 모델이 바뀔 때마다(연결 상태·진행 이벤트) 아이콘 상태를 다시 계산한다. 같으면 다시 그리지 않는다.
        iconSubscription = model.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.updateStatusIcon()
                self?.popover?.fitContent()   // 연결 상태에 따라 높이가 바뀐다
            }
        // CLO-107: 팝오버는 연결 상태·실행 중 작업·최근 알림만 담는다. 설정과 로그는 창으로 옮겼다.
        popover = MenuBarPanel(rootView: PopoverView(model: model, actions: actions))

        model.reloadDraft()
        // 토큰은 절대 main thread 에서 읽지 않는다 (Keychain ACL 프롬프트가 IPC 를 막는다) → 백그라운드 로드
        model.tokenStore = "\(TokenStore.label) (\(TokenStore.sourceNote))"
        tokens.onChange = { [weak self] status in
            guard let self = self else { return }
            self.model.tokenStatus = status.text
            if case .ready(let has) = status { self.model.hasToken = has } else { self.model.hasToken = false }
            self.model.log("토큰 저장소(\(TokenStore.label)) \(status.text)")
            // CLO-107 ⑤ 첫 실행: 토큰이 없으면 팝오버 대신 창을 열어 pairing 을 안내한다.
            // 처음 쓰는 사람이 상단바 아이콘을 찾는 것보다 창이 눈에 띈다.
            if case .ready(false) = status { self.offerFirstRunSetupOnce() }
            if case .ready(let has) = status { self.inbox.pairingChanged(hasToken: has) }
        }
        // 프롬프트에 늦게 응답해 토큰을 뒤늦게 읽은 경우: 데몬은 이미 not_paired 로 떨어져 있으므로 다시 알려 준다
        tokens.onLateSuccess = { [weak self] in
            guard let self = self else { return }
            self.model.log("토큰을 뒤늦게 읽었습니다 → 데몬에 settings.changed 로 재시도 알림")
            if let payload = try? IPCCodec.payload(of: SettingsChanged(settings: SettingsStore.shared.all())) {
                self.supervisor.send(type: MessageType.settingsChanged, payload: payload)
            }
        }
        tokens.load()
        inbox.start()
        // 개발 편의: 접근성 도구의 set-value 는 SwiftUI TextField 바인딩을 갱신하지 못하므로(실측) pairing code 를 미리 채울 수 있다
        if let preset = UserDefaults.standard.string(forKey: "shell.devPairingCode"), !preset.isEmpty { model.pairingCode = preset }
        notifications.onClick = { [weak self] id, requestId, webUrl, action in self?.notificationClicked(id: id, requestId: requestId, webUrl: webUrl, action: action) }
        notifications.requestAuthorization { [weak self] s in self?.applyNotificationStatus(s) }

        supervisor.delegate = self
        supervisor.commandLine = SettingsStore.shared.daemonCommand
        model.log("shell \(AppInfo.version) 시작, bundle=\(Bundle.main.bundleIdentifier ?? "-"), tokenStore=\(TokenStore.label), daemonCommand=\(supervisor.commandLine)")
        // CLO-117-a: 번들 내장 데몬을 쓰는지 저장소 개발본을 쓰는지, node 를 어디서 찾았는지 한 줄 남긴다.
        // 개발 중에 "왜 내 수정이 반영되지 않지?" 로 헤매지 않으려면 이 줄이 있어야 한다.
        applyRuntimePlan()
        supervisor.start()

        // 개발 편의: BATON_DEV_OPEN_POPOVER=1 이면 시작 1.5초 뒤 설정·기록 창을 연다 (접근성 도구로 UI 를 검사할 때 사용)
        // (`open` 으로 실행할 때는 환경변수를 못 넘기므로 `defaults write dev.baton.desktop shell.devOpenPanel -bool true` 도 허용)
        // CLO-107 이전에는 팝오버 내용을 담은 별도 폴백 패널을 띄웠는데, 이제 그 역할을 창이 대신한다.
        if ProcessInfo.processInfo.environment["BATON_DEV_OPEN_POPOVER"] == "1" || UserDefaults.standard.bool(forKey: "shell.devOpenPanel") {
            let pane = MainPane(rawValue: UserDefaults.standard.string(forKey: "shell.devWindowPane") ?? "") ?? .settings
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.mainWindow.show(pane: pane) }
        }
    }

    /// 데몬 런타임(데몬 파일·node·홈 디렉터리)을 살펴 모델과 로그에 반영한다 (CLO-117-a).
    /// node 가 없거나 버전이 낮으면 데몬을 띄우려다 조용히 실패하게 두지 않고 창에 해결 방법을 띄운다.
    func applyRuntimePlan() {
        let plan = DaemonRuntime.makePlan()
        model.daemonScriptSource = plan.script.label
        model.daemonNodeInfo = plan.node.label
        model.daemonHome = DaemonRuntime.daemonHome
        model.daemonExecutionsDir = DaemonRuntime.executionsDir
        model.daemonHomeFromEnv = DaemonRuntime.daemonHomeFromEnv
        model.daemonCommandIsCustom = SettingsStore.shared.hasCustomDaemonCommand
        model.log(plan.logLine)
        if SettingsStore.shared.hasCustomDaemonCommand {
            model.log("데몬 명령이 사용자 지정값으로 덮여 있습니다 — 자동 탐색 결과 대신 이 값을 씁니다: \(supervisor.commandLine)")
        }
        if let problem = plan.problem {
            model.runtimeProblemTitle = problem.title
            model.runtimeProblemDetail = problem.detail
            model.log("데몬을 띄울 수 없습니다: \(problem.title)")
            // 사용자가 무엇을 해야 하는지 보이도록 창을 연다. 로그만 남기면 상단바 아이콘만 보고는 알 수 없다.
            mainWindow.show(pane: .settings)
        } else {
            model.runtimeProblemTitle = nil
            model.runtimeProblemDetail = ""
        }
    }

    /// 첫 실행 안내 창을 한 번만 연다. 이미 창이 떠 있으면 그대로 둔다.
    private func offerFirstRunSetupOnce() {
        guard !didOfferFirstRunSetup, !mainWindow.isVisible else { return }
        didOfferFirstRunSetup = true
        model.log("첫 실행(토큰 없음) — 설정 창으로 pairing 을 안내한다")
        mainWindow.show(pane: .settings)
    }

    /// 시스템 설정에서 알림을 켜고 돌아오면 팝오버 표시가 바로 갱신되도록 활성화 시마다 다시 읽는다 (CLO-9 ④)
    func applicationDidBecomeActive(_ notification: Notification) {
        notifications.refreshAuthorization { [weak self] s in self?.applyNotificationStatus(s) }
    }

    /// 알림 권한 상태를 모델에 반영. `denied` 면 팝오버가 복구 안내와 "시스템 설정 열기" 버튼을 보여 준다.
    func applyNotificationStatus(_ status: NotificationManager.AuthState) {
        let changed = model.notificationAuth != status.text || model.notificationDenied != status.isDenied
        model.notificationAuth = status.text
        model.notificationDenied = status.isDenied
        if changed { model.log("알림 권한: \(status.text)") }
    }

    /// 시스템 설정 → 알림 창을 연다. macOS 13+ 는 Notifications-Settings.extension, 구버전은 preference.notifications.
    func openNotificationSettings() {
        let candidates = [
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.notifications"
        ]
        for raw in candidates {
            if let url = URL(string: raw), NSWorkspace.shared.open(url) {
                model.log("시스템 설정 → 알림 열기 (\(raw))")
                return
            }
        }
        model.log("시스템 설정 → 알림 열기 실패. 직접 시스템 설정 → 알림 → Baton 을 켜 주세요.")
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // 계약 §6-6: daemon.shutdown → ack/5s → SIGTERM → 3s → SIGKILL → 셸 종료
        supervisor.stop(reason: "app_quit") { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    private func updateStatusIcon() {
        let state: MenuBarIcon.State = !model.isConnected ? .disconnected : (model.runningLine != nil ? .running : .connected)
        guard let button = statusItem?.button else { return }
        if state != iconState {
            iconState = state
            button.image = MenuBarIcon.image(state)
        }
        button.title = model.inboxCount > 0 ? String(model.inboxCount) : ""
        button.imagePosition = model.inboxCount > 0 ? .imageLeading : .imageOnly
        button.font = .systemFont(ofSize: 11, weight: .medium)
        button.toolTip = button.image?.accessibilityDescription
    }

    // MARK: 팝오버

    @objc func togglePopover(_ sender: Any?) {
        if popover.isVisible { popover.close(); return }
        // 열린 창을 닫으려고 아이콘을 누르면, 창이 먼저 닫히고 이 클릭이 곧바로 다시 열려 한다 — 무시한다.
        if Date().timeIntervalSince(popover.lastClosedAt) < 0.3 { return }
        showPopover()
    }

    func showPopover() {
        inbox.refresh()
        guard let button = statusItem.button else { return }
        NSApp.activate(ignoringOtherApps: true)
        // PoC 실측: status item window 높이가 0 이면(노치 맥북 등에서 메뉴바가 넘쳐 아이콘이 숨은 경우) 붙일 자리가 없다.
        // 그때는 설정·기록 창을 연다 — 이 창의 내용은 그 창 안에서도 볼 수 있다.
        guard (button.window?.frame.height ?? 0) > 0 else {
            model.log("상단바 아이콘을 띄울 수 없어(메뉴바 overflow 추정) 설정·기록 창을 연다")
            mainWindow.show(pane: .activity)
            return
        }
        popover.show(below: button.window.map { $0.convertToScreen(button.convert(button.bounds, to: nil)) })
    }

    // MARK: 팝오버 동작

    var actions: ShellActions {
        ShellActions(
            quit: { NSApp.terminate(nil) },
            choosePath: { [weak self] key in
                let p = NSOpenPanel(); p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = false
                if p.runModal() == .OK, let url = p.url { self?.model.draft[key] = url.path }
            },
            chooseProjectPath: { [weak self] rowId in
                guard let self = self else { return }
                let p = NSOpenPanel(); p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = false
                guard p.runModal() == .OK, let url = p.url, let i = self.model.projectRows.firstIndex(where: { $0.id == rowId }) else { return }
                self.model.projectRows[i].path = url.path
                // 이름이 비어 있으면 디렉터리 이름을 기본값으로 넣는다
                if self.model.projectRows[i].name.trimmingCharacters(in: .whitespaces).isEmpty { self.model.projectRows[i].name = url.lastPathComponent }
            },
            saveSettings: { [weak self] in self?.saveSettings() },
            startPairing: { [weak self] in self?.startPairing() },
            requestNotificationAuth: { [weak self] in self?.notifications.requestAuthorization { s in self?.applyNotificationStatus(s) } },
            openNotificationSettings: { [weak self] in self?.openNotificationSettings() },
            setLaunchAtLogin: { [weak self] on in
                do { try LoginItem.set(enabled: on); self?.model.log("로그인 항목 \(on ? "등록" : "해제")") }
                catch { self?.model.log("로그인 항목 변경 실패: \(error.localizedDescription)") }
                self?.model.launchAtLogin = LoginItem.isEnabled; self?.model.loginItemStatus = LoginItem.statusText()
            },
            restartDaemon: { [weak self] in self?.supervisor.restart(reason: "restart") },
            saveDaemonCommand: { [weak self] in
                guard let self = self else { return }
                SettingsStore.shared.daemonCommand = self.model.daemonCommand
                self.supervisor.commandLine = self.model.daemonCommand
                self.model.daemonCommandIsCustom = true
                self.model.log("daemonCommand 저장: \(self.model.daemonCommand)")
            },
            resetDaemonCommand: { [weak self] in
                guard let self = self else { return }
                SettingsStore.shared.resetDaemonCommand()
                let auto = SettingsStore.defaultDaemonCommand
                self.model.daemonCommand = auto
                self.supervisor.commandLine = auto
                self.applyRuntimePlan()
                self.model.log("daemonCommand 를 자동 탐색값으로 되돌렸습니다: \(auto)")
                self.supervisor.restart(reason: "daemonCommand reset")
            },
            openNotification: { [weak self] n in self?.openWebUrl(n.webUrl) },
            openInbox: { [weak self] requestId in
                guard let self = self, let server = SettingsStore.shared.savedServerURL else { return }
                var url = server.appendingPathComponent("requests")
                if let requestId = requestId { url.appendPathComponent(requestId) }
                if self.popover.isVisible { self.popover.close() }
                self.mainWindow.show(pane: .requests, url: url)
            },
            openWindow: { [weak self] pane in
                guard let self = self else { return }
                // 팝오버를 먼저 닫아야 창이 앞으로 올라온다 (transient 팝오버가 key window 를 잡고 있다)
                if self.popover.isVisible { self.popover.close() }
                self.mainWindow.show(pane: pane)
            },
            log: { [weak self] line in self?.model.log(line) }
        )
    }

    func saveSettings() {
        let patch = model.patchFromDraft()
        SettingsStore.shared.apply(patch: patch)
        model.reloadDraft()
        let all = SettingsStore.shared.all()
        if let payload = try? IPCCodec.payload(of: SettingsChanged(settings: all)) { supervisor.send(type: MessageType.settingsChanged, payload: payload) }
        model.log("설정 저장 (\(patch.keys.sorted().joined(separator: ","))) 프로젝트 \(model.projectRows.count)개")
    }

    func startPairing() {
        let code = model.pairingCode.trimmingCharacters(in: .whitespaces)
        guard !code.isEmpty else { return }
        model.pairingStatus = "pairing 중…"
        let payload = (try? IPCCodec.payload(of: PairStart(pairingCode: code, deviceName: SettingsStore.shared.string("deviceName")))) ?? .object([:])
        // 데몬이 죽어 있어도 pairing 은 돼야 한다. 필요하면 먼저 띄운다.
        supervisor.ensureRunning { [weak self] ok in
            guard let self = self else { return }
            guard ok else {
                self.model.pairingStatus = "실패: 데몬을 시작하지 못했습니다 (설정 → 데몬 런타임 확인)"
                return
            }
            self.sendPairStart(payload: payload)
        }
    }

    private func sendPairStart(payload: JSONValue) {
        supervisor.request(type: MessageType.pairStart, payload: payload, timeout: 30) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let env):
                if let r = try? IPCCodec.payload(env, as: PairResult.self) {
                    self.model.pairingStatus = r.ok ? "완료: \(r.deviceId ?? "")" : "실패: \(r.error?.message ?? "?")"
                    if r.ok { self.model.pairingCode = "" }
                } else { self.model.pairingStatus = "응답 해석 실패 (\(env.type))" }
            case .failure(let e): self.model.pairingStatus = "실패: \(e.message)"
            }
            self.tokens.load(force: true)
            self.model.reloadDraft()
        }
    }

    // MARK: 알림 클릭 → webUrl open + notification.clicked

    func notificationClicked(id: String, requestId: String?, webUrl: String?, action: String) {
        model.log("알림 클릭 id=\(id) action=\(action)")
        if action == "default" { openWebUrl(webUrl) }
        let payload = (try? IPCCodec.payload(of: NotificationClicked(notificationId: id, requestId: requestId, webUrl: webUrl, action: action, clickedAt: Envelope.now()))) ?? .object([:])
        supervisor.request(type: MessageType.notificationClicked, payload: payload) { [weak self] result in
            if case .failure(let e) = result { self?.model.log("notification.clicked 전달 실패: \(e.message)") }
        }
    }

    /// http/https 만 연다 (계약 §3.3 request.notify.webUrl)
    func openWebUrl(_ s: String?) {
        guard let s = s, let url = URL(string: s), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        if let host = SettingsStore.shared.savedServerURL?.host,
           url.host?.lowercased() == host.lowercased() {
            if popover?.isVisible == true { popover.close() }
            mainWindow.show(pane: .requests, url: url)
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: DaemonSupervisorDelegate

    /// 핸드셰이크 응답은 절대 기다리면 안 된다(데몬 hello timeout 10초). 아직 못 읽었으면 토큰 없이 보내고,
    /// 데몬은 뒤이어 `token.get` 으로 다시 물어본다 (그쪽은 TokenService 가 비동기로 답한다).
    func shellHello(for supervisor: DaemonSupervisor) -> ShellHello {
        let token = tokens.tokenIfLoaded
        if token == nil { tokens.load() }
        model.log("shell.hello hasToken=\(token != nil) tokenStore=\(TokenStore.label) serverUrl=\(SettingsStore.shared.string("serverUrl") ?? "-")")
        return ShellHello(protocol: ipcProtocolVersion, shellVersion: AppInfo.version, platform: "macos", settings: SettingsStore.shared.all(), deviceToken: token)
    }

    func supervisor(_ supervisor: DaemonSupervisor, handleRequest env: Envelope, reply: @escaping (Result<(type: String, payload: JSONValue), IPCError>) -> Void) {
        // 토큰 계열만 비동기(TokenService 직렬 큐), 나머지는 UserDefaults/알림이라 즉답한다.
        switch env.type {
        case MessageType.tokenGet:
            // 프롬프트가 떠 있으면 여기서 바로 답하지 않고 기다린다. 그동안에도 main queue 는 비어 있어 IPC 가 계속 돈다.
            tokens.token { [weak self] result in
                switch result {
                case .success(let token):
                    guard let payload = try? IPCCodec.payload(of: TokenValue(deviceToken: token)) else {
                        reply(.failure(IPCError(code: .internal, message: "token.value 직렬화 실패"))); return
                    }
                    reply(.success((MessageType.tokenValue, payload)))
                case .failure(let e):
                    self?.model.log("token.get 실패 (\(TokenStore.label)): \(e.message)")
                    reply(.failure(e))
                }
            }
            return
        case MessageType.tokenSet:
            guard let t = try? IPCCodec.payload(env, as: TokenSet.self) else {
                reply(.failure(IPCError(code: .invalidPayload, message: "token.set payload"))); return
            }
            tokens.write(t.deviceToken) { [weak self] result in
                guard let self = self else { return }
                switch result {
                case .success:
                    self.model.log("토큰 \(t.deviceToken == nil ? "삭제" : "저장") (\(TokenStore.label))")
                    guard let payload = try? IPCCodec.payload(of: TokenValue(deviceToken: t.deviceToken)) else {
                        reply(.failure(IPCError(code: .internal, message: "token.value 직렬화 실패"))); return
                    }
                    reply(.success((MessageType.tokenValue, payload)))
                case .failure(let e):
                    self.model.log("토큰 저장 실패 (\(TokenStore.label)): \(e.message)")
                    reply(.failure(e))
                }
            }
            return
        default:
            break
        }
        do { reply(.success(try handleSyncRequest(env))) }
        catch let e as IPCError { reply(.failure(e)) }
        catch { reply(.failure(IPCError(code: .internal, message: "\(error)"))) }
    }

    /// 즉답 가능한(블록하지 않는) request 들
    private func handleSyncRequest(_ env: Envelope) throws -> (type: String, payload: JSONValue) {
        switch env.type {
        case MessageType.requestNotify:
            let n = try IPCCodec.payload(env, as: RequestNotify.self)
            notifications.post(id: n.notificationId, title: n.title, body: n.body, requestId: n.requestId, webUrl: n.webUrl)
            let item = NotificationItem(id: n.notificationId, kind: n.kind ?? "generic", requestId: n.requestId, title: n.title, body: n.body, webUrl: n.webUrl, at: Date())
            model.notifications.removeAll { $0.id == item.id }
            model.notifications.insert(item, at: 0)
            if model.notifications.count > 5 { model.notifications.removeLast(model.notifications.count - 5) }
            model.log("알림 게시 \(n.notificationId): \(n.title)")
            inbox.refresh()
            return (MessageType.ack, .object([:]))
        case MessageType.notificationDismiss:
            // 04 §10: 팀 뿌리기 요청을 다른 팀원이 claim → 배너 제거, 알림 탭 항목은 "처리 중: 이름" 으로 갱신
            let d = try IPCCodec.payload(env, as: NotificationDismiss.self)
            var ids: [String] = []
            for i in model.notifications.indices where (d.notificationId != nil && model.notifications[i].id == d.notificationId) || (d.notificationId == nil && d.requestId != nil && model.notifications[i].requestId == d.requestId) {
                ids.append(model.notifications[i].id)
                model.notifications[i].note = d.note
                if d.reason == "claimed" { model.notifications[i].kind = "request.claimed" }
            }
            if ids.isEmpty, let id = d.notificationId { ids = [id] }   // 목록에 없어도(재시작 등) 시스템 알림은 지운다
            notifications.remove(ids: ids)
            model.log("알림 제거 (\(d.reason)) \(ids.joined(separator: ",")) \(d.note ?? "")")
            return (MessageType.ack, .object([:]))
        case MessageType.settingsGet:
            let g = try IPCCodec.payload(env, as: SettingsGet.self)
            var all = SettingsStore.shared.all()
            if let keys = g.keys { all = all.filter { keys.contains($0.key) } }
            return (MessageType.settingsValue, try IPCCodec.payload(of: SettingsValue(settings: all)))
        case MessageType.settingsSet:
            let s = try IPCCodec.payload(env, as: SettingsSet.self)
            SettingsStore.shared.apply(patch: s.patch)
            model.reloadDraft()
            if let d = s.patch["deviceId"]?.stringValue { model.deviceId = d }
            return (MessageType.settingsValue, try IPCCodec.payload(of: SettingsValue(settings: SettingsStore.shared.all())))
        default:
            throw IPCError(code: .unknownType, message: env.type)
        }
    }

    func supervisor(_ supervisor: DaemonSupervisor, handleEvent env: Envelope) {
        switch env.type {
        case MessageType.daemonStatus:
            guard let s = try? IPCCodec.payload(env, as: DaemonStatus.self) else { model.log("daemon.status payload 오류"); return }
            let previousConnectionState = model.connectionState
            model.connectionState = s.state
            if s.state == "connected", previousConnectionState != "connected" { inbox.refresh() }
            if let d = s.deviceId { model.deviceId = d }
            if let p = s.providers { model.providers = p }
            model.lastError = s.lastError.map { "\($0.code): \($0.message)" }
        case MessageType.executionProgress:
            guard let p = try? IPCCodec.payload(env, as: ExecutionProgress.self) else { return }
            model.progress.append(ProgressItem(phase: p.phase, message: String(p.message.prefix(400)), at: p.at ?? env.ts))
            if model.progress.count > AppModel.progressLimit { model.progress.removeFirst(model.progress.count - AppModel.progressLimit) }
        case MessageType.settingsSchema:
            guard let s = try? IPCCodec.payload(env, as: SettingsSchema.self) else { return }
            SettingsStore.shared.schema = s.fields
            model.fields = s.fields
            model.reloadDraft()
        case MessageType.daemonLog:
            if let l = try? IPCCodec.payload(env, as: DaemonLog.self) { model.log("[daemon:\(l.level)] \(l.message)") }
        default: break
        }
    }

    func supervisor(_ supervisor: DaemonSupervisor, stateChanged state: DaemonSupervisor.State) {
        switch state {
        case .stopped: model.daemonState = "stopped"; model.connectionState = "idle"
        case .starting(let pid): model.daemonState = "starting(\(pid))"
        case .running(let pid): model.daemonState = "running(\(pid))"; model.daemonVersionLine = "daemon pid \(pid)"
        case .backoff(let s, let code): model.daemonState = "backoff \(s)s"; model.connectionState = "idle"; model.lastError = "daemon_exited: exit \(code)"
        case .failed(let r): model.daemonState = "failed"; model.lastError = r
        }
        model.log("daemon state: \(model.daemonState)")
    }
}
