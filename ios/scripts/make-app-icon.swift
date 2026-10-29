// Original vector artwork rendered into an opaque RGB PNG with Core Graphics.
import AppKit
import CoreGraphics
let output = CommandLine.arguments[1]
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 4096,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> CGColor { CGColor(red: red/255, green: green/255, blue: blue/255, alpha: 1) }
func rounded(_ rect: CGRect, radius: CGFloat) -> CGPath { CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil) }
// iOS supplies the rounded mask. A full purple tile keeps the white/cyan mark
// legible at notification-icon size without a second white border.
context.setFillColor(color(7,23,37)); context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
func frame(_ rectangle: CGRect, _ tint: CGColor) {
    context.setStrokeColor(tint); context.setLineWidth(29); context.addPath(rounded(rectangle, radius: 42)); context.strokePath()
}
frame(CGRect(x: 247, y: 245, width: 370, height: 490), color(255,255,255))
frame(CGRect(x: 397, y: 315, width: 370, height: 490), color(176,38,255))
context.setFillColor(color(57,255,20)); context.addPath(rounded(CGRect(x: 397, y: 207, width: 370, height: 34), radius: 17)); context.fillPath()
context.setFillColor(color(255,92,92)); context.fillEllipse(in: CGRect(x: 671, y: 713, width: 112, height: 112))
let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
