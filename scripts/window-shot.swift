// Screenshot the Pivot window (dev helper): swift scripts/window-shot.swift out.png
import CoreGraphics
import Foundation

let out = CommandLine.arguments.dropFirst().first ?? "pivot.png"
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
guard let window = windows.first(where: { ($0[kCGWindowOwnerName as String] as? String)?.lowercased() == "pivot" }),
      let id = window[kCGWindowNumber as String] as? Int else {
    FileHandle.standardError.write("Pivot window not found\n".data(using: .utf8)!)
    exit(1)
}
let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
task.arguments = ["-x", "-o", "-l", String(id), out]
try task.run()
task.waitUntilExit()
