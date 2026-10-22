import Foundation
import SwiftUI

private enum ProjectGitState: Equatable {
    case checking, repository, notRepository, missing, error(String)
}

private enum ProjectGit {
    // 셸을 거치지 않아 공백·메타문자가 있는 경로도 인자로만 취급한다.
    static func run(_ args: [String], path: String) -> (Int32, String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = args
        process.currentDirectoryURL = URL(fileURLWithPath: path)
        process.environment = ProcessInfo.processInfo.environment.merging(["LC_ALL": "C", "GIT_TERMINAL_PROMPT": "0"]) { _, new in new }
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            // UI를 막지 않고 외부 프로세스에도 상한을 둔다.
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 10, execute: timeout)
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            timeout.cancel()
            return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        } catch {
            return (-1, error.localizedDescription)
        }
    }

    static func inspect(_ path: String) -> ProjectGitState {
        guard !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .error("프로젝트 폴더를 선택해 주세요.")
        }
        // git 확인은 폴더 오류와 별개로 판정한다.
        guard run(["--version"], path: "/").0 == 0 else { return .missing }
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &directory), directory.boolValue else {
            return .error("프로젝트 폴더를 찾을 수 없습니다.")
        }
        let result = run(["rev-parse", "--is-inside-work-tree"], path: path)
        if result.0 == 0 && result.1.trimmingCharacters(in: .whitespacesAndNewlines) == "true" { return .repository }
        if result.1.contains("not a git repository") { return .notRepository }
        return .error("git 저장소 확인 실패: \(result.1.prefix(300))")
    }
}

struct ProjectGitStatus: View {
    let path: String
    @State private var state: ProjectGitState = .checking
    @State private var creating = false
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch state {
            case .checking:
                Text("git 저장소 확인 중…").foregroundColor(.secondary)
            case .repository:
                Label("git 저장소", systemImage: "checkmark.circle").foregroundColor(BrandColor.blue)
            case .notRepository:
                Text("git 저장소 아님 · Codex·Antigravity는 git 저장소에서만 실행됩니다")
                Button(creating ? "만드는 중…" : "git 저장소로 만들기") {
                    let selectedPath = path
                    creating = true
                    message = nil
                    Task {
                        let result = await Task.detached { () -> (ProjectGitState, String?) in
                            // 클릭 때 다시 확인하고 초기 커밋·사용자 파일 변경 없이 git init만 한다.
                            let before = ProjectGit.inspect(selectedPath)
                            guard before == .notRepository else { return (before, nil) }
                            let initialized = ProjectGit.run(["init"], path: selectedPath)
                            return (ProjectGit.inspect(selectedPath), initialized.0 == 0 ? nil : "git 저장소 만들기 실패: \(initialized.1.prefix(300))")
                        }.value
                        if path == selectedPath { state = result.0; message = result.1 }
                        creating = false
                    }
                }
                .buttonStyle(.borderedProminent).tint(BrandColor.deepBlue).disabled(creating)
                Text("폴더에 .git 관리 정보를 만듭니다. 초기 커밋은 만들지 않습니다.").foregroundColor(.secondary)
            case .missing:
                Text("git을 사용할 수 없습니다. 터미널에서 xcode-select --install을 실행해 주세요.")
            case .error(let reason):
                Text(reason).foregroundColor(.secondary)
            }
            if let message { Text(message).foregroundColor(.red) }
            Button("다시 확인") { Task { await refresh() } }
                .buttonStyle(.plain).foregroundColor(BrandColor.blue).disabled(creating)
        }
        .font(.caption)
        .task(id: path) { await refresh() }
    }

    @MainActor private func refresh() async {
        let selectedPath = path
        state = .checking
        message = nil
        let result = await Task.detached { ProjectGit.inspect(selectedPath) }.value
        guard !Task.isCancelled, path == selectedPath else { return }
        state = result
    }
}
