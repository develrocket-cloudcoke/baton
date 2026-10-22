import Foundation

/// IPC 프로토콜 버전. docs/design/04-shell-daemon-ipc.md §2.
public let ipcProtocolVersion = 1

/// 메시지 봉투. payload 는 타입별로 해석하기 위해 원시 JSON(`JSONValue`) 으로 보관한다.
public struct Envelope: Codable, Equatable {
    public var v: Int
    public var type: String
    public var id: String
    public var ts: String
    public var replyTo: String?
    public var payload: JSONValue

    public init(v: Int = ipcProtocolVersion, type: String, id: String, ts: String = Envelope.now(), replyTo: String? = nil, payload: JSONValue = .object([:])) {
        self.v = v; self.type = type; self.id = id; self.ts = ts; self.replyTo = replyTo; self.payload = payload
    }

    /// ISO 8601 UTC, 밀리초 포함 (계약 §2 의 ts 형식)
    public static func now(_ date: Date = Date()) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }

    /// 봉투 필드 검증 (§5 invalid_envelope 판정)
    public func validate() -> IPCError? {
        if v != ipcProtocolVersion { return IPCError(code: .protocolMismatch, message: "protocol v=\(v)") }
        if type.isEmpty || id.isEmpty || ts.isEmpty { return IPCError(code: .invalidEnvelope, message: "type/id/ts required") }
        if case .object = payload { return nil }
        return IPCError(code: .invalidEnvelope, message: "payload must be object")
    }

    public var isReply: Bool { replyTo != nil }
}

/// 계약 §5 의 오류 코드
public struct IPCError: Error, Equatable {
    public enum Code: String { case invalidEnvelope = "invalid_envelope", invalidPayload = "invalid_payload", unknownType = "unknown_type", protocolMismatch = "protocol_mismatch", timeout, keychainError = "keychain_error", notPaired = "not_paired", invalidPairingCode = "invalid_pairing_code", serverUnreachable = "server_unreachable", daemonExited = "daemon_exited", `internal` }
    public var code: Code
    public var message: String
    public var retryable: Bool
    public init(code: Code, message: String, retryable: Bool = false) { self.code = code; self.message = message; self.retryable = retryable }
}

/// 순서 없는 JSON 값. Codable 로 그대로 직렬화된다.
public indirect enum JSONValue: Codable, Equatable {
    case string(String), number(Double), bool(Bool), null, array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): if n == n.rounded() && abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    // 편의 접근자
    public subscript(key: String) -> JSONValue? { if case .object(let o) = self { return o[key] }; return nil }
    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var intValue: Int? { if case .number(let n) = self { return Int(n) }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var isNull: Bool { if case .null = self { return true }; return false }
}
