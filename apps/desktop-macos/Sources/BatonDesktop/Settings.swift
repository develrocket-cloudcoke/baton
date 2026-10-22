import Foundation
import BatonIPC

/// 셸이 대행하는 설정 저장소 (UserDefaults, 키 `settings.<key>`). 계약 §4.
/// 비밀값(디바이스 토큰)은 여기 저장하지 않는다 → Keychain.swift
final class SettingsStore {
    static let shared = SettingsStore()
    private let defaults = UserDefaults.standard
    private let prefix = "settings."

    /// 데몬이 보낸 스키마 (없으면 기본 필드로 UI 를 그린다)
    var schema: [SettingsField] = SettingsStore.defaultSchema

    static let defaultSchema: [SettingsField] = [
        SettingsField(key: "serverUrl", label: "서버 URL", type: "url", required: true, default: .string("https://baton.example.com"), help: "Baton 서버 주소"),
        // 04 §11.1: 프로젝트 여러 개. 값은 `[{name,path,projectId}]` 의 JSON 문자열이고 설정 탭이 목록 UI 로 편집한다.
        SettingsField(key: "projects", label: "프로젝트 목록", type: "projects", required: false, default: .string("[]"), help: "이름 + 로컬 경로. 설치된 에이전트마다 등록된다"),
        SettingsField(key: "deviceName", label: "디바이스 이름", type: "string", required: false, default: .string(Host.current().localizedName ?? "Mac")),
        SettingsField(key: "deviceId", label: "디바이스 ID", type: "string", required: false, readonly: true, default: .null),
        // 데몬 스키마와 같은 기본값(빈 문자열). "0" 을 보내면 서버가 없는 outbox id 를 조회해 전체 재생으로 떨어진다.
        SettingsField(key: "lastEventId", label: "마지막 이벤트", type: "string", required: false, hidden: true, default: .string("")),
    ]

    /// 알려진 키(스키마 + 저장된 키) 전체를 돌려준다. 값이 없으면 스키마 default, 그것도 없으면 null.
    func all() -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        var keys = Set(schema.map { $0.key })
        for k in defaults.dictionaryRepresentation().keys where k.hasPrefix(prefix) { keys.insert(String(k.dropFirst(prefix.count))) }
        for k in keys { out[k] = value(k) }
        return out
    }

    func value(_ key: String) -> JSONValue {
        if let raw = defaults.object(forKey: prefix + key) {
            switch raw {
            case let s as String: return .string(s)
            case let b as Bool: return .bool(b)
            case let n as NSNumber: return .number(n.doubleValue)
            default: break
            }
        }
        return schema.first { $0.key == key }?.default ?? .null
    }

    /// 스키마 예시 주소로 접속하지 않도록 실제 저장값만 읽는다.
    var savedServerURL: URL? {
        guard let raw = defaults.string(forKey: prefix + "serverUrl"),
              let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              url.host != nil else { return nil }
        return url
    }

    func string(_ key: String) -> String? { value(key).stringValue }

    /// patch 적용. 값이 null 이면 삭제.
    func apply(patch: [String: JSONValue]) {
        for (k, v) in patch {
            switch v {
            case .null: defaults.removeObject(forKey: prefix + k)
            case .string(let s): defaults.set(s, forKey: prefix + k)
            case .bool(let b): defaults.set(b, forKey: prefix + k)
            case .number(let n): defaults.set(n, forKey: prefix + k)
            default: break // array/object 는 설정 값으로 허용하지 않는다 (계약 §3.3 settings.schema type)
            }
        }
    }

    // 셸 전용 설정 (데몬에 보내지 않음)
    var daemonCommand: String {
        get { defaults.string(forKey: "shell.daemonCommand") ?? SettingsStore.defaultDaemonCommand }
        set { defaults.set(newValue, forKey: "shell.daemonCommand") }
    }

    /// 기본 데몬 명령 (CLO-117-a). 계산은 DaemonRuntime 이 한다:
    ///   ① 앱 번들 안 Resources/baton.cjs (테스터가 .app 만 받아도 도는 경로)
    ///   ② 없으면 저장소 개발본 apps/desktop-agent/dist/cli.js
    /// node 도 GUI 앱이 못 받는 PATH 대신 흔한 설치 위치에서 직접 찾아 절대 경로로 박는다.
    static var defaultDaemonCommand: String { DaemonRuntime.makePlan().commandLine }

    /// 사용자가 "명령 저장" 으로 직접 넣은 값이 있는가. 있으면 런타임 자동 탐색보다 그 값이 우선이다.
    var hasCustomDaemonCommand: Bool { defaults.string(forKey: "shell.daemonCommand") != nil }

    /// 사용자가 손댄 값을 지워 자동 탐색으로 되돌린다 (설정 화면의 "자동 탐색으로 되돌리기").
    func resetDaemonCommand() { defaults.removeObject(forKey: "shell.daemonCommand") }
}
