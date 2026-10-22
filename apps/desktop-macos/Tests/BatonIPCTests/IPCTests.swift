// XCTest 버전. Command Line Tools 에는 XCTest 모듈이 없어 `swift test` 가 실패한다 (Package.swift 메모 참조).
// Xcode 가 있는 환경에서 `swift test` 로 실행한다. CLT 에서는 `swift run baton-ipc-selftest` 가 같은 케이스를 검사한다.
import XCTest
@testable import BatonIPC

final class EnvelopeCodecTests: XCTestCase {
    func testEnvelopeRoundTripAndReplyToOmitted() throws {
        let env = Envelope(type: "request.notify", id: "d-42", ts: "2026-09-04T08:00:00.123Z", payload: .object(["title": .string("새 요청"), "n": .number(3)]))
        let line = try IPCCodec.encodeLine(env)
        let text = String(decoding: line, as: UTF8.self)
        XCTAssertTrue(text.hasSuffix("\n"))
        XCTAssertFalse(text.contains("replyTo"))
        XCTAssertTrue(text.contains("\"n\":3"))
        XCTAssertEqual(try IPCCodec.decodeLine(line.dropLast()), env)
    }

    func testReplyEnvelope() throws {
        let text = String(decoding: try IPCCodec.encodeLine(Envelope(type: "ack", id: "s-7", replyTo: "d-42")), as: UTF8.self)
        XCTAssertTrue(text.contains("\"replyTo\":\"d-42\""))
        XCTAssertTrue(text.contains("\"payload\":{}"))
    }

    func testPayloadRoundTrips() throws {
        let hello = ShellHello(protocol: 1, shellVersion: "0.1.0", platform: "macos", settings: ["serverUrl": .string("https://x"), "projectPath": .null], deviceToken: nil)
        let hp = try IPCCodec.payload(of: hello)
        XCTAssertEqual(hp["deviceToken"]?.isNull, true)
        XCTAssertEqual(try IPCCodec.payload(Envelope(type: "shell.hello", id: "s-1", payload: hp), as: ShellHello.self), hello)

        let notify = RequestNotify(notificationId: "ntf_1", kind: "request.delivered", requestId: "req_1", title: "t", body: "b", webUrl: "https://b/r/1")
        XCTAssertEqual(try IPCCodec.payload(Envelope(type: "request.notify", id: "d-1", payload: try IPCCodec.payload(of: notify)), as: RequestNotify.self), notify)

        let status = DaemonStatus(state: "connected", since: nil, deviceId: "dev_1", lastError: DaemonStatus.LastError(code: "x", message: "y", at: nil), activeExecutionId: nil)
        XCTAssertEqual(try IPCCodec.payload(Envelope(type: "daemon.status", id: "d-2", payload: try IPCCodec.payload(of: status)), as: DaemonStatus.self), status)
    }

    func testInvalidPayload() {
        let bad = Envelope(type: "request.notify", id: "d-3", payload: .object(["notificationId": .string("n"), "body": .string("b")]))
        XCTAssertThrowsError(try IPCCodec.payload(bad, as: RequestNotify.self)) { e in
            XCTAssertEqual((e as? IPCError)?.code, .invalidPayload)
        }
    }

    func testValidate() {
        XCTAssertNil(Envelope(type: "x", id: "1").validate())
        XCTAssertEqual(Envelope(v: 2, type: "x", id: "1").validate()?.code, .protocolMismatch)
        XCTAssertEqual(Envelope(type: "x", id: "1", payload: .array([])).validate()?.code, .invalidEnvelope)
    }
}

final class LineParserTests: XCTestCase {
    func testSplitChunksCRLFBlankAndMalformed() throws {
        let parser = LineParser(maxLineBytes: 200)
        let l1 = String(decoding: try IPCCodec.encodeLine(Envelope(type: "a", id: "d-1")), as: UTF8.self)
        let l2 = String(decoding: try IPCCodec.encodeLine(Envelope(type: "b", id: "d-2")), as: UTF8.self)
        let bytes = Array((l1.dropLast() + "\r\n" + "\n" + "{not json}\n" + l2).utf8)
        var events: [LineParser.Event] = []
        events += parser.feed(Data(bytes[0..<7]))
        events += parser.feed(Data(bytes[7..<(bytes.count - 3)]))
        events += parser.feed(Data(bytes[(bytes.count - 3)...]))
        let types = events.compactMap { if case .envelope(let e) = $0 { return e.type } else { return nil } }
        XCTAssertEqual(types, ["a", "b"])
        XCTAssertEqual(events.filter { if case .malformed = $0 { return true } else { return false } }.count, 1)
        XCTAssertEqual(parser.consecutiveMalformed, 0)
    }

    func testOversizeAndRecovery() throws {
        let parser = LineParser(maxLineBytes: 200)
        let ov = parser.feed(Data(repeating: 0x41, count: 500) + Data([0x0A]))
        XCTAssertTrue(ov.contains { if case .oversize = $0 { return true } else { return false } })
        let ok = parser.feed(try IPCCodec.encodeLine(Envelope(type: "a", id: "d-1")))
        XCTAssertTrue(ok.contains { if case .envelope(let e) = $0 { return e.type == "a" } else { return false } })
    }

    func testConsecutiveMalformed() {
        let p = LineParser()
        _ = p.feed(Data("x\ny\n".utf8))
        XCTAssertTrue(p.feed(Data("z\n".utf8)).contains { if case .malformed(let n, _) = $0 { return n == 3 } else { return false } })
    }
}
