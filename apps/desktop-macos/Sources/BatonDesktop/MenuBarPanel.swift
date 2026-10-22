import AppKit
import SwiftUI

/// 상단바 아이콘을 누르면 아이콘 바로 아래에 붙어 뜨는 평평한 창(다른 상단바 앱·메뉴와 같은 모양).
///
/// 처음엔 NSPopover 를 썼는데 두 가지가 맞지 않았다(2026-09-28).
/// - 꼬리(화살표)가 달려 다른 상단바 앱들과 모양이 달랐다.
/// - macOS 26 에서 상단바 아이콘에 붙이면 상단바 두께(30pt)만큼 위로 떠서 아이콘과 상단바를 덮었다
///   (실측: 아이콘 y=1574, 화면 위끝 1600 인데 팝오버 위끝 1604).
/// 그래서 위치를 직접 계산하는 테두리 없는 패널로 바꿨다. 바깥을 누르거나 Esc 를 누르면 닫힌다.
final class MenuBarPanel: NSPanel {
    private let hosting: NSView
    private var outsideClickMonitor: Any?
    /// 아이콘을 눌러 닫을 때: 패널이 먼저 key 를 잃어 닫히고, 이어서 아이콘 클릭이 다시 여는 것을 막는다.
    private(set) var lastClosedAt = Date.distantPast

    init<Content: View>(rootView: Content) {
        hosting = NSHostingView(rootView: rootView)
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isFloatingPanel = true
        level = .popUpMenu
        hasShadow = true
        isOpaque = false
        backgroundColor = .clear
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        collectionBehavior = [.transient, .ignoresCycle, .canJoinAllSpaces, .fullScreenAuxiliary]

        // 메뉴와 같은 반투명 배경 + 둥근 모서리
        let background = NSVisualEffectView()
        background.material = .menu
        background.blendingMode = .behindWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 12
        background.layer?.masksToBounds = true
        hosting.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(hosting)
        NSLayoutConstraint.activate([
            hosting.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            hosting.topAnchor.constraint(equalTo: background.topAnchor),
            hosting.bottomAnchor.constraint(equalTo: background.bottomAnchor),
        ])
        contentView = background
    }

    override var canBecomeKey: Bool { true }

    override func cancelOperation(_ sender: Any?) { close() }   // Esc

    override func resignKey() {
        super.resignKey()
        if isVisible { close() }
    }

    /// 아이콘(`icon`, 화면 좌표) 바로 아래에 띄운다. 아이콘 좌표가 누른 모니터와 다르면(macOS 26 은 아이콘을 모니터마다
    /// 따로 그린다) 누른 자리 기준으로 띄운다.
    func show(below icon: NSRect?) {
        let click = NSEvent.mouseLocation
        let onIcon = icon.map { $0.insetBy(dx: -2, dy: -2).contains(click) } ?? false
        let anchor = onIcon ? icon! : NSRect(x: click.x, y: click.y, width: 0, height: 0)
        let screen = NSScreen.screens.first(where: { NSMouseInRect(click, $0.frame, false) })
            ?? NSScreen.screens.first(where: { $0.frame.intersects(anchor) }) ?? NSScreen.main
        guard let screen else { return }

        let size = hosting.fittingSize
        // 상단바 자동 숨김이면 visibleFrame 이 화면 끝까지라 상단바 두께만큼 내린다.
        var menuBarBottom = screen.visibleFrame.maxY
        if menuBarBottom >= screen.frame.maxY { menuBarBottom = screen.frame.maxY - NSStatusBar.system.thickness }
        // 메뉴처럼 왼쪽 끝을 아이콘 왼쪽에 맞추고, 화면 밖으로 나가면 안쪽으로 민다.
        let margin: CGFloat = 6
        let x = min(max(anchor.minX, screen.visibleFrame.minX + margin), screen.visibleFrame.maxX - size.width - margin)
        setFrame(NSRect(x: x, y: menuBarBottom - 4 - size.height, width: size.width, height: size.height), display: true)

        makeKeyAndOrderFront(nil)
        // 다른 앱 창을 눌러도 닫는다(nonactivating 패널이라 key 를 잃지 않는 경우가 있다).
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.close()
        }
    }

    /// 내용 크기가 바뀌면(연결 상태에 따라 높이가 다르다) 위끝을 고정한 채 맞춘다.
    func fitContent() {
        guard isVisible else { return }
        let size = hosting.fittingSize
        guard size != frame.size else { return }
        setFrame(NSRect(x: frame.minX, y: frame.maxY - size.height, width: size.width, height: size.height), display: true)
    }

    override func close() {
        if let m = outsideClickMonitor { NSEvent.removeMonitor(m); outsideClickMonitor = nil }
        if isVisible { lastClosedAt = Date() }
        super.close()
    }
}
