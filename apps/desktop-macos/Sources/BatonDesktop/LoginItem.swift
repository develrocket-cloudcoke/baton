import Foundation
import ServiceManagement

/// 로그인 시 자동 실행 (SMAppService.mainApp, macOS 13+). 등록 시 macOS 가 "로그인 항목이 추가됨" 알림을 띄운다.
enum LoginItem {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func statusText() -> String {
        switch SMAppService.mainApp.status {
        case .notRegistered: return "미등록"
        case .enabled: return "등록됨"
        case .requiresApproval: return "승인 필요 (시스템 설정 → 로그인 항목)"
        case .notFound: return "앱을 찾을 수 없음"
        @unknown default: return "알 수 없음"
        }
    }

    static func set(enabled: Bool) throws {
        if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}
