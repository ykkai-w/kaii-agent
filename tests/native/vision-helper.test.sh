#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/../.." && pwd)"
binary="$project_root/resources/bin/kaii-vision"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/kaii-vision-test.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

"$project_root/scripts/build-vision-helper.sh" >/dev/null

test_image="$temporary_dir/vision-smoke.png"

xcrun swift - "$test_image" <<'SWIFT'
import AppKit
import Foundation

let outputPath = CommandLine.arguments[1]
let width = 900
let height = 500
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    fputs("Unable to allocate test bitmap\n", stderr)
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

NSColor(calibratedRed: 0.96, green: 0.93, blue: 0.84, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()

NSColor(calibratedRed: 0.16, green: 0.40, blue: 0.72, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 55, y: 55, width: 790, height: 390), xRadius: 28, yRadius: 28).fill()

let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center
let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 76, weight: .bold),
    .foregroundColor: NSColor.white,
    .paragraphStyle: paragraph,
]

let text = "KAI VISION 2026"
text.draw(in: NSRect(x: 80, y: 205, width: 740, height: 100), withAttributes: attributes)
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("Unable to generate test PNG\n", stderr)
    exit(1)
}

try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
SWIFT

json_output="$temporary_dir/result.json"
"$binary" "$test_image" >"$json_output"

jq -e '
  .ok == true and
  .width == 900 and
  .height == 500 and
  (.ocr.lines | type == "array" and length >= 1 and length <= 80) and
  (.ocr.text | ascii_upcase | contains("KAI") and contains("2026")) and
  (.classifications | type == "array" and length <= 15) and
  (all(.ocr.lines[]; (.text | type == "string") and (.confidence >= 0 and .confidence <= 1))) and
  (all(.classifications[]; (.label | type == "string") and (.confidence >= 0 and .confidence <= 1)))
' "$json_output" >/dev/null

relative_output="$temporary_dir/relative.json"
if (cd "$temporary_dir" && "$binary" "vision-smoke.png" >"$relative_output"); then
  echo "Expected relative path to fail" >&2
  exit 1
fi
jq -e '.ok == false and .error.code == "path_not_absolute"' "$relative_output" >/dev/null

# 失败路径也是 helper 协议的一部分。只断言“返回非 0”会漏过
# 栈跟踪、空输出或一句普通文字，Electron 那边都无法解析。
fake_image="$temporary_dir/fake.png"
printf 'not an image' >"$fake_image"
if "$binary" "$fake_image" >"$temporary_dir/fake.json"; then
  echo "Expected fake image to fail" >&2
  exit 1
fi
jq -e '.ok == false and .error.code == "unreadable_image"' "$temporary_dir/fake.json" >/dev/null

if "$binary" "$temporary_dir/missing.png" >"$temporary_dir/missing.json"; then
  echo "Expected missing image to fail" >&2
  exit 1
fi
jq -e '.ok == false and .error.code == "not_a_file"' "$temporary_dir/missing.json" >/dev/null

if "$binary" "$test_image" extra >"$temporary_dir/usage.json"; then
  echo "Expected extra argument to fail" >&2
  exit 1
fi
jq -e '.ok == false and .error.code == "usage"' "$temporary_dir/usage.json" >/dev/null

printf 'vision-helper smoke PASS: %sx%s, OCR=%s, labels=%s\n' \
  "$(jq -r '.width' "$json_output")" \
  "$(jq -r '.height' "$json_output")" \
  "$(jq -r '.ocr.lines | length' "$json_output")" \
  "$(jq -r '.classifications | length' "$json_output")"
