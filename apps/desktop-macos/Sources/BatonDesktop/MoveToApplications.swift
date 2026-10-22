import AppKit
import Darwin
import Foundation

/// DMG 실행에서는 데몬을 시작하지 않고 설치를 먼저 끝낸다. 개발 빌드는 그대로 통과한다.
@MainActor
enum MoveToApplications {
    static func interceptLaunch() -> Bool {
        let bundle = Bundle.main.bundleURL.standardizedFileURL
        guard bundle.path.hasPrefix("/Volumes/") || bundle.path.contains("/AppTranslocation/") else { return false }
        let alert = NSAlert()
        alert.messageText = "Baton 을 Applications 폴더로 옮겨 주세요"
        alert.informativeText = "디스크 이미지(DMG) 안에서 실행 중입니다. 이대로 쓰면 업데이트가 반영되지 않고 Finder 에 디스크가 쌓입니다."
        alert.addButton(withTitle: "Applications 로 옮기고 다시 실행")
        alert.addButton(withTitle: "종료")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { NSApp.terminate(nil); return true }
        Task { await install(bundle) }
        return true
    }

    private static func originalURL(_ url: URL) throws -> URL {
        guard url.path.contains("/AppTranslocation/") else { return url }
        // 공개 Swift 헤더에 없는 Security 심볼은 선택적으로 로드한다. 없는 OS에서도 빌드된다.
        typealias IsTranslocated = @convention(c) (CFURL, UnsafeMutablePointer<Bool>, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Bool
        typealias OriginalPath = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?
        if let library = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY) {
            defer { dlclose(library) }
            if let check = dlsym(library, "SecTranslocateIsTranslocatedURL"),
               let resolve = dlsym(library, "SecTranslocateCreateOriginalPathForURL") {
                var translocated = false
                if unsafeBitCast(check, to: IsTranslocated.self)(url as CFURL, &translocated, nil), translocated,
                   let original = unsafeBitCast(resolve, to: OriginalPath.self)(url as CFURL, nil)?.takeRetainedValue() {
                    return (original as URL).standardizedFileURL
                }
            }
        }
        // 옛 DMG가 여러 개면 이름만 보고 고르지 않는다. 내용까지 같은 유일한 복사본만 사용한다.
        let fm = FileManager.default
        let volumes = try fm.contentsOfDirectory(at: URL(fileURLWithPath: "/Volumes"), includingPropertiesForKeys: nil)
        let candidates = volumes.map { $0.appendingPathComponent(url.lastPathComponent) }.filter {
            fm.contentsEqual(atPath: url.path, andPath: $0.path)
        }
        guard candidates.count == 1, let original = candidates.first else {
            throw failure("원래 앱 위치를 하나로 확인하지 못했습니다. 사용하지 않는 Baton 디스크 이미지를 꺼낸 뒤 다시 시도해 주세요.")
        }
        return original
    }

    private static func install(_ bundle: URL) async {
        let fm = FileManager.default
        let destination = URL(fileURLWithPath: "/Applications/Baton.app")
        var trashed: NSURL?
        var copying = false
        do {
            let source = try originalURL(bundle)
            guard source != destination else { throw failure("Applications의 앱을 Finder에서 직접 열어 주세요.") }
            guard Bundle(url: source)?.bundleIdentifier == Bundle.main.bundleIdentifier else {
                throw failure("원래 Baton 앱의 식별자가 일치하지 않습니다.")
            }
            let running = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
                .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && $0.bundleURL?.standardizedFileURL == destination }
            for app in running { _ = app.terminate() }
            for _ in 0..<50 {
                if running.allSatisfy({ $0.isTerminated }) { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            guard running.allSatisfy({ $0.isTerminated }) else {
                throw failure("Applications에서 실행 중인 Baton을 종료하지 못했습니다. 진행 중인 작업을 확인하고 직접 종료해 주세요.")
            }
            if fm.fileExists(atPath: destination.path) {
                try fm.trashItem(at: destination, resultingItemURL: &trashed)
            }
            copying = true
            try fm.copyItem(at: source, to: destination)
            try removeQuarantine(destination)
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.createsNewApplicationInstance = true
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                NSWorkspace.shared.openApplication(at: destination, configuration: configuration) { app, error in
                    if let error { continuation.resume(throwing: error) }
                    else if app != nil { continuation.resume() }
                    else { continuation.resume(throwing: failure("설치한 앱을 실행하지 못했습니다.")) }
                }
            }
            // 자기 프로세스가 종료된 다음에만 볼륨을 꺼낸다. 경로는 셸 코드에 보간하지 않는다.
            if source.path.hasPrefix("/Volumes/"), source.pathComponents.count > 2 {
                let volume = URL(fileURLWithPath: "/Volumes").appendingPathComponent(source.pathComponents[2])
                let helper = Process()
                helper.executableURL = URL(fileURLWithPath: "/bin/sh")
                helper.arguments = ["-c", "sleep 2; while /bin/kill -0 \"$2\" 2>/dev/null; do sleep 1; done; /usr/bin/hdiutil detach \"$1\" -quiet", "baton-detach", volume.path, String(ProcessInfo.processInfo.processIdentifier)]
                helper.standardInput = FileHandle.nullDevice
                helper.standardOutput = FileHandle.nullDevice
                helper.standardError = FileHandle.nullDevice
                // 꺼내기 실패로 이미 정상 실행한 새 앱을 되돌리지는 않는다.
                try? helper.run()
            }
            NSApp.terminate(nil)
        } catch {
            var detail = error.localizedDescription
            do {
                if copying && fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
                if let old = trashed { try fm.moveItem(at: old as URL, to: destination) }
            } catch {
                detail += "\n이전 앱 복구도 실패했습니다: \(error.localizedDescription)"
                if let old = trashed { detail += "\n이전 앱은 휴지통에 보관되어 있습니다: \(old.path ?? "")" }
            }
            let alert = NSAlert()
            alert.messageText = "Baton을 옮기지 못했습니다"
            alert.informativeText = "\(detail)\n\nFinder 에서 Baton 을 Applications 로 끌어다 놓아 주세요."
            alert.addButton(withTitle: "종료")
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    private static func removeQuarantine(_ root: URL) throws {
        let fm = FileManager.default
        func remove(_ url: URL) throws {
            let result = url.path.withCString { removexattr($0, "com.apple.quarantine", XATTR_NOFOLLOW) }
            if result != 0 && errno != ENOATTR { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        }
        try remove(root)
        var traversalError: Error?
        let files = fm.enumerator(at: root, includingPropertiesForKeys: nil, errorHandler: { _, error in
            traversalError = error
            return false
        })
        guard let files else { throw failure("복사한 앱의 파일 목록을 읽지 못했습니다.") }
        for case let file as URL in files { try remove(file) }
        if let traversalError { throw traversalError }
    }

    nonisolated private static func failure(_ message: String) -> NSError {
        NSError(domain: "Baton.MoveToApplications", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
