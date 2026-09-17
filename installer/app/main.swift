// Install Arrow Switch — the branded installer app.
//
// It unpacks the bundled extension into the current user's CEP folder, so it
// never asks for an admin password. Built and signed by scripts/build-installer-app.sh.

import AppKit
import SwiftUI

// MARK: - Palette (the panel's, from extension/css/style.css)

extension Color {
    static let ink = Color(red: 0.231, green: 0.165, blue: 0.333)
    static let lilac = Color(red: 0.706, green: 0.612, blue: 1.0)
    static let lilacDeep = Color(red: 0.459, green: 0.333, blue: 0.780)
    static let pinkBrand = Color(red: 1.0, green: 0.620, blue: 0.788)
    static let butter = Color(red: 1.0, green: 0.843, blue: 0.447)
    static let mint = Color(red: 0.498, green: 0.863, blue: 0.702)
    static let tomato = Color(red: 1.0, green: 0.478, blue: 0.420)
    static let clay = Color(red: 0.984, green: 0.961, blue: 1.0)
}

// MARK: - Install

enum Phase: Equatable {
    case welcome, working, done, failed(String)
}

@MainActor final class Installer: ObservableObject {
    @Published var phase: Phase = .welcome
    @Published var progress = 0.0
    @Published var status = ""

    let dest = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/Application Support/Adobe/CEP/extensions/com.arrow.switch")

    var premiereRunning: Bool {
        NSWorkspace.shared.runningApplications.contains {
            ($0.bundleIdentifier ?? "").hasPrefix("com.adobe.PremierePro")
        }
    }

    var alreadyInstalled: Bool { FileManager.default.fileExists(atPath: dest.path) }

    func quitPremiere() {
        for app in NSWorkspace.shared.runningApplications
        where (app.bundleIdentifier ?? "").hasPrefix("com.adobe.PremierePro") {
            app.terminate()
        }
    }

    func install() {
        phase = .working
        progress = 0
        Task.detached(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            do {
                try await self.run()
                await MainActor.run { self.progress = 1; self.phase = .done }
            } catch {
                await MainActor.run { self.phase = .failed(error.localizedDescription) }
            }
        }
    }

    private func step(_ text: String, _ value: Double) async {
        await MainActor.run { self.status = text; self.progress = value }
        try? await Task.sleep(for: .milliseconds(320))   // let people read what's happening
    }

    private func run() async throws {
        let fm = FileManager.default
        guard let zxp = Bundle.main.url(forResource: "ArrowSwitch", withExtension: "zxp") else {
            throw Err("The installer is missing its copy of the panel.")
        }

        await step("Making room in Premiere's extensions folder", 0.15)
        let staging = dest.deletingLastPathComponent().appending(path: "com.arrow.switch.new")
        try? fm.removeItem(at: staging)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)

        await step("Unpacking the panel", 0.45)
        try shell("/usr/bin/unzip", ["-q", zxp.path, "-d", staging.path])
        guard fm.fileExists(atPath: staging.appending(path: "CSXS/manifest.xml").path) else {
            throw Err("The bundled panel looks incomplete.")
        }

        await step("Setting up the audio decoder", 0.7)
        let ffmpeg = staging.appending(path: "bin/ffmpeg")
        try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: ffmpeg.path)
        try? shell("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staging.path])

        await step("Putting everything in place", 0.9)
        try? fm.removeItem(at: dest)
        try fm.moveItem(at: staging, to: dest)
        // An older build installed under the previous name; two panels would both load.
        try? fm.removeItem(at: dest.deletingLastPathComponent().appending(path: "com.arrow.autocut"))

        await step("Done", 1)
    }

    func openPremiere() {
        let apps = ["Adobe Premiere Pro 2025", "Adobe Premiere Pro 2024", "Adobe Premiere Pro 2023"]
        for name in apps {
            let url = URL(fileURLWithPath: "/Applications/\(name)/\(name).app")
            if FileManager.default.fileExists(atPath: url.path) {
                NSWorkspace.shared.openApplication(at: url, configuration: .init())
                return
            }
        }
        NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications"))
    }

    func revealInstall() { NSWorkspace.shared.activateFileViewerSelecting([dest]) }

    private struct Err: LocalizedError {
        let msg: String
        init(_ m: String) { msg = m }
        var errorDescription: String? { msg }
    }

    private func shell(_ tool: String, _ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            throw Err("\(URL(fileURLWithPath: tool).lastPathComponent) failed (\(p.terminationStatus)).")
        }
    }
}
