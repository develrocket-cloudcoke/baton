import Foundation

/// 봉투 ↔ 한 줄 JSON 변환과 payload 타입 변환.
public enum IPCCodec {
    public static let maxLineBytes = 1_048_576 // 1 MiB (계약 §1)

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()
    static let decoder = JSONDecoder()

    /// 봉투를 개행 없는 한 줄로 직렬화한다 (개행은 JSON 이스케이프로 들어간다).
    public static func encodeLine(_ env: Envelope) throws -> Data {
        var data = try encoder.encode(env)
        if data.count > maxLineBytes { throw IPCError(code: .invalidPayload, message: "line exceeds 1 MiB") }
        data.append(0x0A)
        return data
    }

    public static func decodeLine(_ line: Data) throws -> Envelope {
        try decoder.decode(Envelope.self, from: line)
    }

    /// payload 를 Codable 구조체로 변환. 필드 타입이 다르면 invalid_payload.
    public static func payload<T: Decodable>(_ env: Envelope, as type: T.Type) throws -> T {
        do {
            let data = try encoder.encode(env.payload)
            return try decoder.decode(T.self, from: data)
        } catch let e as DecodingError {
            throw IPCError(code: .invalidPayload, message: describe(e))
        }
    }

    /// Codable 구조체를 payload(JSONValue.object) 로 변환.
    public static func payload<T: Encodable>(of value: T) throws -> JSONValue {
        let data = try encoder.encode(value)
        return try decoder.decode(JSONValue.self, from: data)
    }

    static func describe(_ e: DecodingError) -> String {
        switch e {
        case .keyNotFound(let k, _): return "missing field \(k.stringValue)"
        case .typeMismatch(_, let ctx): return "type mismatch at " + ctx.codingPath.map { $0.stringValue }.joined(separator: ".")
        case .valueNotFound(_, let ctx): return "null at " + ctx.codingPath.map { $0.stringValue }.joined(separator: ".")
        default: return "invalid payload"
        }
    }
}

/// 보내는 쪽의 id 생성기 (`s-<n>` / `d-<n>`)
public final class MessageIdSequence {
    private let prefix: String
    private var counter = 0
    private let lock = NSLock()
    public init(prefix: String) { self.prefix = prefix }
    public func next() -> String { lock.lock(); defer { lock.unlock() }; counter += 1; return "\(prefix)-\(counter)" }
}
