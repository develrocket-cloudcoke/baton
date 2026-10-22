import Foundation

/// 바이트 기반 JSON Lines 파서 (계약 §1). 텍스트 line API 를 쓰지 않고 0x0A 로 직접 자른다.
/// - 빈 줄은 keep-alive 로 무시
/// - CR 은 제거
/// - 1 MiB 초과 줄은 버리고 `oversize` 이벤트
/// - JSON 파싱 실패는 `malformed` 이벤트 (연속 실패 횟수 제공)
public final class LineParser {
    public enum Event: Equatable {
        case envelope(Envelope)
        case malformed(consecutive: Int, preview: String)
        case oversize(bytes: Int)
    }

    private var buffer = Data()
    private var droppingOversize = false
    private var droppedBytes = 0
    public private(set) var consecutiveMalformed = 0
    public let maxLineBytes: Int

    public init(maxLineBytes: Int = IPCCodec.maxLineBytes) { self.maxLineBytes = maxLineBytes }

    /// 수신한 바이트 덩어리를 넣고, 완성된 줄에서 나온 이벤트를 돌려준다.
    public func feed(_ chunk: Data) -> [Event] {
        var events: [Event] = []
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
            var line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if droppingOversize {
                // 앞서 1 MiB 를 넘긴 줄의 나머지: 개행까지 버린다
                droppingOversize = false
                events.append(.oversize(bytes: droppedBytes + line.count))
                droppedBytes = 0
                continue
            }
            if line.last == 0x0D { line.removeLast() }
            if line.isEmpty { continue }
            if line.count > maxLineBytes { events.append(.oversize(bytes: line.count)); continue }
            do {
                let env = try IPCCodec.decodeLine(line)
                consecutiveMalformed = 0
                events.append(.envelope(env))
            } catch {
                consecutiveMalformed += 1
                let preview = String(decoding: line.prefix(80), as: UTF8.self)
                events.append(.malformed(consecutive: consecutiveMalformed, preview: preview))
            }
        }
        // 개행 없이 1 MiB 를 넘기면 버퍼를 비우고 개행까지 버리는 상태로 전환
        if buffer.count > maxLineBytes {
            droppedBytes += buffer.count
            buffer.removeAll(keepingCapacity: false)
            droppingOversize = true
        }
        return events
    }

    /// 스트림 종료 시 남은 바이트 (개행 없이 끝난 마지막 줄) 처리
    public func finish() -> [Event] {
        guard !buffer.isEmpty else { return [] }
        var tail = buffer; buffer.removeAll()
        tail.append(0x0A)
        return feed(tail)
    }

    public func reset() { buffer.removeAll(); droppingOversize = false; droppedBytes = 0; consecutiveMalformed = 0 }
}
