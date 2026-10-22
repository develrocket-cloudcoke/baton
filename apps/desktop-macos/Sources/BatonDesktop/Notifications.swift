import Foundation
import UserNotifications

/// 시스템 알림 (UNUserNotificationCenter). 클릭(didReceive) → onClick 콜백.
/// delegate 는 앱 launch 완료 전에 설정해야 알림 클릭으로 앱이 실행되는 경우에도 콜백을 받는다.
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    /// (notificationId, requestId, webUrl, action)
    var onClick: ((String, String?, String?, String) -> Void)?
    private(set) var authorization: AuthState = .init(text: "미확인", isDenied: false)

    /// 권한 상태 표시용. `isDenied` 면 팝오버가 복구 안내를 띄운다 (CLO-9 ④).
    struct AuthState: Equatable {
        var text: String
        var isDenied: Bool
    }

    override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    /// 프롬프트를 띄우지 않고 현재 상태만 읽는다 (앱 활성화 때마다 호출).
    func refreshAuthorization(completion: @escaping (AuthState) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            let state = NotificationManager.describe(s.authorizationStatus, granted: nil, error: nil)
            DispatchQueue.main.async { self.authorization = state; completion(state) }
        }
    }

    /// 권한 요청. 이미 `denied` 인 번들에서는 프롬프트가 다시 뜨지 않고 그대로 denied 로 돌아온다
    /// — 그 경우 복구는 시스템 설정 → 알림 뿐이다 (README "알림 권한 복구").
    func requestAuthorization(completion: @escaping (AuthState) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            UNUserNotificationCenter.current().getNotificationSettings { s in
                let state = NotificationManager.describe(s.authorizationStatus, granted: granted, error: error)
                DispatchQueue.main.async { self.authorization = state; completion(state) }
            }
        }
    }

    static func describe(_ status: UNAuthorizationStatus, granted: Bool?, error: Error?) -> AuthState {
        if let e = error { return AuthState(text: "오류: \(e.localizedDescription) (status=\(status.rawValue))", isDenied: status == .denied) }
        switch status {
        case .authorized: return AuthState(text: "허용됨", isDenied: false)
        case .denied: return AuthState(text: "거부됨", isDenied: true)
        case .notDetermined: return AuthState(text: "미결정", isDenied: false)
        case .provisional: return AuthState(text: "임시 허용", isDenied: false)
        default: return AuthState(text: (granted ?? false) ? "허용됨" : "알 수 없음", isDenied: false)
        }
    }

    /// 같은 identifier 로 다시 add 하면 기존 알림이 갱신된다 (계약: 중복 배너 금지)
    func post(id: String, title: String, body: String, requestId: String?, webUrl: String?) {
        let content = UNMutableNotificationContent()
        content.title = String(title.prefix(200))
        content.body = String(body.prefix(200))
        content.sound = .default
        var info: [String: String] = [:]
        if let r = requestId { info["requestId"] = r }
        if let u = webUrl { info["webUrl"] = u }
        content.userInfo = info
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
            if let e = error { FileLog.shell.write("notification add failed id=\(id): \(e.localizedDescription)") }
        }
    }

    /// 게시된 배너·알림 센터 항목 제거 (04 §10 notification.dismiss)
    func remove(ids: [String]) {
        guard !ids.isEmpty else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
    }

    // 앱이 포그라운드여도 배너 표시
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier == UNNotificationDismissActionIdentifier ? "dismiss" : "default"
        onClick?(response.notification.request.identifier, info["requestId"] as? String, info["webUrl"] as? String, action)
        completionHandler()
    }
}
