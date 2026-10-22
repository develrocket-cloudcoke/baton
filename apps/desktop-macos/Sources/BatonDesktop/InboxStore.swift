import Foundation
import Combine

struct InboxItem: Decodable, Identifiable {
    let id: String
    let title: String
    let state: String
    let role: String
    let reason: String
    let teamName: String
    let updatedAt: String
}

private struct InboxResponse: Decodable {
    let items: [InboxItem]
    let count: Int
}

/// 메인 큐에서 조회를 조율한다. 토큰 읽기는 기존 TokenService의 백그라운드 경로만 사용한다.
final class InboxStore {
    private weak var model: AppModel?
    private let tokens: TokenService
    private var timer: Timer?
    private var settingsSubscription: AnyCancellable?
    private var task: URLSessionDataTask?
    private var inFlight = false
    private var generation = 0
    private var server: URL?
    private var identityToken: String?

    init(model: AppModel, tokens: TokenService) {
        self.model = model
        self.tokens = tokens
        server = SettingsStore.shared.savedServerURL
    }

    func start() {
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 60, repeats: true) { [weak self] _ in self?.refresh() }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
        settingsSubscription = NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self = self, self.server != SettingsStore.shared.savedServerURL else { return }
                self.reset()
                self.server = SettingsStore.shared.savedServerURL
                self.refresh()
            }
        refresh()
    }

    func pairingChanged(hasToken: Bool) {
        if hasToken {
            if let previous = identityToken, previous != tokens.tokenIfLoaded { reset() }
            refresh()
        } else {
            reset()
        }
    }

    private func reset() {
        // 계정·서버를 바꾼 뒤 이전 응답이 늦게 도착해 다른 사용자의 목록을 덮지 않게 한다.
        generation += 1
        task?.cancel()
        task = nil
        inFlight = false
        identityToken = nil
        model?.inboxItems = []
        model?.inboxCount = 0
    }

    func refresh() {
        guard !inFlight, model?.hasToken == true, let server = SettingsStore.shared.savedServerURL else { return }
        inFlight = true
        let ticket = generation
        tokens.token { [weak self] result in
            guard let self = self, self.generation == ticket else { return }
            switch result {
            case .failure:
                self.inFlight = false
                self.model?.log("내 차례 조회 실패: 기기 토큰을 읽지 못했습니다")
            case .success(let value):
                guard let token = value, !token.isEmpty else { self.inFlight = false; return }
                if let previous = self.identityToken, previous != token {
                    self.model?.inboxItems = []
                    self.model?.inboxCount = 0
                }
                self.identityToken = token
                var request = URLRequest(url: server.appendingPathComponent("v1/desktop/inbox"))
                request.httpMethod = "GET"
                request.timeoutInterval = 20
                request.cachePolicy = .reloadIgnoringLocalCacheData
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                self.task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
                    DispatchQueue.main.async {
                        guard let self = self, self.generation == ticket else { return }
                        self.inFlight = false
                        self.task = nil
                        guard SettingsStore.shared.savedServerURL == server,
                              self.tokens.tokenIfLoaded == token else { self.refresh(); return }
                        if let error = error {
                            self.model?.log("내 차례 조회 실패: \(error.localizedDescription)")
                            return
                        }
                        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                            self.model?.log("내 차례 조회 실패: HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
                            return
                        }
                        do {
                            let inbox = try JSONDecoder().decode(InboxResponse.self, from: data ?? Data())
                            self.model?.inboxItems = Array(inbox.items.prefix(20))
                            self.model?.inboxCount = max(0, inbox.count)
                        } catch {
                            self.model?.log("내 차례 조회 실패: 응답 형식을 읽지 못했습니다")
                        }
                    }
                }
                self.task?.resume()
            }
        }
    }

    deinit {
        timer?.invalidate()
        task?.cancel()
    }
}
