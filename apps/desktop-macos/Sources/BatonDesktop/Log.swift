import Foundation

/// `~/Library/Logs/Baton/<name>.log` 에 append. 5 MB 를 넘으면 `.1` 로 1세대 회전 (계약 §6-10).
final class FileLog {
    static let shell = FileLog(name: "shell")
    static let daemon = FileLog(name: "daemon")
    static let directory: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Baton")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private let url: URL
    private let queue = DispatchQueue(label: "baton.log")
    private let maxBytes = 5 * 1024 * 1024

    init(name: String) { url = FileLog.directory.appendingPathComponent("\(name).log") }

    func write(_ line: String) {
        queue.async {
            let text = "[\(Envelope_now())] \(line)\n"
            if let attrs = try? FileManager.default.attributesOfItem(atPath: self.url.path), let size = attrs[.size] as? Int, size > self.maxBytes {
                let rotated = self.url.deletingPathExtension().appendingPathExtension("1.log")
                try? FileManager.default.removeItem(at: rotated)
                try? FileManager.default.moveItem(at: self.url, to: rotated)
            }
            if let fh = try? FileHandle(forWritingTo: self.url) {
                fh.seekToEndOfFile(); fh.write(Data(text.utf8)); try? fh.close()
            } else {
                FileManager.default.createFile(atPath: self.url.path, contents: Data(text.utf8))
            }
        }
    }

    /// 데몬 stderr 처럼 이미 줄바꿈이 있는 원문을 그대로 붙인다
    func writeRaw(_ data: Data) {
        queue.async {
            if let fh = try? FileHandle(forWritingTo: self.url) { fh.seekToEndOfFile(); fh.write(data); try? fh.close() }
            else { FileManager.default.createFile(atPath: self.url.path, contents: data) }
        }
    }
}

private func Envelope_now() -> String {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: Date())
}
