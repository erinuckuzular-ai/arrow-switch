// The installer window: one screen, three states, the panel's art direction.

import AppKit
import SwiftUI

@main
struct InstallerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        WindowGroup {
            RootView()
                .frame(width: 760, height: 500)
                .background(WindowStyler())
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
        .commands { CommandGroup(replacing: .newItem) {} }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationDidFinishLaunching(_ n: Notification) { NSApp.activate(ignoringOtherApps: true) }
}

/// Makes the window edge-to-edge so the gradient reaches the title bar.
private struct WindowStyler: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async {
            guard let w = v.window else { return }
            w.titlebarAppearsTransparent = true
            w.isMovableByWindowBackground = true
            w.backgroundColor = .clear
            w.standardWindowButton(.zoomButton)?.isHidden = true
            w.standardWindowButton(.miniaturizeButton)?.isHidden = true
        }
        return v
    }
    func updateNSView(_ v: NSView, context: Context) {}
}

// MARK: - Root

struct RootView: View {
    @StateObject private var installer = Installer()
    @State private var drift = false

    private var mood: Mood {
        switch installer.phase {
        case .welcome: return .idle
        case .working: return .working
        case .done: return .done
        case .failed: return .oops
        }
    }

    var body: some View {
        ZStack {
            Backdrop(drift: $drift, warm: installer.phase == .done)
            HStack(spacing: 0) {
                VStack {
                    Spacer()
                    Mascot(mood: mood)
                    Spacer()
                }
                .frame(width: 290)
                panel
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .bottomTrailing) {
                        Text("Arrow Switch \(Bundle.main.shortVersion) · signed & notarised")
                            .font(.system(size: 11, weight: .medium, design: .rounded))
                            .foregroundStyle(Color.ink.opacity(0.35))
                            .padding(.bottom, 2)
                    }
                    .padding(.trailing, 46)
            }
            .padding(.vertical, 34)
        }
        .frame(width: 760, height: 500)
        .preferredColorScheme(.light)
    }

    @ViewBuilder private var panel: some View {
        switch installer.phase {
        case .welcome: welcome
        case .working: working
        case .done: done
        case .failed(let message): failed(message)
        }
    }

    // MARK: States

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Arrow Switch")
                .font(.system(size: 46, weight: .heavy, design: .rounded))
                .foregroundStyle(Color.ink)
            Text("Podcast editing that cuts itself.")
                .font(.system(size: 16, weight: .medium, design: .rounded))
                .foregroundStyle(Color.ink.opacity(0.62))
                .padding(.top, 4)

            VStack(alignment: .leading, spacing: 11) {
                Bullet("Installs the panel into Premiere Pro, just for you")
                Bullet("No admin password, no System Settings detour")
                Bullet(installer.premiereRunning ? "Premiere is open — I'll close it for you" : "Premiere is closed. Good.",
                       warn: installer.premiereRunning)
            }
            .padding(.top, 26)

            Spacer()

            HStack(spacing: 14) {
                BigButton(installer.alreadyInstalled ? "UPDATE IT!" : "INSTALL IT!") {
                    if installer.premiereRunning { installer.quitPremiere() }
                    installer.install()
                }
                Button("Not now") { NSApp.terminate(nil) }
                    .buttonStyle(.plain)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.ink.opacity(0.5))
            }
        }
    }

    private var working: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Hold still…")
                .font(.system(size: 40, weight: .heavy, design: .rounded))
                .foregroundStyle(Color.ink)
            // No cross-fade here: two status lines drawn over each other is unreadable.
            Text(installer.status)
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .foregroundStyle(Color.ink.opacity(0.62))
                .padding(.top, 6)
                .animation(nil, value: installer.status)

            Meter(value: installer.progress)
                .padding(.top, 30)

            Spacer()
        }
    }

    private var done: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("In you go")
                .font(.system(size: 46, weight: .heavy, design: .rounded))
                .foregroundStyle(Color.ink)
            Text("The panel is installed. Premiere picks it up on the next launch.")
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .foregroundStyle(Color.ink.opacity(0.62))
                .padding(.top, 6)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 11) {
                Step(1, "Open Premiere Pro")
                Step(2, "Window → Extensions → Arrow Switch")
                Step(3, "Add cameras and mics, then let the mic do the work")
            }
            .padding(.top, 24)

            if !installer.systemLeftovers.isEmpty || installer.cleanup != .idle {
                leftovers.padding(.top, 20)
            }

            Spacer()

            HStack(spacing: 14) {
                BigButton("OPEN PREMIERE") { installer.openPremiere(); NSApp.terminate(nil) }
                Button("Done") { NSApp.terminate(nil) }
                    .buttonStyle(.plain)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .foregroundStyle(Color.ink.opacity(0.5))
            }
        }
    }

    // An old copy installed for everyone on this Mac: offer to clear it out.
    private var leftovers: some View {
        HStack(alignment: .center, spacing: 12) {
            switch installer.cleanup {
            case .removed:
                Text("Old copy removed. Tidy.")
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(Color.ink.opacity(0.7))
            default:
                VStack(alignment: .leading, spacing: 3) {
                    Text("There's an old copy installed for everyone on this Mac.")
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                    Text(installer.cleanup == .failed
                         ? "Couldn't remove it. Try again, or run the uninstaller in Everything else."
                         : "It shows up as a second panel. Removing it asks for your password once.")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(Color.ink.opacity(0.6))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(Color.ink)
                Spacer(minLength: 8)
                Button(installer.cleanup == .removing ? "Removing…" : "Remove it") {
                    installer.removeSystemLeftovers()
                }
                .disabled(installer.cleanup == .removing)
                .buttonStyle(.plain)
                .font(.system(size: 13, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Capsule().fill(Color.lilacDeep))
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.55)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.ink.opacity(0.1)))
    }

    private func failed(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("That went badly")
                .font(.system(size: 40, weight: .heavy, design: .rounded))
                .foregroundStyle(Color.ink)
            Text(message)
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .foregroundStyle(Color.ink.opacity(0.7))
                .padding(.top, 8)
                .fixedSize(horizontal: false, vertical: true)
            Text("The disk image also holds Install Arrow Switch.pkg, which takes a different route.")
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(Color.ink.opacity(0.5))
                .padding(.top, 12)
                .fixedSize(horizontal: false, vertical: true)

            Spacer()
            BigButton("TRY AGAIN") { installer.install() }
        }
    }
}

extension Bundle {
    var shortVersion: String {
        object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    }
}

// MARK: - Pieces

private struct Backdrop: View {
    @Binding var drift: Bool
    var warm: Bool

    var body: some View {
        ZStack {
            LinearGradient(colors: warm
                           ? [Color(red: 0.996, green: 0.878, blue: 0.788), Color(red: 1.0, green: 0.788, blue: 0.867), Color(red: 0.788, green: 0.722, blue: 1.0)]
                           : [Color(red: 0.788, green: 0.722, blue: 1.0), Color(red: 1.0, green: 0.788, blue: 0.867), Color(red: 1.0, green: 0.882, blue: 0.761)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            .animation(.easeInOut(duration: 0.9), value: warm)

            Circle().fill(Color.lilac.opacity(0.55)).frame(width: 420).blur(radius: 90)
                .offset(x: drift ? -250 : -300, y: drift ? -170 : -120)
            Circle().fill(Color.pinkBrand.opacity(0.5)).frame(width: 360).blur(radius: 90)
                .offset(x: drift ? 280 : 230, y: drift ? 180 : 140)
            Circle().fill(Color.butter.opacity(0.35)).frame(width: 280).blur(radius: 80)
                .offset(x: drift ? 150 : 210, y: drift ? -190 : -150)
        }
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.easeInOut(duration: 9).repeatForever(autoreverses: true)) { drift = true }
        }
    }
}

private struct Bullet: View {
    let text: String
    var warn = false
    init(_ text: String, warn: Bool = false) { self.text = text; self.warn = warn }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle()
                .fill(warn ? Color.butter : Color.mint)
                .frame(width: 9, height: 9)
                .overlay(Circle().stroke(Color.ink.opacity(0.35), lineWidth: 1.5))
            Text(text)
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .foregroundStyle(Color.ink.opacity(0.82))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct Step: View {
    let n: Int
    let text: String
    init(_ n: Int, _ text: String) { self.n = n; self.text = text }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 11) {
            Text("\(n)")
                .font(.system(size: 12, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.lilacDeep))
                .overlay(Circle().stroke(Color.ink.opacity(0.25), lineWidth: 1.5))
            Text(text)
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .foregroundStyle(Color.ink.opacity(0.82))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct Meter: View {
    var value: Double
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.55))
                Capsule()
                    .fill(LinearGradient(colors: [Color.lilacDeep, Color.pinkBrand],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(18, geo.size.width * value))
                    .animation(.spring(response: 0.5, dampingFraction: 0.85), value: value)
            }
            .overlay(Capsule().stroke(Color.ink.opacity(0.28), lineWidth: 2))
        }
        .frame(height: 20)
    }
}

private struct BigButton: View {
    let title: String
    let action: () -> Void
    @State private var down = false
    init(_ title: String, action: @escaping () -> Void) { self.title = title; self.action = action }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 17, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
                .padding(.horizontal, 30)
                .padding(.vertical, 15)
                .background(
                    RoundedRectangle(cornerRadius: 17, style: .continuous)
                        .fill(LinearGradient(colors: [Color(red: 0.482, green: 0.357, blue: 0.804), Color(red: 0.353, green: 0.212, blue: 0.647)],
                                             startPoint: .top, endPoint: .bottom))
                )
                .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous)
                    .stroke(Color(red: 0.286, green: 0.161, blue: 0.537), lineWidth: 2.5))
                .shadow(color: Color.ink.opacity(0.35), radius: down ? 2 : 7, x: 0, y: down ? 1 : 5)
                .offset(y: down ? 3 : 0)
        }
        .buttonStyle(.plain)
        .onHover { _ in }
        .simultaneousGesture(DragGesture(minimumDistance: 0)
            .onChanged { _ in withAnimation(.easeOut(duration: 0.08)) { down = true } }
            .onEnded { _ in withAnimation(.easeOut(duration: 0.12)) { down = false } })
    }
}
