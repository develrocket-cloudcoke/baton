import Foundation
import SwiftUI
import BatonIPC

struct NotificationItem: Identifiable, Equatable {
    let id: String          // notificationId
    var kind: String
    let requestId: String?
    let title: String
    let body: String
    let webUrl: String?
    let at: Date
    var note: String? = nil // notification.dismiss 로 갱신된 상태 (예: "처리 중: 박인프라")
}

/// 04 §11.1 설정 키 `projects` 의 한 줄 (이름 + 로컬 경로). projectId 는 데몬이 서버 등록 후 채워 넣는 표시 전용 값이다.
struct ProjectRow: Identifiable, Equatable {
    var id = UUID()
    var name: String
    var path: String
    var projectId: String? = nil
}

struct ProgressItem: Identifiable, Equatable {
    let id = UUID()
    let phase: String
    let message: String
    let at: String
}

/// 팝오버가 관찰하는 상태. main thread 에서만 바꾼다.
final class AppModel: ObservableObject {
    // 데몬/연결 상태
    @Published var daemonState: String = "stopped"         // supervisor 상태 (stopped/starting/running/backoff/failed)
    @Published var connectionState: String = "idle"        // daemon.status.state (idle/connecting/connected/running)
    @Published var lastError: String? = nil
    @Published var deviceId: String? = nil
    /// 이 기기에서 감지돼 서버에 등록된 에이전트 (CLAUDE_CODE, CODEX, AGY)
    @Published var providers: [String] = []
    @Published var daemonVersionLine: String = ""

    // 읽기 전용 내 차례 목록. 실패 시 마지막으로 받은 값을 유지한다.
    @Published var inboxItems: [InboxItem] = []
    @Published var inboxCount = 0

    // 알림·활동
    @Published var notifications: [NotificationItem] = []  // 최근 5개
    // CLO-107: 활동 기록이 창으로 옮겨가 스크롤·검색이 되므로 보관량을 늘렸다.
    // 문제가 생겼을 때 앱을 다시 띄우지 않고도 앞뒤를 볼 수 있어야 한다 (더 오래된 것은 ~/Library/Logs/Baton).
    @Published var progress: [ProgressItem] = []           // 최근 progressLimit 개
    @Published var logLines: [String] = []                 // 최근 logLimit 줄
    static let progressLimit = 1000
    static let logLimit = 2000

    /// 창의 사이드바 선택 (CLO-107). 팝오버의 "설정 열기"·"기록 열기" 가 이 값을 바꾼다.
    @Published var windowPane: MainPane = .requests

    /// 팝오버의 "실행 중인 작업" 한 줄. 데몬이 running 이 아니면 nil 이다.
    /// 마지막 진행 줄을 그대로 쓰되, 종료 phase 는 "실행 중" 으로 보이면 안 되므로 제외한다.
    var runningLine: String? {
        guard connectionState == "running" else { return nil }
        guard let last = progress.last else { return "실행 준비 중…" }
        let finished: Set<String> = ["finished", "finished_partial", "failed", "cancelled"]
        if finished.contains(last.phase) { return nil }
        return last.message
    }

    // 표시 전용 상태. IPC 값이나 연결 동작은 바꾸지 않는다.
    var isConnected: Bool {
        hasToken && daemonState.hasPrefix("running") && ["connected", "running"].contains(connectionState)
    }

    var connectionHelp: String? {
        guard let error = lastError, !error.isEmpty else { return nil }
        if error.hasPrefix("not_paired") { return "이 Mac을 계정에 연결해 주세요. 웹의 디바이스 추가에서 새 코드를 받을 수 있습니다." }
        if error.hasPrefix("server_unreachable") { return "서버에 연결할 수 없습니다. 서버 주소와 인터넷 연결을 확인해 주세요. 연결되면 자동으로 다시 시도합니다." }
        if error.hasPrefix("connection_replaced") { return "같은 디바이스가 다른 앱에서 연결됐습니다. 다른 Baton 앱을 종료한 뒤 고급 설정에서 연결 프로그램을 다시 시작해 주세요." }
        if error.hasPrefix("invalid_pairing_code") { return "연결 코드가 만료됐거나 올바르지 않습니다. 웹에서 새 코드를 발급해 주세요." }
        if error.hasPrefix("daemon_exited") { return "작업 연결 프로그램이 중단됐습니다. 잠시 기다린 뒤에도 계속되면 고급 설정과 활동 기록을 확인해 주세요." }
        return "연결을 완료하지 못했습니다. 서버 주소와 연결 코드를 확인하고, 계속되면 활동 기록의 오류를 관리자에게 전달해 주세요."
    }

    // 설정 화면 (편집 중 사본)
    @Published var fields: [SettingsField] = SettingsStore.defaultSchema
    @Published var draft: [String: String] = [:]           // key → 문자열 표현
    @Published var projectRows: [ProjectRow] = []          // settings.projects (JSON 문자열) 의 편집 사본
    private var loadedProjectsJson: String? = nil          // 마지막으로 목록을 읽어 들인 저장 값
    @Published var pairingCode: String = ""
    @Published var pairingStatus: String = ""
    @Published var notificationAuth: String = "미확인"
    /// 알림 권한이 거부 상태면 팝오버가 복구 안내 + "시스템 설정 열기" 를 보여 준다 (CLO-9 ④)
    @Published var notificationDenied: Bool = false
    @Published var loginItemStatus: String = LoginItem.statusText()
    @Published var launchAtLogin: Bool = LoginItem.isEnabled
    @Published var daemonCommand: String = SettingsStore.shared.daemonCommand
    // CLO-117-a 데몬 런타임: 어느 데몬 파일을 쓰는지(번들 내장/저장소 개발본), 어느 node 를 찾았는지,
    // 토큰·실행 산출물이 어디에 쌓이는지. 앱 시작 때 한 번 계산해 설정 화면에 그대로 보여 준다.
    @Published var daemonScriptSource: String = "-"
    @Published var daemonNodeInfo: String = "-"
    @Published var daemonHome: String = DaemonRuntime.daemonHome
    @Published var daemonExecutionsDir: String = DaemonRuntime.executionsDir
    @Published var daemonHomeFromEnv: Bool = DaemonRuntime.daemonHomeFromEnv
    /// 데몬을 띄울 수 없는 이유 + 해결 방법 (node 없음·버전 미달·데몬 파일 없음). nil 이면 정상.
    @Published var runtimeProblemTitle: String? = nil
    @Published var runtimeProblemDetail: String = ""
    /// 사용자가 데몬 명령을 직접 넣었는가 (자동 탐색 결과와 다를 수 있다는 안내에 쓴다)
    @Published var daemonCommandIsCustom: Bool = SettingsStore.shared.hasCustomDaemonCommand
    @Published var hasToken: Bool = false
    /// 어느 저장소를 쓰는지 + 그렇게 고른 근거 (예: "Keychain (기본값)", "파일 /Users/x/.baton/device-token (BATON_TOKEN_STORE 환경변수)")
    @Published var tokenStore: String = TokenStore.label
    /// 저장소 읽기 상태 ("읽는 중…" / "토큰 저장됨" / "읽기 실패: …") — CLO-9 ①③
    @Published var tokenStatus: String = TokenService.Status.loading.text

    func reloadDraft() {
        var d: [String: String] = [:]
        for f in fields {
            let v = SettingsStore.shared.value(f.key)
            switch v {
            case .string(let s): d[f.key] = s
            case .bool(let b): d[f.key] = b ? "true" : "false"
            case .number(let n): d[f.key] = n == n.rounded() ? String(Int(n)) : String(n)
            default: d[f.key] = ""
            }
        }
        draft = d
        // 데몬이 lastEventId 같은 다른 키만 바꿔도 reloadDraft 가 불린다. 저장된 목록이 그대로면
        // 사용자가 편집 중인 행(아직 저장 전)을 덮어쓰지 않는다. projectId 가 채워지는 등 값이 바뀌면 다시 읽는다.
        let stored = d["projects"] ?? ""
        if stored != loadedProjectsJson {
            loadedProjectsJson = stored
            projectRows = AppModel.decodeProjects(stored)
        }
    }

    /// `[{"name":…,"path":…,"projectId":…}]` JSON 문자열 → 편집용 행. 깨진 값은 빈 목록으로 본다.
    static func decodeProjects(_ json: String) -> [ProjectRow] {
        let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return raw.compactMap { item in
            guard let name = item["name"] as? String, let path = item["path"] as? String, !name.isEmpty, !path.isEmpty else { return nil }
            return ProjectRow(name: name, path: path, projectId: item["projectId"] as? String)
        }
    }

    /// 편집용 행 → JSON 문자열. 이름·경로가 빈 줄은 빼고, 데몬이 넣어 준 projectId 는 유지한다.
    static func encodeProjects(_ rows: [ProjectRow]) -> String {
        let list: [[String: Any]] = rows.compactMap { r in
            let name = r.name.trimmingCharacters(in: .whitespacesAndNewlines)
            let path = r.path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, !path.isEmpty else { return nil }
            return ["name": name, "path": path, "projectId": r.projectId ?? NSNull()]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: list), let s = String(data: data, encoding: .utf8) else { return "[]" }
        return s
    }

    /// draft → patch (스키마 타입에 맞춰 변환). readonly/hidden 은 제외.
    func patchFromDraft() -> [String: JSONValue] {
        var patch: [String: JSONValue] = [:]
        for f in fields where f.readonly != true && f.hidden != true {
            // 프로젝트 목록은 텍스트 필드가 아니라 전용 UI 에서 편집하므로 행을 다시 JSON 으로 만든다
            if f.type == "projects" { patch[f.key] = .string(AppModel.encodeProjects(projectRows)); continue }
            let raw = (draft[f.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if raw.isEmpty { patch[f.key] = .null; continue }
            switch f.type {
            case "bool": patch[f.key] = .bool(raw == "true" || raw == "1")
            case "int": patch[f.key] = .number(Double(Int(raw) ?? 0))
            default: patch[f.key] = .string(raw)
            }
        }
        return patch
    }

    func log(_ line: String) {
        logLines.append(line)
        if logLines.count > AppModel.logLimit { logLines.removeFirst(logLines.count - AppModel.logLimit) }
        FileLog.shell.write(line)
    }
}
