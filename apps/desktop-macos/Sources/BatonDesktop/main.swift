import AppKit

// LSUIElement=true 번들 안에서 실행된다 (build.sh). Dock 아이콘 없이 메뉴바 항목만 표시한다.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
