// CLT 환경용 자체 검증. Tests/BatonIPCTests 와 같은 케이스를 XCTest 없이 실행한다.
// 실행: swift run baton-ipc-selftest   (실패 시 exit 1)
import Foundation
import BatonIPC

var failures = 0
func check(_ name: String, _ cond: @autoclosure () -> Bool) {
    if cond() { print("ok   \(name)") } else { failures += 1; print("FAIL \(name)") }
}

// 1. 봉투 라운드트립 (replyTo 없음 → 키 자체가 없어야 함)
let env = Envelope(type: "request.notify", id: "d-42", ts: "2026-09-04T08:00:00.123Z", payload: .object(["title": .string("새 요청"), "n": .number(3)]))
let line = try! IPCCodec.encodeLine(env)
let text = String(decoding: line, as: UTF8.self)
check("encode ends with LF", text.hasSuffix("\n"))
check("encode omits replyTo when nil", !text.contains("replyTo"))
check("encode v=1", text.contains("\"v\":1"))
let back = try! IPCCodec.decodeLine(line.dropLast())
check("roundtrip equal", back == env)
check("number encodes as int", text.contains("\"n\":3"))

// 2. reply 봉투
let reply = Envelope(type: "ack", id: "s-7", replyTo: "d-42")
let rtext = String(decoding: try! IPCCodec.encodeLine(reply), as: UTF8.self)
check("reply has replyTo", rtext.contains("\"replyTo\":\"d-42\""))
check("empty payload is {}", rtext.contains("\"payload\":{}"))

// 3. payload Codable 라운드트립
let hello = ShellHello(protocol: 1, shellVersion: "0.1.0", platform: "macos", settings: ["serverUrl": .string("https://x"), "projects": .string("[]")], deviceToken: nil)
let hp = try! IPCCodec.payload(of: hello)
check("shell.hello deviceToken null present", hp["deviceToken"]?.isNull == true)
let hello2 = try! IPCCodec.payload(Envelope(type: "shell.hello", id: "s-1", payload: hp), as: ShellHello.self)
check("shell.hello roundtrip", hello2 == hello)

let notify = RequestNotify(notificationId: "ntf_1", kind: "request.delivered", requestId: "req_1", title: "t", body: "b", webUrl: "https://b/r/1")
let np = try! IPCCodec.payload(of: notify)
check("request.notify roundtrip", (try! IPCCodec.payload(Envelope(type: "request.notify", id: "d-1", payload: np), as: RequestNotify.self)) == notify)

let dismiss = NotificationDismiss(notificationId: "ntf_req_1", requestId: "req_1", reason: "claimed", note: "처리 중: 박인프라", claimedBy: "박인프라")
check("notification.dismiss roundtrip", (try! IPCCodec.payload(Envelope(type: "notification.dismiss", id: "d-5", payload: try! IPCCodec.payload(of: dismiss)), as: NotificationDismiss.self)) == dismiss)
check("notification.dismiss requires reason", (try? IPCCodec.payload(Envelope(type: "notification.dismiss", id: "d-6", payload: .object(["requestId": .string("r")])), as: NotificationDismiss.self)) == nil)

let status = DaemonStatus(state: "connected", since: "2026-09-04T08:00:03.000Z", deviceId: "dev_1", lastError: DaemonStatus.LastError(code: "x", message: "y", at: nil), activeExecutionId: nil)
check("daemon.status roundtrip", (try! IPCCodec.payload(Envelope(type: "daemon.status", id: "d-2", payload: try! IPCCodec.payload(of: status)), as: DaemonStatus.self)) == status)

// 4. invalid_payload: title 누락
let bad = Envelope(type: "request.notify", id: "d-3", payload: .object(["notificationId": .string("n"), "body": .string("b")]))
var badErr: IPCError? = nil
do { _ = try IPCCodec.payload(bad, as: RequestNotify.self) } catch let e as IPCError { badErr = e } catch {}
check("missing field → invalid_payload", badErr?.code == .invalidPayload && (badErr?.message.contains("title") ?? false))

// 5. 봉투 검증
check("validate ok", env.validate() == nil)
check("validate protocol mismatch", Envelope(v: 2, type: "x", id: "1").validate()?.code == .protocolMismatch)
check("validate payload must be object", Envelope(type: "x", id: "1", payload: .array([])).validate()?.code == .invalidEnvelope)

// 6. LineParser: 바이트 분할·CRLF·빈 줄·malformed·oversize
let parser = LineParser(maxLineBytes: 200)
let l1 = String(decoding: try! IPCCodec.encodeLine(Envelope(type: "a", id: "d-1")), as: UTF8.self)
let l2 = String(decoding: try! IPCCodec.encodeLine(Envelope(type: "b", id: "d-2")), as: UTF8.self)
var events: [LineParser.Event] = []
// 두 줄을 임의 지점에서 잘라 넣고, 중간에 CRLF·빈 줄·malformed 를 섞는다
let stream = l1.dropLast() + "\r\n" + "\n" + "{not json}\n" + l2
let bytes = Array(stream.utf8)
events += parser.feed(Data(bytes[0..<7]))
events += parser.feed(Data(bytes[7..<(bytes.count - 3)]))
events += parser.feed(Data(bytes[(bytes.count - 3)...]))
let envs = events.compactMap { if case .envelope(let e) = $0 { return e.type } else { return nil } }
check("parser yields both envelopes in order", envs == ["a", "b"])
check("parser reports malformed once", events.filter { if case .malformed = $0 { return true } else { return false } }.count == 1)
check("malformed counter resets on valid line", parser.consecutiveMalformed == 0)
let big = Data(repeating: 0x41, count: 500) + Data([0x0A])
let ov = parser.feed(big)
check("oversize line dropped", ov.contains { if case .oversize = $0 { return true } else { return false } })
check("parser recovers after oversize", parser.feed(Data(l1.utf8)).contains { if case .envelope(let e) = $0 { return e.type == "a" } else { return false } })
check("finish flushes last line without LF", parser.feed(Data(l2.dropLast().utf8)).isEmpty && parser.finish().count == 1)

// 7. 연속 malformed 3회
let p2 = LineParser()
_ = p2.feed(Data("x\ny\n".utf8))
let third = p2.feed(Data("z\n".utf8))
check("consecutive malformed count reaches 3", third.contains { if case .malformed(let n, _) = $0 { return n == 3 } else { return false } })

print(failures == 0 ? "ALL PASSED" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
