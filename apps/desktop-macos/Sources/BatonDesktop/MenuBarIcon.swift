import AppKit

/// 상단바 아이콘. 로고(파란 사각형 안의 B 와 바통)를 메뉴바 규칙(18pt, 단색 템플릿)에 맞게 줄인 모양이다:
/// 꽉 찬 B 에서 바통 모양을 비워 낸다(2026-09-28 시안 C, 원본 branding/baton-logo-source.png).
///
/// 상태별로 모양을 바꿔 메뉴바만 보고도 알 수 있게 한다.
/// - 연결됨: 기본
/// - 연결 안 됨(페어링 전·서버 연결 실패 등): 흐리게
/// - 작업 실행 중: 오른쪽 아래 점
enum MenuBarIcon {
    enum State: Equatable { case connected, disconnected, running }

    private static let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="36" height="36">
      <defs><mask id="m"><rect width="36" height="36" fill="#fff"/><line x1="9" y1="26.5" x2="27" y2="11.5" stroke="#000" stroke-width="4" stroke-linecap="round"/></mask></defs>
      <path d="M8 4.5 H20 a7 7 0 0 1 4.6 12.3 A7.6 7.6 0 0 1 21 31.5 H8 Z" fill="#000" mask="url(#m)"/>
    </svg>
    """

    private static let size = NSSize(width: 18, height: 18)
    private static let base: NSImage? = NSImage(data: Data(svg.utf8))

    static func image(_ state: State) -> NSImage {
        // SVG 를 못 읽는 macOS 에서는 예전 기호로 대신한다(흐림·점 표현은 동일하게 적용).
        let glyph = base ?? NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted", accessibilityDescription: "Baton")
        let image = NSImage(size: size, flipped: false) { rect in
            glyph?.draw(in: rect, from: .zero, operation: .sourceOver, fraction: state == .disconnected ? 0.35 : 1)
            if state == .running, let ctx = NSGraphicsContext.current {
                // 점 둘레를 비워 B 와 붙어 보이지 않게 한 뒤 점을 찍는다.
                let center = NSPoint(x: rect.maxX - 3.2, y: rect.minY + 3.2)
                ctx.compositingOperation = .destinationOut
                NSBezierPath(ovalIn: NSRect(x: center.x - 3.6, y: center.y - 3.6, width: 7.2, height: 7.2)).fill()
                ctx.compositingOperation = .sourceOver
                NSColor.black.setFill()
                NSBezierPath(ovalIn: NSRect(x: center.x - 2.4, y: center.y - 2.4, width: 4.8, height: 4.8)).fill()
            }
            return true
        }
        image.isTemplate = true   // 메뉴바 색(라이트·다크·강조)에 맞춰 macOS 가 칠한다
        image.accessibilityDescription = {
            switch state {
            case .connected: return "Baton — 연결됨"
            case .disconnected: return "Baton — 연결 안 됨"
            case .running: return "Baton — 작업 실행 중"
            }
        }()
        return image
    }
}
