import SwiftUI
import AppKit
import BatonIPC

/// 팝오버·창 → AppDelegate 동작
struct ShellActions {
    var quit: () -> Void
    var choosePath: (String) -> Void          // key
    var chooseProjectPath: (UUID) -> Void     // 프로젝트 목록 행 id
    var saveSettings: () -> Void
    var startPairing: () -> Void
    var requestNotificationAuth: () -> Void
    var openNotificationSettings: () -> Void
    var setLaunchAtLogin: (Bool) -> Void
    var restartDaemon: () -> Void
    var saveDaemonCommand: () -> Void
    /// 사용자가 손댄 데몬 명령을 지우고 자동 탐색(번들 내장 → 저장소) 결과로 되돌린다 (CLO-117-a)
    var resetDaemonCommand: () -> Void
    var openNotification: (NotificationItem) -> Void
    var openInbox: (String?) -> Void
    /// 설정·활동 기록 창 열기 (CLO-107)
    var openWindow: (MainPane) -> Void
    var log: (String) -> Void
}

/// 상단바 팝오버 (CLO-107 로 축소).
///
/// 여기 남는 것은 **자주 보지만 화면을 적게 먹는 것**뿐이다: 연결 상태, 실행 중인 작업 한 줄, 최근 알림 두세 건.
/// 설정과 로그는 창(`MainWindowController`)이 맡는다 — 팝오버는 다른 곳을 클릭하면 닫혀서 그 일에 맞지 않는다.
struct PopoverView: View {
    @ObservedObject var model: AppModel
    var actions: ShellActions
    /// 팝오버에 띄우는 최근 알림 건수
    static let recentNotificationCount = 3

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                inboxSection
                Divider()
                if !model.isConnected {
                    Button("설정에서 연결하기") { actions.openWindow(.settings) }
                        .buttonStyle(.borderedProminent).tint(BrandColor.deepBlue)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                runningRow
                Divider()
                notificationsSection
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            Divider()
            footer
        }
        .tint(BrandColor.blue)
        .frame(width: 360)
        .fixedSize(horizontal: false, vertical: true)
    }

    var header: some View {
        HStack(spacing: 6) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 28, height: 28)
            Text("Baton").font(.headline)
            Spacer()
            Circle().fill(StatusPalette.color(model)).frame(width: 9, height: 9)
            Text(StatusPalette.text(model)).font(.caption).foregroundColor(.secondary)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    // MARK: 내 차례 — 상태 변경은 요청 창에서 하고 여기서는 조회만 한다.

    var inboxSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("내 차례 (\(model.inboxCount))").font(.caption).foregroundColor(.secondary)
                Spacer()
                if model.inboxCount > 5 {
                    Button("모두 보기") { actions.openInbox(nil) }.font(.caption)
                }
            }
            if model.inboxItems.isEmpty {
                Text("지금 처리할 요청이 없습니다.").font(.caption).foregroundColor(.secondary)
            }
            ForEach(model.inboxItems.prefix(5)) { item in
                Button { actions.openInbox(item.id) } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                            Text("\(item.reason) · \(item.teamName)").font(.caption).foregroundColor(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Circle().fill(Self.inboxColor(item.reason)).frame(width: 7, height: 7)
                            .accessibilityLabel(item.reason)
                    }
                    .padding(6).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(nsColor: .controlBackgroundColor)).cornerRadius(6)
                }
                .buttonStyle(.plain)
            }
        }
    }

    static func inboxColor(_ reason: String) -> Color {
        switch reason {
        case "확인 필요": return .yellow
        case "실행 준비": return BrandColor.deepBlue
        case "결과 검토": return .orange
        case "실행 실패": return .red
        case "보완 요청": return .purple
        default: return .gray
        }
    }

    // MARK: 실행 중인 작업 한 줄

    var runningRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("실행 중인 작업").font(.caption).foregroundColor(.secondary)
            if let line = model.runningLine {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(line).font(.system(size: 12)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
            } else if !model.hasToken {
                // pairing 전에는 실행 자체가 불가능하므로 그 사실을 먼저 알려 준다 (CLO-107 ⑤)
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle").foregroundColor(.orange)
                    Text("아직 이 Mac 이 연결되지 않았습니다.").font(.system(size: 12))
                }
            } else {
                Text("웹에서 실행한 작업이 여기에 표시됩니다.").font(.system(size: 12)).foregroundColor(.secondary)
            }
            if let help = model.connectionHelp {
                Text(help).font(.caption2).foregroundColor(.red).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: 최근 알림 2~3건

    var notificationsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("최근 알림").font(.caption).foregroundColor(.secondary)
                Spacer()
                if model.notifications.count > PopoverView.recentNotificationCount {
                    Text("+\(model.notifications.count - PopoverView.recentNotificationCount)건 더")
                        .font(.caption2).foregroundColor(.secondary)
                }
            }
            if model.notifications.isEmpty {
                Text("받은 알림이 없습니다.").font(.caption).foregroundColor(.secondary)
            }
            ForEach(model.notifications.prefix(PopoverView.recentNotificationCount)) { n in
                Button(action: { actions.openNotification(n) }) {
                    HStack(alignment: .top, spacing: 6) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(n.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                            Text(n.body).font(.caption).foregroundColor(.secondary).lineLimit(1)
                            if let note = n.note { Text(note).font(.caption2).foregroundColor(.orange).lineLimit(1) }   // 예: "처리 중: 박인프라"
                        }
                        Spacer(minLength: 0)
                        Text(PopoverView.badgeText(n.kind)).font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(PopoverView.badgeColor(n.kind).opacity(0.18))
                            .foregroundColor(PopoverView.badgeColor(n.kind)).cornerRadius(4)
                    }
                    .padding(6).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(nsColor: .controlBackgroundColor)).cornerRadius(6)
                }
                .buttonStyle(.plain)
                .help(n.webUrl == nil ? n.body : "열기: \(n.webUrl ?? "")")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: 아래 버튼 줄

    var footer: some View {
        HStack(spacing: 8) {
            Button("요청 열기") { actions.openWindow(.requests) }
            Button("설정 열기") { actions.openWindow(.settings) }
            Button("기록 열기") { actions.openWindow(.activity) }
            Spacer()
            Button("종료") { actions.quit() }.font(.caption)
        }
        .padding(10)
    }

    // MARK: 알림 종류 뱃지

    static func badgeText(_ kind: String) -> String {
        switch kind {
        case "request.delivered": return "새 요청"
        case "request.claimed": return "처리 중"
        case "request.returned": return "보완 요청"
        case "request.rejected": return "거절됨"
        case "execution.finished": return "결과 검토"
        case "execution.failed": return "실행 실패"
        case "result.delivered": return "전달 완료"
        default: return "안내"
        }
    }

    static func badgeColor(_ kind: String) -> Color {
        switch kind {
        case "request.delivered": return BrandColor.orange
        case "request.claimed": return .gray
        case "request.returned": return .orange
        case "request.rejected", "execution.failed": return .red
        case "execution.finished": return .teal
        case "result.delivered": return .green
        default: return .gray
        }
    }
}
