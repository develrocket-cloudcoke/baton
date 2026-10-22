import SwiftUI
import AppKit

/// 로고의 색은 강조에만 쓰고 배경·본문은 시스템 색을 따라간다.
enum BrandColor {
    /// 글자·아이콘·tint 용 파랑. 로고 파랑(#1E50C0)은 다크 모드 배경에서 글자가 거의 안 보여서
    /// (2026-09-23 사용자 지적 — 팝오버 하단 버튼 글자가 사라짐) 다크 모드에서는 밝은 파랑(#7AA2FF)으로 바꾼다.
    static let blue = Color(nsColor: NSColor(name: "BatonBlue") { appearance in
        appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil
            ? NSColor(srgbRed: 122 / 255, green: 162 / 255, blue: 1, alpha: 1)
            : NSColor(srgbRed: 30 / 255, green: 80 / 255, blue: 192 / 255, alpha: 1)
    })
    /// 채운 버튼 배경용. 흰 글자가 라이트·다크 모두에서 읽히는 진한 파랑(#2444A8)으로 고정한다.
    static let deepBlue = Color(red: 36 / 255, green: 68 / 255, blue: 168 / 255)
    static let orange = Color(red: 248 / 255, green: 148 / 255, blue: 0)
}
