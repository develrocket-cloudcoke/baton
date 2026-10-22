import Foundation
import BatonIPC
import Security

/// 디바이스 토큰 저장소. 계약 §3.3 token.*
///
/// 기본은 Keychain(generic password, service `dev.baton.desktop`, account `deviceToken`).
/// 개발 모드: 환경변수 `BATON_TOKEN_STORE=file` 이면 `~/.baton/device-token`(0600) 파일을 쓴다.
/// — ad-hoc 서명 빌드는 빌드할 때마다 코드 서명이 바뀌어, 이전 빌드가 만든 Keychain 항목을 읽을 때
///   macOS 가 키체인 암호 프롬프트를 띄우고 그동안 `SecItemCopyMatching` 이 호출한 스레드를 막는다
///   (W4b 인수, docs/mvp-acceptance.md §4 이슈 2). 개발 반복 중에는 파일 저장소로 우회한다.
///
/// CLO-9 ①: 실제 읽기·쓰기는 항상 `TokenService` 의 직렬 큐(=main thread 밖)에서 부른다.
/// main thread 에서 부르면 프롬프트가 떠 있는 동안 IPC 가 통째로 멈춘다.
enum TokenStore {
    enum Mode: String { case keychain, file }

    static let mode: Mode = {
        let raw = ProcessInfo.processInfo.environment["BATON_TOKEN_STORE"]?.lowercased() ?? ""
        return Mode(rawValue: raw) ?? .keychain
    }()

    /// 저장소를 고른 근거 (팝오버·로그 표시용)
    static var sourceNote: String {
        ProcessInfo.processInfo.environment["BATON_TOKEN_STORE"] != nil ? "BATON_TOKEN_STORE 환경변수" : "기본값"
    }

    /// UI/로그 표시용
    static var label: String {
        switch mode {
        case .keychain: return "Keychain"
        case .file: return "파일 \(FileTokenStore.path.path)"
        }
    }

    static func readToken() throws -> String? {
        switch mode {
        case .keychain: return try Keychain.readToken()
        case .file: return try FileTokenStore.readToken()
        }
    }

    /// nil 이면 삭제
    static func writeToken(_ token: String?) throws {
        switch mode {
        case .keychain: try Keychain.writeToken(token)
        case .file: try FileTokenStore.writeToken(token)
        }
    }
}

/// 개발용 파일 저장소 (~/.baton/device-token, 디렉터리 0700 / 파일 0600)
enum FileTokenStore {
    struct FileError: Error { let message: String }

    /// 데몬과 같은 규칙: `BATON_HOME` 이 있으면 그 아래, 없으면 `~/.baton`.
    /// (검증용 빌드를 사용자의 `~/.baton` 과 분리할 수 있어야 한다)
    static var path: URL {
        if let home = ProcessInfo.processInfo.environment["BATON_HOME"], !home.isEmpty {
            return URL(fileURLWithPath: (home as NSString).expandingTildeInPath).appendingPathComponent("device-token")
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".baton/device-token")
    }

    static func readToken() throws -> String? {
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        let data = try Data(contentsOf: path)
        let s = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : s
    }

    static func writeToken(_ token: String?) throws {
        let fm = FileManager.default
        guard let token = token else {
            if fm.fileExists(atPath: path.path) { try fm.removeItem(at: path) }
            return
        }
        let dir = path.deletingLastPathComponent()
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try Data(token.utf8).write(to: path, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }
}

/// Keychain 저장소 (generic password, service `dev.baton.desktop`, account `deviceToken`)
enum Keychain {
    /// 번들 id 를 그대로 쓴다. 기본 번들이면 `dev.baton.desktop` 으로 기존과 같고,
    /// `BATON_BUNDLE_ID` 로 빌드한 검증용 앱은 별도 항목을 쓴다(정식 항목의 ACL 을 건드리지 않는다).
    static let service = Bundle.main.bundleIdentifier ?? "dev.baton.desktop"
    static let account = "deviceToken"

    struct KeychainError: Error { let status: OSStatus; var message: String { (SecCopyErrorMessageString(status, nil) as String?) ?? "OSStatus \(status)" } }

    private static var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func readToken() throws -> String? {
        var q = baseQuery
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// nil 이면 삭제
    static func writeToken(_ token: String?) throws {
        guard let token = token else {
            let status = SecItemDelete(baseQuery as CFDictionary)
            if status != errSecSuccess && status != errSecItemNotFound { throw KeychainError(status: status) }
            return
        }
        let data = Data(token.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let s2 = SecItemAdd(add as CFDictionary, nil)
            guard s2 == errSecSuccess else { throw KeychainError(status: s2) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }
}

/// 토큰 읽기·쓰기를 **main thread 밖**(전용 직렬 큐)에서 수행하고 결과를 캐시한다. (CLO-9 ①)
///
/// 왜: ad-hoc 서명 빌드를 다시 만들면 Keychain 항목의 ACL 이 더 이상 맞지 않아 macOS 가 암호 프롬프트를 띄운다.
/// `SecItemCopyMatching` 은 그동안 호출한 스레드를 막는데, 예전에는 그게 main thread 라 셸의 IPC 루프가 통째로
/// 멈췄고 → 데몬의 `token.get` 이 10초 timeout → 데몬 exit 1 → 백오프 재시작(프롬프트 재발) 루프였다.
///
/// 지금은 프롬프트가 떠 있어도 main queue 는 계속 돌고, `replyDeadline` 안에 못 읽으면
/// 데몬에 `keychain_error` 를 돌려준다. 데몬은 이를 받고 죽지 않고 not_paired 상태로 떨어진다.
final class TokenService {
    enum Status: Equatable {
        case loading                 // 읽는 중 (Keychain 프롬프트 대기 중일 수 있다)
        case ready(hasToken: Bool)
        case failed(String)

        /// 팝오버 표시용 한 줄
        var text: String {
            switch self {
            case .loading: return TokenStore.mode == .keychain ? "읽는 중… (Keychain 프롬프트가 떠 있으면 응답해 주세요)" : "읽는 중…"
            case .ready(let has): return has ? "토큰 저장됨" : "토큰 없음"
            case .failed(let m): return "읽기 실패: \(m)"
            }
        }
    }

    /// 데몬 `token.get` 에 응답하기까지 기다리는 한계. 데몬 IPC timeout(10초)보다 짧게 잡아
    /// 데몬이 timeout 으로 죽는 대신 `keychain_error` 를 받아 not_paired 로 떨어지게 한다.
    static let replyDeadline: TimeInterval = 6

    private let queue = DispatchQueue(label: "dev.baton.tokenstore", qos: .userInitiated)
    private(set) var status: Status = .loading      // main queue 에서만 읽고 쓴다
    private(set) var cached: String? = nil
    private var inFlight = false
    private var waiters: [(Result<String?, IPCError>) -> Void] = []

    /// 상태가 바뀔 때 main queue 로 호출된다 (UI·로그)
    var onChange: ((Status) -> Void)?
    /// 처음에는 못 읽었다가 나중에 읽기에 성공했을 때 (프롬프트에 늦게 응답한 경우) main queue 로 호출된다.
    /// 데몬이 이미 not_paired 로 떨어져 있으므로 셸이 다시 알려 줘야 재연결된다.
    var onLateSuccess: (() -> Void)?

    private var everFailed = false

    /// 캐시된 값 (없으면 nil). 절대 블록하지 않는다 — shell.hello 처럼 즉답이 필요한 자리에서 쓴다.
    var tokenIfLoaded: String? { if case .ready = status { return cached }; return nil }

    /// 백그라운드 읽기를 시작한다. 이미 진행 중이면 아무것도 하지 않는다.
    func load(force: Bool = false) {
        if inFlight { return }
        if case .ready = status, !force { return }
        inFlight = true
        setStatus(.loading)
        let startedAt = Date()
        queue.async { [weak self] in
            let result: Result<String?, IPCError>
            do { result = .success(try TokenStore.readToken()) }
            catch let e as Keychain.KeychainError { result = .failure(IPCError(code: .keychainError, message: e.message, retryable: true)) }
            catch let e as FileTokenStore.FileError { result = .failure(IPCError(code: .keychainError, message: e.message, retryable: true)) }
            catch { result = .failure(IPCError(code: .keychainError, message: "\(error)", retryable: true)) }
            let elapsed = Date().timeIntervalSince(startedAt)
            DispatchQueue.main.async { self?.finish(result, elapsed: elapsed) }
        }
    }

    /// 토큰을 비동기로 돌려준다. 캐시가 있으면 즉시, 없으면 읽기를 기다리되
    /// `replyDeadline` 을 넘기면 사유와 함께 실패로 답한다 (호출자를 영원히 붙잡지 않는다).
    func token(_ completion: @escaping (Result<String?, IPCError>) -> Void) {
        if case .ready = status, !inFlight { completion(.success(cached)); return }
        var done = false
        let once: (Result<String?, IPCError>) -> Void = { r in
            guard !done else { return }
            done = true
            completion(r)
        }
        waiters.append(once)
        load()
        DispatchQueue.main.asyncAfter(deadline: .now() + TokenService.replyDeadline) { [weak self] in
            guard !done else { return }
            let label = TokenStore.label
            FileLog.shell.write("token.get deadline \(Int(TokenService.replyDeadline))s 초과 (\(label)) — keychain_error 로 응답")
            self?.setStatus(.failed("\(Int(TokenService.replyDeadline))초 안에 응답 없음 (프롬프트 대기 추정)"))
            once(.failure(IPCError(code: .keychainError, message: "\(label) 읽기가 \(Int(TokenService.replyDeadline))초 안에 끝나지 않았습니다. 키체인 접근 프롬프트가 떠 있는지 확인하거나 BATON_TOKEN_STORE=file 로 실행하세요.", retryable: true)))
        }
    }

    /// 쓰기(저장·삭제)도 같은 직렬 큐에서 한다. completion 은 main queue.
    ///
    /// 읽기 프롬프트가 떠 있으면 그 읽기가 끝날 때까지 큐에서 대기하므로(직렬), 읽기와 같은 한계 시간을 둔다.
    /// 그러지 않으면 "프롬프트를 무시한 채 재-pairing" 이 데몬 IPC timeout(10초)으로 끝나 버린다.
    func write(_ token: String?, completion: @escaping (Result<Void, IPCError>) -> Void) {
        var done = false
        let once: (Result<Void, IPCError>) -> Void = { r in
            guard !done else { return }
            done = true
            completion(r)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + TokenService.replyDeadline) {
            guard !done else { return }
            let label = TokenStore.label
            FileLog.shell.write("token.set deadline \(Int(TokenService.replyDeadline))s 초과 (\(label))")
            once(.failure(IPCError(code: .keychainError, message: "\(label) 저장이 \(Int(TokenService.replyDeadline))초 안에 끝나지 않았습니다. 키체인 접근 프롬프트가 떠 있는지 확인하세요.", retryable: true)))
        }
        queue.async { [weak self] in
            let result: Result<Void, IPCError>
            do { try TokenStore.writeToken(token); result = .success(()) }
            catch let e as Keychain.KeychainError { result = .failure(IPCError(code: .keychainError, message: e.message)) }
            catch let e as FileTokenStore.FileError { result = .failure(IPCError(code: .keychainError, message: e.message)) }
            catch { result = .failure(IPCError(code: .keychainError, message: "\(error)")) }
            DispatchQueue.main.async {
                guard let self = self else { return }
                if case .success = result {
                    self.cached = token
                    self.inFlight = false
                    self.setStatus(.ready(hasToken: token != nil))
                }
                once(result)
            }
        }
    }

    // MARK: 내부 (모두 main queue)

    private func finish(_ result: Result<String?, IPCError>, elapsed: TimeInterval) {
        inFlight = false
        switch result {
        case .success(let token):
            cached = token
            setStatus(.ready(hasToken: token != nil))
            FileLog.shell.write("token 읽기 완료 (\(TokenStore.label)) hasToken=\(token != nil) \(String(format: "%.2f", elapsed))s")
            if everFailed { everFailed = false; onLateSuccess?() }
        case .failure(let e):
            everFailed = true
            setStatus(.failed(e.message))
            FileLog.shell.write("token 읽기 실패 (\(TokenStore.label)): \(e.message) \(String(format: "%.2f", elapsed))s")
        }
        let pending = waiters
        waiters.removeAll()
        for w in pending { w(result) }
    }

    private func setStatus(_ s: Status) {
        if case .failed = s { everFailed = true }
        guard status != s else { return }
        status = s
        onChange?(s)
    }
}
