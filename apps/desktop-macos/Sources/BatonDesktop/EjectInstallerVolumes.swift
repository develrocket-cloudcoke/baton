import Foundation

/// 설치에 쓴 Baton DMG 가 연결된 채 남아 있으면 꺼낸다.
///
/// 대부분의 사람은 DMG 를 열고 Baton 을 Applications 로 끌어다 놓은 뒤 꺼내기를 잊는다. 그러면 Finder "위치"에
/// Baton 볼륨이 쌓이고(2026-09-28 사용자 Mac 에 16개), 그 안의 옛 앱을 실수로 실행할 수 있다. 끌어다 놓기에는
/// 앱이 끼어들 틈이 없으므로, 설치된 앱이 처음 뜰 때가 정리할 수 있는 유일한 순간이다.
///
/// 꺼내는 대상은 `hdiutil info` 에 나오는 **디스크 이미지**이면서, 그 안의 앱이 이 앱과 같은 bundle id 인 볼륨뿐이다.
/// 다른 DMG·외장 디스크는 건드리지 않는다. DMG 안에서 실행 중일 때만 건너뛴다(그 경우는 MoveToApplications 가 맡는다).
/// 처음엔 /Applications 에서만 돌게 했는데, 사용자가 Spotlight 로 빌드 폴더의 Baton 을 실행해 동작하지 않았다(2026-09-28).
enum EjectInstallerVolumes {
    static func run(log: @escaping (String) -> Void) {
        let path = Bundle.main.bundleURL.standardizedFileURL.path
        guard !path.hasPrefix("/Volumes/"), !path.contains("/AppTranslocation/"),
              let myId = Bundle.main.bundleIdentifier else { return }
        DispatchQueue.global(qos: .utility).async {
            for mountPoint in batonImageMountPoints(bundleId: myId) {
                // Finder 가 그 볼륨 창을 열어 두면 "사용 중" 으로 거부된다. 잠시 뒤 몇 번 더 시도한다.
                var ejected = false
                for attempt in 0..<4 {
                    if attempt > 0 { Thread.sleep(forTimeInterval: 3) }
                    if hdiutil(["detach", mountPoint, "-quiet"]) != nil { ejected = true; break }
                }
                DispatchQueue.main.async {
                    log(ejected ? "설치용 디스크 이미지 꺼냄: \(mountPoint)"
                                : "설치용 디스크 이미지를 꺼내지 못했습니다(사용 중): \(mountPoint) — Finder 에서 ⏏ 로 꺼내 주세요")
                }
            }
        }
    }

    /// 연결된 디스크 이미지 중 안에 이 앱(같은 bundle id)이 든 볼륨의 마운트 경로.
    private static func batonImageMountPoints(bundleId: String) -> [String] {
        guard let data = hdiutil(["info", "-plist"]),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let images = plist["images"] as? [[String: Any]] else { return [] }
        var result: [String] = []
        for image in images {
            for entity in image["system-entities"] as? [[String: Any]] ?? [] {
                guard let mount = entity["mount-point"] as? String, mount.hasPrefix("/Volumes/") else { continue }
                let fm = FileManager.default
                let apps = (try? fm.contentsOfDirectory(atPath: mount))?.filter { $0.hasSuffix(".app") } ?? []
                if apps.contains(where: { Bundle(path: "\(mount)/\($0)")?.bundleIdentifier == bundleId }) {
                    result.append(mount)
                }
            }
        }
        return result
    }

    /// 성공하면 표준 출력, 실패하면 nil. 인자는 셸을 거치지 않고 그대로 넘긴다.
    private static func hdiutil(_ args: [String]) -> Data? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 ? data : nil
    }
}
