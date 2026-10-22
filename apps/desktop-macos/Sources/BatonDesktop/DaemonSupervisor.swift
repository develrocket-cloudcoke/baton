import Foundation
import BatonIPC

/// 셸이 데몬에 응답해야 하는 요청과, 받아서 처리할 이벤트를 위임한다. 모든 콜백은 main queue 에서 호출된다.
protocol DaemonSupervisorDelegate: AnyObject {
    /// daemon.hello 에 대한 shell.hello payload
    func shellHello(for supervisor: DaemonSupervisor) -> ShellHello
    /// 데몬→셸 request 처리. 응답 (type, payload) 또는 IPCError 를 `reply` 로 돌려준다.
    /// 비동기인 이유: Keychain 읽기는 ACL 프롬프트 때문에 오래 걸릴 수 있어 main thread 밖에서 처리한다 (CLO-9 ①).
    /// `reply` 는 main queue 에서, 정확히 한 번 호출한다.
    func supervisor(_ supervisor: DaemonSupervisor, handleRequest env: Envelope, reply: @escaping (Result<(type: String, payload: JSONValue), IPCError>) -> Void)
    /// 데몬→셸 event 처리
    func supervisor(_ supervisor: DaemonSupervisor, handleEvent env: Envelope)
    func supervisor(_ supervisor: DaemonSupervisor, stateChanged state: DaemonSupervisor.State)
}

/// 데몬 프로세스 생명주기 (계약 §6): spawn, 핸드셰이크 타임아웃, hung 감지, 백오프 재시작, 종료 순서.
final class DaemonSupervisor {
    enum State: Equatable {
        case stopped
        case starting(pid: Int32)
        case running(pid: Int32)
        case backoff(seconds: Int, lastExit: Int32)
        case failed(reason: String)   // protocol_mismatch 등 재시작하지 않는 종료
    }

    weak var delegate: DaemonSupervisorDelegate?
    private(set) var state: State = .stopped { didSet { if state != oldValue { delegate?.supervisor(self, stateChanged: state) } } }
    private(set) var helloReceived = false
    private(set) var daemonPid: Int32 = 0

    // 계약 §6 상수
    private let helloTimeout: TimeInterval = 10
    private let statusWatchdog: TimeInterval = 120
    private let shutdownGrace: TimeInterval = 5
    private let termGrace: TimeInterval = 3
    private let backoffMax = 60
    private let stableUptime: TimeInterval = 300
    /// 04 §11.2: 데몬이 "다른 데몬 연결로 대체됨" 으로 스스로 끝냈다는 뜻. 재시작하면 서로 밀어내는 루프가 되므로 재시작하지 않는다.
    static let exitConnectionReplaced: Int32 = 17

    private var process: Process?
    private var stdinPipe: Pipe?
    private let parser = LineParser()
    private let ids = MessageIdSequence(prefix: "s")
    private var backoffSeconds = 1
    private var startedAt: Date?
    private var shutdownSent = false
    private var restartTimer: DispatchWorkItem?
    private var helloTimer: DispatchWorkItem?
    private var watchdogTimer: DispatchWorkItem?
    private var stopping = false

    /// 셸→데몬 request 의 대기 응답
    private struct Pending { let completion: (Result<Envelope, IPCError>) -> Void; let timer: DispatchWorkItem }
    private var pending: [String: Pending] = [:]

    var commandLine: String = SettingsStore.shared.daemonCommand

    // MARK: 시작/정지

    func start() {
        stopping = false
        shutdownSent = false
        spawn()
    }

    /// 앱 종료·재시작용 정상 종료 순서: daemon.shutdown → ack/5s → SIGTERM → 3s → SIGKILL. completion 은 프로세스 종료 후 main queue.
    func stop(reason: String, completion: @escaping () -> Void) {
        stopping = true
        restartTimer?.cancel(); helloTimer?.cancel(); watchdogTimer?.cancel()
        guard let proc = process, proc.isRunning else { state = .stopped; completion(); return }
        shutdownSent = true
        let pid = proc.processIdentifier
        var finished = false
        let finish = { if !finished { finished = true; completion() } }
        let waitExit = { (grace: TimeInterval, then: @escaping () -> Void) in
            let deadline = Date().addingTimeInterval(grace)
            DispatchQueue.global().async {
                while proc.isRunning && Date() < deadline { usleep(50_000) }
                DispatchQueue.main.async { then() }
            }
        }
        let escalate = { [weak self] in
            guard let self = self else { return }
            if !proc.isRunning { self.state = .stopped; finish(); return }
            FileLog.shell.write("daemon pid=\(pid) SIGTERM (group)")
            kill(-pid, SIGTERM); kill(pid, SIGTERM)
            waitExit(self.termGrace) {
                if proc.isRunning { FileLog.shell.write("daemon pid=\(pid) SIGKILL"); kill(-pid, SIGKILL); kill(pid, SIGKILL) }
                waitExit(1) { self.state = .stopped; finish() }
            }
        }
        if helloReceived {
            request(type: MessageType.daemonShutdown, payload: (try? IPCCodec.payload(of: DaemonShutdown(reason: reason))) ?? .object([:]), timeout: shutdownGrace) { _ in
                waitExit(1) { escalate() }
            }
        } else {
            escalate()
        }
    }

    func restart(reason: String) {
        stop(reason: reason) { [weak self] in
            self?.backoffSeconds = 1
            self?.start()
        }
    }

    // MARK: 송신

    /// event 전송 (응답 없음)
    @discardableResult
    func send(type: String, payload: JSONValue = .object([:]), replyTo: String? = nil) -> String? {
        let env = Envelope(type: type, id: ids.next(), replyTo: replyTo, payload: payload)
        return write(env) ? env.id : nil
    }

    /// 데몬이 떠 있으면 바로, 아니면 **띄운 뒤** 핸드셰이크가 끝나면 실행한다.
    ///
    /// 데몬이 죽어 있는 동안에도 사람이 할 수 있어야 하는 일이 있다 — 특히 pairing.
    /// 예전에는 그냥 "daemon not running" 으로 끝나서, 웹에서 디바이스를 해제한 뒤
    /// 다시 연결할 방법이 앱 재시작밖에 없었다(2026-09-21).
    func ensureRunning(timeout: TimeInterval = 15, _ body: @escaping (Bool) -> Void) {
        if let proc = process, proc.isRunning, helloReceived { body(true); return }
        FileLog.shell.write("ensureRunning: 데몬을 다시 띄웁니다 (state=\(state))")
        restartTimer?.cancel()
        backoffSeconds = 1
        if process == nil { start() }
        let deadline = Date().addingTimeInterval(timeout)
        func poll() {
            if let proc = self.process, proc.isRunning, self.helloReceived { body(true); return }
            if Date() >= deadline { body(false); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { poll() }
        }
        poll()
    }

    /// request 전송. 응답(또는 timeout)을 main queue 로 돌려준다.
    func request(type: String, payload: JSONValue = .object([:]), timeout: TimeInterval = 10, completion: @escaping (Result<Envelope, IPCError>) -> Void) {
        let env = Envelope(type: type, id: ids.next(), payload: payload)
        guard write(env) else { completion(.failure(IPCError(code: .daemonExited, message: "daemon not running", retryable: true))); return }
        let timer = DispatchWorkItem { [weak self] in
            guard let self = self, let p = self.pending.removeValue(forKey: env.id) else { return }
            FileLog.shell.write("ipc.timeout type=\(type) id=\(env.id)")
            p.completion(.failure(IPCError(code: .timeout, message: "\(type) timed out after \(Int(timeout))s", retryable: true)))
        }
        pending[env.id] = Pending(completion: completion, timer: timer)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: timer)
    }

    private func write(_ env: Envelope) -> Bool {
        guard let proc = process, proc.isRunning, let stdin = stdinPipe else { return false }
        do {
            let data = try IPCCodec.encodeLine(env)
            stdin.fileHandleForWriting.write(data)
            return true
        } catch {
            FileLog.shell.write("ipc.encode_error type=\(env.type) \(error)")
            return false
        }
    }

    // MARK: spawn

    private func spawn() {
        let parts = DaemonSupervisor.tokenize(commandLine)
        guard let exe = parts.first else { state = .failed(reason: "daemonCommand 가 비어 있음"); return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: resolveExecutable(exe))
        proc.arguments = Array(parts.dropFirst())
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        env["BATON_IPC"] = "stdio"
        env["BATON_SHELL"] = "macos"
        env["BATON_SHELL_VERSION"] = AppInfo.version
        // 04 §11.4: 데몬(Node)의 os.release() 는 커널 버전(Darwin 25.5.0)이라 사람이 읽기 어렵다.
        // 셸이 아는 제품 버전을 넘겨 웹 "내 디바이스" 에 macOS 15.5 처럼 보이게 한다.
        env["BATON_OS_VERSION"] = AppInfo.osVersion
        env["BATON_LOG_DIR"] = FileLog.directory.path
        proc.environment = env
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        proc.standardInput = stdin; proc.standardOutput = stdout; proc.standardError = stderr
        parser.reset()
        helloReceived = false
        shutdownSent = false

        stdout.fileHandleForReading.readabilityHandler = { [weak self] fh in
            let chunk = fh.availableData
            guard !chunk.isEmpty else { return }
            DispatchQueue.main.async { self?.handleChunk(chunk, from: proc) }
        }
        stderr.fileHandleForReading.readabilityHandler = { fh in
            let d = fh.availableData
            if !d.isEmpty { FileLog.daemon.writeRaw(d) }
        }
        proc.terminationHandler = { [weak self] p in
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async { self?.handleExit(p) }
        }
        do {
            try proc.run()
        } catch {
            FileLog.shell.write("daemon spawn failed: \(error.localizedDescription) cmd=\(commandLine)")
            scheduleRestart(lastExit: -1, error: "spawn 실패: \(error.localizedDescription)")
            return
        }
        process = proc; stdinPipe = stdin; daemonPid = proc.processIdentifier; startedAt = Date()
        state = .starting(pid: proc.processIdentifier)
        FileLog.shell.write("daemon spawned pid=\(proc.processIdentifier) cmd=\(commandLine)")
        let hello = DispatchWorkItem { [weak self] in
            guard let self = self, !self.helloReceived, proc.isRunning else { return }
            FileLog.shell.write("daemon.hello timeout (10s) → SIGKILL")
            kill(proc.processIdentifier, SIGKILL)
        }
        helloTimer = hello
        DispatchQueue.main.asyncAfter(deadline: .now() + helloTimeout, execute: hello)
    }

    /// 명령 문자열을 인자로 쪼갠다. 경로에 공백이 있을 수 있어 큰따옴표를 이해한다
    /// (번들 경로가 "/Users/…/My Apps/Baton.app/…" 처럼 될 수 있다).
    static func tokenize(_ line: String) -> [String] {
        var out: [String] = []
        var cur = ""
        var inQuote = false
        for ch in line {
            if ch == "\"" { inQuote.toggle(); continue }
            if ch == " " && !inQuote {
                if !cur.isEmpty { out.append(cur); cur = "" }
                continue
            }
            cur.append(ch)
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    /// PATH 에서 실행 파일을 찾는다 (GUI 앱의 PATH 가 빈약하므로 직접 탐색).
    /// node 는 버전까지 봐야 하므로 DaemonRuntime 의 탐색 결과를 먼저 쓴다.
    private func resolveExecutable(_ name: String) -> String {
        if name.hasPrefix("/") { return name }
        if name == "node", let found = DaemonRuntime.findNode().path { return found }
        let dirs = ["/opt/homebrew/bin", "/usr/local/bin", NSHomeDirectory() + "/.volta/bin", "/usr/bin", "/bin"] + (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        for d in dirs { let p = "\(d)/\(name)"; if FileManager.default.isExecutableFile(atPath: p) { return p } }
        return name
    }

    // MARK: 수신

    private func handleChunk(_ chunk: Data, from proc: Process) {
        guard proc === process else { return } // 이전 프로세스의 잔여 출력
        for event in parser.feed(chunk) {
            switch event {
            case .oversize(let bytes):
                FileLog.shell.write("ipc.oversize bytes=\(bytes)")
            case .malformed(let n, let preview):
                FileLog.shell.write("ipc.malformed consecutive=\(n) preview=\(preview)")
                if n >= 3 { FileLog.shell.write("3 consecutive malformed lines → restart"); kill(proc.processIdentifier, SIGKILL) }
            case .envelope(let env):
                handleEnvelope(env)
            }
        }
    }

    private func handleEnvelope(_ env: Envelope) {
        if let err = env.validate() {
            FileLog.shell.write("ipc.invalid_envelope \(err.message)")
            if err.code == .protocolMismatch && env.type == MessageType.daemonHello { protocolMismatch(env) ; return }
            if !env.id.isEmpty { reply(to: env, type: MessageType.error, payload: (try? IPCCodec.payload(of: ErrorPayload(err))) ?? .object([:])) }
            return
        }
        // 응답
        if let replyTo = env.replyTo {
            guard let p = pending.removeValue(forKey: replyTo) else { FileLog.shell.write("ipc.unknown_reply replyTo=\(replyTo)"); return }
            p.timer.cancel()
            if env.type == MessageType.error, let e = try? IPCCodec.payload(env, as: ErrorPayload.self) {
                p.completion(.failure(IPCError(code: IPCError.Code(rawValue: e.code) ?? .internal, message: e.message, retryable: e.retryable)))
            } else { p.completion(.success(env)) }
            return
        }
        // 핸드셰이크 전에는 hello 만 받는다
        if !helloReceived {
            guard env.type == MessageType.daemonHello else { FileLog.shell.write("ipc.before_hello type=\(env.type) dropped"); return }
            guard let hello = try? IPCCodec.payload(env, as: DaemonHello.self) else { reply(to: env, type: MessageType.error, payload: (try? IPCCodec.payload(of: ErrorPayload(IPCError(code: .invalidPayload, message: "daemon.hello payload")))) ?? .object([:])); return }
            guard hello.protocol == ipcProtocolVersion else { protocolMismatch(env); return }
            helloReceived = true
            helloTimer?.cancel()
            if hello.pid > 0 { daemonPid = hello.pid }
            if let sh = delegate?.shellHello(for: self), let payload = try? IPCCodec.payload(of: sh) {
                reply(to: env, type: MessageType.shellHello, payload: payload)
            }
            state = .running(pid: daemonPid)
            FileLog.shell.write("handshake ok daemon=\(hello.daemonVersion) pid=\(hello.pid) caps=\(hello.capabilities)")
            armWatchdog()
            return
        }
        switch env.type {
        case MessageType.daemonStatus:
            armWatchdog()
            delegate?.supervisor(self, handleEvent: env)
        case MessageType.executionProgress, MessageType.settingsSchema, MessageType.daemonLog:
            delegate?.supervisor(self, handleEvent: env)
        case MessageType.requestNotify, MessageType.notificationDismiss, MessageType.settingsGet, MessageType.settingsSet, MessageType.tokenGet, MessageType.tokenSet:
            guard let delegate = delegate else { reply(to: env, type: MessageType.ack, payload: .object([:])); return }
            // 응답이 늦어도(Keychain 프롬프트) 여기서 return 하므로 수신 루프는 계속 돈다
            delegate.supervisor(self, handleRequest: env) { [weak self] result in
                guard let self = self else { return }
                switch result {
                case .success(let answer):
                    self.reply(to: env, type: answer.type, payload: answer.payload)
                case .failure(let e):
                    self.reply(to: env, type: MessageType.error, payload: (try? IPCCodec.payload(of: ErrorPayload(e))) ?? .object([:]))
                }
            }
        default:
            FileLog.shell.write("ipc.unknown_type \(env.type)")
            reply(to: env, type: MessageType.error, payload: (try? IPCCodec.payload(of: ErrorPayload(IPCError(code: .unknownType, message: env.type)))) ?? .object([:]))
        }
    }

    private func reply(to env: Envelope, type: String, payload: JSONValue) {
        _ = write(Envelope(type: type, id: ids.next(), replyTo: env.id, payload: payload))
    }

    private func protocolMismatch(_ env: Envelope) {
        FileLog.shell.write("protocol_mismatch: daemon v=\(env.payload["protocol"]?.intValue ?? env.v)")
        reply(to: env, type: MessageType.error, payload: (try? IPCCodec.payload(of: ErrorPayload(IPCError(code: .protocolMismatch, message: "shell protocol \(ipcProtocolVersion)")))) ?? .object([:]))
        helloReceived = true // shutdown 을 보낼 수 있도록
        stop(reason: "protocol_mismatch") { [weak self] in self?.state = .failed(reason: "데몬 프로토콜 버전 불일치") }
    }

    private func armWatchdog() {
        watchdogTimer?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, let proc = self.process, proc.isRunning else { return }
            FileLog.shell.write("daemon.status watchdog (120s) → restart")
            kill(proc.processIdentifier, SIGTERM)
            DispatchQueue.main.asyncAfter(deadline: .now() + self.termGrace) { if proc.isRunning { kill(proc.processIdentifier, SIGKILL) } }
        }
        watchdogTimer = w
        DispatchQueue.main.asyncAfter(deadline: .now() + statusWatchdog, execute: w)
    }

    // MARK: 종료·재시작

    private func handleExit(_ proc: Process) {
        guard proc === process else { return }
        let code = proc.terminationStatus
        FileLog.shell.write("daemon exited code=\(code) uptime=\(Int(-(startedAt?.timeIntervalSinceNow ?? 0)))s shutdownSent=\(shutdownSent)")
        helloTimer?.cancel(); watchdogTimer?.cancel()
        for (_, p) in pending { p.timer.cancel(); p.completion(.failure(IPCError(code: .daemonExited, message: "daemon exited", retryable: true))) }
        pending.removeAll()
        process = nil; stdinPipe = nil
        if stopping || shutdownSent { state = .stopped; return }
        if code == DaemonSupervisor.exitConnectionReplaced {
            FileLog.shell.write("daemon exit \(code): 다른 데몬 연결로 대체됨 → 재시작하지 않음")
            state = .failed(reason: "다른 데몬이 이 디바이스에 연결되어 종료했습니다 (중복 실행)")
            return
        }
        if let s = startedAt, -s.timeIntervalSinceNow > stableUptime { backoffSeconds = 1 }
        scheduleRestart(lastExit: code, error: "exit \(code)")
    }

    private func scheduleRestart(lastExit: Int32, error: String) {
        let delay = backoffSeconds
        state = .backoff(seconds: delay, lastExit: lastExit)
        FileLog.shell.write("daemon restart in \(delay)s (\(error))")
        backoffSeconds = min(backoffSeconds * 2, backoffMax)
        let item = DispatchWorkItem { [weak self] in guard let self = self, !self.stopping else { return }; self.spawn() }
        restartTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(delay), execute: item)
    }
}

enum AppInfo {
    static let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.1.0-dev"
    /// 표시용 OS 버전 (예: macOS 15.5)
    static var osVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let patch = v.patchVersion > 0 ? ".\(v.patchVersion)" : ""
        return "macOS \(v.majorVersion).\(v.minorVersion)\(patch)"
    }
}
