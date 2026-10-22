import Foundation

/// 계약 §3 의 type 문자열
public enum MessageType {
    // 데몬 → 셸
    public static let daemonHello = "daemon.hello"
    public static let daemonStatus = "daemon.status"
    public static let requestNotify = "request.notify"
    public static let notificationDismiss = "notification.dismiss"   // 04 §10 (W5d-1): claim 된 팀 뿌리기 요청의 배너 제거·알림 탭 갱신
    public static let executionProgress = "execution.progress"
    public static let settingsSchema = "settings.schema"
    public static let settingsGet = "settings.get"
    public static let settingsSet = "settings.set"
    public static let tokenGet = "token.get"
    public static let tokenSet = "token.set"
    public static let daemonLog = "daemon.log"
    // 셸 → 데몬
    public static let shellHello = "shell.hello"
    public static let settingsChanged = "settings.changed"
    public static let pairStart = "pair.start"
    public static let pairResult = "pair.result"
    public static let notificationClicked = "notification.clicked"
    public static let daemonShutdown = "daemon.shutdown"
    // 공통
    public static let settingsValue = "settings.value"
    public static let tokenValue = "token.value"
    public static let ack = "ack"
    public static let error = "error"
}

// MARK: - payload 구조체 (Codable). 셸이 실제로 해석하는 메시지만 정의한다.

public struct DaemonHello: Codable, Equatable {
    public var `protocol`: Int
    public var daemonVersion: String
    public var pid: Int32
    public var capabilities: [String]
    public init(protocol: Int, daemonVersion: String, pid: Int32, capabilities: [String]) { self.protocol = `protocol`; self.daemonVersion = daemonVersion; self.pid = pid; self.capabilities = capabilities }
}

public struct ShellHello: Codable, Equatable {
    public var `protocol`: Int
    public var shellVersion: String
    public var platform: String
    public var settings: [String: JSONValue]
    public var deviceToken: String?
    public init(protocol: Int, shellVersion: String, platform: String, settings: [String: JSONValue], deviceToken: String?) { self.protocol = `protocol`; self.shellVersion = shellVersion; self.platform = platform; self.settings = settings; self.deviceToken = deviceToken }
    // deviceToken 이 nil 이어도 키를 null 로 내보낸다 (계약: 없으면 null)
    enum CodingKeys: String, CodingKey { case `protocol`, shellVersion, platform, settings, deviceToken }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(`protocol`, forKey: .protocol); try c.encode(shellVersion, forKey: .shellVersion); try c.encode(platform, forKey: .platform); try c.encode(settings, forKey: .settings)
        try c.encode(deviceToken, forKey: .deviceToken)
    }
}

public struct DaemonStatus: Codable, Equatable {
    public struct LastError: Codable, Equatable { public var code: String; public var message: String; public var at: String?
        public init(code: String, message: String, at: String?) { self.code = code; self.message = message; self.at = at } }
    public var state: String            // idle | connecting | connected | running
    public var since: String?
    public var deviceId: String?
    public var lastError: LastError?
    public var activeExecutionId: String?
    /// 이 기기에서 감지돼 서버에 등록된 에이전트 (CLAUDE_CODE, CODEX, AGY)
    public var providers: [String]?
    public init(state: String, since: String? = nil, deviceId: String? = nil, lastError: LastError? = nil, activeExecutionId: String? = nil, providers: [String]? = nil) { self.state = state; self.since = since; self.deviceId = deviceId; self.lastError = lastError; self.activeExecutionId = activeExecutionId; self.providers = providers }
}

public struct RequestNotify: Codable, Equatable {
    public var notificationId: String
    public var kind: String?
    public var requestId: String?
    public var title: String
    public var body: String
    public var webUrl: String?
    public init(notificationId: String, kind: String?, requestId: String?, title: String, body: String, webUrl: String?) { self.notificationId = notificationId; self.kind = kind; self.requestId = requestId; self.title = title; self.body = body; self.webUrl = webUrl }
}

/// 04 §10 notification.dismiss (데몬→셸, request, 응답 ack). notificationId 가 없으면 requestId 로 찾는다.
public struct NotificationDismiss: Codable, Equatable {
    public var notificationId: String?
    public var requestId: String?
    public var reason: String            // claimed | withdrawn | generic
    public var note: String?             // 알림 탭 항목에 남길 한 줄 (예: "처리 중: 박인프라")
    public var claimedBy: String?
    public init(notificationId: String?, requestId: String?, reason: String, note: String?, claimedBy: String?) { self.notificationId = notificationId; self.requestId = requestId; self.reason = reason; self.note = note; self.claimedBy = claimedBy }
}

public struct ExecutionProgress: Codable, Equatable {
    public var executionId: String?
    public var requestId: String?
    public var phase: String
    public var message: String
    public var at: String?
    public init(executionId: String?, requestId: String?, phase: String, message: String, at: String?) { self.executionId = executionId; self.requestId = requestId; self.phase = phase; self.message = message; self.at = at }
}

public struct SettingsField: Codable, Equatable {
    public var key: String
    public var label: String
    public var type: String              // string | url | path | bool | int
    public var required: Bool?
    public var readonly: Bool?
    public var hidden: Bool?
    public var `default`: JSONValue?
    public var help: String?
    public init(key: String, label: String, type: String, required: Bool? = nil, readonly: Bool? = nil, hidden: Bool? = nil, default: JSONValue? = nil, help: String? = nil) { self.key = key; self.label = label; self.type = type; self.required = required; self.readonly = readonly; self.hidden = hidden; self.default = `default`; self.help = help }
}
public struct SettingsSchema: Codable, Equatable { public var fields: [SettingsField]; public init(fields: [SettingsField]) { self.fields = fields } }
public struct SettingsGet: Codable, Equatable { public var keys: [String]?; public init(keys: [String]?) { self.keys = keys } }
public struct SettingsSet: Codable, Equatable { public var patch: [String: JSONValue]; public init(patch: [String: JSONValue]) { self.patch = patch } }
public struct SettingsValue: Codable, Equatable { public var settings: [String: JSONValue]; public init(settings: [String: JSONValue]) { self.settings = settings } }
public struct SettingsChanged: Codable, Equatable { public var settings: [String: JSONValue]; public init(settings: [String: JSONValue]) { self.settings = settings } }

public struct TokenSet: Codable, Equatable {
    public var deviceToken: String?
    public init(deviceToken: String?) { self.deviceToken = deviceToken }
}
public struct TokenValue: Codable, Equatable {
    public var deviceToken: String?
    public init(deviceToken: String?) { self.deviceToken = deviceToken }
    enum CodingKeys: String, CodingKey { case deviceToken }
    public func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: CodingKeys.self); try c.encode(deviceToken, forKey: .deviceToken) }
}

public struct DaemonLog: Codable, Equatable { public var level: String; public var message: String; public init(level: String, message: String) { self.level = level; self.message = message } }

public struct PairStart: Codable, Equatable { public var pairingCode: String; public var deviceName: String?; public init(pairingCode: String, deviceName: String?) { self.pairingCode = pairingCode; self.deviceName = deviceName } }
public struct PairResult: Codable, Equatable {
    public struct Failure: Codable, Equatable { public var code: String; public var message: String; public init(code: String, message: String) { self.code = code; self.message = message } }
    public var ok: Bool; public var deviceId: String?; public var error: Failure?
    public init(ok: Bool, deviceId: String?, error: Failure?) { self.ok = ok; self.deviceId = deviceId; self.error = error }
}

public struct NotificationClicked: Codable, Equatable {
    public var notificationId: String
    public var requestId: String?
    public var webUrl: String?
    public var action: String            // default | dismiss
    public var clickedAt: String
    public init(notificationId: String, requestId: String?, webUrl: String?, action: String, clickedAt: String) { self.notificationId = notificationId; self.requestId = requestId; self.webUrl = webUrl; self.action = action; self.clickedAt = clickedAt }
}

public struct DaemonShutdown: Codable, Equatable { public var reason: String; public init(reason: String) { self.reason = reason } }

public struct ErrorPayload: Codable, Equatable {
    public var code: String; public var message: String; public var retryable: Bool; public var details: [String: JSONValue]?
    public init(code: String, message: String, retryable: Bool, details: [String: JSONValue]? = nil) { self.code = code; self.message = message; self.retryable = retryable; self.details = details }
    public init(_ e: IPCError) { self.init(code: e.code.rawValue, message: e.message, retryable: e.retryable) }
}
