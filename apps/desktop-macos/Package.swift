// swift-tools-version:5.9
// Baton Desktop (macOS 메뉴바 셸). Apple 프레임워크만 사용한다. Xcode 없이 Command Line Tools 로 빌드한다.
//
// 테스트에 관한 메모 (2026-09-04 실측, CLT 6.3.3 / macOS 26.5):
//   Command Line Tools 에는 XCTest 도, swift-testing(Testing) 모듈도 없어서 `swift test` 가
//   "no such module 'XCTest'" / "no such module 'Testing'" 으로 실패한다.
//   그래서 Tests/BatonIPCTests 는 Xcode 가 있는 환경용으로 두고, 같은 검증을 실행 파일
//   `baton-ipc-selftest` 로 복제해 CLT 에서도 `swift run baton-ipc-selftest` 로 돌릴 수 있게 했다.
import PackageDescription

let package = Package(
    name: "BatonDesktop",
    platforms: [.macOS(.v13)],
    targets: [
        // IPC 봉투·메시지·JSON Lines 파서 (UI 와 분리해 단위 테스트 대상으로 둔다)
        .target(name: "BatonIPC", path: "Sources/BatonIPC"),
        .executableTarget(name: "BatonDesktop", dependencies: ["BatonIPC"], path: "Sources/BatonDesktop"),
        // CLT 환경용 자체 검증 (XCTest 없이 실행). Tests/ 와 같은 케이스를 검사한다.
        .executableTarget(name: "baton-ipc-selftest", dependencies: ["BatonIPC"], path: "Sources/BatonIPCSelfTest"),
        .testTarget(name: "BatonIPCTests", dependencies: ["BatonIPC"], path: "Tests/BatonIPCTests"),
    ]
)
