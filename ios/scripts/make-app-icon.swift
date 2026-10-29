// Original folded-home artwork. One geometry source exports native and web marks.
// From ios/: swift scripts/make-app-icon.swift --all
// A single output PNG path remains supported for existing workflows.
import AppKit
import CoreGraphics

enum Command {
    case move(CGFloat, CGFloat), line(CGFloat, CGFloat)
    case curve(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat), close
    var svg: String {
        func n(_ value: CGFloat) -> String { String(Int(value)) }
        switch self {
        case let .move(x, y): return "M\(n(x)) \(n(y))"
        case let .line(x, y): return "L\(n(x)) \(n(y))"
        case let .curve(a, b, c, d, x, y): return "C\(n(a)) \(n(b)) \(n(c)) \(n(d)) \(n(x)) \(n(y))"
        case .close: return "Z"
        }
    }
}
func path(_ commands: [Command]) -> CGPath {
    let result = CGMutablePath()
    for command in commands {
        switch command {
        case let .move(x, y): result.move(to: CGPoint(x: x, y: y))
        case let .line(x, y): result.addLine(to: CGPoint(x: x, y: y))
        case let .curve(a, b, c, d, x, y): result.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: a, y: b), control2: CGPoint(x: c, y: d))
        case .close: result.closeSubpath()
        }
    }
    return result
}
func color(_ hex: UInt32) -> CGColor {
    CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, components: [CGFloat((hex >> 16) & 255) / 255, CGFloat((hex >> 8) & 255) / 255, CGFloat(hex & 255) / 255, 1])!
}
let navy: UInt32 = 0x071725, paper: UInt32 = 0xfffefa, purple: UInt32 = 0xb026ff, green: UInt32 = 0x39ff14
let home: [Command] = [
    .move(512, 220), .curve(496, 220, 484, 226, 472, 236), .line(238, 426),
    .curve(222, 439, 212, 458, 212, 479), .line(212, 738),
    .curve(212, 779, 245, 812, 286, 812), .line(738, 812),
    .curve(779, 812, 812, 779, 812, 738), .line(812, 479),
    .curve(812, 458, 802, 439, 786, 426), .line(552, 236),
    .curve(540, 226, 528, 220, 512, 220), .close
]
let fold: [Command] = [
    .move(512, 220), .line(512, 400), .curve(512, 444, 548, 480, 592, 480),
    .line(812, 480), .curve(812, 458, 802, 439, 786, 426), .line(552, 236),
    .curve(540, 226, 528, 220, 512, 220), .close
]
let check: [Command] = [.move(364, 614), .line(462, 712), .line(660, 514)]

func png(size: Int) throws -> Data {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    // Work in the same top-left coordinate space as the SVG.
    context.translateBy(x: 0, y: CGFloat(size))
    context.scaleBy(x: CGFloat(size) / 1024, y: -CGFloat(size) / 1024)
    context.setFillColor(color(navy)); context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
    context.setFillColor(color(paper)); context.addPath(path(home)); context.fillPath()
    context.setFillColor(color(purple)); context.addPath(path(fold)); context.fillPath()
    context.setStrokeColor(color(navy)); context.setLineWidth(64); context.setLineCap(.round); context.setLineJoin(.round)
    context.addPath(path(check)); context.strokePath()
    context.setFillColor(color(green)); context.fillEllipse(in: CGRect(x: 754, y: 194, width: 96, height: 96))
    let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
    return bitmap.representation(using: .png, properties: [:])!
}
func save(_ data: Data, at url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
}

if CommandLine.arguments.dropFirst().first == "--all" {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let image = try png(size: 1024)
    try save(image, at: root.appendingPathComponent("ios/FamilyFrame/Assets.xcassets/AppIcon.appiconset/AppIcon.png"))
    try save(image, at: root.appendingPathComponent("ios/FamilyFrame/Assets.xcassets/BrandMark.imageset/BrandMark.png"))
    for size in [180, 192, 512] {
        try save(png(size: size), at: root.appendingPathComponent("dashboard/public/brand/icon-\(size).png"))
    }
    // Keep legacy dashboard/manifest consumers on the same identity.
    for size in [192, 512] {
        try save(png(size: size), at: root.appendingPathComponent("dashboard/public/icon-\(size).png"))
    }
    let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none">
      <rect width="1024" height="1024" rx="224" fill="#071725"/>
      <path d="\(home.map(\.svg).joined(separator: " "))" fill="#fffefa"/>
      <path d="\(fold.map(\.svg).joined(separator: " "))" fill="#b026ff"/>
      <path d="\(check.map(\.svg).joined(separator: " "))" stroke="#071725" stroke-width="64" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="802" cy="242" r="48" fill="#39ff14"/>
    </svg>
    """
    try save(Data(svg.utf8), at: root.appendingPathComponent("dashboard/public/brand/folded-home.svg"))
    print("Exported folded-home SVG, iOS icons, and web icons.")
} else {
    guard CommandLine.arguments.count == 2 else {
        fatalError("Usage: swift make-app-icon.swift --all | <output.png>")
    }
    try save(png(size: 1024), at: URL(fileURLWithPath: CommandLine.arguments[1]))
}
