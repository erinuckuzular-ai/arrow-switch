// The panel's mascot, drawn live. Same 132x150 drawing space as the SVG in
// extension/index.html, so the two stay recognisably the same character.

import SwiftUI

enum Mood { case idle, working, done, oops }

struct Mascot: View {
    var mood: Mood
    @State private var bob = false
    @State private var blink = false

    private let ink = Color.ink

    var body: some View {
        Canvas { ctx, size in
            let s = min(size.width / 132, size.height / 150)
            ctx.scaleBy(x: s, y: s)
            ctx.translateBy(x: (size.width / s - 132) / 2, y: 0)
            draw(&ctx)
        }
        .frame(width: 210, height: 240)
        .offset(y: bob ? -7 : 0)
        .animation(.easeInOut(duration: mood == .working ? 0.55 : 2.2).repeatForever(autoreverses: true), value: bob)
        .rotationEffect(.degrees(mood == .oops ? 6 : 0))
        .onAppear { bob = true; scheduleBlink() }
    }

    private func scheduleBlink() {
        Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Double.random(in: 2.4...5.5)))
                withAnimation(.easeInOut(duration: 0.09)) { blink = true }
                try? await Task.sleep(for: .milliseconds(110))
                withAnimation(.easeInOut(duration: 0.09)) { blink = false }
            }
        }
    }

    private func draw(_ ctx: inout GraphicsContext) {
        // floor shadow
        ctx.fill(Path(ellipseIn: CGRect(x: 30, y: 131, width: 60, height: 10)),
                 with: .color(.black.opacity(0.16)))

        // arms: one waves, both go up when it's finished
        let leftArm = Path { p in
            p.move(to: CGPoint(x: 42, y: 76))
            if mood == .done { p.addQuadCurve(to: CGPoint(x: 16, y: 30), control: CGPoint(x: 20, y: 56)) }
            else { p.addQuadCurve(to: CGPoint(x: 18, y: 50), control: CGPoint(x: 24, y: 66)) }
        }
        let rightArm = Path { p in
            p.move(to: CGPoint(x: 78, y: 76))
            if mood == .done { p.addQuadCurve(to: CGPoint(x: 104, y: 30), control: CGPoint(x: 100, y: 56)) }
            else { p.addQuadCurve(to: CGPoint(x: 98, y: 98), control: CGPoint(x: 96, y: 84)) }
        }
        ctx.stroke(leftArm, with: .color(ink), style: .init(lineWidth: 6, lineCap: .round))
        ctx.stroke(rightArm, with: .color(ink), style: .init(lineWidth: 6, lineCap: .round))
        ctx.fill(Path(ellipseIn: CGRect(x: mood == .done ? 10 : 12, y: mood == .done ? 21 : 44, width: 12, height: 12)), with: .color(ink))
        ctx.fill(Path(ellipseIn: CGRect(x: mood == .done ? 98 : 93, y: mood == .done ? 21 : 94, width: 12, height: 11)), with: .color(ink))

        // handle, switch, collar
        let handle = Path { p in
            p.move(to: CGPoint(x: 44, y: 72))
            p.addLine(to: CGPoint(x: 50, y: 118))
            p.addQuadCurve(to: CGPoint(x: 70, y: 118), control: CGPoint(x: 60, y: 126))
            p.addLine(to: CGPoint(x: 76, y: 72))
            p.closeSubpath()
        }
        ctx.fill(handle, with: .linearGradient(
            Gradient(colors: [Color(red: 0.545, green: 0.471, blue: 0.722), .ink]),
            startPoint: CGPoint(x: 44, y: 72), endPoint: CGPoint(x: 76, y: 126)))
        ctx.fill(Path(roundedRect: CGRect(x: 55, y: 90, width: 10, height: 14), cornerRadius: 4),
                 with: .color(Color(red: 0.165, green: 0.118, blue: 0.243)))
        ctx.fill(Path(ellipseIn: CGRect(x: 57.6, y: 91.6, width: 4.8, height: 4.8)),
                 with: .color(mood == .working ? .mint : .tomato))
        ctx.fill(Path(roundedRect: CGRect(x: 38, y: 62, width: 44, height: 14), cornerRadius: 7),
                 with: .linearGradient(Gradient(colors: [Color(red: 1, green: 0.941, blue: 0.722), Color(red: 0.941, green: 0.663, blue: 0.231)]),
                                       startPoint: CGPoint(x: 38, y: 62), endPoint: CGPoint(x: 82, y: 76)))

        // head
        let head = CGRect(x: 28, y: 2, width: 64, height: 64)
        ctx.fill(Path(ellipseIn: head), with: .radialGradient(
            Gradient(colors: [.white, Color(red: 0.851, green: 0.863, blue: 0.918), Color(red: 0.561, green: 0.580, blue: 0.678)]),
            center: CGPoint(x: 48, y: 20), startRadius: 2, endRadius: 58))
        var grille = Path()
        for i in stride(from: -64, through: 64, by: 6) {
            grille.move(to: CGPoint(x: 60 + Double(i), y: 2)); grille.addLine(to: CGPoint(x: 60 + Double(i) + 64, y: 66))
            grille.move(to: CGPoint(x: 60 + Double(i), y: 66)); grille.addLine(to: CGPoint(x: 60 + Double(i) + 64, y: 2))
        }
        ctx.clipToLayer { $0.fill(Path(ellipseIn: head), with: .color(.white)) }
        ctx.stroke(grille, with: .color(Color(red: 0.357, green: 0.373, blue: 0.471).opacity(0.5)), lineWidth: 1.1)
        ctx.fill(Path(ellipseIn: CGRect(x: 36, y: 11, width: 20, height: 10)).applying(
            CGAffineTransform(rotationAngle: -0.52).concatenating(CGAffineTransform(translationX: 24, y: 24))),
                 with: .color(.white.opacity(0.65)))

        // face
        if mood == .done {
            ctx.fill(Path(ellipseIn: CGRect(x: 32, y: 40, width: 12, height: 7)), with: .color(.pinkBrand.opacity(0.85)))
            ctx.fill(Path(ellipseIn: CGRect(x: 76, y: 40, width: 12, height: 7)), with: .color(.pinkBrand.opacity(0.85)))
        }
        if mood == .oops {
            var x = Path()
            for cx in [48.0, 72.0] {
                x.move(to: CGPoint(x: cx - 6, y: 26)); x.addLine(to: CGPoint(x: cx + 6, y: 38))
                x.move(to: CGPoint(x: cx + 6, y: 26)); x.addLine(to: CGPoint(x: cx - 6, y: 38))
            }
            ctx.stroke(x, with: .color(ink), style: .init(lineWidth: 4, lineCap: .round))
        } else {
            for (ex, px) in [(44.0, 46.0), (68.0, 70.0)] {
                let eye = CGRect(x: ex, y: blink ? 30 : 23, width: 16, height: blink ? 4 : 18)
                ctx.fill(Path(ellipseIn: eye), with: .color(.white))
                ctx.stroke(Path(ellipseIn: eye), with: .color(ink), lineWidth: 2.5)
                if !blink {
                    ctx.fill(Path(ellipseIn: CGRect(x: px, y: mood == .working ? 32 : 30, width: 8, height: 8)), with: .color(ink))
                }
            }
        }
        var brow = Path()
        brow.move(to: CGPoint(x: 38, y: mood == .done ? 14 : 18)); brow.addLine(to: CGPoint(x: 56, y: 23))
        brow.move(to: CGPoint(x: 82, y: mood == .done ? 14 : 18)); brow.addLine(to: CGPoint(x: 64, y: 23))
        ctx.stroke(brow, with: .color(ink), style: .init(lineWidth: 4, lineCap: .round))

        var mouth = Path()
        switch mood {
        case .idle:
            mouth.move(to: CGPoint(x: 50, y: 50)); mouth.addQuadCurve(to: CGPoint(x: 72, y: 46), control: CGPoint(x: 62, y: 56))
            ctx.stroke(mouth, with: .color(ink), style: .init(lineWidth: 3.5, lineCap: .round))
        case .working:
            ctx.fill(Path(ellipseIn: CGRect(x: 55, y: 46, width: 10, height: 12)), with: .color(.tomato))
        case .done:
            mouth.move(to: CGPoint(x: 46, y: 46))
            mouth.addQuadCurve(to: CGPoint(x: 74, y: 46), control: CGPoint(x: 60, y: 66))
            mouth.closeSubpath()
            ctx.fill(mouth, with: .color(.tomato))
        case .oops:
            mouth.move(to: CGPoint(x: 46, y: 52))
            for i in 0..<3 {
                let x = 46.0 + Double(i) * 8
                mouth.addQuadCurve(to: CGPoint(x: x + 8, y: 52), control: CGPoint(x: x + 4, y: 47))
            }
            ctx.stroke(mouth, with: .color(ink), style: .init(lineWidth: 3.5, lineCap: .round))
        }

        if mood == .done {
            for (x, y, r) in [(6.0, 20.0, 9.0), (108.0, 4.0, 7.0), (98.0, 84.0, 6.0)] {
                var star = Path()
                star.move(to: CGPoint(x: x, y: y - r))
                star.addQuadCurve(to: CGPoint(x: x + r, y: y), control: CGPoint(x: x + r * 0.2, y: y - r * 0.2))
                star.addQuadCurve(to: CGPoint(x: x, y: y + r), control: CGPoint(x: x + r * 0.2, y: y + r * 0.2))
                star.addQuadCurve(to: CGPoint(x: x - r, y: y), control: CGPoint(x: x - r * 0.2, y: y + r * 0.2))
                star.addQuadCurve(to: CGPoint(x: x, y: y - r), control: CGPoint(x: x - r * 0.2, y: y - r * 0.2))
                ctx.fill(star, with: .color(.butter))
            }
        }
    }
}
