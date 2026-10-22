import SwiftUI
import AppKit

/// 창의 "설정" 화면 (CLO-107). 예전 팝오버 설정 탭의 내용을 그대로 옮기되 폭이 넓어져 스크롤이 훨씬 짧다.
/// 서버 URL·pairing·프로젝트 목록·디바이스 정보·토큰 저장소·로그인 항목·알림 권한이 여기 모인다.
struct SettingsPane: View {
    @ObservedObject var model: AppModel
    var actions: ShellActions

    @State private var advanced = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 48, height: 48)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Baton").font(.title.bold())
                        Text("웹에서 받은 작업을 이 Mac의 프로젝트에서 실행합니다.")
                            .font(.callout).foregroundColor(.secondary)
                    }
                }
                if let help = model.connectionHelp {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(help, systemImage: "exclamationmark.circle").font(.callout)
                        if let raw = model.lastError { Text(raw).font(.caption2).foregroundColor(.secondary).lineLimit(3).textSelection(.enabled) }
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(nsColor: .controlBackgroundColor)).cornerRadius(10)
                }
                if let title = model.runtimeProblemTitle { runtimeProblem(title) }
                if model.isConnected {
                    section("이 Mac의 연결", "desktopcomputer") { connectionSummary }
                    section("프로젝트 관리", "folder") { projectSection }
                    section("알림", "bell") { notificationSection }
                    section("자동 실행", "power") { loginItemSection }
                } else {
                    Text("처음 연결하기").font(.title2.bold())
                    Text("서버 주소를 저장하고 계정에 연결한 뒤, 작업할 폴더를 등록하세요.")
                        .font(.callout).foregroundColor(.secondary)
                    section("서버 주소", "network") {
                        completion(serverAddressSaved ? "주소 저장됨" : "서버 주소 입력 후 저장 필요", complete: serverAddressSaved)
                        serverSection
                    }
                    section("계정 연결", "qrcode") {
                        completion(model.hasToken ? "연결 정보 저장됨 · 서버 확인 중" : "연결 코드 입력 필요", complete: model.hasToken)
                        pairingSection
                    }
                    section("프로젝트 폴더", "folder") {
                        completion(model.projectRows.contains { $0.projectId != nil } ? "등록된 프로젝트 있음" : "폴더 선택 후 저장 필요", complete: model.projectRows.contains { $0.projectId != nil })
                        projectSection
                    }
                }
                DisclosureGroup("고급 · 문제 해결", isExpanded: $advanced) {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("연결 문제가 계속될 때 확인하는 기술 정보입니다. 보통은 변경할 필요가 없습니다.")
                            .font(.caption).foregroundColor(.secondary)
                        if model.isConnected {
                            section("서버 주소 변경", "network") { serverSection }
                            section("계정 다시 연결", "qrcode") { pairingSection }
                        }
                        section("연결 프로그램 정보", "shippingbox") { runtimeSection }
                        section("연결 프로그램 설정", "terminal") { daemonSection }
                        section("연결 진단", "stethoscope") {
                            deviceSection
                            labeled("토큰 저장소", model.tokenStore)
                            labeled("읽기 상태", model.tokenStatus)
                        }
                    }.padding(.top, 12)
                }
            }
            .padding(24)
            .frame(maxWidth: 720, alignment: .leading)
        }
        .tint(BrandColor.blue)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    var serverAddressSaved: Bool {
        guard case .string(let saved) = SettingsStore.shared.value("serverUrl") else { return false }
        return !saved.isEmpty && saved == model.draft["serverUrl"]
    }

    var connectionSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(StatusPalette.text(model), systemImage: "checkmark.circle.fill").foregroundColor(BrandColor.blue)
            labeled("서버", model.draft["serverUrl"] ?? "미설정")
            labeled("이 Mac 이름", model.draft["deviceName"] ?? "미설정")
            labeled("사용 가능한 AI", model.providers.isEmpty ? "아직 찾지 못했습니다. 사용할 AI 도구가 설치돼 있는지 확인해 주세요." : model.providers.map(Self.agentLabel).joined(separator: ", "))
        }
    }

    func completion(_ title: String, complete: Bool) -> some View {
        Label(title, systemImage: complete ? "checkmark.circle.fill" : "circle")
            .font(.caption).foregroundColor(complete ? BrandColor.blue : Color.secondary)
    }

    /// node 가 없거나 버전이 낮아 데몬을 못 띄울 때의 안내 (CLO-117-a ③).
    /// 조용히 재시작 백오프만 돌면 사용자는 "왜 안 되는지" 를 영원히 모른다.
    func runtimeProblem(_ title: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.orange)
                Text(title).font(.headline)
            }
            Text("작업 실행에 필요한 프로그램을 준비하지 못했습니다. 안내에 따라 설치한 뒤 다시 확인해 주세요.").font(.callout)
            Text(model.runtimeProblemDetail)
                .font(.system(size: 12, design: .monospaced))
                .foregroundColor(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Node 내려받기 페이지 열기") { NSWorkspace.shared.open(URL(string: "https://nodejs.org/")!) }
                Button("다시 확인") { actions.resetDaemonCommand() }
                Spacer()
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12))
        .cornerRadius(8)
    }

    // MARK: 데몬 런타임 (CLO-117-a)
    // 앱만 설치해도 돌아야 하므로, 지금 **어느 데몬 파일과 어느 node 를 쓰는지** 를 숨기지 않고 그대로 보여 준다.
    // 개발자는 저장소 개발본을 쓰는지 번들 내장을 쓰는지 여기서 바로 구분할 수 있다.

    var runtimeSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            labeled("실행 파일", model.daemonScriptSource)
            labeled("Node", model.daemonNodeInfo,
                    color: model.runtimeProblemTitle == nil ? .primary : .orange)
            labeled("데이터 폴더", model.daemonHome + (model.daemonHomeFromEnv ? "  (BATON_HOME 환경변수)" : "  (기본값)"))
            labeled("실행 산출물", model.daemonExecutionsDir)
            Text("토큰·설정·실행 기록(프롬프트·결과·patch)이 모두 데이터 폴더에 저장됩니다. 저장소 위치와는 무관합니다.")
                .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("데이터 폴더 열기") { NSWorkspace.shared.open(URL(fileURLWithPath: model.daemonHome)) }
                    .disabled(!FileManager.default.fileExists(atPath: model.daemonHome))
                Button("로그 폴더 열기") { NSWorkspace.shared.open(FileLog.directory) }
                Spacer()
            }
        }
    }

    // MARK: 섹션 골격

    @ViewBuilder
    func section<Content: View>(_ title: String, _ symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: symbol).foregroundColor(BrandColor.blue)
                Text(title).font(.system(size: 14, weight: .semibold))
            }
            Text(sectionHelp(title)).font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    func sectionHelp(_ title: String) -> String {
        switch title {
        case "서버 주소", "서버 주소 변경": return "웹에서 사용하는 Baton 서버 주소를 입력합니다. 다른 서버로 바꾸면 계정을 다시 연결해야 합니다."
        case "계정 연결", "계정 다시 연결": return "웹의 내 디바이스 → 디바이스 추가에서 받은 코드를 입력하면 이 Mac으로 작업을 받을 수 있습니다."
        case "프로젝트 폴더", "프로젝트 관리": return "AI가 실제 파일을 읽고 수정할 로컬 폴더입니다. 웹에서 작업을 실행할 때 이 목록에서 고릅니다."
        case "이 Mac의 연결": return "웹 계정에 연결된 서버와 이 Mac에서 사용할 수 있는 AI 도구를 확인합니다."
        case "알림": return "새 요청과 작업 완료 소식을 놓치지 않도록 macOS 알림을 허용해 주세요."
        case "자동 실행": return "Mac에 로그인할 때 Baton을 열어 작업 요청을 받을 수 있게 합니다."
        case "연결 프로그램 정보": return "설치된 실행 프로그램과 기록 저장 위치를 확인합니다."
        case "연결 프로그램 설정": return "자동 탐색이 실패한 경우에만 실행 명령을 바꾸거나 프로그램을 재시작하세요."
        default: return "문제 해결을 요청할 때 연결 상태와 기술 정보를 확인할 수 있습니다."
        }
    }

    // MARK: 서버 URL 등 settings.schema 기반 필드

    var serverSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            // 프로젝트 목록은 아래 전용 섹션에서, deviceId 같은 읽기 전용 값은 "디바이스" 섹션에서 그린다
            ForEach(model.fields.filter { $0.hidden != true && ["serverUrl", "deviceName"].contains($0.key) }, id: \.key) { f in
                VStack(alignment: .leading, spacing: 3) {
                    Text(f.key == "serverUrl" ? "서버 주소" : "이 Mac 이름").font(.caption).foregroundColor(.secondary)
                    if f.type == "bool" {
                        Toggle("", isOn: Binding(get: { model.draft[f.key] == "true" }, set: { model.draft[f.key] = $0 ? "true" : "false" })).labelsHidden()
                    } else {
                        HStack {
                            TextField(f.key == "serverUrl" ? "https://baton.example.com" : "웹에서 구별할 Mac 이름", text: Binding(get: { model.draft[f.key] ?? "" }, set: { model.draft[f.key] = $0 }))
                                .textFieldStyle(.roundedBorder)
                            if f.type == "path" { Button("선택…") { actions.choosePath(f.key) } }
                        }
                    }
                }
            }
            HStack {
                Button("주소와 이름 저장") { actions.saveSettings() }.buttonStyle(.borderedProminent).tint(BrandColor.deepBlue).keyboardShortcut("s", modifiers: .command)
                Spacer()
            }
        }
    }

    // MARK: Pairing + 토큰 저장소

    var pairingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            // 05 §3.4: 웹 "내 디바이스" 에서 발급한 사용자별 1회용 코드 (10분)
            Text("웹 → 내 디바이스에서 발급한 코드 (XXXX-XXXX, 10분 안에 입력)").font(.caption).foregroundColor(.secondary)
            HStack {
                TextField("XXXX-XXXX", text: $model.pairingCode)
                    .textFieldStyle(.roundedBorder).font(.system(size: 13, design: .monospaced)).frame(width: 200)
                    .onSubmit { if !model.pairingCode.isEmpty { actions.startPairing() } }
                Button("이 Mac 연결하기") { actions.startPairing() }.buttonStyle(.borderedProminent).tint(BrandColor.orange).foregroundColor(.black).disabled(model.pairingCode.isEmpty)
                Spacer()
            }
            // 만료·재사용 등 서버가 준 403 사유(pair.result.error.message)를 그대로 보여 준다
            if !model.pairingStatus.isEmpty {
                Text(model.pairingStatus).font(.caption)
                    .foregroundColor(model.pairingStatus.hasPrefix("실패") ? .red : .primary)
                    .textSelection(.enabled)
            }

        }
    }

    // MARK: 프로젝트 목록 (04 §11.1)
    // 이름 + 로컬 경로를 여러 개 등록한다. 저장하면 데몬이 각각 서버 Project 로 등록하고 projectId 를 채워 준다.

    var projectSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.projectRows.isEmpty {
                Text("등록된 프로젝트가 없습니다. \"프로젝트 추가\" 로 이름과 로컬 경로를 넣고 설정을 저장하세요.")
                    .font(.caption).foregroundColor(.secondary)
            }
            ForEach($model.projectRows) { $row in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        TextField("프로젝트 이름", text: $row.name).textFieldStyle(.roundedBorder).frame(width: 120)
                        TextField("로컬 경로", text: $row.path).textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
                        Button("폴더 선택…") { actions.chooseProjectPath(row.id) }
                        Button(action: { model.projectRows.removeAll { $0.id == row.id } }) { Image(systemName: "trash") }
                            .buttonStyle(.plain).help("목록에서 제거합니다. 실제 폴더와 파일은 지우지 않습니다.").accessibilityLabel("프로젝트 목록에서 제거")
                    }
                    ProjectGitStatus(path: row.path).id(row.path)
                    Text(row.projectId != nil ? "웹에서 선택할 수 있습니다" : "폴더를 선택하고 저장하면 웹에 등록됩니다")
                        .font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary)
                }
            }
            HStack {
                Button("프로젝트 추가") { model.projectRows.append(ProjectRow(name: "", path: "")) }
                Button("설정 저장") { actions.saveSettings() }
                Spacer()
            }
        }
    }

    // MARK: 디바이스 정보

    static func agentLabel(_ provider: String) -> String {
        switch provider {
        case "CLAUDE_CODE": return "Claude Code"
        case "CODEX": return "Codex"
        case "AGY": return "Antigravity"
        default: return provider
        }
    }

    var deviceSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            // deviceId 는 바로 아래에서 모델 값으로 보여 주므로 스키마 readonly 필드에서는 뺀다 (중복 표시 방지)
            labeled("디바이스 ID", model.deviceId ?? "미등록")
            ForEach(model.fields.filter { $0.hidden != true && $0.readonly == true && $0.key != "deviceId" }, id: \.key) { f in
                labeled(f.label, model.draft[f.key].flatMap { $0.isEmpty ? nil : $0 } ?? "-")
            }
            labeled("연결 상태", StatusPalette.text(model))
            // 어떤 에이전트가 붙었는지 여기서만 알 수 있다. 설치돼 있어야 목록에 뜬다.
            labeled("에이전트", model.providers.isEmpty ? "감지된 에이전트 없음 (claude/codex/agy 설치 필요)" : model.providers.map(Self.agentLabel).joined(separator: ", "))
            labeled("실행 상태", model.daemonState + (model.daemonVersionLine.isEmpty ? "" : " · \(model.daemonVersionLine)"))
            if let e = model.lastError {
                Text(e).font(.caption).foregroundColor(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: 알림 권한 (CLO-9 ④)

    var notificationSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("현재 상태: \(model.notificationAuth)").font(.callout)
                    .foregroundColor(model.notificationDenied ? .red : .primary)
                Spacer()
                Button("알림 허용하기") { actions.requestNotificationAuth() }.disabled(model.notificationDenied)
            }
            // 거부 상태에서는 앱이 프롬프트를 다시 띄울 수 없다 — 시스템 설정에서만 복구된다
            if model.notificationDenied {
                VStack(alignment: .leading, spacing: 6) {
                    Text("알림이 거부되어 있어 새 요청 배너가 뜨지 않습니다. 시스템 설정 → 알림 → Baton 에서 \"알림 허용\" 을 켜 주세요.")
                        .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button("시스템 설정 열기") { actions.openNotificationSettings() }
                }
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.08)).cornerRadius(6)
            }
        }
    }

    var loginItemSection: some View {
        HStack {
            Toggle("로그인 시 자동 실행", isOn: Binding(get: { model.launchAtLogin }, set: { actions.setLaunchAtLogin($0) }))
            Spacer()
            Text(model.loginItemStatus).font(.caption).foregroundColor(.secondary)
        }
    }

    var daemonSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("node …/baton.cjs daemon --ipc stdio", text: $model.daemonCommand)
                .textFieldStyle(.roundedBorder).font(.system(size: 12, design: .monospaced))
            if model.daemonCommandIsCustom {
                Text("직접 지정한 실행 명령을 사용하고 있습니다. 자동 탐색된 프로그램 정보와 다를 수 있습니다.")
                    .font(.caption).foregroundColor(.secondary)
            }
            HStack {
                Button("명령 저장") { actions.saveDaemonCommand() }
                Button("자동 탐색으로 되돌리기") { actions.resetDaemonCommand() }
                    .disabled(!model.daemonCommandIsCustom)
                Button("연결 프로그램 재시작") { actions.restartDaemon() }
                Spacer()
            }
        }
    }

    // MARK: 표시용 한 줄

    func labeled(_ label: String, _ value: String, color: Color = .primary) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(.caption).foregroundColor(.secondary).frame(width: 90, alignment: .leading)
            Text(value).font(.system(size: 12, design: .monospaced)).foregroundColor(color)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
    }
}
