import SwiftUI
import AppKit

/// 창의 "활동 기록" 화면 (CLO-107).
///
/// 팝오버 활동 탭이 가장 곤란했던 이유는 다른 곳을 클릭하면 팝오버가 닫혀서, 문제가 생겼을 때 로그를 읽으며
/// 다른 창을 함께 볼 수 없었기 때문이다. 이 화면은 창 안에 있으므로 그 제약이 없고, 검색·복사·자동 스크롤을 지원한다.
struct ActivityPane: View {
    @ObservedObject var model: AppModel
    var actions: ShellActions

    // 개발 편의: 접근성 도구의 타이핑·set-value 는 SwiftUI TextField 바인딩을 갱신하지 못한다(README 실측).
    // 검색 결과를 캡처해야 할 때 `defaults write <bundle> shell.devActivityQuery <검색어>` 로 초기값을 넣는다.
    @State private var query: String = UserDefaults.standard.string(forKey: "shell.devActivityQuery") ?? ""
    /// 새 줄이 올 때마다 끝으로 따라간다. 위로 올려 과거를 읽는 동안에는 끈다.
    @State private var follow: Bool = true
    @State private var showDiagnostics: Bool = false

    /// 실행 진행 이력 (phase/message 둘 다에서 검색)
    var progressRows: [ProgressItem] {
        guard !trimmedQuery.isEmpty else { return model.progress }
        return model.progress.filter { $0.phase.localizedCaseInsensitiveContains(trimmedQuery) || $0.message.localizedCaseInsensitiveContains(trimmedQuery) }
    }

    var logRows: [(offset: Int, element: String)] {
        let rows = Array(model.logLines.enumerated())
        guard !trimmedQuery.isEmpty else { return rows.map { (offset: $0.offset, element: $0.element) } }
        return rows.filter { $0.element.localizedCaseInsensitiveContains(trimmedQuery) }.map { (offset: $0.offset, element: $0.element) }
    }

    var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("활동 기록").font(.title2.bold())
            Text("작업이 어디까지 진행됐는지 확인하고, 필요한 기록을 복사해 공유하세요.")
                .font(.callout).foregroundColor(.secondary)
            toolbar
            progressSection
            DisclosureGroup("문제 해결용 상세 로그", isExpanded: $showDiagnostics) {
                Text("연결과 실행 프로그램의 기술 기록입니다. 오류를 문의할 때 사용하세요.")
                    .font(.caption).foregroundColor(.secondary)
                logSection
            }
            HStack(spacing: 6) {
                Text("로그 파일: ~/Library/Logs/Baton/").font(.caption).foregroundColor(.secondary)
                Button("폴더 열기") { NSWorkspace.shared.open(FileLog.directory) }.font(.caption)
                Spacer()
            }
        }
        .tint(BrandColor.blue)
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    var toolbar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 4) {
                Image(systemName: "magnifyingglass").foregroundColor(.secondary)
                TextField("작업·상세 로그 검색", text: $query).textFieldStyle(.plain).frame(minWidth: 100, maxWidth: 260)
                if !trimmedQuery.isEmpty {
                    Button(action: { query = "" }) { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundColor(.secondary)
                }
            }
            .padding(6).background(Color(nsColor: .controlBackgroundColor)).cornerRadius(6)
            Toggle("최신 기록 따라가기", isOn: $follow).toggleStyle(.checkbox).help("새 줄이 추가되면 끝으로 스크롤합니다")
            Spacer()
            Button("전체 복사") { copy(allText) }.help("진행 이력과 로그를 한 번에 클립보드로 복사합니다")
        }
    }

    // MARK: 실행 진행 이력

    var progressSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            header("실행 진행 이력", count: progressRows.count, total: model.progress.count) { copy(progressText) }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        if progressRows.isEmpty {
                            Text(model.progress.isEmpty ? "아직 실행 기록이 없습니다." : "검색 결과가 없습니다.")
                                .font(.caption).foregroundColor(.secondary).padding(6)
                        }
                        ForEach(progressRows) { p in
                            HStack(alignment: .top, spacing: 8) {
                                Text(shortTime(p.at)).font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary).frame(width: 62, alignment: .leading)
                                Text(phaseLabel(p.phase)).help(p.phase).font(.system(size: 10, design: .monospaced)).foregroundColor(phaseColor(p.phase)).frame(width: 110, alignment: .leading)
                                Text(p.message).font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .id(p.id)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                    .textSelection(.enabled)
                }
                .onChange(of: model.progress.count) { _ in
                    guard follow, let last = progressRows.last else { return }
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
                .onAppear { if let last = progressRows.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            .frame(minHeight: 150, maxHeight: .infinity)
            .background(Color(nsColor: .controlBackgroundColor)).cornerRadius(6)
        }
    }

    // MARK: 셸/데몬 로그

    var logSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            header("연결 프로그램 로그", count: logRows.count, total: model.logLines.count) { copy(logText) }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        if logRows.isEmpty {
                            Text("검색 결과가 없습니다.").font(.caption).foregroundColor(.secondary).padding(6)
                        }
                        ForEach(logRows, id: \.offset) { row in
                            Text(row.element)
                                .font(.system(size: 10, design: .monospaced))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, 6)
                                .id(row.offset)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                    .textSelection(.enabled)
                }
                .onChange(of: model.logLines.count) { _ in
                    guard follow, let last = logRows.last else { return }
                    proxy.scrollTo(last.offset, anchor: .bottom)
                }
                .onAppear { if let last = logRows.last { proxy.scrollTo(last.offset, anchor: .bottom) } }
            }
            .frame(minHeight: 150, maxHeight: .infinity)
            .background(Color(nsColor: .controlBackgroundColor)).cornerRadius(6)
        }
    }

    func header(_ title: String, count: Int, total: Int, copy: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Text(title).font(.system(size: 12, weight: .semibold))
            Text(count == total ? "\(total)줄" : "\(count)/\(total)줄").font(.caption).foregroundColor(.secondary)
            Spacer()
            Button("복사") { copy() }.font(.caption)
        }
    }

    // MARK: 복사

    var progressText: String { progressRows.map { "\($0.at)\t\($0.phase)\t\($0.message)" }.joined(separator: "\n") }
    var logText: String { logRows.map { $0.element }.joined(separator: "\n") }
    var allText: String { "## 실행 진행 이력\n\(progressText)\n\n## 셸·데몬 로그\n\(logText)\n" }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        actions.log("활동 기록 \(text.count)자 복사")
    }

    // MARK: 표시 보조

    /// `2026-09-11T02:06:34.123Z` → `11:06:34` (로컬 시각). 형식이 다르면 원문 끝부분을 그대로 쓴다.
    func shortTime(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date = date else { return String(iso.suffix(8)) }
        let out = DateFormatter()
        out.dateFormat = "HH:mm:ss"
        return out.string(from: date)
    }

    func phaseLabel(_ phase: String) -> String {
        switch phase {
        case "started": return "시작"
        case "reading_input": return "요청 확인"
        case "editing": return "파일 수정"
        case "testing": return "테스트 중"
        case "test_passed": return "테스트 통과"
        case "test_failed": return "테스트 실패"
        case "writing_result": return "결과 정리"
        case "finished": return "완료"
        case "finished_partial": return "일부 완료"
        case "failed": return "실패"
        case "cancelled": return "취소"
        case "blocked": return "실행 제한"
        case "warning": return "주의"
        default: return "진행 안내"
        }
    }

    func phaseColor(_ phase: String) -> Color {
        switch phase {
        case "failed", "test_failed", "blocked": return .red
        case "cancelled": return .orange
        case "finished", "test_passed": return .green
        case "finished_partial", "warning": return .yellow
        case "started": return BrandColor.blue
        default: return .secondary
        }
    }
}
