import Foundation

/// 데몬을 어떻게 띄울지 결정한다 (CLO-117-a).
///
/// 배경: 예전 기본 명령은 앱 번들 위치에서 **저장소 루트를 추정해** `node <저장소>/apps/desktop-agent/dist/cli.js` 를 불렀다.
/// 테스터 컴퓨터에는 그 저장소가 없으므로 앱만 받아서는 데몬이 뜨지 않았다.
/// 이제 빌드가 데몬을 단일 파일로 묶어 `Baton.app/Contents/Resources/baton.cjs` 에 넣고, 그것을 1순위로 쓴다.
/// 저장소에서 개발 중일 때는 번들에 그 파일이 없으므로 예전 경로로 폴백한다.
///
/// Node 런타임: GUI 앱은 로그인 셸의 PATH 를 받지 못한다(실측 2026-09-16: `launchctl getenv PATH` 가 비어 있어
/// `/usr/bin:/bin:/usr/sbin:/sbin` 만 들어오고 그 안에 node 가 없다). 그래서 흔한 설치 위치를 직접 뒤진다.
enum DaemonRuntime {

    /// 데몬 스크립트를 어디서 찾았는가
    enum ScriptSource: Equatable {
        case bundled(path: String)       // Baton.app/Contents/Resources/baton.cjs
        case repository(path: String)    // 저장소의 apps/desktop-agent/dist/cli.js
        case none                        // 둘 다 없음

        var path: String? {
            switch self {
            case .bundled(let p), .repository(let p): return p
            case .none: return nil
            }
        }

        /// 사람이 읽는 한 줄 (로그·설정 화면에 그대로 쓴다)
        var label: String {
            switch self {
            case .bundled(let p): return "앱 번들 내장 (\(p))"
            case .repository(let p): return "저장소 개발본 (\(p))"
            case .none: return "찾지 못함"
            }
        }
    }

    /// Node 를 찾은 결과
    enum NodeResult: Equatable {
        case ok(path: String, version: String)
        /// 실행은 되는데 버전이 낮다 (가장 높은 버전을 보고한다)
        case tooOld(path: String, version: String)
        case missing

        var path: String? {
            switch self {
            case .ok(let p, _), .tooOld(let p, _): return p
            case .missing: return nil
            }
        }

        var label: String {
            switch self {
            case .ok(let p, let v): return "node \(v) (\(p))"
            case .tooOld(let p, let v): return "node \(v) — 22 이상이 필요합니다 (\(p))"
            case .missing: return "node 를 찾지 못했습니다"
            }
        }
    }

    static let minimumMajor = 22

    // MARK: 데몬 스크립트

    /// 번들 안의 단일 파일 데몬. build.sh 가 scripts/pack-agent.sh 로 만들어 넣는다.
    static var bundledScriptPath: String? {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("baton.cjs") else { return nil }
        return FileManager.default.isReadableFile(atPath: url.path) ? url.path : nil
    }

    /// 저장소 개발본. 앱 번들 위치에서 위로 올라가며 `apps/desktop-agent` 를 찾는다 (예전 동작).
    static var repositoryScriptPath: String? {
        var dir = Bundle.main.bundleURL.deletingLastPathComponent()
        for _ in 0..<6 {
            let cli = dir.appendingPathComponent("apps/desktop-agent/dist/cli.js")
            if FileManager.default.isReadableFile(atPath: cli.path) { return cli.path }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }

    /// 번들 내장이 있으면 그것, 없으면 저장소 개발본.
    static var scriptSource: ScriptSource {
        if let p = bundledScriptPath { return .bundled(path: p) }
        if let p = repositoryScriptPath { return .repository(path: p) }
        return .none
    }

    // MARK: Node

    /// 사용자가 직접 지정한 node 경로. 자동 탐색이 못 찾는 곳에 깔았을 때의 탈출구다.
    /// (검증에서도 이 값으로 "node 없음"·"버전 낮음" 화면을 재현한다.)
    static var explicitNodePath: String? {
        let raw = ProcessInfo.processInfo.environment["BATON_NODE"] ?? ""
        return raw.isEmpty ? nil : (raw as NSString).expandingTildeInPath
    }

    /// node 를 찾을 후보 디렉터리. GUI 앱의 PATH 가 비어 있다는 전제로 흔한 설치 위치를 직접 넣는다.
    /// nvm·asdf·fnm 은 버전 디렉터리가 여러 개라 따로 펼친다.
    static func nodeCandidates() -> [String] {
        // BATON_NODE 를 줬으면 그것만 본다. 준 값이 틀렸는데 자동 탐색이 조용히 다른 node 를 쓰면
        // 사용자는 자기가 지정한 값이 무시된 줄 모른다.
        if let explicit = explicitNodePath { return [explicit] }
        let home = NSHomeDirectory()
        var dirs = [
            "/opt/homebrew/bin",              // Apple Silicon Homebrew
            "/usr/local/bin",                 // Intel Homebrew · 공식 pkg 설치본
            "\(home)/.volta/bin",             // Volta (shim)
            "\(home)/.asdf/shims",            // asdf
            "\(home)/.local/share/fnm/aliases/default/bin", // fnm 기본 별칭
            "/usr/bin", "/bin",
        ]
        // nvm 은 버전마다 디렉터리가 따로다. 최신 것을 먼저 본다.
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            dirs.insert(contentsOf: versions.sorted(by: >).map { "\(nvm)/\($0)/bin" }, at: 3)
        }
        // 마지막으로 프로세스 PATH (터미널에서 띄운 개발 실행에서는 여기에 답이 있다)
        dirs += (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        var seen = Set<String>()
        return dirs.filter { seen.insert($0).inserted }.map { "\($0)/node" }
    }

    /// 후보를 순서대로 실행해 `--version` 을 읽고, 22 이상인 첫 번째를 고른다.
    /// 전부 낮으면 그중 가장 높은 것을 `tooOld` 로 돌려준다 (사용자에게 "무엇이 깔려 있는지" 를 알려 주려고).
    static func findNode() -> NodeResult {
        var best: (path: String, version: String, major: Int)?
        for path in nodeCandidates() where FileManager.default.isExecutableFile(atPath: path) {
            guard let version = runVersion(path) else { continue }
            let major = majorVersion(version)
            if major >= minimumMajor { return .ok(path: path, version: version) }
            if best == nil || major > best!.major { best = (path, version, major) }
        }
        if let b = best { return .tooOld(path: b.path, version: b.version) }
        return .missing
    }

    /// `node --version` 을 실행해 `v22.17.1` 같은 문자열을 돌려준다. 2초 안에 안 끝나면 포기한다.
    private static func runVersion(_ path: String) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: path)
        proc.arguments = ["--version"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        // volta shim 은 HOME 을 보고 자기 설치 위치를 찾는다. 최소 환경이라도 HOME·PATH 는 넘긴다.
        proc.environment = [
            "HOME": NSHomeDirectory(),
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        ]
        do { try proc.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(2)
        while proc.isRunning && Date() < deadline { usleep(20_000) }
        if proc.isRunning { proc.terminate(); return nil }
        guard proc.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let out = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return out.hasPrefix("v") ? out : nil
    }

    static func majorVersion(_ version: String) -> Int {
        Int(version.dropFirst().split(separator: ".").first.map(String.init) ?? "") ?? 0
    }

    // MARK: 데몬 홈 (토큰·실행 산출물이 쌓이는 곳)

    /// 데몬의 `BATON_HOME` (util/fs.ts 의 batonHome()). 저장소와 무관한 위치여야 한다.
    /// 셸이 자식에게 넘기는 환경을 그대로 계산하므로 여기 보이는 값이 실제 값이다.
    static var daemonHome: String {
        let env = ProcessInfo.processInfo.environment["BATON_HOME"]
        if let env = env, !env.isEmpty { return (env as NSString).expandingTildeInPath }
        return NSHomeDirectory() + "/.baton"
    }

    /// 실행 산출물(프롬프트·결과·patch)이 쌓이는 곳
    static var executionsDir: String { daemonHome + "/executions" }

    /// BATON_HOME 을 환경변수로 받았는가 (설정 화면에서 "기본값" 과 구분해 보여 준다)
    static var daemonHomeFromEnv: Bool {
        !(ProcessInfo.processInfo.environment["BATON_HOME"] ?? "").isEmpty
    }

    // MARK: 종합

    /// 데몬을 띄우기 위해 알아낸 것 전부. 앱 시작 시 한 번 계산해 로그와 설정 화면에 쓴다.
    struct Plan {
        let script: ScriptSource
        let node: NodeResult

        /// `spawn` 이 그대로 쓸 명령 문자열. 경로에 공백이 있을 수 있어 따옴표로 감싼다.
        var commandLine: String {
            let node = self.node.path ?? "node"
            let script = self.script.path ?? "./apps/desktop-agent/dist/cli.js"
            return "\(quote(node)) \(quote(script)) daemon --ipc stdio"
        }

        /// 지금 상태로 데몬을 띄울 수 있는가
        var isRunnable: Bool {
            if case .ok = node, script != .none { return true }
            return false
        }

        /// 못 띄우는 이유 + 해결 방법. 창에 그대로 보여 준다.
        var problem: (title: String, detail: String)? {
            switch node {
            case .missing:
                return ("Node 를 찾지 못했습니다",
                        """
                        Baton 데몬은 Node 22 이상에서 돕니다. 아래 중 하나로 설치한 뒤 Baton 을 다시 실행하세요.

                          • Homebrew:  brew install node
                          • 공식 설치본: https://nodejs.org 에서 LTS 를 받아 설치

                        설치했는데도 이 메시지가 보이면, 터미널에서 `which node` 로 나온 경로를 아래 "데몬 명령" 에 직접 넣거나
                        `BATON_NODE=/경로/node` 환경변수로 지정해 주세요.
                        (GUI 앱은 터미널의 PATH 를 물려받지 않아 흔한 설치 위치만 찾아봅니다.)
                        \(explicitNodeNote)
                        """)
            case .tooOld(let path, let version):
                return ("Node 버전이 낮습니다 (\(version))",
                        """
                        Baton 데몬은 Node \(minimumMajor) 이상이 필요한데 \(version) 만 찾았습니다.
                          찾은 위치: \(path)

                        Homebrew 를 쓴다면 `brew upgrade node`, 아니면 https://nodejs.org 에서 LTS 를 다시 설치하세요.
                        \(explicitNodeNote)
                        """)
            case .ok:
                if script == .none {
                    return ("데몬 파일을 찾지 못했습니다",
                            """
                            앱 번들 안에 baton.cjs 가 없고 저장소 개발본도 찾지 못했습니다.
                            앱을 다시 받거나, 저장소에서 `bash apps/desktop-macos/build.sh` 로 다시 빌드하세요.
                            """)
                }
                return nil
            }
        }

        /// BATON_NODE 로 경로를 지정한 상태면 "자동 탐색이 아니라 당신이 준 값을 봤다" 를 알려 준다.
        private var explicitNodeNote: String {
            guard let p = DaemonRuntime.explicitNodePath else { return "" }
            return "\n지금은 BATON_NODE=\(p) 만 확인했습니다 (이 값이 있으면 자동 탐색을 하지 않습니다)."
        }

        /// 시작 로그 한 줄 (개발자가 어느 쪽을 쓰는지 헷갈리지 않게)
        var logLine: String {
            "데몬 런타임: \(script.label) · \(node.label) · BATON_HOME=\(DaemonRuntime.daemonHome)"
        }

        private func quote(_ s: String) -> String {
            s.contains(" ") ? "\"\(s)\"" : s
        }
    }

    /// 지금 환경을 살펴 계획을 만든다. `node --version` 을 실제로 실행하므로 앱 시작 시 한 번만 부른다.
    static func makePlan() -> Plan {
        Plan(script: scriptSource, node: findNode())
    }
}
